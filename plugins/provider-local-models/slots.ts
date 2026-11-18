import { setTimeout as wait } from 'node:timers/promises';

export type SlotsCall = (method: string, input: Record<string, unknown>) => Promise<any>;
// Holds a Machine Slots `local-model` use while GPU work runs, so it shows in Slots and queues behind other local-model work.
// A thread that already holds the pool's lease (slots-run) just adds a use to it. Slots is optional: when it is missing,
// fails or does not answer, the work runs unleased.
export async function withSlot<T>(call: SlotsCall, threadId: string | undefined, job: string, signal: AbortSignal, work: () => Promise<T>, log: (line: string) => void, pollMs = 3000, heartbeatMs = 60000): Promise<T> {
  let useId: string | undefined;
  if (threadId) {
    try {
      const result = await call('acquire', { pool: 'local-model', threadId, job, estMs: 300000 });
      if (!result?.ok) log('Machine Slots: ' + (result?.error?.message ?? 'acquire failed'));
      else {
        useId = result.data.useId;
        for (let data = result.data; data.kind !== 'leased';) {
          await wait(pollMs, undefined, { signal });
          const next = await call('heartbeatUse', { threadId, useId });
          if (!next?.ok) { log('Machine Slots: ' + (next?.error?.message ?? 'heartbeat failed')); break; }
          data = next.data;
        }
      }
    } catch (error) {
      if (signal.aborted) { if (useId) await call('done', { threadId, useId }).catch(() => {}); throw error; }
      log('Machine Slots unavailable, running without a slot: ' + String(error));
    }
  }
  const timer = useId ? setInterval(() => void call('heartbeatUse', { threadId, useId }).catch(() => {}), heartbeatMs) : undefined;
  try { return await work(); }
  finally { clearInterval(timer); if (useId) await call('done', { threadId, useId }).catch(() => {}); }
}
