import { setTimeout as wait } from 'node:timers/promises';

export type SlotsCall = (method: string, input: Record<string, unknown>) => Promise<any>;
// Holds a Machine Slots `local-model` use while GPU work runs, so it shows in Slots and queues behind other local-model work.
// A thread that already holds the pool's lease (slots-run) just adds a use to it. Slots is optional: when it is missing,
// fails or does not answer, the work runs unleased.
// `device` pins a registered machine ('local' for this Mac); without it Slots grants the first free device. `work` gets the
// granted device: a machine name, '' for this Mac, or undefined when it runs unleased.
export async function withSlot<T>(call: SlotsCall, threadId: string | undefined, job: string, signal: AbortSignal, work: (device?: string) => Promise<T>, log: (line: string) => void, pollMs = 3000, heartbeatMs = 60000, device?: string): Promise<T> {
  let useId: string | undefined, granted: string | undefined;
  if (threadId) {
    try {
      const result = await call('acquire', { pool: 'local-model', threadId, job, estMs: 300000, ...(device ? { device } : {}) });
      if (!result?.ok) log('Machine Slots: ' + (result?.error?.message ?? 'acquire failed'));
      else {
        useId = result.data.useId;
        let data = result.data;
        while (data.kind !== 'leased') {
          await wait(pollMs, undefined, { signal });
          const next = await call('heartbeatUse', { threadId, useId });
          if (!next?.ok) { log('Machine Slots: ' + (next?.error?.message ?? 'heartbeat failed')); break; }
          data = next.data;
        }
        if (data.kind === 'leased') granted = data.lease?.device ?? data.device ?? '';
      }
    } catch (error) {
      if (signal.aborted) { if (useId) await call('done', { threadId, useId }).catch(() => {}); throw error; }
      log('Machine Slots unavailable, running without a slot: ' + String(error));
    }
  }
  const timer = useId ? setInterval(() => void call('heartbeatUse', { threadId, useId }).catch(() => {}), heartbeatMs) : undefined;
  try { return await work(granted); }
  finally { clearInterval(timer); if (useId) await call('done', { threadId, useId }).catch(() => {}); }
}
