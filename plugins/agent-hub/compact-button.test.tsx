// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { CompactButton, compactAvailable } from './compact-button';
afterEach(cleanup);

const plugin = (over = {}) => ({ id: 'idle-compact', version: '0.3.0', enabled: true, status: 'running', ...over });
it('needs Idle Compact 0.3.0 or later, enabled and running', () => {
  expect(compactAvailable([plugin()])).toBe(true); expect(compactAvailable([plugin({ version: '0.10.1' })])).toBe(true);
  expect(compactAvailable([plugin({ version: '0.2.9' })])).toBe(false); expect(compactAvailable([plugin({ enabled: false })])).toBe(false);
  expect(compactAvailable([plugin({ status: 'failed' })])).toBe(false); expect(compactAvailable([])).toBe(false);
});
it('compacts an idle thread through Idle Compact and reports a refusal', async () => {
  const callRpc = vi.fn().mockRejectedValueOnce(new Error('An earlier compaction of this thread has not finished')).mockResolvedValue({ ok: true });
  const onError = vi.fn();
  const view = (status: string) => renderSlot({ component: () => <CompactButton threadId="thr_a" status={status} onError={onError} /> }, {}, { sdk: { plugins: { list: () => Promise.resolve({ plugins: [plugin()] }), callRpc } } } as any);
  const busy = view('running'); await act(async () => {}); expect(busy.queryByRole('button')).toBeNull(); cleanup();
  const slot = view('idle'); fireEvent.click(await slot.findByRole('button', { name: 'Compact' }));
  await waitFor(() => expect(onError).toHaveBeenCalledWith('An earlier compaction of this thread has not finished'));
  expect(callRpc.mock.calls[0]![0]).toMatchObject({ pluginId: 'idle-compact', method: 'compact', input: { threadId: 'thr_a' } });
  fireEvent.click(slot.getByRole('button', { name: 'Compact failed' })); await waitFor(() => expect(slot.getByRole('button', { name: 'Compact' })).toBeTruthy()); expect(callRpc).toHaveBeenCalledTimes(2);
});
it('shows nothing without Idle Compact', async () => {
  const list = vi.fn(() => Promise.resolve({ plugins: [] }));
  const slot = renderSlot({ component: () => <CompactButton threadId="thr_a" status="idle" onError={() => {}} /> }, {}, { sdk: { plugins: { list } } } as any);
  await waitFor(() => expect(list).toHaveBeenCalled()); expect(slot.queryByRole('button')).toBeNull();
});
it('queues a compaction during a turn on Idle Compact 0.4.0, then cancels it', async () => {
  let queued = false;
  const callRpc = vi.fn(({ method, input }: any) => {
    if (method === 'compactState') return Promise.resolve({ queued, running: false });
    if (method === 'compact') { expect(input).toEqual({ threadId: 'thr_a', queue: true }); queued = true; return Promise.resolve({ ok: true, queued: true }); }
    queued = false; return Promise.resolve({ ok: true });
  });
  const slot = renderSlot({ component: () => <CompactButton threadId="thr_a" status="running" onError={() => {}} /> }, {}, { sdk: { plugins: { list: () => Promise.resolve({ plugins: [plugin({ version: '0.4.0' })] }), callRpc } } } as any);
  fireEvent.click(await slot.findByRole('button', { name: 'Compact' }));
  fireEvent.click(await slot.findByRole('button', { name: 'Compact queued' }));
  await slot.findByRole('button', { name: 'Compact' });
  expect(callRpc.mock.calls.map(c => c[0].method)).toContain('cancelQueuedCompact');
});
it('restores a queued request after a reload', async () => {
  const callRpc = vi.fn(() => Promise.resolve({ queued: true, running: false }));
  const slot = renderSlot({ component: () => <CompactButton threadId="thr_a" status="running" onError={() => {}} /> }, {}, { sdk: { plugins: { list: () => Promise.resolve({ plugins: [plugin({ version: '0.4.0' })] }), callRpc } } } as any);
  expect(await slot.findByRole('button', { name: 'Compact queued' })).toBeTruthy();
});
