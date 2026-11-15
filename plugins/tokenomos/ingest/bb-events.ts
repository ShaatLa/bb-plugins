import type { Database } from "better-sqlite3";
import type { PluginBbSdk, PluginLogger } from "@get-bb/plugin-sdk";
import { setImmediate } from "node:timers/promises";
import { z } from "zod";
import { bandOf, BACKFILLED, ESTIMATED, RECOVERED, type UsageRow } from "../contract";
import type { Store } from "../store/write";
import { normaliseTier } from "./tiers";
import { createCompactions } from "./compactions";
export { onRowsApplied } from "./compactions";

const TYPES = ["thread/tokenUsage/updated","thread/contextWindowUsage/updated","thread/compacted","client/turn/requested","turn/input/accepted","turn/started","turn/completed","thread/identity"] as const;
const n = z.number().finite().nonnegative();
const counts = z.object({ totalTokens:n,inputTokens:n,cachedInputTokens:n,outputTokens:n,reasoningOutputTokens:n.optional(),cacheReadInputTokens:n.optional(),cacheWriteInputTokens:n.optional() });
const identity = z.object({providerThreadId:z.string()});
const schemas = {
  "client/turn/requested":z.object({requestId:z.string(),input:z.array(z.object({type:z.string(),text:z.string().optional()})),execution:z.object({model:z.string().nullish(),serviceTier:z.string().nullish()})}),
  "turn/input/accepted":identity.extend({clientRequestId:z.string()}),
  "turn/started":identity,
  "turn/completed":identity.extend({status:z.string().optional()}),
  "thread/identity":identity,
  "thread/compacted":identity,
  "thread/contextWindowUsage/updated":identity.extend({contextWindowUsage:z.object({usedTokens:n,modelContextWindow:n.nullish(),estimated:z.boolean()})}),
  "thread/tokenUsage/updated":identity.extend({parentToolCallId:z.string().nullish(),tokenUsage:z.object({total:counts,last:counts,modelContextWindow:n.nullish(),promptCacheTtlMs:n.optional()})}),
};
type Counts = z.infer<typeof counts>;
type Components = Pick<UsageRow,"freshIn"|"cacheRead"|"cacheWriteShort"|"cacheWriteLong"|"output"|"reasoning">;
function components(c: Counts): Components {
  const openai = c.totalTokens===c.inputTokens+c.outputTokens;
  const read = c.cacheReadInputTokens ?? (openai ? c.cachedInputTokens : 0);
  const write = c.cacheWriteInputTokens ?? (openai ? 0 : Math.max(0,c.cachedInputTokens-read));
  return {freshIn:Math.max(0,c.inputTokens-(openai ? c.cachedInputTokens : 0)),cacheRead:read,cacheWriteShort:write,cacheWriteLong:0,output:c.outputTokens,reasoning:c.reasoningOutputTokens??0};
}
type Turn = {model:string;tier:string;tier_raw:string;request_id:string};

export function createBbEvents(o: {store:Store;db:Database;sdk:PluginBbSdk;log:PluginLogger;now?:()=>number;signal?:AbortSignal}) {
  const {db,store,sdk,log} = o;
  const now = o.now ?? Date.now;
  const effects = createCompactions(db,store,now);
  return {
    onRowsApplied: effects.onRowsApplied,
    async flushThread(threadId: string, fallbackOwned: boolean) {
      let cursor = (db.prepare("SELECT last_seq FROM bb_cursor WHERE thread_id=?").get(threadId) as {last_seq:number}|undefined)?.last_seq ?? 0;
      const rows:UsageRow[]=[];
      let touched=false;
      let more = false;
      for (let pageNumber=0; pageNumber<5; pageNumber++) {
        o.signal?.throwIfAborted();
        const page = await sdk.threads.events.list({threadId,afterSeq:String(cursor),limit:"100",order:"asc",types:[...TYPES],signal:o.signal});
        o.signal?.throwIfAborted();
        const batch:UsageRow[]=[], initial:UsageRow[]=[];
        db.transaction(()=>{
          let errors=0;
          const thread = db.prepare("SELECT provider_id,project_id FROM threads WHERE id=?").get(threadId) as {provider_id:string;project_id:string}|undefined;
          for (const e of page) {
            if (e.seq<=cursor) continue;
            cursor=e.seq; touched=true;
            const schema = schemas[e.type as keyof typeof schemas];
            if (!schema || !schema.safeParse(e.data).success) {errors++;continue;}
            const turnId = e.scope.kind==="turn" ? e.scope.turnId : null;
            const at=e.createdAt;
            if (turnId) db.prepare("INSERT OR IGNORE INTO turns(thread_id,turn_id) VALUES (?,?)").run(threadId,turnId);
            switch(e.type) {
              case "client/turn/requested": {
                const d=schemas[e.type].parse(e.data);
                db.prepare("INSERT OR IGNORE INTO requests(request_id,thread_id,model,tier,tier_raw,at,compact) VALUES (?,?,?,?,?,?,?)")
                  .run(d.requestId,threadId,d.execution.model??"unknown",normaliseTier(d.execution.serviceTier),d.execution.serviceTier??"",at,+(d.input.length===1&&d.input[0].type==="text"&&d.input[0].text==="/compact"));
                break;
              }
              case "turn/input/accepted": {
                const d=schemas[e.type].parse(e.data);
                const r=db.prepare("SELECT * FROM requests WHERE request_id=? AND thread_id=?").get(d.clientRequestId,threadId) as {model:string;tier:string;tier_raw:string;compact:number}|undefined;
                if (r&&turnId) db.prepare("UPDATE turns SET model=?,tier=?,tier_raw=?,compaction_only=?,request_id=? WHERE thread_id=? AND turn_id=? AND request_id=''")
                  .run(r.model,r.tier,r.tier_raw,r.compact,d.clientRequestId,threadId,turnId);
                break;
              }
              case "turn/started": if(turnId) db.prepare("UPDATE turns SET started_at=? WHERE thread_id=? AND turn_id=?").run(at,threadId,turnId); break;
              case "turn/completed": if(turnId) db.prepare("UPDATE turns SET completed_at=? WHERE thread_id=? AND turn_id=?").run(at,threadId,turnId); break;
              case "thread/identity": db.prepare("INSERT OR REPLACE INTO provider_session VALUES (?,?)").run(schemas[e.type].parse(e.data).providerThreadId,threadId);break;
              case "thread/contextWindowUsage/updated": {
                const d=schemas[e.type].parse(e.data).contextWindowUsage;
                db.prepare("INSERT OR REPLACE INTO context_last VALUES (?,?,?)").run(threadId,d.usedTokens,at);
                db.prepare("INSERT OR REPLACE INTO context_snap VALUES (?,?,?,?)").run(threadId,e.seq,d.usedTokens,at);
                effects.resolve(threadId, false);
                db.prepare("DELETE FROM context_snap WHERE thread_id=? AND seq NOT IN (SELECT seq FROM context_snap WHERE thread_id=? ORDER BY seq DESC LIMIT 50)").run(threadId,threadId);
                break;
              }
              case "thread/compacted": {
                const prev=db.prepare("SELECT MAX(seq) AS seq FROM compactions WHERE thread_id=?").get(threadId) as {seq:number|null};
                const before=db.prepare("SELECT used_tokens FROM context_snap WHERE thread_id=? AND seq<? AND seq>? ORDER BY seq DESC LIMIT 1").get(threadId,e.seq,prev.seq??0) as {used_tokens:number}|undefined;
                const turn=db.prepare("SELECT model FROM turns WHERE thread_id=? AND turn_id=?").get(threadId,turnId??"") as {model:string}|undefined;
                db.prepare(`INSERT OR IGNORE INTO compactions(id,thread_id,turn_id,at,before_tokens,model,ttl_ms,seq,before_known) VALUES (?,?,?,?,?,?,?,?,?)`)
                  .run(`bbc:${e.id}`,threadId,turnId??"",at,before?.used_tokens??0,turn?.model??"unknown",store.getCursor<number>(`cache-ttl:${threadId}`)??(thread?.provider_id==="claude-code"?3_600_000:1_800_000),e.seq,+!!before);
                break;
              }
              case "thread/tokenUsage/updated": {
                const d=schemas[e.type].parse(e.data),u=d.tokenUsage;
                if(u.promptCacheTtlMs!==undefined) store.setCursor(`cache-ttl:${threadId}`,u.promptCacheTtlMs);
                if(turnId&&u.last.totalTokens>0) db.prepare("UPDATE turns SET reported_usage=1 WHERE thread_id=? AND turn_id=?").run(threadId,turnId);
                const exact=db.prepare("SELECT * FROM turns WHERE thread_id=? AND turn_id=? AND request_id<>''").get(threadId,turnId??"") as Turn|undefined;
                const turn=exact??db.prepare("SELECT * FROM turns WHERE thread_id=? AND request_id<>'' ORDER BY started_at DESC LIMIT 1").get(threadId) as Turn|undefined;
                const scope=thread?.provider_id==="codex" ? d.parentToolCallId??"" : "";
                const old=db.prepare("SELECT prev_total FROM bb_counter WHERE thread_id=? AND provider_thread_id=? AND scope=?").get(threadId,d.providerThreadId,scope) as {prev_total:string}|undefined;
                const previous=old ? JSON.parse(old.prev_total) as Counts|null : null;
                const make=(c:Components,key:string,flags:number):UsageRow=>{const promptTokens=c.freshIn+c.cacheRead+c.cacheWriteShort+c.cacheWriteLong;return {...c,key,ts:at,threadId,projectId:thread?.project_id??"",provider:thread?.provider_id??"",model:turn?.model||"unknown",tier:turn?.tier||"standard",tierRaw:turn?.tier_raw??"",promptTokens,band:bandOf(flags & (BACKFILLED|RECOVERED) ? (u.last.totalTokens>0 ? last.freshIn+last.cacheRead+last.cacheWriteShort+last.cacheWriteLong : 0) : promptTokens),conv:d.parentToolCallId?`nested:${d.parentToolCallId}`:"",turnId,source:"bb-events",flags:flags|(!exact?ESTIMATED:0)};};
                const last=components(u.last);
                const estimated=u.last.totalTokens!==u.last.inputTokens+u.last.outputTokens&&u.last.totalTokens!==u.last.inputTokens+u.last.outputTokens+u.last.cachedInputTokens;
                if (!previous && fallbackOwned) {
                  if (u.total.totalTokens>0) batch.push(make(components(u.total),`bb:${threadId}:${e.id}`,BACKFILLED|ESTIMATED));
                } else if(u.last.totalTokens>0) batch.push(make(last,`bb:${threadId}:${e.id}`,estimated?ESTIMATED:0));
                // Keep the total separate until the scheduler resolves initial file ownership.
                if (!previous && !fallbackOwned && u.total.totalTokens>0) initial.push(make(components(u.total),`bbi:${threadId}:${e.id}`,BACKFILLED|ESTIMATED));
                const gap=previous ? Math.max(0,u.total.totalTokens-(u.total.totalTokens>=previous.totalTokens?previous.totalTokens:0)-u.last.totalTokens) : 0;
                if(gap>0) {
                  const total=components(u.total),base=previous&&u.total.totalTokens>=previous.totalTokens?components(previous):components({...u.total,totalTokens:0,inputTokens:0,cachedInputTokens:0,outputTokens:0,cacheReadInputTokens:0,cacheWriteInputTokens:0,reasoningOutputTokens:0});
                  const recovered={...total};
                  for(const k of Object.keys(total) as Array<keyof Components>) recovered[k]=Math.max(0,total[k]-base[k]-last[k]);
                  const sum=recovered.freshIn+recovered.cacheRead+recovered.cacheWriteShort+recovered.cacheWriteLong+recovered.output;
                  if(sum!==gap) {for(const k of Object.keys(recovered) as Array<keyof Components>) recovered[k]=0;recovered.freshIn=gap;}
                  batch.push(make(recovered,`bbr:${threadId}:${e.id}`,RECOVERED|ESTIMATED));
                }
                db.prepare("INSERT OR REPLACE INTO bb_counter VALUES (?,?,?,?)").run(threadId,d.providerThreadId,scope,JSON.stringify(u.total));
                break;
              }
            }
          }
          if(errors){store.setCursor(`bb-parse-errors:${threadId}`,(store.getCursor<number>(`bb-parse-errors:${threadId}`)??0)+errors);log.warn(`Tokenomos skipped ${errors} invalid/unknown events in ${threadId}`);}
          effects.resolve(threadId, false);
          // Persist rows with the read cursor so a later source failure cannot lose usage.
          const saveCandidate = db.prepare(`INSERT OR REPLACE INTO bb_candidate
            (key,ts,thread_id,project_id,provider,model,tier,tier_raw,prompt_tokens,band,conv,fresh_in,cache_read,cache_write_short,cache_write_long,output,reasoning,turn_id,source,flags)
            VALUES (@key,@ts,@threadId,@projectId,@provider,@model,@tier,@tierRaw,@promptTokens,@band,@conv,@freshIn,@cacheRead,@cacheWriteShort,@cacheWriteLong,@output,@reasoning,@turnId,@source,@flags)`);
          for (const row of [...batch,...initial]) saveCandidate.run({ ...row, turnId: row.turnId ?? '' });
          db.prepare("INSERT OR REPLACE INTO bb_cursor VALUES (?,?)").run(threadId,cursor);
        })();
        rows.push(...batch);
        more = page.length === 100;
        if (!more) break;
        await setImmediate(undefined,{signal:o.signal});
      }
      effects.resolve(threadId);
      return {rows:fallbackOwned?rows:[],candidates:fallbackOwned?[]:rows,touched,more};
    },
    async coverage(threadId:string) {
      o.signal?.throwIfAborted();
      const source=(db.prepare("SELECT source FROM thread_source WHERE thread_id=?").get(threadId) as {source:string}|undefined)?.source;
      const fileSource=source==="claude-file"||source==="codex-file" ? source : (db.prepare("SELECT provider_id FROM threads WHERE id=?").get(threadId) as {provider_id:string}|undefined)?.provider_id==="codex"?"codex-file":"claude-file";
      const turns=db.prepare(`SELECT started_at,EXISTS(SELECT 1 FROM usage_raw u WHERE u.thread_id=t.thread_id AND source=? AND conv='' AND ts BETWEEN t.started_at AND t.completed_at+120000) AS covered
        FROM turns t WHERE thread_id=? AND completed_at>0 AND reported_usage=1 ORDER BY started_at DESC`).all(fileSource,threadId) as Array<{started_at:number;covered:number}>;
      let uncoveredStreak=0,firstUncoveredStart:number|null=null,lastCoveredTurnStart:number|null=null;
      for(const t of turns){if(t.covered){lastCoveredTurnStart=t.started_at;break;}uncoveredStreak++;firstUncoveredStart=t.started_at;}
      return {uncoveredStreak,firstUncoveredStart,lastCoveredTurnStart};
    },
  };
}
