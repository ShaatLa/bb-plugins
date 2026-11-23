import { describe, expect, it } from 'vitest';
import { collectLimits, createLimitCollector } from './usage-limits.js';

const week = (usedPercent: number) => ({ kind: 'weekly', id: '0:Weekly', label: 'Weekly limit', usedPercent, resetsAt: '2026-11-25T01:00:00.000Z', model: null });
const usage = (accountKey: string | null, windows: unknown[]) => ({ accountKey, observedAt: 5, usage: { status: 'ok', planLabel: 'Max', windows } });

describe('collectLimits', () => {
  it('reads provider plugins first, keeps an account once by its key and never merges unknown keys', async () => {
    const plugins: Record<string, { list: unknown; get: Record<string, unknown> }> = {
      'account-pool': { list: { resources: [{ id: 'p1', providerId: 'claude-code', label: 'pooled', accountKey: 'acct-a' }, { id: 'p2', providerId: 'codex', label: 'pooled codex', accountKey: null }] },
        get: { p1: usage('acct-a', [week(99)]), p2: usage(null, [week(7)]) } },
      'provider-claude-code': { list: { resources: [{ id: 'r1', providerId: 'claude-code', label: 'Claude Code', accountKey: 'acct-a' }] }, get: { r1: usage('acct-a', [week(12)]) } },
      'provider-codex': { list: { resources: [{ id: 'r2', providerId: 'codex', label: 'Codex', accountKey: null }] }, get: { r2: usage(null, [week(100)]) } },
      tokenomos: { list: { resources: [] }, get: {} },
    };
    const calls: string[] = [];
    const accounts = (await collectLimits(
      async () => Object.keys(plugins).map(pluginId => ({ pluginId })),
      async (pluginId, method, input) => {
        calls.push(`${pluginId} ${method}`);
        return method.endsWith('listResources') ? plugins[pluginId]!.list : plugins[pluginId]!.get[(input as { resourceId: string }).resourceId];
      },
      'tokenomos',
    )).map(r => r.account);
    expect(accounts.map(a => [a.label, a.windows[0]?.usedPercent])).toEqual([['Claude Code', 12], ['Codex', 100], ['pooled codex', 7]]);
    expect(accounts[0]).toMatchObject({ providerId: 'claude-code', plan: 'Max', status: 'ok', observedAt: 5 });
    expect(accounts[0]!.windows[0]).toEqual({ id: '0:Weekly', label: 'Weekly limit', kind: 'weekly', usedPercent: 12, resetsAt: Date.UTC(2026, 10, 25, 1), model: null });
    expect(calls.some(c => c.startsWith('tokenomos'))).toBe(false);
  });

  it('reports a failing resource as an error and skips a plugin whose inventory is malformed', async () => {
    const accounts = (await collectLimits(
      async () => [{ pluginId: 'provider-a' }, { pluginId: 'provider-b' }],
      async (pluginId, method) => {
        if (pluginId === 'provider-b') return { resources: 'nope' };
        if (method.endsWith('listResources')) return { resources: [{ id: 'x', providerId: 'a', label: 'A' }] };
        throw new Error('offline');
      },
      'tokenomos',
    )).map(r => r.account);
    expect(accounts).toEqual([{ providerId: 'a', label: 'A', plan: null, status: 'error', message: 'offline', observedAt: null, windows: [] }]);
  });

  it('takes a failed provider plugin\'s account from an aggregator, and shows the last good numbers when both fail', async () => {
    let up = { provider: false, pool: true };
    const discover = async () => [{ pluginId: 'provider-claude-code' }, { pluginId: 'account-pool' }];
    const callRpc = async (pluginId: string, method: string) => {
      const pool = pluginId === 'account-pool';
      if (method.endsWith('listResources')) return { resources: [{ id: 'r', providerId: 'claude-code', label: pool ? 'pooled' : 'Claude Code', accountKey: 'acct' }] };
      if (!(pool ? up.pool : up.provider)) throw new Error('The operation was aborted due to timeout');
      return usage('acct', [week(pool ? 13 : 14)]);
    };
    const collect = createLimitCollector(discover, callRpc, 'tokenomos');
    expect((await collect(1000)).map(a => [a.label, a.status, a.windows[0]?.usedPercent, a.stale])).toEqual([['Claude Code', 'ok', 13, undefined]]);
    up = { provider: false, pool: false };
    expect(await collect(2000)).toEqual([expect.objectContaining({ label: 'Claude Code', status: 'ok', stale: true, message: 'The operation was aborted due to timeout', windows: [expect.objectContaining({ usedPercent: 13 })] })]);
    up = { provider: true, pool: true };
    expect((await collect(3000))[0]).toMatchObject({ windows: [{ usedPercent: 14 }] });
    expect((await collect(3000))[0]!.stale).toBeUndefined();
  });

  it('still merges a failed provider account into the aggregator\'s when the provider stops listing its key', async () => {
    let cold = false;
    const discover = async () => [{ pluginId: 'provider-claude-code' }, { pluginId: 'account-pool' }];
    const callRpc = async (pluginId: string, method: string) => {
      const pool = pluginId === 'account-pool';
      if (method.endsWith('listResources')) return { resources: [{ id: 'r', providerId: 'claude-code', label: pool ? 'pooled' : 'Claude Code', accountKey: pool || !cold ? 'acct' : null }] };
      if (cold && !pool) throw new Error('The operation was aborted due to timeout');
      return usage('acct', [week(pool ? 13 : 14)]);
    };
    const collect = createLimitCollector(discover, callRpc, 'tokenomos');
    await collect(1000);
    cold = true;
    expect((await collect(2000)).map(a => [a.label, a.status, a.windows[0]?.usedPercent])).toEqual([['Claude Code', 'ok', 13]]);
  });

  it('falls back to the last good report kept from before a restart, even when the cold source lists no key', async () => {
    let up = true;
    const discover = async () => [{ pluginId: 'provider-claude-code' }];
    const callRpc = async (_: string, method: string) => {
      if (method.endsWith('listResources')) return { resources: [{ id: 'r', providerId: 'claude-code', label: 'Claude Code', accountKey: up ? 'acct' : null }] };
      if (!up) throw new Error('The operation was aborted due to timeout');
      return usage('acct', [week(21)]);
    };
    const before = createLimitCollector(discover, callRpc, 'tokenomos');
    await before(1000);
    up = false;
    const after = createLimitCollector(discover, callRpc, 'tokenomos', 8000, JSON.parse(JSON.stringify(before.state())));
    expect((await after(2000)).map(a => [a.label, a.stale, a.windows[0]?.usedPercent])).toEqual([['Claude Code', true, 21]]);
  });

  it('keeps a window a successful report leaves out, marked stale, until it resets', async () => {
    const fable = { kind: 'weekly', id: '1:Fable', label: 'Fable', usedPercent: 4, resetsAt: '2026-11-25T01:00:00.000Z', model: 'fable' };
    let windows: unknown[] = [week(10), fable];
    const callRpc = async (_: string, method: string) => method.endsWith('listResources')
      ? { resources: [{ id: 'r', providerId: 'claude-code', label: 'Claude Code', accountKey: 'acct' }] } : usage('acct', windows);
    const collect = createLimitCollector(async () => [{ pluginId: 'provider-claude-code' }], callRpc, 'tokenomos');
    await collect(1000);
    windows = [week(11)];
    expect((await collect(2000))[0]!.windows.map(w => [w.label, w.usedPercent, w.stale, w.seenAt])).toEqual([['Weekly limit', 11, undefined, undefined], ['Fable', 4, true, 1000]]);
    // Another source names the same window differently: it replaces the kept one, capitalized.
    windows = [week(11), { ...fable, id: 'weekly:fable', label: 'Weekly · fable', usedPercent: 5 }];
    expect((await collect(2500))[0]!.windows.map(w => [w.label, w.usedPercent, w.stale])).toEqual([['Weekly limit', 11, undefined], ['Weekly · Fable', 5, undefined]]);
    windows = [week(11)];
    expect((await collect(Date.parse('2026-11-25T02:00:00.000Z')))[0]!.windows.map(w => w.label)).toEqual(['Weekly limit']);
  });
});
