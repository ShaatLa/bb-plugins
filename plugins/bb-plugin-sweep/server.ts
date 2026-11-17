import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { deliveryStore } from './delivery.ts';
import { execute } from './runner.ts';

const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
export const configSchema = z.object({ enabled: z.boolean().default(false), remote: z.string().min(1).max(2000).refine(s => !s.startsWith('-')), branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/), script: z.string().min(1).max(1000).refine(s => !s.startsWith('/') && !s.split('/').includes('..')), args: z.array(z.string().max(10000)).max(100).default([]), manager: z.string().regex(/^(thr_[a-z0-9]+)?$/).default(''), intervalMinutes: z.number().int().min(1).max(1440).default(10), timeoutSeconds: z.number().int().min(1).max(300).default(300), snapshots: z.boolean().default(false) }).strict();
export type Config = z.infer<typeof configSchema>;
const projectsSchema = z.record(projectId, configSchema);
const input = z.object({ projectId }).strict();
export const contract = defineRpcContract({
  configure: { input: z.object({ projectId, config: configSchema }).strict(), output: z.unknown() },
  'seed-state': { input: z.object({ projectId, snapshot: z.string().min(1).max(1000000).refine(s => { try { JSON.parse(s); return true; } catch { return false; } }, 'Snapshot must be JSON') }).strict(), output: z.object({ seeded: z.literal(true) }) },
  manager: { input, output: z.object({ manager: z.string().nullable() }) },
  status: { input, output: z.unknown() },
  run: { input, output: z.unknown() },
});
type State = { tickId?: string; deliveredTickId?: string; deliveredTo?: string; lastRun?: number; exitCode?: number; delivered?: string; deliveredAt?: number; heartbeatAt?: number; error?: string | null; alertError?: string | null; nextRun?: number };
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ runtimePath: { type: 'string', label: 'Script PATH (empty inherits server)', default: '' }, bbCli: { type: 'string', label: 'BB CLI absolute path', default: '' }, projects: { type: 'string', label: 'Project sweeps (JSON)', experimental_multiline: true, default: '{}', experimental_schema: z.string().refine(s => { try { return projectsSchema.safeParse(JSON.parse(s)).success; } catch { return false; } }, 'Expected project id → Sweep configuration JSON') } });
  const configs = async () => projectsSchema.parse(JSON.parse((await settings.get()).projects));
  const db = bb.storage.database(), deliveries = deliveryStore(db);
  db.exec('CREATE TABLE IF NOT EXISTS status (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const state = (id: string): State => JSON.parse((db.prepare('SELECT value FROM status WHERE id = ?').get(id) as { value: string } | undefined)?.value ?? '{}');
  const save = (id: string, value: State) => db.prepare('INSERT INTO status VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(id, JSON.stringify(value));
  const status = async (id: string) => ({ projectId: id, config: (await configs())[id] ?? null, ...state(id), pending: deliveries.read(id)?.pending_message ?? null });
  const controller = new AbortController(); bb.onDispose(() => controller.abort());
  const busy = new Set<string>();
  async function managerFor(id: string) {
    const manager = (await configs())[id]?.manager;
    if (!manager) throw new Error('Manager is unset');
    const thread = await bb.sdk.threads.get({ threadId: manager });
    if (!thread || thread.archivedAt) throw new Error('Manager missing or archived');
    return manager;
  }
  async function send(id: string, text: string) {
    const manager = await managerFor(id);
    await bb.sdk.threads.send({ threadId: manager, mode: 'queue-if-active', originPluginId: bb.pluginId, input: [{ type: 'text', text, mentions: [] }] });
    return manager;
  }
  async function deliver(id: string, current: State) {
    const pending = deliveries.read(id)?.pending_message;
    if (!pending) return;
    current.deliveredTo = await send(id, pending);
    current.deliveredTickId = /tick=([^\s]+)/.exec(pending)?.[1];
    current.delivered = pending; current.deliveredAt = Date.now();
    if (pending.startsWith('[sweep] alive')) current.heartbeatAt = Date.now();
    db.transaction(() => { deliveries.acknowledge(id); save(id, current); })();
  }
  async function tick(id: string, manual = false) {
    if (busy.has(id)) throw new Error('Sweep already running');
    busy.add(id);
    const current = state(id);
    let config: Config | undefined;
    try {
      config = (await configs())[id]; if (!config) throw new Error('Project not configured');
      if (!manual) {
        current.tickId = `${id}:${Date.now()}`;
        current.lastRun = Date.now(); current.nextRun = Date.now() + config.intervalMinutes * 60000;
        save(id, current);
        await deliver(id, current);
        await managerFor(id);
      }
      let result;
      try { result = await execute(dirname(db.name), id, config, deliveries.read(id)?.committed ?? null, controller.signal, (await settings.get()).bbCli, (await settings.get()).runtimePath); }
      catch (e) { if (controller.signal.aborted) throw e; result = { code: 2, output: `ERROR ${String(e)}`, snapshot: null }; }
      if (manual) return { exitCode: result.code, output: result.output, manual: true };
      current.exitCode = result.code;
      const heartbeat = !current.heartbeatAt || Date.now() - current.heartbeatAt >= 3600000;
      // Every candidate is delivered in full before promotion, including exit-zero candidates.
      if (result.code || result.snapshot || heartbeat) {
        const message = result.code || result.snapshot ? `[sweep] exit ${result.code} tick=${current.tickId}\n${result.output}` : `[sweep] alive tick=${current.tickId}\n${result.output.split('\n').find(s => s.startsWith('sweep:')) ?? ''}`;
        deliveries.stage(id, message, result.snapshot);
        await deliver(id, current);
      }
      current.error = result.code >= 2 ? result.output : null;
      current.alertError = null;
      save(id, current);
      return await status(id);
    } catch (e) {
      if (!manual && !controller.signal.aborted) {
        current.error = String(e); save(id, current);
        try { await bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'notifications.send', input: { title: 'Sweep manager unreachable', body: `${id}: ${String(e)}` }, outputSchema: z.unknown() }); }
        catch (alert) { current.alertError = String(alert); save(id, current); bb.log.error(`Sweep push failed: ${String(alert)}`); }
      }
      throw e;
    } finally { busy.delete(id); }
  }
  let writes = Promise.resolve();
  const configure = async ({ projectId, config }: { projectId: string; config: Config }) => {
    const operation = writes.then(async () => { if (!(await bb.sdk.projects.list()).some(p => p.id === projectId)) throw new Error('Unknown project'); const projects = await configs(); projects[projectId] = config; await settings.experimental_set({ projects: JSON.stringify(projects) }); });
    writes = operation.catch(() => {}); await operation; if (!busy.has(projectId)) save(projectId, { ...state(projectId), nextRun: Date.now() }); return status(projectId);
  };
  bb.rpc.register(contract, { configure, 'seed-state': async ({ projectId, snapshot }) => { if (busy.has(projectId)) throw new Error('Sweep already running'); const config = (await configs())[projectId]; if (!config) throw new Error('Project not configured'); if (config.enabled) throw new Error('Disable project before seeding'); if (busy.has(projectId)) throw new Error('Sweep already running'); deliveries.seed(projectId, Buffer.from(snapshot)); return { seeded: true as const }; }, manager: async ({ projectId }) => ({ manager: (await configs())[projectId]?.manager || null }), status: ({ projectId }) => status(projectId), run: ({ projectId }) => tick(projectId, true) });
  const runDue = async () => { for (const [id, config] of Object.entries(await configs())) if (config.enabled && !busy.has(id) && (state(id).nextRun ?? 0) <= Date.now()) await tick(id).catch(e => bb.log.error(String(e))); };
  bb.background.schedule('sweep', '* * * * *', runDue);
  // Recover due ticks if the host cron dispatcher stalls; nextRun and busy prevent repeats.
  bb.background.service('due-ticks', { async start(signal) {
    while (!signal.aborted) {
      await runDue();
      try { await delay(30000, undefined, { signal }); } catch { break; }
    }
  } });
  bb.cli.register({ name: 'sweep', summary: 'Read Sweep status, manager or run without advancing state', async run(argv, ctx) {
    try {
      if (!argv.length || argv.includes('--help')) return { exitCode: 0, stdout: 'bb sweep status|manager|run [--project <id>] [--json]. Configure in Settings → Sweep, or RPC configure.' };
      let id = ctx.projectId;
      for (let i = 1; i < argv.length; i++) { if (argv[i] === '--project') id = argv[++i]; else if (argv[i] !== '--json' && argv[i] !== '--dry-run') throw new Error(`Unknown option ${argv[i]}`); }
      if (!id) throw new Error('Supply --project <id>'); projectId.parse(id);
      const result = argv[0] === 'status' ? await status(id) : argv[0] === 'manager' ? { manager: (await configs())[id]?.manager || null } : argv[0] === 'run' ? await tick(id, true) : (() => { throw new Error('Use status, manager or run'); })();
      return { exitCode: 0, stdout: JSON.stringify(result) };
    } catch (e) { return { exitCode: 1, stderr: String(e) }; }
  } });
}
