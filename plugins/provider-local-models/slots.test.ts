import test from 'node:test';
import assert from 'node:assert/strict';
import { withSlot } from './slots.ts';

test('waits for a local-model slot, keeps it during the work and finishes the use', async () => {
  const calls: string[] = []; let polls = 0;
  const call = async (method: string, input: Record<string, unknown>) => {
    calls.push(method + ':' + (input.useId ?? input.pool));
    if (method === 'acquire') return { ok: true, data: { kind: 'queued', useId: 'use-1' } };
    if (method === 'heartbeatUse') return { ok: true, data: { kind: ++polls > 1 ? 'leased' : 'queued', useId: 'use-1' } };
    return { ok: true, data: null };
  };
  const result = await withSlot(call, 'thr', 'job', AbortSignal.timeout(2000), async () => { calls.push('work'); return 'answer'; }, () => {}, 1);
  assert.equal(result, 'answer');
  assert.deepEqual(calls, ['acquire:local-model', 'heartbeatUse:use-1', 'heartbeatUse:use-1', 'work', 'done:use-1']);
});

test('runs without a slot when Slots is missing, and finishes the use when the work fails', async () => {
  const logs: string[] = [];
  assert.equal(await withSlot(async () => { throw Error('plugin not found'); }, 'thr', 'job', AbortSignal.timeout(2000), async () => 'ok', line => logs.push(line)), 'ok');
  assert.match(logs[0], /running without a slot/);
  const done: string[] = [];
  const call = async (method: string) => { if (method === 'done') done.push(method); return { ok: true, data: { kind: 'leased', useId: 'use-2' } }; };
  await assert.rejects(withSlot(call, 'thr', 'job', AbortSignal.timeout(2000), async () => { throw Error('model failed'); }, () => {}), /model failed/);
  assert.deepEqual(done, ['done']);
});

test('pins a device when asked and hands the granted device to the work', async () => {
  const inputs: Record<string, unknown>[] = [];
  const call = async (method: string, input: Record<string, unknown>) => { if (method === 'acquire') inputs.push(input); return { ok: true, data: { kind: 'leased', useId: 'use-3', device: inputs.length > 1 ? 'M1' : undefined } }; };
  assert.equal(await withSlot(call, 'thr', 'job', AbortSignal.timeout(2000), async device => device, () => {}, 1, 60000, 'local'), '');
  assert.equal(await withSlot(call, 'thr', 'job', AbortSignal.timeout(2000), async device => device, () => {}), 'M1');
  assert.equal(await withSlot(call, undefined, 'job', AbortSignal.timeout(2000), async device => device, () => {}), undefined);
  assert.deepEqual(inputs.map(input => input.device), ['local', undefined]);
});
