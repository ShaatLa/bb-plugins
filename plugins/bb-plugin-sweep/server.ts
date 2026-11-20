import { defineRpcContract, type BbPluginApi } from '@get-bb/plugin-sdk';
import { z } from 'zod';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { attentionObservations, attentionStore, type ShadowRun } from './attention.ts';
import { scanArchivedWorktrees } from './archived-worktrees.ts';
import { deliveryStore } from './delivery.ts';
import { sendOrAppend } from './queued-notice.ts';
import { sweepHistory } from './history.ts';
import { formatNotification } from './notification.ts';
import { managerTag, overviewContract, projectId, projectInput as input, projectsTag, statsInput, statsTag } from './overview-contract.ts';
import { reportContents } from './reports.ts';
import { CheckoutRefreshError, execute } from './runner.ts';
import { chunkOutput, incomingStore, ownershipOutput, pullBytes, readChunk, sha256, transferDocument, type TransferDocument } from './transfer.ts';

const repositoryUrl = z.string().min(1).max(2000).refine(s => !s.startsWith('-'));
const bbCliSchema = z.string().refine(path => path === '' || isAbsolute(path), 'Enter the absolute path to bb (for example /opt/bin/bb), or clear bbCli to use the server environment.');
export const configSchema = z.object({ enabled: z.boolean().default(false), branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/), script: z.string().min(1).max(1000).refine(s => !s.startsWith('/') && !s.split('/').includes('..')), args: z.array(z.string().max(10000)).max(100).default([]), manager: z.string().regex(/^(thr_[a-z0-9]+)?$/).default(''), intervalMinutes: z.number().int().min(1).max(1440).default(10), timeoutSeconds: z.number().int().min(1).max(300).default(300), snapshots: z.boolean().default(false) });
export type Config = z.infer<typeof configSchema>;
const projectDraft = configSchema.partial().refine(config => !config.enabled || configSchema.safeParse(config).success, 'Complete the checkout settings before enabling Sweep');
const projectsSchema = z.record(projectId, projectDraft);
const configKey = configSchema.keyof();
const transferInput = input;
const handoffId = z.string().min(1).max(200);
const configGetInput = input.extend({ key: configKey.optional() });
const configSetInput = input.extend({ key: configKey, value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]) });
export const contract = defineRpcContract({
  ...overviewContract,
  'attention.observations': attentionObservations,
  'settings.read': { experimental_description: 'Read settings and UI choices. For one project, use config.get.', input: z.null(), output: z.object({ projects: z.array(z.object({ id: z.string(), name: z.string(), hasRepository: z.boolean(), config: configSchema.nullable() })), threads: z.array(z.object({ id: z.string(), title: z.string(), projectId: z.string() })), environment: z.object({ bbCli: z.string(), runtimePath: z.string() }) }) },
  'environment.write': { experimental_description: 'Replace both global execution settings (bbCli and runtimePath). Use native plugin config to change one field.', input: z.object({ bbCli: bbCliSchema, runtimePath: z.string() }).strict(), output: z.unknown() },
  configure: { experimental_description: 'Replace the entire configuration for one project. Use config.set for one field. Changing manager redirects pending reports.', input: z.object({ projectId, config: configSchema.extend({ remote: z.string().optional() }).strict().transform(config => configSchema.parse(config)) }).strict(), output: z.unknown() },
  'config.get': { experimental_description: 'Read project configuration or only the requested key, for example {"projectId":"proj_example","key":"manager"}.', input: configGetInput, output: z.unknown() },
  'config.set': { experimental_description: 'Set and return one key, for example {"projectId":"proj_example","key":"manager","value":"thr_example"}. A new manager receives pending reports too.', input: configSetInput, output: z.unknown() },
  'seed-state': { experimental_description: 'Import committed JSON once for a disabled project with no committed state or pending report. For example {"projectId":"proj_example","snapshot":"{}"}.', input: z.object({ projectId, snapshot: z.string().min(1).max(1000000).refine(s => { try { JSON.parse(s); return true; } catch { return false; } }, 'Pass the contents of the committed JSON file as a string, for example "{}".') }).strict(), output: z.object({ seeded: z.literal(true) }) },
  status: { experimental_description: 'Read the last scheduled result and any pending report for one project, with running, importing, incoming, hasState and the transfer handoff.', input, output: z.unknown() },
  'transfer.export': { experimental_description: 'Serves the Work Board transfer commands: marks this project as sent to Work Board and returns the transfer document. Needs a disabled, idle project with no pending report; repeats return the same document.', input: transferInput, output: transferDocument },
  'transfer.chunk': { experimental_description: 'Serves the Work Board transfer commands: one chunk (at most 256 KB, base64) of the committed bytes of the current unconfirmed send.', input: transferInput.extend({ handoffId, offset: z.number().int().min(0) }), output: chunkOutput },
  'transfer.confirm': { experimental_description: 'Serves the Work Board transfer commands: records that Work Board received the send. Refused unless Work Board shows the receipt.', input: transferInput.extend({ handoffId }), output: z.unknown() },
  'transfer.preflight': { experimental_description: 'Serves the Work Board transfer commands: read-only answer whether this project would accept a handoff whose previous id is given.', input: transferInput.extend({ previous: z.string().min(1).nullable() }), output: z.object({ accept: z.boolean(), reason: z.string().nullable() }) },
  'transfer.import': { experimental_description: 'Serves the Work Board transfer commands: pulls the handoff from Work Board and stages it. It is applied only once Work Board shows Sweep as the owner.', input: transferInput.extend({ handoffId }), output: z.unknown() },
  'transfer.commit': { experimental_description: 'Serves the Work Board transfer commands: applies the staged handoff once Work Board confirms it, or discards it when the send was aborted.', input: transferInput.extend({ handoffId }), output: z.unknown() },
  'transfer.cancel': { experimental_description: 'Serves the Work Board transfer commands: clears the unconfirmed send with the given handoff id when Work Board shows it never received it; does nothing if the send changed.', input: transferInput.extend({ handoffId }), output: z.unknown() },
  run: { experimental_description: 'Refresh the checkout and execute the configured script. Sweep does not deliver or acknowledge the result. The script can have side effects.', input, output: z.unknown() },
});
type ReportReceipt = { fingerprint: string; manager?: string };
type Handoff = { granted?: true; sent?: { id: string; at: number; confirmed?: true }; received?: string };
type State = { handoff?: Handoff; tickId?: string; deliveredTickId?: string; deliveredTo?: string; deliveredNoticeId?: string; fallbackReason?: string; lastRun?: number; exitCode?: number | null; delivered?: string; deliveredAt?: number; error?: string | null; managerError?: string | null; alertError?: string | null; nextRun?: number; refreshFailures?: number; refreshRetryAt?: number; attentionShadow?: ShadowRun; reportedWorktrees?: string[]; pendingWorktrees?: string[]; lastMeasuredWorktree?: string; lastFailure?: ReportReceipt; lastReport?: ReportReceipt & { at: number; changes?: ReturnType<typeof reportContents>['changes'] } };
const noticeReceipt = z.object({ id: z.string().min(1), created: z.boolean() });
const maxRefreshBackoffMs = 3600000;
const reportHeader = /^\[sweep\] (alive|exit (\d+))(?: tick=(\S+))?\n/;
const cliHelp = {
  status: 'bb sweep status [--project <id>] [--json]\nRead the last scheduled run, delivery and pending report. Example: bb sweep status --project proj_example --json',
  manager: 'bb sweep manager [--project <id>] [--json]\nRead the configured manager ID (or null). Example: bb sweep manager --project proj_example',
  run: 'bb sweep run --project <id> [--dry-run] [--json]\nRefresh the checkout and execute its configured script. This never changes Sweep status, delivers a report or acknowledges a snapshot. The script can have side effects. Example: bb sweep run --project proj_example --dry-run',
  config: 'bb sweep config get [<key>] [--project <id>] [--json]\nbb sweep config set <key> <value> --project <id> [--json]\nRequired before enabling: branch (for example main), script (repository-relative, for example checks/sweep.py). Other keys: enabled and snapshots (true/false), args (JSON array of strings), manager (a thread ID or empty), intervalMinutes (1–1440), timeoutSeconds (script timeout, 1–300). Changing manager also redirects pending reports. Set the Git URL in the bb project settings. Example: bb sweep config set args \'["--brief"]\' --project proj_example',
  stats: 'bb sweep stats [--days <1-30>] [--project <id>] [--json]\nRead scheduled-run statistics for the last 1–30 days (default 1). Example: bb sweep stats --days 7 --project proj_example',
};
const cliSummary = 'Read status, manager or stats, edit one project setting, or run a check manually';
export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({ runtimePath: { type: 'string', label: 'Script PATH (empty inherits server)', default: '' }, bbCli: { type: 'string', label: 'BB CLI absolute path', default: '', experimental_schema: bbCliSchema }, projects: { type: 'string', label: 'All project settings (legacy JSON replacement)', experimental_multiline: true, default: '{}', experimental_schema: z.string().refine(s => { try { return projectsSchema.safeParse(JSON.parse(s)).success; } catch { return false; } }, 'Pass a JSON object keyed by project ID, or use bb sweep config set <key> <value> --project proj_example to edit one field.') } });
  settings.onChange((next, previous) => {
    if (next.projects !== previous.projects) bb.rpc.experimental_invalidate([projectsTag, managerTag]);
  });
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
  const status = async (id: string) => { const config = (await configs())[id] ?? null, current = state(id); return { projectId: id, config, ...current, nextRun: config?.enabled ? current.nextRun ?? Date.now() : null, pending: deliveries.read(id)?.pending_message ?? null, running: busy.has(id), importing: importing.has(id), incoming: incoming.read(id)?.handoff_id ?? null, hasState: hasState(id) }; };
  const controller = new AbortController(); bb.onDispose(() => controller.abort());
  const attention = attentionStore(db, bb, controller.signal);
  const busy = new Set<string>();
  const importing = new Set<string>(), incoming = incomingStore(db);
  const workBoard = <T>(method: string, input: Record<string, string | number | null>, outputSchema: z.ZodType<T>, ms = 3000) => bb.sdk.plugins.callRpc({ pluginId: 'work-board', method, input, outputSchema, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(ms)]) });
  const ownership = (id: string) => workBoard('checks.ownership', { bbProjectId: id }, ownershipOutput);
  const grant = z.object({ granted: z.boolean(), reason: z.string().optional() });
  // Volatile keys do not make a project hold runner state: a settings edit or a refused tick writes them.
  const hasState = (id: string) => {
    const row = deliveries.read(id);
    if (row?.committed || row?.pending_message) return true;
    const { nextRun: _n, error: _e, alertError: _a, handoff: _h, refreshFailures: _f, refreshRetryAt: _r, ...rest } = state(id);
    return Object.keys(rest).length > 0;
  };
  /** Why a project cannot take part in a transfer right now, or null: the sender and the receiver need it disabled, idle and drained. */
  const notIdle = (id: string, config: Config | undefined) =>
    !config ? 'Set branch and script for this project first.'
    : config.enabled ? `Disable Sweep first: bb sweep config set enabled false --project ${id}.`
    : busy.has(id) ? 'A check is running. Wait until bb sweep status shows running: false, then retry.'
    : deliveries.read(id)?.pending_message ? 'A report is pending. Let it deliver (enable Sweep until bb sweep status shows pending: null, then disable it), then retry.'
    : incoming.read(id) ? 'A handoff from Work Board is already staged here. Rerun bb work-board checks export-to-sweep to finish it.'
    : null;
  const sentNotice = 'This project\'s runner state was sent to Work Board. Run bb work-board checks export-to-sweep --project <KEY> to bring it back.';
  /** Whether this project may run now. Returns the refusal, or null; an inconclusive answer from Work Board refuses. */
  async function admit(id: string): Promise<string | null> {
    const handoff = state(id).handoff;
    if (handoff?.sent) return sentNotice;
    if (importing.has(id) || incoming.read(id)) return 'A handoff from Work Board is pending for this project. Rerun bb work-board checks export-to-sweep to finish it.';
    if (handoff?.granted) return null;
    try {
      const { plugins } = await bb.sdk.plugins.list({ signal: controller.signal });
      if (!plugins.some(plugin => plugin.id === 'work-board')) return null;
      const claim = await workBoard('checks.claim', { bbProjectId: id, claimant: 'sweep' }, grant);
      if (!claim.granted) return `Work Board holds this project's repository checks (${claim.reason ?? 'no reason given'}). Run bb work-board checks export-to-sweep --project <KEY> to hand them to Sweep.`;
      const next = state(id);
      next.handoff = { ...next.handoff, granted: true };
      save(id, next);
      return null;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      return `Work Board could not confirm that Sweep may run (${String(error)}). Sweep retries in a minute.`;
    }
  }
  // Legacy reports without baselines get them from the delivered text, and an old failure moves into lastFailure.
  function normalizeBaselines(current: State) {
    if (!current.lastReport || current.lastReport.changes || !current.delivered) return;
    const previous = reportHeader.exec(current.delivered);
    if (previous?.[2] === undefined) return;
    const code = Number(previous[2]);
    if (code >= 2) {
      const { fingerprint, manager } = current.lastReport;
      current.lastFailure ??= { fingerprint, manager };
      current.lastReport = undefined;
    } else {
      current.lastReport.changes = reportContents(code, current.delivered.slice(previous[0].length)).changes;
    }
  }
  function buildDocument(id: string, current: State, handoffId: string, at: number): TransferDocument {
    const committed = deliveries.read(id)?.committed ?? null;
    // JSON round trip: an absent baseline is a missing key, never an undefined one.
    return transferDocument.parse(JSON.parse(JSON.stringify({
      format: 'bb-runner-state/1', from: 'sweep', bbProjectId: id, handoffId, previous: current.handoff?.received ?? null, exportedAt: new Date(at).toISOString(),
      committed: committed ? { size: committed.length, sha256: sha256(committed) } : null,
      lastReport: current.lastReport, lastFailure: current.lastFailure, reportedWorktrees: current.reportedWorktrees ?? [], lastMeasuredWorktree: current.lastMeasuredWorktree,
    })));
  }
  type Verdict = { accept: true; duplicate?: true } | { accept: false; reason: string };
  /** The receiver rule, the same on both sides: duplicate, returning owner, empty initial destination, or refusal. */
  function judge(id: string, previous: string | null, handoffId: string | null): Verdict {
    const handoff = state(id).handoff ?? {};
    if (handoffId !== null && handoff.received === handoffId) return { accept: true, duplicate: true };
    if (handoff.sent && previous === handoff.sent.id) return handoff.sent.confirmed ? { accept: true } : { accept: false, reason: 'The earlier send to Work Board is not confirmed yet. Rerun bb work-board checks import-from-sweep to confirm it, then retry.' };
    if (!handoff.sent && !handoff.received && !hasState(id)) return { accept: true };
    return { accept: false, reason: 'Newer state is held here.' };
  }
  async function managerFor(manager: string | undefined) {
    if (!manager) throw new Error('Manager is unset. Set the manager field to an available thread ID.');
    const thread = await bb.sdk.threads.get({ threadId: manager });
    if (!thread || thread.archivedAt || thread.deletedAt) throw new Error('Manager missing, archived or deleted. Set the manager field to an available thread ID.');
    if (thread.status === 'error' || thread.runtime.displayStatus === 'error') throw new Error('Manager thread failed. Recover the thread or set the manager field to an available thread ID.');
    if (thread.runtime.displayStatus === 'waiting-for-host') throw new Error('Manager host unreachable. Bring the host online or set the manager field to an available thread ID.');
    return manager;
  }
  async function deliver(id: string, current: State, tickId: string) {
    const pending = deliveries.read(id)?.pending_message;
    if (!pending) return;
    const header = reportHeader.exec(pending);
    const heartbeat = header?.[1] === 'alive';
    const code = Number(header?.[2]);
    const output = header ? pending.slice(header[0].length) : pending;
    const message = header ? formatNotification(heartbeat ? 'alive' : code, output) : pending;
    const manager = (await configs())[id]?.manager;
    let receipt: Parameters<typeof attention.accept>[2];
    try {
      const threadId = await managerFor(manager);
      receipt = { ...await sendOrAppend(bb, { threadId, text: message }), destination: threadId };
      current.deliveredTo = threadId;
      current.deliveredNoticeId = undefined;
      current.fallbackReason = undefined;
      current.managerError = null;
    } catch (error) {
      if (controller.signal.aborted) throw error;
      current.managerError = String(error);
      // Older pending reports did not carry a tick ID. Derive a stable key for their retries.
      const tickId = header?.[3] ?? `${id}:legacy:${createHash('sha256').update(pending).digest('hex')}`;
      try {
        const { plugins } = await bb.sdk.plugins.list({ signal: controller.signal });
        const pluginId = ['agent-hub', 'answers'].find(id => plugins.some(plugin => plugin.id === id && plugin.enabled));
        if (!pluginId) throw new Error('No enabled Agent Hub or Answers plugin. Restore manager delivery or enable Agent Hub to receive pending reports.');
        const notice = await bb.sdk.plugins.callRpc({
          pluginId, method: 'notice', signal: controller.signal, outputSchema: noticeReceipt,
          input: {
            source: bb.pluginId, tickId, projectId: id, ...(manager ? { threadId: manager } : {}),
            title: 'Sweep report · Manager unavailable',
            markdown: Buffer.byteLength(message) <= 1024 * 1024 ? message : pending,
          },
        });
        current.deliveredTo = pluginId;
        current.deliveredNoticeId = notice.id;
        current.fallbackReason = current.managerError;
        receipt = { mode: 'notice', destination: pluginId, id: notice.id };
      } catch (cause) {
        if (!controller.signal.aborted) history.deliveryFailed(tickId);
        throw new Error(`Notice fallback failed after ${current.managerError}: ${String(cause)}`, { cause });
      }
    }
    current.deliveredTickId = header?.[3];
    const acceptedAt = Date.now();
    current.delivered = pending; current.deliveredAt = acceptedAt;
    current.error = code >= 2 ? output : null;
    current.alertError = null;
    if (header && !heartbeat) {
      const { fingerprint, changes } = reportContents(code, output);
      if (code >= 2) current.lastFailure = { fingerprint, manager };
      else current.lastReport = { fingerprint, changes, at: current.deliveredAt, manager };
    }
    if (current.pendingWorktrees) {
      current.reportedWorktrees = [...new Set([...(current.reportedWorktrees ?? []), ...current.pendingWorktrees])];
      current.pendingWorktrees = undefined;
    }
    db.transaction(() => {
      deliveries.acknowledge(id);
      if (current.deliveredTickId) attention.accept(current.deliveredTickId, acceptedAt, receipt);
      history.delivered(tickId, current.deliveredNoticeId !== undefined);
      save(id, current);
    })();
  }
  async function tick(id: string, manual = false) {
    // A staged handoff is settled before the run is reserved; busy is checked again after that await.
    const staged = incoming.read(id);
    if (staged) await settleIncoming(id, staged.handoff_id).catch(error => { if (controller.signal.aborted) throw error; bb.log.warn(`Sweep could not settle the staged handoff for ${id}: ${String(error)}`); });
    if (busy.has(id)) throw new Error('Sweep is already running for this project. Wait for the active check to finish and retry.');
    busy.add(id);
    let current = state(id);
    let config: Config | undefined;
    let historyChanged = false;
    let shadowTick: { id: string; mode: ShadowRun } | undefined;
    const shadowIssues: string[] = [];
    let observationRecorded = false;
    try {
      config = (await configs())[id]; if (!config) throw new Error('Set branch and script with bb sweep config set <key> <value> --project <id> before running Sweep.');
      const refusal = await admit(id);
      if (refusal) {
        if (manual) throw new Error(refusal);
        current = state(id); current.error = refusal; current.nextRun = Date.now() + 60000; save(id, current);
        return await status(id);
      }
      current = state(id);
      const now = Date.now(), interval = config.intervalMinutes * 60000;
      const timestamp = Math.max(now, (Number(current.tickId?.split(':')[1]) || 0) + 1);
      const tickId = `${id}:${timestamp}`;
      if (!manual) {
        normalizeBaselines(current);
        current.tickId = tickId;
        current.lastRun = now;
        current.nextRun = now + interval;
        db.transaction(() => { history.start(id, tickId, now); save(id, current); })();
        historyChanged = true;
        const shadow = await attention.shadowMode(id);
        controller.signal.throwIfAborted();
        if (shadow !== undefined) current.attentionShadow = shadow ?? undefined;
        if (current.attentionShadow) {
          shadowTick = { id: tickId, mode: current.attentionShadow };
          if (shadow === undefined) shadowIssues.push('mode-unavailable');
        }
        attention.prune(now);
        await deliver(id, current, tickId);
        if (current.refreshRetryAt && current.refreshRetryAt > Date.now()) {
          if (shadowTick) attention.gap(id, shadowTick.id, shadowTick.mode, [...shadowIssues, 'refresh-backoff']);
          current.nextRun = current.refreshRetryAt;
          save(id, current);
          return status(id);
        }
      }
      const committed = deliveries.read(id)?.committed ?? null;
      const scanStartedAt = Date.now();
      let result;
      let project: Awaited<ReturnType<typeof bb.sdk.projects.get>> | undefined;
      let refreshFailed = false;
      try {
        project = await bb.sdk.projects.get({ projectId: id }).catch(cause => {
          throw new CheckoutRefreshError('Could not read the bb project repository settings', { cause });
        });
        const remote = repositoryUrl.safeParse(project?.gitRemoteUrl);
        if (!remote.success) throw new CheckoutRefreshError('Set a valid Git remote URL in the bb project settings');
        const { bbCli, runtimePath } = await settings.get();
        result = await execute(dirname(db.name), id, { ...config, remote: remote.data }, committed, controller.signal, bbCli, runtimePath);
      }
      catch (e) {
        if (controller.signal.aborted) throw e;
        refreshFailed = e instanceof CheckoutRefreshError;
        result = { code: 2, output: `ERROR ${String(e)}`, snapshot: null };
      }
      if (manual) return { exitCode: result.code, output: result.output, manual: true };
      if (shadowTick) {
        if (result.code >= 2) attention.gap(id, shadowTick.id, shadowTick.mode, [...shadowIssues, refreshFailed ? 'refresh-failed' : 'script-failed']);
        else await attention.observe(id, shadowTick.id, shadowTick.mode, scanStartedAt, result.output, shadowIssues);
        observationRecorded = true;
        controller.signal.throwIfAborted();
      }
      const worktrees = project ? await scanArchivedWorktrees(bb, project, current.reportedWorktrees ?? [], current.lastMeasuredWorktree, AbortSignal.any([controller.signal, AbortSignal.timeout(60000)])).catch(error => {
        controller.signal.throwIfAborted();
        bb.log.warn(`Archived worktree scan failed for ${id}: ${String(error)}`);
        return null;
      }) : null;
      if (worktrees) current.lastMeasuredWorktree = worktrees.lastMeasuredPath;
      if (worktrees?.complete && current.reportedWorktrees) {
        const present = new Set(worktrees.present);
        current.reportedWorktrees = current.reportedWorktrees.filter(path => present.has(path));
      }
      const newWorktrees = worktrees?.newPaths.length ? worktrees.newPaths : undefined;
      const output = worktrees?.lines.length ? [result.output.trimEnd(), ...worktrees.lines].filter(Boolean).join('\n') : result.output;
      const code = newWorktrees && result.code === 0 ? 1 : result.code;
      current.exitCode = code;
      current.refreshFailures = refreshFailed ? (current.refreshFailures ?? 0) + 1 : 0;
      current.refreshRetryAt = refreshFailed
        ? Date.now() + Math.min(interval * 2 ** Math.min(current.refreshFailures - 1, 6), Math.max(interval, maxRefreshBackoffMs))
        : undefined;
      const report = reportContents(code, output);
      history.result(id, tickId, now, report.items, refreshFailed ? 'refresh' : code >= 2 ? 'script' : undefined);
      const candidateChanged = result.snapshot !== null && (!committed || !result.snapshot.equals(committed));
      const answerWithoutCandidate = config.snapshots && result.snapshot === null && [...report.items.values()].includes('ANSWER');
      const lastReport = current.lastReport?.manager === config.manager ? current.lastReport : undefined;
      const previous = lastReport?.changes;
      const sameLegacyReport = !previous && lastReport?.fingerprint === report.fingerprint;
      const waitingChanged = code < 2 && !sameLegacyReport &&
        report.changes.waiting !== (previous?.waiting ?? '');
      const knownItems = new Set(previous?.noteworthy);
      const newItem = !sameLegacyReport && report.changes.noteworthy.some(id => !knownItems.has(id));
      const lastFailure = current.lastFailure;
      const changedFailure = lastFailure?.manager !== config.manager || lastFailure?.fingerprint !== report.fingerprint;
      const changedDiagnostic = code === 1 && !report.items.size && lastReport?.fingerprint !== report.fingerprint;
      const notify = newWorktrees || (code >= 2 ? changedFailure :
        waitingChanged || newItem || candidateChanged || answerWithoutCandidate || changedDiagnostic);
      if (code < 2) current.lastFailure = undefined;
      if (notify) {
        const body = waitingChanged && !report.changes.waiting
          ? `${output.trimEnd()}\nSTATE Waiting list is clear.\n` : output;
        const message = `[sweep] exit ${code} tick=${tickId}\n${body}`;
        current.pendingWorktrees = newWorktrees;
        db.transaction(() => {
          deliveries.stage(id, message, result.snapshot);
          if (shadowTick) attention.stage(shadowTick.id, Date.now());
          save(id, current);
        })();
        await deliver(id, current, tickId);
      } else if (code !== 0 || report.changes.waiting || result.snapshot !== null) history.suppress(tickId);
      if (current.refreshRetryAt) current.nextRun = current.refreshRetryAt;
      current.error = result.code >= 2 ? result.output : null;
      current.alertError = null;
      save(id, current);
      return await status(id);
    } catch (e) {
      if (!manual && !controller.signal.aborted) {
        if (shadowTick && !observationRecorded) attention.gap(id, shadowTick.id, shadowTick.mode, [...shadowIssues, 'tick-interrupted']);
        current.error = String(e); save(id, current);
        try { await bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'notifications.send', input: { title: 'Sweep manager unreachable', body: `${id}: ${String(e)}` }, outputSchema: z.unknown() }); }
        catch (alert) { current.alertError = String(alert); save(id, current); bb.log.error(`Sweep push failed: ${String(alert)}`); }
      }
      throw e;
    } finally {
      busy.delete(id);
      if (historyChanged) bb.rpc.experimental_invalidate([statsTag(id)]);
    }
  }
  let writes = Promise.resolve();
  function serializeWrite<T>(write: () => Promise<T>) {
    const operation = writes.then(write);
    writes = operation.then(() => {}, () => {});
    return operation;
  }
  /** `enabling` marks an explicit request to enable, which is guarded even when the stored draft already says enabled (a legacy whole-JSON write). */
  function writeConfig(id: string, edit: (config: Partial<Config> | undefined) => Partial<Config>, enabling = false) {
    return serializeWrite(async () => {
      if (!(await bb.sdk.projects.list()).some(p => p.id === id)) throw new Error('Unknown project. Run bb project list and use an existing project ID.');
      const projects = await drafts();
      const previous = projects[id];
      const config = edit(previous);
      if (config.enabled && (enabling || !previous?.enabled)) {
        // Enabling settles a staged handoff first, and is refused while the project is marked or a handoff is pending.
        const staged = incoming.read(id);
        if (staged) await settleLocked(id, staged.handoff_id).catch(() => 'waiting');
        if (state(id).handoff?.sent) throw new Error(sentNotice);
        if (importing.has(id) || incoming.read(id)) throw new Error('A handoff from Work Board is pending for this project. Rerun bb work-board checks export-to-sweep to finish it.');
      }
      projects[id] = config;
      await settings.experimental_set({ projects: JSON.stringify(projects) });
      if (!busy.has(id)) {
        const current = state(id);
        if (previous?.branch !== config.branch) {
          current.refreshFailures = 0;
          current.refreshRetryAt = undefined;
        }
        save(id, { ...current, nextRun: Date.now() });
      }
      return config;
    });
  }
  const configure = async ({ projectId, config }: { projectId: string; config: Config }) => {
    await writeConfig(projectId, () => config, config.enabled);
    return status(projectId);
  };
  const configGet = async ({ projectId, key }: z.infer<typeof configGetInput>) => {
    const config = (await drafts())[projectId];
    return key ? { [key]: config?.[key] ?? null } : config ?? null;
  };
  const configSet = async ({ projectId, key, value }: z.infer<typeof configSetInput>) => {
    const parsed = configSchema.shape[key].safeParse(value);
    if (!parsed.success) throw new Error(`Invalid ${key}: ${parsed.error.issues[0].message}. Run bb sweep config --help for accepted values.`);
    const config = await writeConfig(projectId, current => {
      const next = { ...current, [key]: parsed.data };
      if (!next.enabled) return next;
      const enabled = configSchema.safeParse(next);
      if (!enabled.success) throw new Error('Set branch (for example main) and script (for example checks/sweep.py) before enabling Sweep.');
      return enabled.data;
    }, key === 'enabled' && parsed.data === true);
    return { [key]: config[key] };
  };
  const seedState = ({ projectId, snapshot }: { projectId: string; snapshot: string }) => serializeWrite(async () => {
    if (!(await bb.sdk.projects.list()).some(p => p.id === projectId)) throw new Error('Unknown project. Run bb project list and use an existing project ID.');
    const config = (await configs())[projectId];
    if (!config) throw new Error('Set branch and script before importing committed state.');
    if (config.enabled) throw new Error(`Disable Sweep first with bb sweep config set enabled false --project ${projectId}.`);
    if (busy.has(projectId)) throw new Error('Wait for the active Sweep check to finish before importing committed state.');
    if (state(projectId).handoff?.sent || importing.has(projectId) || incoming.read(projectId)) throw new Error('This project is part of a transfer to or from Work Board. Seeding is refused until the transfer is settled.');
    deliveries.seed(projectId, Buffer.from(snapshot));
    return { seeded: true as const };
  });
  /** Applies or discards the staged handoff when Work Board's row decides it. Runs under serializeWrite only. */
  async function settleLocked(id: string, handoffId: string): Promise<'applied' | 'discarded' | 'waiting' | 'none'> {
    if (incoming.read(id)?.handoff_id !== handoffId) return 'none';
    let own: Awaited<ReturnType<typeof ownership>>;
    try { own = await ownership(id); } catch (error) { if (controller.signal.aborted) throw error; return 'waiting'; }
    const config = (await configs())[id];
    // No await from here to the transaction: the row, the project and the checks are read together.
    const row = incoming.read(id);
    if (!row || row.handoff_id !== handoffId) return 'none';
    if (!config || config.enabled || busy.has(id) || deliveries.read(id)?.pending_message) return 'waiting';
    const confirmed = own.owner === 'sweep' && own.sentId === handoffId && own.sentConfirmed;
    if (!confirmed && own.sentId === handoffId) return 'waiting';
    const document = transferDocument.parse(JSON.parse(row.document));
    let result: 'applied' | 'discarded' | 'none' = 'none';
    db.transaction(() => {
      if (!incoming.take(id, handoffId)) return;
      if (!confirmed) { result = 'discarded'; return; }
      deliveries.replace(id, row.bytes);
      const next = state(id);
      next.lastReport = document.lastReport; next.lastFailure = document.lastFailure;
      next.reportedWorktrees = document.reportedWorktrees; next.lastMeasuredWorktree = document.lastMeasuredWorktree;
      next.pendingWorktrees = undefined;
      next.delivered = undefined; next.deliveredAt = undefined; next.deliveredTickId = undefined; next.deliveredTo = undefined; next.deliveredNoticeId = undefined;
      next.handoff = { granted: true, received: handoffId };
      next.nextRun = Date.now();
      save(id, next);
      result = 'applied';
    })();
    return result;
  }
  const settleIncoming = (id: string, handoffId: string) => serializeWrite(() => settleLocked(id, handoffId));
  const transferExport = ({ projectId: id }: { projectId: string }) => serializeWrite(async () => {
    const config = (await configs())[id];
    // Everything below is synchronous: the checks and the write that marks the sender are one section.
    const refusal = notIdle(id, config) ?? (importing.has(id) ? 'An import is in progress for this project.' : null);
    if (refusal) throw new Error(refusal);
    const current = state(id);
    const sent = current.handoff?.sent;
    if (sent?.confirmed) throw new Error('Work Board already holds this project\'s state. Run bb work-board checks export-to-sweep --project <KEY> to bring it back.');
    if (sent) return buildDocument(id, current, sent.id, sent.at);
    normalizeBaselines(current);
    const handoffId = randomUUID(), at = Date.now();
    const document = buildDocument(id, current, handoffId, at);
    current.handoff = { ...current.handoff, sent: { id: handoffId, at } };
    save(id, current);
    return document;
  });
  const transferChunk = ({ projectId: id, handoffId, offset }: { projectId: string; handoffId: string; offset: number }) => {
    const sent = state(id).handoff?.sent;
    if (!sent || sent.confirmed || sent.id !== handoffId) throw new Error('No unconfirmed send with that handoff id.');
    return readChunk(deliveries.read(id)?.committed ?? Buffer.alloc(0), offset);
  };
  const transferConfirm = ({ projectId: id, handoffId }: { projectId: string; handoffId: string }) => serializeWrite(async () => {
    const sent = state(id).handoff?.sent;
    if (sent?.id !== handoffId) throw new Error('No send with that handoff id is recorded here.');
    if (sent.confirmed) return { confirmed: true as const, duplicate: true as const };
    const own = await ownership(id);
    if (own.owner !== 'work-board' || own.receivedId !== handoffId) throw new Error('Work Board has not recorded the receipt of that handoff.');
    const current = state(id);
    if (current.handoff?.sent?.id !== handoffId) throw new Error('The send changed while the receipt was checked. Retry.');
    current.handoff = { ...current.handoff, sent: { ...sent, confirmed: true } };
    save(id, current);
    return { confirmed: true as const };
  });
  const transferPreflight = async ({ projectId: id, previous }: { projectId: string; previous: string | null }) => {
    const refusal = notIdle(id, (await configs())[id]) ?? (importing.has(id) ? 'An import is in progress for this project.' : null);
    if (refusal) return { accept: false, reason: refusal };
    const verdict = judge(id, previous, null);
    return { accept: verdict.accept, reason: verdict.accept ? null : verdict.reason };
  };
  const transferImport = ({ projectId: id, handoffId }: { projectId: string; handoffId: string }) => serializeWrite(async () => {
    const config = (await configs())[id];
    if (incoming.read(id)?.handoff_id === handoffId) return { staged: true as const, duplicate: true as const };
    if (state(id).handoff?.received === handoffId) return { staged: false as const, duplicate: true as const };
    const refusal = notIdle(id, config);
    if (refusal) throw new Error(refusal);
    importing.add(id);
    try {
      const own = await ownership(id);
      if (own.sentId !== handoffId || own.sentConfirmed) throw new Error('Work Board is not sending that handoff.');
      const document = await workBoard('checks.transferDocument', { bbProjectId: id, handoffId }, transferDocument);
      if (document.from !== 'work-board' || document.bbProjectId !== id || document.handoffId !== handoffId) throw new Error('The handoff document does not belong to this project and sender.');
      const bytes = await pullBytes(document, offset => workBoard('checks.transferChunk', { bbProjectId: id, handoffId, offset }, chunkOutput, 15000));
      const verdict = judge(id, document.previous, handoffId);
      if (!verdict.accept) throw new Error(verdict.reason);
      const latest = (await configs())[id];
      const again = judge(id, document.previous, handoffId);
      const changed = notIdle(id, latest) ?? (again.accept ? null : again.reason);
      if (changed) throw new Error(changed);
      incoming.put(id, handoffId, document, bytes);
      return { staged: true as const };
    } finally { importing.delete(id); }
  });
  const transferCancel = ({ projectId: id, handoffId }: { projectId: string; handoffId: string }) => serializeWrite(async () => {
    const sent = state(id).handoff?.sent;
    // The caller observed a specific send; a different or missing one is not cancelled.
    if (sent?.id !== handoffId) return { cancelled: false as const, current: sent?.id ?? null };
    if (sent.confirmed) throw new Error('The send is confirmed: Work Board holds the state. Run bb work-board checks export-to-sweep --project <KEY> to bring it back.');
    const own = await ownership(id);
    if (own.transferring || own.receivedId === sent.id) throw new Error('Work Board is transferring or has received that handoff. Rerun bb work-board checks import-from-sweep to confirm it.');
    const current = state(id);
    if (current.handoff?.sent?.id !== sent.id) return { cancelled: false as const, current: current.handoff?.sent?.id ?? null };
    current.handoff = { ...current.handoff, sent: undefined };
    save(id, current);
    return { cancelled: true as const };
  });
  bb.rpc.register(contract, {
    'transfer.export': transferExport, 'transfer.chunk': transferChunk, 'transfer.confirm': transferConfirm, 'transfer.preflight': transferPreflight, 'transfer.import': transferImport,
    'transfer.commit': async ({ projectId: id, handoffId }) => ({ settled: await settleIncoming(id, handoffId) }), 'transfer.cancel': transferCancel,
    'attention.observations': attention.read,
    'overview.projects': async () => {
      const projects = await configs();
      return (await bb.sdk.projects.list()).flatMap(({ id, name }) => projects[id] ? [{ id, name, enabled: projects[id].enabled }] : []);
    },
    'settings.read': async () => { const values = await settings.get(), projects = await configs(); return { projects: (await bb.sdk.projects.list()).map(p => ({ id: p.id, name: p.name, hasRepository: repositoryUrl.safeParse(p.gitRemoteUrl).success, config: projects[p.id] ?? null })), threads: (await bb.sdk.threads.list({ limit: 100, archived: false })).map(t => ({ id: t.id, title: t.title || t.id, projectId: t.projectId })), environment: { bbCli: values.bbCli, runtimePath: values.runtimePath } }; }, 'environment.write': async values => settings.experimental_set(values), configure, 'config.get': configGet, 'config.set': configSet, stats: ({ projectId, days }) => history.stats(projectId, days), 'seed-state': seedState, manager: async ({ projectId }) => ({ manager: (await configs())[projectId]?.manager || null }), status: ({ projectId }) => status(projectId), run: ({ projectId }) => tick(projectId, true) }, { experimental_discoverable: true });
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
  bb.cli.register({ name: 'sweep', summary: cliSummary, async run(argv, ctx) {
    try {
      const [command, ...args] = argv;
      if (!command || command === '--help' || command === '-h') return { exitCode: 0, stdout: `bb sweep <status|manager|run|config|stats>\n${cliSummary}. Run bb sweep <command> --help for usage.\nRun and config set require exactly one --project <id>.` };
      if (!Object.hasOwn(cliHelp, command)) throw new Error('Run bb sweep --help to choose a command.');
      const help = cliHelp[command as keyof typeof cliHelp];
      const advice = `Run bb sweep ${command} --help for usage.`;
      let id = ctx.projectId;
      const positional: string[] = [];
      const seen = new Set<string>();
      let days: number | undefined;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') return { exitCode: 0, stdout: help };
        if (arg === '--' && command === 'config') { positional.push(...args.slice(i + 1)); break; }
        if (arg === '--dry-run' && command !== 'run') throw new Error('--dry-run is only valid for bb sweep run. Use bb sweep config get to inspect settings without changing them.');
        if (arg === '--project' || (arg === '--days' && command === 'stats') || arg === '--json' || arg === '--dry-run') {
          if (seen.has(arg)) throw new Error(`Pass ${arg} only once. ${advice}`);
          seen.add(arg);
          if (arg === '--project' || arg === '--days') {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`Pass a value after ${arg}. ${advice}`);
            if (arg === '--project') id = value;
            else days = Number(value);
          }
        } else if (command === 'config' && !arg.startsWith('--')) positional.push(arg);
        else throw new Error(`Unexpected argument ${arg}. ${advice}`);
      }
      if (!id || ((command === 'run' || (command === 'config' && positional[0] === 'set')) && !seen.has('--project'))) {
        throw new Error('Pass --project <id> explicitly, for example --project proj_example. Run bb project list to find the ID.');
      }
      if (!projectId.safeParse(id).success) throw new Error('Pass a bb project ID, for example --project proj_example. Run bb project list to find the ID.');
      let result;
      switch (command) {
        case 'status': result = await status(id); break;
        case 'manager': result = { manager: (await configs())[id]?.manager || null }; break;
        case 'run': result = await tick(id, true); break;
        case 'stats': {
          const stats = statsInput.safeParse({ projectId: id, days });
          if (!stats.success) throw new Error(`Pass an integer from 1 through 30 for --days. ${advice}`);
          result = history.stats(id, stats.data.days);
          break;
        }
        case 'config': {
          const [operation, field, raw] = positional;
          if (operation === 'get' && positional.length <= 2) {
            const parsed = configGetInput.safeParse({ projectId: id, key: field });
            if (!parsed.success) throw new Error(`Unknown Sweep setting ${field}. ${advice}`);
            result = await configGet(parsed.data);
            break;
          }
          if (operation !== 'set' || positional.length !== 3) throw new Error(`Use config get [<key>] or config set <key> <value>. ${advice}`);
          const parsedKey = configKey.safeParse(field);
          if (!parsedKey.success) throw new Error(`Unknown Sweep setting ${field}. ${advice}`);
          const key = parsedKey.data;
          let value: unknown = raw;
          if (!configSchema.shape[key].safeParse(raw).success) {
            try { value = JSON.parse(raw); } catch { /* Validation will name the field. */ }
          }
          result = await configSet(configSetInput.parse({ projectId: id, key, value }));
          break;
        }
      }
      return { exitCode: 0, stdout: JSON.stringify(result) };
    } catch (e) { return { exitCode: 1, stderr: String(e) }; }
  } });
}
