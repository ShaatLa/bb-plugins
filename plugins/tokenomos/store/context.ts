import type { Database } from 'better-sqlite3';
import { experimental_PluginRpcRefusal } from '@get-bb/plugin-sdk';
import { BACKFILLED, RECOVERED, bandOf } from '../contract';
import { costUsd, type Overrides } from '../pricing/price';

type Call = { ts:number;model:string;tier:string;prompt_tokens:number;provider_thread_id:string;write_split:number;cache_write_short:number;cache_write_long:number };
const mask=BACKFILLED|RECOVERED;
export function currentContext(db:Database,threadId:string) {
  const thread=db.prepare('SELECT provider_id FROM threads WHERE id=?').get(threadId) as {provider_id:string}|undefined;
  if (!thread) return null;
  const cleared=(db.prepare('SELECT at FROM context_cleared WHERE thread_id=?').get(threadId) as {at:number}|undefined)?.at ?? -1;
  const call=db.prepare(`SELECT * FROM usage_raw WHERE thread_id=? AND provider=? AND conv='' AND (flags & ?)=0 AND ts>? ORDER BY ts DESC,key DESC LIMIT 1`).get(threadId,thread.provider_id,mask,cleared) as Call|undefined;
  let contextTokens:number|null=call?.prompt_tokens ?? null, at=call?.ts ?? -1;
  const snap=db.prepare('SELECT at,used_tokens FROM context_last WHERE thread_id=? AND at>?').get(threadId,cleared) as {at:number;used_tokens:number}|undefined;
  if (snap && snap.at>at) {contextTokens=snap.used_tokens;at=snap.at;}
  const compact=db.prepare('SELECT at,after_tokens,after_known FROM compactions WHERE thread_id=? AND at>? ORDER BY at DESC,seq DESC LIMIT 1').get(threadId,cleared) as {at:number;after_tokens:number;after_known:number}|undefined;
  if (compact && compact.at>at) { if (!compact.after_known) return null; contextTokens=compact.after_tokens; }
  if(contextTokens===null)return null;
  const writeKind=call?.write_split && !!call.cache_write_long!==!!call.cache_write_short ? (call.cache_write_long ? 'long' : 'short') : null;
  return {contextTokens,model:call?.model ?? 'unknown',tier:call?.tier ?? 'unknown',band:bandOf(contextTokens),lastCallAt:call?.ts ?? null,session:call?.provider_thread_id ?? '',writeKind};
}
export function wakeCost(db:Database,threadId:string,now:number,overrides:Overrides={}) {
  const thread=db.prepare('SELECT provider_id FROM threads WHERE id=?').get(threadId) as {provider_id:string}|undefined;
  if (!thread) throw new experimental_PluginRpcRefusal({code:'not_found',message:'Unknown thread'});
  const c=currentContext(db,threadId),claude=thread.provider_id==='claude-code';
  let ttlMinutes=claude?60:30,ttlSource:'observed'|'assumed'='assumed',kind=c?.session ? c.writeKind : null;
  if (c?.session) {
    if (claude && kind) {ttlMinutes=kind==='long'?60:5;ttlSource='observed';}
    else {
      const ttl=db.prepare('SELECT ttl_ms FROM cache_ttl WHERE thread_id=? AND provider_thread_id=? AND at>=? ORDER BY at DESC LIMIT 1').get(threadId,c.session,c.lastCallAt) as {ttl_ms:number}|undefined;
      if (ttl) {ttlMinutes=ttl.ttl_ms/60000;ttlSource='observed';}
    }
  }
  const idleMinutes=c?.lastCallAt!=null ? Math.max(0,(now-c.lastCallAt)/60000) : null;
  const price=(warm:boolean) => c ? costUsd({freshIn:!warm&&!claude?c.contextTokens:0,cacheRead:warm?c.contextTokens:0,cacheWriteShort:!warm&&claude&&kind==='short'?c.contextTokens:0,cacheWriteLong:!warm&&claude&&kind!=='short'?c.contextTokens:0,output:0},c.model,c.tier,c.band,overrides) : null;
  return {threadId,provider:thread.provider_id,model:c?.model ?? 'unknown',contextTokens:c?.contextTokens ?? null,lastCallAt:c?.lastCallAt ?? null,idleMinutes,ttlMinutes,ttlSource,cacheLikelyExpired:idleMinutes===null?null:idleMinutes>ttlMinutes,coldCostUsd:price(false),warmCostUsd:price(true)};
}
export function watchlist(db:Database,now:number,threshold:number,overrides:Overrides={}) {
  // One ts-bounded candidate scan; cap the expensive per-thread work before resolving context.
  const candidates=db.prepare(`SELECT r.thread_id,MAX(r.ts) last FROM usage_raw r JOIN threads t ON t.id=r.thread_id
    WHERE r.ts>=? AND r.ts<=? AND r.conv='' AND r.provider=t.provider_id AND (r.flags & ?)=0
    GROUP BY r.thread_id ORDER BY last DESC,r.thread_id LIMIT 200`).all(now-3600000,now,mask) as {thread_id:string}[];
  const items=candidates.flatMap(({thread_id})=>{
    const c=currentContext(db,thread_id);if(!c || c.lastCallAt===null || c.contextTokens<threshold)return [];
    const thread=db.prepare('SELECT title,provider_id FROM threads WHERE id=?').get(thread_id) as {title:string;provider_id:string};
    const rows=db.prepare(`SELECT * FROM usage_raw WHERE thread_id=? AND ts>=? AND ts<=?`).all(thread_id,now-3600000,now) as Array<{model:string;tier:string;band:number;provider:string;fresh_in:number;cache_read:number;cache_write_short:number;cache_write_long:number;output:number}>;
    const costs=rows.map(r=>r.provider==='local-models'?0:costUsd({freshIn:r.fresh_in,cacheRead:r.cache_read,cacheWriteShort:r.cache_write_short,cacheWriteLong:r.cache_write_long,output:r.output},r.model,r.tier,r.band,overrides));
    const readCostPerCallUsd=costUsd({freshIn:0,cacheRead:c.contextTokens,cacheWriteShort:0,cacheWriteLong:0,output:0},c.model,c.tier,c.band,overrides);
    return [{threadId:thread_id,title:thread.title,provider:thread.provider_id,model:c.model,contextTokens:c.contextTokens,callsLastHour:rows.length,readCostPerCallUsd,costLastHourUsd:costs.some(v=>v===null)?null:costs.reduce<number>((a,b)=>a+(b??0),0),lastCallAt:c.lastCallAt}];
  });
  return {items:items.sort((a,b)=>(b.costLastHourUsd??-1)-(a.costLastHourUsd??-1)||b.lastCallAt-a.lastCallAt).slice(0,20)};
}
