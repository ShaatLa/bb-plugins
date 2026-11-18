import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const tokens = z.number().int().nonnegative();
export const tokenEntrySchema = z.object({
  id: z.string().min(1), ts: tokens, source: z.literal("thread"),
  threadId: z.string().nullable(), providerThreadId: z.string().nullable(), model: z.string().min(1),
  promptTokens: tokens, cachedTokens: tokens, completionTokens: tokens,
  reasoningTokens: tokens.nullable(), durationMs: z.number().nonnegative().nullable(),
});
const cursorSchema = z.tuple([tokens, z.string().min(1)]);
export const tokenUsageContract = defineRpcContract({
  "usage.list": {
    input: z.object({ after: z.string().max(4096).optional(), limit: z.number().int().min(1).max(1000).default(200) }).strict().nullable(),
    output: z.object({ entries: z.array(tokenEntrySchema), nextCursor: z.string().nullable() }),
  },
});

export async function listTokenUsage(file: string, input: { after?: string; limit?: number } | null) {
  const { after, limit = 200 } = tokenUsageContract["usage.list"].input.parse(input) ?? {};
  const cursor = after === undefined ? null : cursorSchema.parse(JSON.parse(after));
  const unique = new Map<string, z.infer<typeof tokenEntrySchema>>();
  // Read current first so rotation between reads cannot hide its previous contents.
  for (const journal of [file, path.join(path.dirname(file), "usage.1.jsonl")]) {
    let text: string;
    try { text = await readFile(journal, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const line of text.split("\n").slice(0, -1)) {
      try { const entry = tokenEntrySchema.parse(JSON.parse(line)); if (!unique.has(entry.id)) unique.set(entry.id, entry); }
      catch { /* A damaged record must not hide later usage. */ }
    }
  }
  const retainedCursor = cursor && unique.get(cursor[1])?.ts === cursor[0] ? cursor : null;
  const entries = [...unique.values()]
    .filter(e => !retainedCursor || e.ts > retainedCursor[0] || (e.ts === retainedCursor[0] && e.id > retainedCursor[1]))
    .sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, limit);
  const last = entries.at(-1);
  return { entries, nextCursor: last ? JSON.stringify([last.ts, last.id]) : null };
}

// Executed inside the standalone shim; never await usage I/O on the turn path.
export const tokenUsageShimSource = String.raw`
let usageWrites=Promise.resolve();
function recordUsage(session,step,model){
  const u=step.usage,valid=n=>Number.isSafeInteger(n)&&n>=0;
  if(step.state!=='DONE'||!valid(step.step_index)||!u||!valid(u.input_tokens)||!valid(u.output_tokens)||!valid(u.cache_read_tokens)||!valid(u.input_tokens+u.cache_read_tokens)||!session.conversationId)return;
  const entry={id:session.id+':'+session.conversationId+':'+step.step_index,ts:Date.now(),source:'thread',threadId:process.env.BB_THREAD_ID||null,providerThreadId:session.id,model,
    promptTokens:u.input_tokens+u.cache_read_tokens,cachedTokens:u.cache_read_tokens,completionTokens:u.output_tokens,
    reasoningTokens:valid(u.thinking_tokens)?u.thinking_tokens:null,durationMs:typeof step.duration_seconds==='number'&&Number.isFinite(step.duration_seconds)&&step.duration_seconds>=0?Math.round(step.duration_seconds*1000):null};
  usageWrites=usageWrites.then(async()=>{
    const file=join(dataDir,'usage.jsonl');
    await appendFile(file,JSON.stringify(entry)+'\n',{mode:0o600});
    if((await stat(file)).size>8*1024*1024)await rename(file,join(dataDir,'usage.1.jsonl'));
  }).catch(()=>{});
}
`;
