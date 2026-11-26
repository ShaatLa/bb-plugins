// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { matchLandings, reconcilePending, type PendingRow } from './inbox';
import type { Item } from './contract';

const row = (id: string, text: string, createdAt = 100) => ({ id, threadId: 't', content: [{ type: 'text', text, mentions: [] }], createdAt, updatedAt: createdAt }) as any;
const stand = (id: number, text: string, fields: Partial<PendingRow> = {}): PendingRow => ({ threadId: 't', text, id, done: true, seenIds: [], queuedIds: [], ...fields });
const mine = (id: string, question: string, createdAt = 200) => ({ id, kind: 'mine', threadId: 't', question, questionSeq: 1, createdAt }) as unknown as Item;

describe('reconcilePending', () => {
  it('lets one real row stand in for only one of two identical placeholders, across re-reads', () => {
    const now = 5000, taken = new Set<string>(), rows = [row('q1', 'Same')];
    const first = reconcilePending([stand(4000, 'Same'), stand(4001, 'Same')], rows, taken, now);
    expect(first.map(r => r.id)).toEqual([4001]);
    expect(reconcilePending(first, rows, taken, now).map(r => r.id)).toEqual([4001]);
  });
  it('ignores a real row that was already queued when the placeholder was added, and drops a stale one', () => {
    expect(reconcilePending([stand(4000, 'Same', { queuedIds: ['q1'] })], [row('q1', 'Same')], new Set(), 5000)).toHaveLength(1);
    expect(reconcilePending([stand(4000, 'Same')], [], new Set(), 15000)).toEqual([]);
    expect(reconcilePending([stand(4000, 'Same', { done: false })], [row('q1', 'Same')], new Set(), 5000)).toHaveLength(1);
  });
});

describe('matchLandings', () => {
  it('gives a delivered item to one owner, real rows first, and keeps it with that owner', () => {
    const owners = new Map<string, string>(), items = [mine('i1', 'Same')], real = [row('q1', 'Same')], pending = [stand(4000, 'Same')];
    const first = matchLandings(items, real, pending, owners);
    expect([...first.rows]).toEqual([['q1', 'i1']]);
    expect(first.pending.size).toBe(0);
    first.rows.forEach((item, id) => owners.set(item, `row:${id}`));
    // The re-read drops the real row; the placeholder still may not take its item.
    expect(matchLandings(items, [], pending, owners).pending.size).toBe(0);
    // Its own delivery lands.
    expect([...matchLandings([...items, mine('i2', 'Same', 300)], [], pending, owners).pending]).toEqual([[4000, 'i2']]);
  });
  it('removes only the first of two identical placeholders for one delivered item, on later renders too', () => {
    const owners = new Map<string, string>(), items = [mine('i1', 'Same')];
    const first = matchLandings(items, [], [stand(4000, 'Same'), stand(4001, 'Same')], owners);
    expect([...first.pending]).toEqual([[4000, 'i1']]);
    first.pending.forEach((item, id) => owners.set(item, `pending:${id}`));
    expect(matchLandings(items, [], [stand(4001, 'Same')], owners).pending.size).toBe(0);
  });
  it('keeps a second identical row that just left the queue when only the first one landed', () => {
    const owners = new Map<string, string>(), items = [mine('i1', 'Same')];
    const first = matchLandings(items, [row('q1', 'Same'), row('q2', 'Same', 150)], [], owners);
    expect([...first.rows]).toEqual([['q1', 'i1']]);
    first.rows.forEach((item, id) => owners.set(item, `row:${id}`));
    // The re-read drops both rows from bb's queue; only q2 moves to leaving, and it may not take q1's item.
    expect(matchLandings(items, [row('q2', 'Same', 150)], [stand(4000, 'Same')], owners).rows.size).toBe(0);
  });
  it('does not match an item that was already in the chat when the placeholder was added', () => {
    expect(matchLandings([mine('i1', 'Same')], [], [stand(4000, 'Same', { seenIds: ['i1'] })], new Map()).pending.size).toBe(0);
  });
});
