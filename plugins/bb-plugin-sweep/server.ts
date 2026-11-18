import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { deliveryStore } from './delivery.ts';
import { historyDays, sweepHistory } from './history.ts';
import { formatNotification } from './notification.ts';
import { reportContents } from './reports.ts';
import { CheckoutRefreshError, execute } from './runner.ts';

const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
export const configSchema = z.object({ enabled: z.boolean().default(false), remote: z.string().min(1).max(2000).refine(s => !s.startsWith('-')), branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/), script: z.string().min(1).max(1000).refine(s => !s.startsWith('/') && !s.split('/').includes('..')), args: z.array(z.string().max(10000)).max(100).default([]), manager: z.string().regex(/^(thr_[a-z0-9]+)?$/).default(''), intervalMinutes: z.number().int().min(1).max(1440).default(10), timeoutSeconds: z.number().int().min(1).max(300).default(300), snapshots: z.boolean().default(false) }).strict();
export type Config = z.infer<typeof configSchema>;
const projectDraft = configSchema.partial().refine(config => !config.enabled || configSchema.safeParse(config).success, 'Complete the checkout settings before enabling Sweep');
const projectsSchema = z.record(projectId, projectDraft);
const input = z.object({ projectId }).strict();
const configKey = configSchema.keyof();
const configGetInput = input.extend({ key: configKey.optional() });
const configSetInput = input.extend({ key: configKey, value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]) });
const statsInput = input.extend({ days: z.number().int().min(1).max(historyDays).default(1) });
export const contract = defineRpcContract({
  'settings.read': { input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), config: configSchema.nullable() })), threads: z.array(z.object({ id: z.string(), title: z.string(), projectId: z.string() })), environment: z.object({ bbCli: z.string(), runtimePath: z.string() }) }) },
  'environment.write': { input: z.object({ bbCli: z.string(), runtimePath: z.string() }).strict(), output: z.unknown() },
  configure: { input: z.object({ projectId, config: configSchema }).strict(), output: z.unknown() },
  'config.get': { input: configGetInput, output: z.unknown() },
  'config.set': { input: configSetInput, output: z.unknown() },
  stats: { input: statsInput, output: z.unknown() },
  'seed-state': { input: z.object({ projectId, snapshot: z.string().min(1).max(1000000).refine(s => { try { JSON.parse(s); return true; } catch { return false; } }, 'Snapshot must be JSON') }).strict(), output: z.object({ seeded: z.literal(true) }) },
  manager: { input, output: z.object({ manager: z.string().nullable() }) },
  status: { input, output: z.unknown() },
  run: { input, output: z.unknown() },
});
type State = { tickId?: string; deliveredTickId?: string; deliveredTo?: string; deliveredNoticeId?: string; fallbackReason?: string; lastRun?: number; exitCode?: number | null; delivered?: string; deliveredAt?: number; heartbeatAt?: number; error?: string | null; managerError?: string | null; alertError?: string | null; nextRun?: number; refreshFailures?: number; refreshRetryAt?: number; lastReport?: { fingerprint: string; at: number; manager?: string } };
const noticeReceipt = z.object({ id: z.string().min(1), created: z.boolean() });
const reminderMs = 3600000;
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ runtimePath: { type: 'string', label: 'Script PATH (empty inherits server)', default: '' }, bbCli: { type: 'string', label: 'BB CLI absolute path', default: '' }, projects: { type: 'string', label: 'Project sweeps (JSON)', experimental_multiline: true, default: '{}', experimental_schema: z.string().refine(s => { try { return projectsSchema.safeParse(JSON.parse(s)).success; } catch { return false; } }, 'Expected project id → Sweep configuration JSON') } });
  const drafts = async () => projectsSchema.parse(JSON.parse((await settings.get()).projects));
  const configs = async () => {
    const configs: Record<string, Config> = {};
    for (const [id, draft] of Object.entries(await drafts())) {
      const parsed = configSchema.safeParse(draft);
      if (parsed.success) configs[id] = parsed.data;
    }
    return configs;
  };
  const db = bb.storage.database(), deliveries = deliveryStore(db);
  const history = sweepHistory(db);
  db.exec('CREATE TABLE IF NOT EXISTS status (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const state = (id: string): State => JSON.parse((db.prepare('SELECT value FROM status WHERE id = ?').get(id) as { value: string } | undefined)?.value ?? '{}');
  const save = (id: string, value: State) => db.prepare('INSERT INTO status VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(id, JSON.stringify(value));
  const status = async (id: string) => { const config = (await configs())[id] ?? null, current = state(id); return { projectId: id, config, ...current, nextRun: config?.enabled ? current.nextRun ?? Date.now() : null, pending: deliveries.read(id)?.pending_message ?? null }; };
  const controller = new AbortController(); bb.onDispose(() => controller.abort());
  const busy = new Set<string>();
  async function managerFor(manager: string | undefined) {
    if (!manager) throw new Error('Manager is unset');
    const thread = await bb.sdk.threads.get({ threadId: manager });
    if (!thread || thread.archivedAt || thread.deletedAt) throw new Error('Manager missing, archived or deleted');
    if (thread.status === 'error' || thread.runtime.displayStatus === 'error') throw new Error('Manager thread failed');
    if (thread.runtime.displayStatus === 'waiting-for-host') throw new Error('Manager host unreachable');
    return manager;
  }
  async function deliver(id: string, current: State, tickId: string) {
    const pending = deliveries.read(id)?.pending_message;
    if (!pending) return;
    const header = /^\[sweep\] (alive|exit (\d+))(?: tick=(\S+))?\n/.exec(pending);
    const heartbeat = header?.[1] === 'alive';
    const code = Number(header?.[2]);
    const output = header ? pending.slice(header[0].length) : pending;
    const message = header ? formatNotification(heartbeat ? 'alive' : code, output) : pending;
    const manager = (await configs())[id]?.manager;
    try {
      const threadId = await managerFor(manager);
      await bb.sdk.threads.send({ threadId, mode: 'queue-if-active', originPluginId: bb.pluginId, input: [{ type: 'text', text: message, mentions: [] }] });
      current.deliveredTo = threadId;
      current.deliveredNoticeId = undefined;
      current.fallbackReason = undefined;
      current.managerError = null;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      current.managerError = String(error);
      // Older pending reports did not carry a tick ID. Derive a stable key for their retries.
      const tickId = header?.[3] ?? `${id}:legacy:${createHash('sha256').update(pending).digest('hex')}`;
      const notice = await bb.sdk.plugins.callRpc({
        pluginId: 'answers', method: 'notice', signal: controller.signal, outputSchema: noticeReceipt,
        input: {
          source: bb.pluginId, tickId, projectId: id, ...(manager ? { threadId: manager } : {}),
          title: 'Sweep report · Manager unavailable',
          markdown: Buffer.byteLength(message) <= 1024 * 1024 ? message : pending,
        },
      }).catch(cause => {
        if (!controller.signal.aborted) history.deliveryFailed(tickId);
        throw new Error(`Answers fallback failed after ${current.managerError}: ${String(cause)}`, { cause });
      });
      current.deliveredTo = 'answers';
      current.deliveredNoticeId = notice.id;
      current.fallbackReason = current.managerError;
    }
    current.deliveredTickId = header?.[3];
    current.delivered = pending; current.deliveredAt = Date.now();
    current.error = code >= 2 ? output : null;
    current.alertError = null;
    if (heartbeat) current.heartbeatAt = current.deliveredAt;
    else if (header) current.lastReport = { fingerprint: reportContents(code, output).fingerprint, at: current.deliveredAt, manager };
    db.transaction(() => {
      deliveries.acknowledge(id);
      history.delivered(tickId, current.deliveredTo === 'answers');
      save(id, current);
    })();
  }
  async function tick(id: string, manual = false) {
    if (busy.has(id)) throw new Error('Sweep already running');
    busy.add(id);
    const current = state(id);
    let config: Config | undefined;
    try {
      config = (await configs())[id]; if (!config) throw new Error('Project not configured');
      const now = Date.now(), interval = config.intervalMinutes * 60000;
      const timestamp = Math.max(now, (Number(current.tickId?.split(':')[1]) || 0) + 1);
      const tickId = `${id}:${timestamp}`;
      if (!manual) {
        current.tickId = tickId;
        current.lastRun = now;
        current.nextRun = now + interval;
        db.transaction(() => { history.start(id, tickId, now); save(id, current); })();
        await deliver(id, current, tickId);
        if (current.refreshRetryAt && current.refreshRetryAt > Date.now()) {
          current.nextRun = current.refreshRetryAt;
          save(id, current);
          return status(id);
        }
      }
      const committed = deliveries.read(id)?.committed ?? null;
      let result;
      let refreshFailed = false;
      try { result = await execute(dirname(db.name), id, config, committed, controller.signal, (await settings.get()).bbCli, (await settings.get()).runtimePath); }
      catch (e) {
        if (controller.signal.aborted) throw e;
        refreshFailed = e instanceof CheckoutRefreshError;
        result = { code: 2, output: `ERROR ${String(e)}`, snapshot: null };
      }
      if (manual) return { exitCode: result.code, output: result.output, manual: true };
      current.exitCode = result.code;
      current.refreshFailures = refreshFailed ? (current.refreshFailures ?? 0) + 1 : 0;
      current.refreshRetryAt = refreshFailed
        ? Date.now() + Math.min(interval * 2 ** Math.min(current.refreshFailures - 1, 6), Math.max(interval, reminderMs))
        : undefined;
      const report = reportContents(result.code, result.output);
      history.result(id, tickId, now, report.items, refreshFailed ? 'refresh' : result.code >= 2 ? 'script' : undefined);
      const actionable = result.code !== 0 || result.snapshot !== null;
      const candidateChanged = result.snapshot !== null && (!committed || !result.snapshot.equals(committed));
      const answerWithoutCandidate = config.snapshots && result.snapshot === null && [...report.items.values()].includes('ANSWER');
      const lastReport = current.lastReport;
      const repeated = actionable && !candidateChanged && !answerWithoutCandidate
        && lastReport?.fingerprint === report.fingerprint && lastReport.manager === config.manager;
      const suppressed = repeated && lastReport && Date.now() - lastReport.at < reminderMs;
      const heartbeat = !actionable && (!current.heartbeatAt || Date.now() - current.heartbeatAt >= reminderMs);
      if (suppressed) history.disposition(tickId, 'suppress');
      else if (actionable || heartbeat) {
        const message = actionable ? `[sweep] exit ${result.code} tick=${tickId}\n${result.output}` : `[sweep] alive tick=${tickId}\n${result.output.split('\n').find(s => s.startsWith('sweep:')) ?? ''}`;
        db.transaction(() => {
          if (repeated) history.disposition(tickId, 'remind');
          deliveries.stage(id, message, result.snapshot);
          save(id, current);
        })();
        await deliver(id, current, tickId);
      }
      if (current.refreshRetryAt) current.nextRun = current.refreshRetryAt;
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
  async function writeConfig(id: string, edit: (config: Partial<Config> | undefined) => Partial<Config>) {
    const operation = writes.then(async () => {
      if (!(await bb.sdk.projects.list()).some(p => p.id === id)) throw new Error('Unknown project');
      const projects = await drafts();
      const previous = projects[id];
      const config = edit(previous);
      projects[id] = config;
      await settings.experimental_set({ projects: JSON.stringify(projects) });
      if (!busy.has(id)) {
        const current = state(id);
        if (previous?.remote !== config.remote || previous?.branch !== config.branch) {
          current.refreshFailures = 0;
          current.refreshRetryAt = undefined;
        }
        save(id, { ...current, nextRun: Date.now() });
      }
      return config;
    });
    writes = operation.then(() => {}, () => {});
    return operation;
  }
  const configure = async ({ projectId, config }: { projectId: string; config: Config }) => {
    await writeConfig(projectId, () => config);
    return status(projectId);
  };
  const configGet = async ({ projectId, key }: z.infer<typeof configGetInput>) => {
    const config = (await drafts())[projectId];
    return key ? { [key]: config?.[key] ?? null } : config ?? null;
  };
  const configSet = async ({ projectId, key, value }: z.infer<typeof configSetInput>) => {
    const parsed = configSchema.shape[key].safeParse(value);
    if (!parsed.success) throw new Error(`Invalid ${key}: ${parsed.error.issues[0].message}`);
    const config = await writeConfig(projectId, current => {
      const next = { ...current, [key]: parsed.data };
      return next.enabled ? configSchema.parse(next) : next;
    });
    return { [key]: config[key] };
  };
  bb.rpc.register(contract, { 'settings.read': async () => { const values = await settings.get(), projects = await configs(); return { projects: (await bb.sdk.projects.list()).map(p => ({ id: p.id, name: p.name, config: projects[p.id] ?? null })), threads: (await bb.sdk.threads.list({ limit: 100, archived: false })).map(t => ({ id: t.id, title: t.title || t.id, projectId: t.projectId })), environment: { bbCli: values.bbCli, runtimePath: values.runtimePath } }; }, 'environment.write': async values => settings.experimental_set(values), configure, 'config.get': configGet, 'config.set': configSet, stats: ({ projectId, days }) => history.stats(projectId, days), 'seed-state': async ({ projectId, snapshot }) => { if (busy.has(projectId)) throw new Error('Sweep already running'); const config = (await configs())[projectId]; if (!config) throw new Error('Project not configured'); if (config.enabled) throw new Error('Disable project before seeding'); if (busy.has(projectId)) throw new Error('Sweep already running'); deliveries.seed(projectId, Buffer.from(snapshot)); return { seeded: true as const }; }, manager: async ({ projectId }) => ({ manager: (await configs())[projectId]?.manager || null }), status: ({ projectId }) => status(projectId), run: ({ projectId }) => tick(projectId, true) });
  const runDue = async () => { for (const [id, config] of Object.entries(await configs())) if (config.enabled && !busy.has(id) && (state(id).nextRun ?? 0) <= Date.now()) await tick(id).catch(e => bb.log.error(String(e))); };
  bb.background.schedule('sweep', '* * * * *', runDue);
  // Recover due ticks if the host cron dispatcher stalls; nextRun and busy prevent repeats.
  bb.background.service('due-ticks', { async start(signal) {
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (signal.aborted) return;
      while (!signal.aborted) {
        await runDue();
        try { await delay(30000, undefined, { signal }); } catch { break; }
      }
    } finally { signal.removeEventListener('abort', abort); }
  } });
  bb.cli.register({ name: 'sweep', summary: 'Read Sweep status, configure a project, report stats, or run manually', async run(argv, ctx) {
    try {
      if (!argv.length || argv.includes('--help')) return { exitCode: 0, stdout: 'bb sweep status|manager|run [--project <id>] [--json]\nbb sweep config get [<key>] | config set <key> <value> [--project <id>]\nbb sweep stats [--days <1-30>] [--project <id>]' };
      let id = ctx.projectId;
      const [command, ...args] = argv;
      const positional: string[] = [];
      let days: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--project') id = args[++i];
        else if (arg === '--days' && command === 'stats') days = Number(args[++i]);
        else if (arg === '--json' || arg === '--dry-run') continue;
        else if (command === 'config') positional.push(arg);
        else throw new Error(`Unknown option ${arg}`);
      }
      if (!id) throw new Error('Supply --project <id>'); projectId.parse(id);
      let result;
      switch (command) {
        case 'status': result = await status(id); break;
        case 'manager': result = { manager: (await configs())[id]?.manager || null }; break;
        case 'run': result = await tick(id, true); break;
        case 'stats': result = history.stats(id, statsInput.parse({ projectId: id, days }).days); break;
        case 'config': {
          const [operation, field, raw] = positional;
          if (operation === 'get' && positional.length <= 2) {
            result = await configGet(configGetInput.parse({ projectId: id, key: field }));
            break;
          }
          if (operation !== 'set' || positional.length !== 3) throw new Error('Use config get [<key>] or config set <key> <value>');
          const key = configKey.parse(field);
          let value: unknown = raw;
          if (!configSchema.shape[key].safeParse(raw).success) {
            try { value = JSON.parse(raw); } catch { /* Validation will name the field. */ }
          }
          result = await configSet(configSetInput.parse({ projectId: id, key, value }));
          break;
        }
        default: throw new Error('Use status, manager, run, config or stats');
      }
      return { exitCode: 0, stdout: JSON.stringify(result) };
    } catch (e) { return { exitCode: 1, stderr: String(e) }; }
  } });
}
