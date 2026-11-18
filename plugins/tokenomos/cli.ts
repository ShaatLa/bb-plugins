import { cliCommand, defineCli, type BbPluginApi } from '@get-bb/plugin-sdk';
import { rangeSchema, type Cost } from './contract.js';
import type { registerRpc } from './rpc.js';

export function registerCli(bb: BbPluginApi, api: Pick<ReturnType<typeof registerRpc>, 'status' | 'summary' | 'wakeCost'>) {
  const money = (c: Cost) => `${c.usd === null ? '?' : '$'+c.usd.toFixed(4)}${c.partial ? ' (partial)' : ''}${c.estimated ? ' ~' : ''}`;
  const clean = (s: string) => s.replace(/\s+/g,' ').slice(0,160);
  bb.cli.register(defineCli({ name: 'tokenomos', summary: 'Token usage and API-equivalent costs', commands: {
    'wake-cost': cliCommand({summary:'Estimate the cost of waking an idle thread',positionals:[{name:'threadId',description:'BB thread id',required:true}],options:{json:{type:'boolean',description:'Return JSON'}},async run(i){
      const r=await api.wakeCost({threadId:i.positionals.threadId as string});
      const unknown=r.contextTokens===null;
      return {exitCode:0,stdout:i.options.json?JSON.stringify(r):`${clean(r.threadId)}: ${unknown?'unknown context':`${r.contextTokens} tokens; estimated cold ${r.coldCostUsd===null?'?':'$'+r.coldCostUsd.toFixed(4)}; warm ${r.warmCostUsd===null?'?':'$'+r.warmCostUsd.toFixed(4)}`}\nTTL: ${r.ttlMinutes} min (${r.ttlSource}${r.ttlSource==='assumed'?', estimate':''}); cache ${r.cacheLikelyExpired===null?'unknown':r.cacheLikelyExpired?'likely expired':'likely warm'}`};
    }}),
    status: cliCommand({ summary: 'Sources and storage status', options: { json: { type: 'boolean', description: 'Return JSON' } }, async run(i) {
      const r = await api.status({});
      return { exitCode: 0, stdout: i.options.json ? JSON.stringify(r) : [`Backfill: ${r.backfill.processedThreads}/${r.backfill.totalThreads} threads; ${r.backfill.done ? 'complete' : 'history is loading, numbers are incomplete'}`, `Disk: ${r.disk.bytes} bytes; degraded threads: ${r.degradedThreads}`, ...(r.loop ? [`Event loop (last minute): p99 ${r.loop.p99Ms.toFixed(1)} ms; max ${r.loop.maxMs.toFixed(1)} ms`] : []), ...r.sources.slice(0,50).map(s => `${clean(s.id)}: ${s.rows} rows; ${clean(s.state)}; last ingest ${s.lastIngestAt === null ? 'never' : new Date(s.lastIngestAt).toISOString()}`)].join('\n') };
    } }),
    summary: cliCommand({ summary: 'Costs by provider and model', options: { range: { type: 'enum', values: rangeSchema.options, description: 'Time range (default: week)' }, json: { type: 'boolean', description: 'Return JSON' } }, async run(i) {
      const range = i.options.range ?? 'week';
      const providers = await api.summary({ range,by: 'provider' }), models = await api.summary({ range,by: 'model' });
      return { exitCode: 0, stdout: i.options.json ? JSON.stringify({ providers,models }) : [`${range}: ${money(providers.totals)}`, 'Providers:', ...providers.breakdown.slice(0,48).map(b => `${clean(b.key)}: ${money(b.cost)}; ${b.calls} calls`), 'Models:', ...models.breakdown.map(b => `${clean(b.key)}: ${money(b.cost)}; ${b.calls} calls`)].join('\n') };
    } }),
  } }));
}
