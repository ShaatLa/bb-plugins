import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { deliveryStore } from './delivery';

const configSchema = z.object({ remote: z.string().min(1), branch: z.string().min(1), script: z.string().min(1), args: z.array(z.string()), manager: z.string(), intervalMinutes: z.number().int().min(1).max(1440).default(10), snapshots: z.boolean().default(false) }).strict();
const projectSchema = z.object({ projectId: z.string().regex(/^proj_[a-z0-9]+$/) });
const contract = defineRpcContract({
  configure: { input: projectSchema.extend({ config: configSchema }), output: z.unknown() },
  manager: { input: projectSchema, output: z.unknown() },
  status: { input: projectSchema, output: z.unknown() },
  run: { input: projectSchema, output: z.unknown() },
});
const exec = promisify(execFile);
export default async function plugin(bb: BbPluginApi) {
  const db = bb.storage.database(), deliveries = deliveryStore(db);
  db.exec('CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, config TEXT NOT NULL, status TEXT NOT NULL DEFAULT "{}")');
  const get = (id: string) => db.prepare('SELECT config, status FROM projects WHERE id = ?').get(id) as { config: string; status: string } | undefined;
  const status = (id: string) => { const row = get(id); return row ? { config: JSON.parse(row.config), ...JSON.parse(row.status), pending: !!deliveries.read(id)?.pending_message } : null; };
  const saveStatus = (id: string, value: object) => db.prepare('UPDATE projects SET status = ? WHERE id = ?').run(JSON.stringify(value), id);
  const busy = new Set<string>();
  async function run(id: string, manual = false) {
    if (busy.has(id)) throw new Error('Sweep already running');
    const row = get(id); if (!row) throw new Error('Project not configured');
    const config = configSchema.parse(JSON.parse(row.config));
    busy.add(id);
    let state = JSON.parse(row.status), temp = '';
    const started = Date.now();
    try {
      const manager = await bb.sdk.threads.get({ threadId: config.manager });
      if (!manager || manager.archivedAt || manager.projectId !== id) throw new Error('Manager missing, archived, or belongs to another project');
      const send = async (message: string) => { await bb.sdk.threads.send({ threadId: config.manager, mode: 'queue-if-active', originPluginId: bb.pluginId, input: [{ type: 'text', text: message, mentions: [] }] }); };
      if (!manual && deliveries.read(id)?.pending_message) {
        await send(deliveries.read(id)!.pending_message!);
        deliveries.acknowledge(id);
      }
      const root = join(dirname(db.name), 'checkouts', id);
      await mkdir(root, { recursive: true });
      const git = (args: string[]) => exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, timeout: 60000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
      try { await git(['rev-parse', '--git-dir']); } catch { await git(['init']); }
      await git(['fetch', '--depth=1', '--', config.remote, config.branch]);
      await git(['checkout', '--force', '--detach', 'FETCH_HEAD']);
      const script = join(root, config.script), rel = relative(root, script);
      if (isAbsolute(config.script) || rel.startsWith('..')) throw new Error('Script must be inside checkout');
      temp = await mkdtemp(join(dirname(db.name), 'sweep-'));
      const committed = join(temp, 'committed.json'), candidate = join(temp, 'candidate.json');
      const previous = deliveries.read(id)?.committed; if (previous) await writeFile(committed, previous);
      let code = 0, output = '';
      try { const result = await exec('python3', [script, ...config.args, ...(config.snapshots ? ['--committed-state', committed, '--candidate-snapshot', candidate] : [])], { cwd: root, timeout: 300000, maxBuffer: 1024 * 1024 }); output = result.stdout + result.stderr; }
      catch (error) { const e = error as Error & { code?: number; stdout?: string; stderr?: string }; if (typeof e.code !== 'number') throw e; code = e.code; output = (e.stdout ?? '') + (e.stderr ?? ''); }
      const heartbeat = !state.heartbeatAt || started - state.heartbeatAt >= 3600000;
      const message = code ? `[sweep] exit ${code}\n${output}` : `[sweep] alive\n${output.split('\n').find(line => line.startsWith('sweep:')) ?? ''}`;
      let delivered = '';
      if (!manual && (code !== 0 || heartbeat)) {
        let snapshot: Buffer | null = null; if (config.snapshots) { try { snapshot = await readFile(candidate); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; } }
        deliveries.stage(id, message, snapshot);
        await send(message); deliveries.acknowledge(id); delivered = message;
        if (!code) state.heartbeatAt = started;
      }
      state = { ...state, lastRun: started, exitCode: code, delivered, error: null, nextRun: started + config.intervalMinutes * 60000 };
      if (!manual) saveStatus(id, state);
      return { ...state, output };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      if (!manual) { saveStatus(id, { ...state, lastRun: started, error, nextRun: started + config.intervalMinutes * 60000 });
        try { await bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'notifications.send', input: { title: 'Sweep failed', body: `${id}: ${error}` }, outputSchema: z.unknown() }); } catch (alert) { bb.log.error(`Sweep notification failed: ${String(alert)}`); }
      }
      throw e;
    } finally { if (temp) await rm(temp, { recursive: true, force: true }); busy.delete(id); }
  }
  const handlers = {
    configure: async ({ projectId, config }: z.infer<typeof projectSchema> & { config: z.infer<typeof configSchema> }) => { if (!(await bb.sdk.projects.list()).some(p => p.id === projectId)) throw new Error('Unknown project'); db.prepare('INSERT INTO projects (id, config) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config').run(projectId, JSON.stringify(config)); return status(projectId); },
    manager: async ({ projectId }: z.infer<typeof projectSchema>) => ({ manager: status(projectId)?.config.manager ?? null }),
    status: async ({ projectId }: z.infer<typeof projectSchema>) => status(projectId),
    run: async ({ projectId }: z.infer<typeof projectSchema>) => run(projectId, true),
  };
  bb.rpc.register(contract, handlers);
  bb.background.schedule('sweep', '* * * * *', async () => { for (const row of db.prepare('SELECT id, status FROM projects').all() as { id: string; status: string }[]) { if ((JSON.parse(row.status).nextRun ?? 0) <= Date.now()) await run(row.id).catch(e => bb.log.error(String(e))); } });
  bb.cli.register({ name: 'sweep', summary: 'Sweep status and project manager', async run(argv, ctx) { try { const id = argv[1] ?? ctx.projectId; if (!id) throw new Error('Supply project id'); const result = argv[0] === 'status' ? await handlers.status({ projectId: id }) : argv[0] === 'manager' ? await handlers.manager({ projectId: id }) : argv[0] === 'run' ? await run(id, true) : (() => { throw new Error('Use status, manager or run'); })(); return { exitCode: 0, stdout: JSON.stringify(result) }; } catch (e) { return { exitCode: 1, stderr: String(e) }; } } });
}
