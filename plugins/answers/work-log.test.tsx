// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { WorkLog, groupRows, summarize, type Row } from './work-log';

const work = (id: string, workKind = 'command', extra = {}): Row => ({ id, kind: 'work', workKind, threadId: 'thread', turnId: 'turn', sourceSeqStart: 1, sourceSeqEnd: 2, startedAt: 0, createdAt: 0, completedAt: 1000, status: 'completed', command: 'pwd', activityIntents: [], ...extra } as unknown as Row);
const conversation = (id: string, messageSeq: number): Row => ({ id, kind: 'conversation', role: 'assistant', messageSeq, text: id } as Row);
afterEach(() => { cleanup(); vi.useRealTimers(); });
function setup(id: string, props = {}, details = vi.fn(async () => ({ rows: [work('command')], olderCursor: null }))) {
  const subscribe = vi.fn((_args: any) => vi.fn());
  const slot = renderSlot({ component: () => <WorkLog threadId={id} turnId="turn" sourceSeqStart={1} sourceSeqEnd={20} startedAt={0} completedAt={811000} {...props} /> }, {}, { sdk: { threads: { timelineTurnSummaryDetails: details }, subscribe } } as any);
  return { slot, details, subscribe };
}
it('groups consecutive work through nested turns and omits the final answer', () => {
  const groups = groupRows([work('a'), { kind: 'turn', children: [work('b'), conversation('progress', 10), work('c'), conversation('answer', 20)] } as Row], 20);
  expect(groups.map(g => Array.isArray(g) ? g.map(r => r.id) : g.id)).toEqual([['a', 'b'], 'progress', ['c']]);
});
it('summarizes bb action categories and counts failures without treating interruption as an error', () => {
  const groups = groupRows([work('a'), work('b', 'command', { status: 'error' }), work('c', 'file-read', { path: 'a' }), work('d', 'file-change', { change: { path: 'b' } }), work('e', 'web-search', { queries: ['a', 'b'], status: 'interrupted' })]);
  expect(summarize(groups[0] as any)).toEqual({ text: 'Ran 2 commands, explored 1 file, edited 1 file, researched 2 search queries', errors: 1 });
});
it('fetches only on expand and caches a finished turn across collapse and remount', async () => {
  const { slot, details, subscribe } = setup('cache');
  const toggle = slot.getByRole('button', { name: /Worked for 13m 31s/ });
  expect(details).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
  fireEvent.click(toggle); await slot.findByText('Ran 1 command');
  expect(details).toHaveBeenCalledExactlyOnceWith({ threadId: 'cache', turnId: 'turn', sourceSeqStart: '1', sourceSeqEnd: '20' });
  fireEvent.click(toggle); fireEvent.click(toggle); await slot.findByText('Ran 1 command');
  expect(details).toHaveBeenCalledOnce(); slot.unmount();
  const again = setup('cache', {}, details); fireEvent.click(again.slot.getByRole('button', { name: /Worked for/ }));
  await again.slot.findByText('Ran 1 command'); expect(details).toHaveBeenCalledOnce();
});
it('ticks the live line while collapsed without fetching or subscribing', () => {
  vi.useFakeTimers(); vi.setSystemTime(72000);
  const { slot, details, subscribe } = setup('tick', { live: true });
  expect(slot.getByRole('button', { name: /Working for 1m 12s/ })).toBeTruthy();
  act(() => vi.advanceTimersByTime(1000));
  expect(slot.getByRole('button', { name: /Working for 1m 13s/ })).toBeTruthy();
  expect(details).not.toHaveBeenCalled(); expect(subscribe).not.toHaveBeenCalled();
});
it('throttles live events, keeps previous rows, and unsubscribes on collapse', async () => {
  vi.useFakeTimers(); vi.setSystemTime(10000);
  const details = vi.fn(async () => ({ rows: [work('a')], olderCursor: null }));
  const { slot, subscribe } = setup('live', { live: true }, details);
  fireEvent.click(slot.getByRole('button', { name: /Working for/ }));
  await act(async () => {});
  const listener = subscribe.mock.calls[0]![0] as any;
  act(() => { listener.callback(); listener.callback(); vi.advanceTimersByTime(1999); });
  expect(details).toHaveBeenCalledOnce(); expect(slot.getByText('Ran 1 command')).toBeTruthy();
  await act(async () => { vi.advanceTimersByTime(1); }); expect(details).toHaveBeenCalledTimes(2);
  fireEvent.click(slot.getByRole('button', { name: /Working for/ }));
  expect(subscribe.mock.results[0]!.value).toHaveBeenCalledOnce();
});
it('loads earlier rows and preserves the final answer exclusion', async () => {
  const details = vi.fn().mockResolvedValueOnce({ rows: [work('b'), conversation('final', 20)], olderCursor: 'older' }).mockResolvedValueOnce({ rows: [conversation('progress', 5)], olderCursor: null });
  const { slot } = setup('pages', { answerSeq: 20 }, details);
  fireEvent.click(slot.getByRole('button', { name: /Worked for/ }));
  fireEvent.click(await slot.findByRole('button', { name: 'Earlier' }));
  await slot.findByText('progress'); expect(slot.queryByText('final')).toBeNull();
  expect(details.mock.calls[1]![0]).toMatchObject({ beforeCursor: 'older', sourceSeqStart: '1', sourceSeqEnd: '20' });
});
it('discovers a live turn and uses its range for earlier pages', async () => {
  const details = vi.fn().mockResolvedValueOnce({ rows: [work('new')], olderCursor: 'cursor' }).mockResolvedValueOnce({ rows: [work('old')], olderCursor: null });
  const timeline = vi.fn(async () => ({ rows: [{ kind: 'turn', turnId: 'discovered', sourceSeqStart: 7, sourceSeqEnd: 42, startedAt: 0 }] }));
  const slot = renderSlot({ component: () => <WorkLog threadId="discovery" live /> }, {}, { sdk: { threads: { timeline, timelineTurnSummaryDetails: details }, subscribe: () => () => {} } } as any);
  expect(timeline).not.toHaveBeenCalled(); fireEvent.click(slot.getByRole('button', { name: /Working for/ }));
  fireEvent.click(await slot.findByRole('button', { name: 'Earlier' })); await slot.findByText('Ran 2 commands');
  expect(details.mock.calls[1]![0]).toEqual({ threadId: 'discovery', turnId: 'discovered', sourceSeqStart: '7', sourceSeqEnd: '42', beforeCursor: 'cursor' });
});
it('shows the skeleton only before the first response and reports errors', async () => {
  let resolve!: (value: any) => void;
  const details = vi.fn(() => new Promise<any>(done => { resolve = done; }));
  const { slot } = setup('skeleton', {}, details);
  fireEvent.click(slot.getByRole('button', { name: /Worked for/ }));
  expect(slot.getByLabelText('Loading work log').children).toHaveLength(2);
  await act(async () => resolve({ rows: [work('loaded')], olderCursor: null }));
  expect(slot.queryByLabelText('Loading work log')).toBeNull(); slot.unmount();
  const failed = setup('failure', {}, vi.fn().mockRejectedValue(new Error('Offline')));
  fireEvent.click(failed.slot.getByRole('button', { name: /Worked for/ }));
  expect((await failed.slot.findByRole('alert')).textContent).toBe('Offline');
});
