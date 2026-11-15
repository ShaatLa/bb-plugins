import { cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { rangeSchema, type Cost } from './contract.js';
import type { registerRpc } from './rpc.js';

export function registerCli(bb: BbPluginApi, api: Pick<ReturnType<typeof registerRpc>, 'status' | 'summary'>) {
  const money = (c: Cost) => `${c.usd === null ? '?' : '$'+c.usd.toFixed(4)}${c.partial ? ' (partial)' : ''}${c.estimated ? ' ~' : ''}`;
  const clean = (s: string) => s.replace(/\s+/g,' ').slice(0,160);
  bb.cli.register(defineCli({ name: 'tokenomos', summary: 'Token usage and API-equivalent costs', commands: {
    status: cliCommand({ summary: 'Sources and storage status', options: { json: { type: 'boolean', description: 'Return JSON' } }, async run(i) {
      const r = await api.status({});
      return { exitCode: 0, stdout: i.options.json ? JSON.stringify(r) : [`Disk: ${r.disk.bytes} bytes; degraded threads: ${r.degradedThreads}`, ...(r.loop ? [`Event loop (last minute): p99 ${r.loop.p99Ms.toFixed(1)} ms; max ${r.loop.maxMs.toFixed(1)} ms`] : []), ...r.sources.slice(0,50).map(s => `${clean(s.id)}: ${s.rows} rows; ${clean(s.state)}; last ingest ${s.lastIngestAt === null ? 'never' : new Date(s.lastIngestAt).toISOString()}`)].join('\n') };
    } }),
    summary: cliCommand({ summary: 'Costs by provider and model', options: { range: { type: 'enum', values: rangeSchema.options, description: 'Time range (default: week)' }, json: { type: 'boolean', description: 'Return JSON' } }, async run(i) {
      const range = i.options.range ?? 'week';
      const providers = await api.summary({ range,by: 'provider' }), models = await api.summary({ range,by: 'model' });
      return { exitCode: 0, stdout: i.options.json ? JSON.stringify({ providers,models }) : [`${range}: ${money(providers.totals)}`, 'Providers:', ...providers.breakdown.slice(0,48).map(b => `${clean(b.key)}: ${money(b.cost)}; ${b.calls} calls`), 'Models:', ...models.breakdown.map(b => `${clean(b.key)}: ${money(b.cost)}; ${b.calls} calls`)].join('\n') };
    } }),
  } }));
}
