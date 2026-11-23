import { randomUUID } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { attentionService } from "../attention/service";
import { configuredManager } from "../attention/modes";
import { deliverWithReceipt, resolvePrRecipient, searchAttentionMarker, type HistoryCursor, type Receipt } from "../steer";
import { errorMessage } from "../shared/errors";
import { isClosedStatus } from "../shared/workflow-policy";
import { parsePrUrl, prIdentity, prLinkSchema, type GitSyncConfig, type PrLink, type PrSnapshot } from "../shared/git-sync";
import { environmentPullRequests, type EnvironmentPullRequest } from "./environment-prs";
import type { DeployRun, GithubClient, QueueRemoval } from "./github";
import { createGitSyncStore } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
export type PrEventKind = "ci" | "queue_removed" | "merged" | "deployed" | "deploy_wait_ended";
export type PrEventSettings = { events: "on" | "off"; manager: "on" | "off" };
export const PR_EVENT_KEYS = { prEvents: "events", prEventsManager: "manager" } as const;

const DAY = 86_400_000;
const DELIVERY_RETENTION_MS = 30 * DAY;
const UNLINKED_RETENTION_MS = 90 * DAY;
const LATE_SEARCH_MS = DAY;
const MAX_ATTEMPTS = 3;
const FINAL_PASSES = 3;
/** A claim not renewed for `ms` is abandoned (a crash or a dead instance); a live attempt renews it every `renewMs`. Tests shorten both. */
export const claimLease = { ms: 15 * 60_000, renewMs: 5 * 60_000 };
const BACKOFF_MS = 60_000, BACKOFF_CAP_MS = 3_600_000;
// A message no single session can be told apart for waits for an owner, rechecked this often, and ends unsent after a day.
const HOLD_RECHECK_MS = 30 * 60_000, HOLD_MS = DAY;
/** The deadline of a drain's one environment-PR lookup; tests shorten it. */
export const environmentLookup = { deadlineMs: 5_000 };
// GitHub may list a run a little after creating it, so the search never freezes a range that ends closer to now than this.
const LISTING_LAG_MS = 60_000;
/** Per-pass search budgets: run-list pages, compare calls and kept-run rechecks. The final pass after the deadline gets more. */
export const deployBudgets = { pass: { pages: 4, compares: 10, rechecks: 10 }, final: { pages: 10, compares: 30, rechecks: 100 } };
// Only these kinds stop at a closed card: merge and post-merge news is still due after review.
const OPEN_CARD_KINDS: readonly PrEventKind[] = ["ci", "queue_removed"];
export const prEventMarker = (deliveryId: string, attempt: number) => `<!-- work-board-pr-event:${deliveryId}:${attempt} -->`;

type Payload = {
  number: number; head?: string; verdict?: "green" | "red"; failed?: string[]; reason?: string | null;
  mergeSha?: string; mergedAt?: string; workflow?: string; runId?: number; workflows?: string[]; days?: number; outcome?: "expired" | "unverifiable";
};
type StateRow = { verdict_key: string | null; queue_entry: string | null; queue_seen_at: string | null; merge_sha: string | null; merge_seen_at: string | null };
type WaitRow = {
  project_id: string; remote_id: string; identity: string; repository: string; number: number; base_branch: string; merge_sha: string;
  merged_at: string; deadline: string; workflows: string; days: number; state: string; baseline_at: string | null; walk: string | null; kept: string;
  found: string | null; final_passes: number;
};
type DeliveryRow = {
  id: string; event_id: string; task_id: string; role: "session" | "manager"; state: string; thread_id: string | null; attempts: number;
  transport_started_at: string | null; marker: string | null; cursor: string | null; lookup_failures: number; claim_owner: string | null;
  project_id: string; remote_id: string; identity: string; kind: PrEventKind; payload: string; created_at: string; held_until: string | null;
};
type Environments = { seen: Set<string>; environmentOf: Map<string, string>; prs: Map<string, EnvironmentPullRequest> };
/** The drain's environment lookup; `wait` false throws `LOOKUP_PENDING` while it is still running. */
type EnvironmentRead = (wait: boolean) => Promise<Environments | null>;
const LOOKUP_PENDING = new Error("Environment lookup still running");

export function prEventSettings(db: Database, projectId: string): PrEventSettings {
  return db.prepare<[string], PrEventSettings>("SELECT events, manager FROM pr_event_settings WHERE project_id=?").get(projectId) ?? { events: "on", manager: "off" };
}
export function setPrEventSetting(db: Database, projectId: string, key: keyof typeof PR_EVENT_KEYS, value: unknown): "on" | "off" {
  if (value !== "on" && value !== "off") throw new Error(`Invalid value for ${key}: use on or off`);
  const column = PR_EVENT_KEYS[key];
  db.prepare<[string, string]>(`INSERT INTO pr_event_settings(project_id, ${column}) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET ${column}=excluded.${column}`).run(projectId, value);
  return value;
}

/**
 * The required-check verdict of the current head, apart from the display `ci` field: only when the requirements are known, the
 * required set (minus ignored contexts) is not empty, and every required check is terminal. Null means no verdict yet.
 */
export function ciVerdict(snapshot: PrSnapshot, config: Pick<GitSyncConfig, "prWaitIgnoredChecks">): { verdict: "green" | "red"; failed: string[] } | null {
  if (!snapshot.requirementsKnown) return null;
  const required = snapshot.checks.filter((check) => check.required === true && !config.prWaitIgnoredChecks.includes(check.name));
  if (!required.length || required.some((check) => ["pending", "unknown"].includes(check.state))) return null;
  const failed = required.filter((check) => ["failed", "cancelled"].includes(check.state)).map((check) => check.name);
  return { verdict: failed.length ? "red" : "green", failed: [...new Set(failed)] };
}

const short = (sha: string) => sha.slice(0, 7);
const identityOf = (url: string) => {
  try {
    return prIdentity(parsePrUrl(url));
  } catch {
    return null;
  }
};
const utc = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
export function prEventText(kind: PrEventKind, payload: Payload, taskKey: string): string {
  const head = `${taskKey} · PR #${payload.number}`;
  if (kind === "ci")
    return payload.verdict === "green"
      ? `${head} CI green on ${short(payload.head!)} (required checks passed).`
      : `${head} CI red on ${short(payload.head!)}: failed ${payload.failed!.join(", ")}.`;
  if (kind === "queue_removed") return `${head} was removed from the merge queue (reason: ${payload.reason ?? "reason unavailable"}). Head ${short(payload.head!)}.`;
  if (kind === "merged") return `${head} merged as ${short(payload.mergeSha!)} at ${utc(payload.mergedAt!)}.`;
  if (kind === "deployed")
    return `${head}: ${payload.workflow} run ${payload.runId} succeeded with merge ${short(payload.mergeSha!)}. Collect the deployment evidence, run the final check and close the card; Work Board does not close it.`;
  const workflows = payload.workflows!.join(", ");
  return payload.outcome === "unverifiable"
    ? `${head}: Work Board could not verify a successful ${workflows} run with merge ${short(payload.mergeSha!)} within ${payload.days} days; it stopped waiting.`
    : `${head}: Work Board saw no successful ${workflows} run with merge ${short(payload.mergeSha!)} within ${payload.days} days; it stopped waiting.`;
}

/** Links of a PR in a project that count now; the remote id also finds links saved under a renamed repository. */
function eligibleLinks(db: Database, tasks: TasksStore, projectId: string, remoteId: string, identity: string, kind: PrEventKind) {
  const config = createGitSyncStore(db).config(projectId);
  const project = tasks.getProject(projectId);
  return db.prepare<[string, string, string], { payload: string }>(
    // A link that knows its remote id must match it, so another PR that takes over a renamed path never inherits this one's messages.
    "SELECT l.payload FROM task_pr_links l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=? AND (json_extract(l.payload, '$.remoteId')=? OR (json_extract(l.payload, '$.remoteId') IS NULL AND l.identity=?)) ORDER BY l.task_id",
  ).all(projectId, remoteId, identity).flatMap((row) => {
    const link = prLinkSchema.parse(JSON.parse(row.payload));
    if (link.excluded || !config.repositories.includes(link.repository)) return [];
    const task = tasks.getTask(link.taskId);
    if (!task || !project || (OPEN_CARD_KINDS.includes(kind) && isClosedStatus(project, task.status))) return [];
    return [link.taskId];
  });
}

/** Record one event once and its delivery rows for the links eligible right now; runs inside the caller's transaction. True when it added a delivery row. */
function emit(db: Database, tasks: TasksStore, projectId: string, remoteId: string, identity: string, kind: PrEventKind, onceKey: string, payload: Payload) {
  const settings = prEventSettings(db, projectId);
  const id = randomUUID(), now = new Date().toISOString();
  const inserted = db.prepare<[string, string, string, string, string, string, string, string]>(
    "INSERT OR IGNORE INTO pr_events(id, project_id, remote_id, identity, kind, once_key, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(id, projectId, remoteId, identity, kind, onceKey, JSON.stringify(payload), now).changes;
  if (!inserted) return false;
  const add = db.prepare<[string, string, string, string, string, string]>(
    "INSERT OR IGNORE INTO pr_event_deliveries(id, event_id, task_id, role, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)",
  );
  let added = false;
  for (const taskId of eligibleLinks(db, tasks, projectId, remoteId, identity, kind)) {
    added = add.run(randomUUID(), id, taskId, "session", now, now).changes > 0 || added;
    if (settings.manager === "on") added = add.run(randomUUID(), id, taskId, "manager", now, now).changes > 0 || added;
  }
  return added;
}

const loadState = (db: Database, projectId: string, remoteId: string) =>
  db.prepare<[string, string], StateRow>("SELECT verdict_key, queue_entry, queue_seen_at, merge_sha, merge_seen_at FROM pr_event_state WHERE project_id=? AND remote_id=?").get(projectId, remoteId);
const active = (snapshot: PrSnapshot) => snapshot.state === "open" || snapshot.state === "draft";

/** The queue entry this observation shows gone (removed or replaced) while the PR is still open, and since when it was last seen queued. */
export function queueDeparture(db: Database, projectId: string, snapshot: PrSnapshot): { entry: string; since: string | null } | null {
  const state = loadState(db, projectId, snapshot.remoteId);
  if (!state?.queue_entry || snapshot.queueEntryId === undefined || !active(snapshot) || snapshot.queueEntryId === state.queue_entry) return null;
  return { entry: state.queue_entry, since: state.queue_seen_at };
}

/**
 * Turn one saved snapshot into events, in the snapshot's transaction. The first observation of a PR only records a baseline, so
 * states it is already in send nothing. `removal` is the timeline lookup made for a queue departure (null when unreadable).
 * Returns true when it added delivery rows.
 */
export function recordPrEvents(db: Database, tasks: TasksStore, input: { projectId: string; config: GitSyncConfig; snapshot: PrSnapshot; removal?: QueueRemoval | null }) {
  const { projectId, config, snapshot } = input;
  let added = false;
  const remoteId = snapshot.remoteId, identity = prIdentity(snapshot), now = Date.now();
  const on = config.enabled && prEventSettings(db, projectId).events === "on";
  const state = loadState(db, projectId, remoteId);
  const verdict = active(snapshot) ? ciVerdict(snapshot, config) : null;
  const verdictKey = verdict ? `${snapshot.headSha}:${verdict.verdict}` : null;
  const merged = snapshot.state === "merged" && snapshot.mergedAt;
  const deadline = merged ? new Date(Date.parse(snapshot.mergedAt!) + config.postMergeDays * DAY).toISOString() : null;
  // A baselined wait carries its observation time: the search settles a success that completed before it silently.
  const arm = (baselineAt: string | null) => {
    if (!on || !snapshot.mergeSha || !deadline || !config.postMergeWorkflows.length) return;
    db.prepare(`INSERT OR IGNORE INTO pr_deploy_waits(project_id, remote_id, identity, repository, number, base_branch, merge_sha, merged_at, deadline, workflows, days, state, baseline_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`).run(projectId, remoteId, identity, snapshot.repository, snapshot.number, snapshot.baseBranch, snapshot.mergeSha,
      snapshot.mergedAt, deadline, JSON.stringify(config.postMergeWorkflows), config.postMergeDays, baselineAt);
  };
  // A renamed repository moves an open wait with it, so the search and its message use the current path.
  db.prepare("UPDATE pr_deploy_waits SET repository=?, identity=?, number=? WHERE project_id=? AND remote_id=? AND state='waiting'")
    .run(snapshot.repository, identity, snapshot.number, projectId, remoteId);
  // A merge whose SHA has not arrived is marked until it does: "?" when it was first seen already merged (a baseline, so the SHA
  // arms the wait without a `merged` event) and "!" when Work Board saw it merge (the SHA still owes the `merged` event).
  // `merge_seen_at` keeps when it was first seen without the SHA: the baseline time, and what keeps the PR polled for the SHA.
  let mergeSha = state?.merge_sha ?? null, mergeSeenAt = state?.merge_seen_at ?? null;
  if (!state) {
    if (merged) {
      mergeSha = snapshot.mergeSha ?? "?";
      mergeSeenAt = snapshot.observedAt;
      if (Date.parse(snapshot.observedAt) <= Date.parse(deadline!)) arm(snapshot.observedAt);
    }
  } else if (merged && !snapshot.mergeSha && mergeSha === null) {
    mergeSha = "!";
    mergeSeenAt = snapshot.observedAt;
  } else if (merged && snapshot.mergeSha && mergeSha !== snapshot.mergeSha) {
    const baselined = mergeSha === "?", sightedWithoutSha = mergeSha === "!";
    mergeSha = snapshot.mergeSha;
    if (!baselined && !sightedWithoutSha) mergeSeenAt = snapshot.observedAt;
    if (!baselined && on) added = emit(db, tasks, projectId, remoteId, identity, "merged", snapshot.mergeSha, { number: snapshot.number, mergeSha: snapshot.mergeSha, mergedAt: snapshot.mergedAt! }) || added;
    // A merge first seen inside its window gets its wait even when the SHA arrives after the deadline: the final pass reconciles it.
    const baselineAt = baselined ? mergeSeenAt ?? snapshot.observedAt : null;
    if (!baselined || Date.parse(baselineAt!) <= Date.parse(deadline!)) arm(baselineAt);
  }
  if (state && on && verdict && verdictKey !== state.verdict_key)
    added = emit(db, tasks, projectId, remoteId, identity, "ci", verdictKey!, { number: snapshot.number, head: snapshot.headSha, verdict: verdict.verdict, failed: verdict.failed }) || added;
  if (state && on && input.removal !== undefined) {
    const departed = state.queue_entry!;
    added = emit(db, tasks, projectId, remoteId, identity, "queue_removed", input.removal?.id ?? `entry:${departed}`, { number: snapshot.number, head: snapshot.headSha, reason: input.removal?.reason ?? null }) || added;
  }
  // An unknown queue read keeps the last known entry; a known one replaces it and dates when it was last seen queued.
  const known = snapshot.queueEntryId !== undefined;
  const queueEntry = known ? snapshot.queueEntryId ?? null : state?.queue_entry ?? null;
  const queueSeenAt = known ? (snapshot.queueEntryId ? snapshot.observedAt : null) : state?.queue_seen_at ?? null;
  db.prepare(`INSERT INTO pr_event_state(project_id, remote_id, initialized_at, verdict_key, queue_entry, queue_seen_at, merge_sha, merge_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(project_id, remote_id) DO UPDATE SET verdict_key=excluded.verdict_key, queue_entry=excluded.queue_entry, queue_seen_at=excluded.queue_seen_at, merge_sha=excluded.merge_sha, merge_seen_at=excluded.merge_seen_at, unlinked_at=NULL`)
    .run(projectId, remoteId, new Date(now).toISOString(), verdictKey ?? state?.verdict_key ?? null, queueEntry, queueSeenAt, mergeSha, mergeSeenAt);
  return added;
}

type Found = { runId: number; workflow: string; completedAt: string };
type Cursor = { createdAt: string; id: number };
/** A run kept for rechecks: `seen` is when it was last observed not yet a qualifying success, `tried` orders the rotation. */
type Kept = { id: number; seen: string; tried: string; unresolved?: boolean };
/** A creation-time range, whole seconds, both ends inclusive. A multi-page range is read last page first, with its total. */
type Range = { lo: string; hi: string; page?: number; total?: number; cursor?: Cursor };
/** Discovery state: ranges still to read, oldest first, up to the frozen `upper`; every run created up to `walkedTo` was examined. */
type Walk = { upper: string; walkedTo: string; ranges: Range[] };
const at = (iso: string) => Date.parse(iso);
const second = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
const afterCursor = (run: DeployRun, cursor: Cursor | undefined) =>
  !cursor || at(run.createdAt) > at(cursor.createdAt) || (at(run.createdAt) === at(cursor.createdAt) && run.id > cursor.id);
const backoff = (failures: number) => new Date(Date.now() + Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** Math.max(0, failures - 1))).toISOString();

const instances = new WeakMap<BbPluginApi, ReturnType<typeof createPrEventService>>();
export type PrEventService = ReturnType<typeof createPrEventService>;
export function prEventService(bb: BbPluginApi, tasks: TasksStore) {
  let found = instances.get(bb);
  if (!found) {
    found = createPrEventService(bb, tasks);
    instances.set(bb, found);
  }
  return found;
}

/** Exported so tests can run two independent drainers against one database; production code uses `prEventService`. */
export function createPrEventService(bb: BbPluginApi, tasks: TasksStore) {
  const db = bb.storage.database();
  const iso = () => new Date().toISOString();
  // Fences this instance's claims: another drainer recovers them only once the lease has run out.
  const owner = randomUUID();

  function settle(wait: WaitRow, state: "deployed" | "satisfied" | "expired" | "unverifiable", found: Found | null) {
    db.transaction(() => {
      const changed = db.prepare("UPDATE pr_deploy_waits SET state=?, found=?, settled_at=? WHERE project_id=? AND remote_id=? AND state='waiting'")
        .run(state, found ? JSON.stringify(found) : null, iso(), wait.project_id, wait.remote_id).changes;
      if (!changed || state === "satisfied" || prEventSettings(db, wait.project_id).events !== "on") return;
      const base = { number: wait.number, mergeSha: wait.merge_sha };
      if (state === "deployed") emit(db, tasks, wait.project_id, wait.remote_id, wait.identity, "deployed", wait.merge_sha, { ...base, workflow: found!.workflow, runId: found!.runId });
      else emit(db, tasks, wait.project_id, wait.remote_id, wait.identity, "deploy_wait_ended", wait.merge_sha, { ...base, workflows: JSON.parse(wait.workflows), days: wait.days, outcome: state });
    })();
  }

  /**
   * One bounded pass of a wait's deployment search. Discovery reads frozen creation-time ranges from the merge, oldest first,
   * splitting a range that does not fit one page; a past range never changes, so its pages stay stable. Runs that contain the merge
   * but are not yet a qualifying success are kept and rechecked, least recently tried first. A success qualifies when it completed by
   * the deadline. The earliest candidate settles only when every run created before its completion was examined and no kept run was
   * last seen before it; after the deadline, an unfinished search counts a pass and the third one ends as unverifiable.
   * At the sweep's `stopAt` (or when `signal` aborts) the pass keeps what it completed, counts no final pass and returns true.
   * A turn is recorded as the sweep's start `turnAt`, also when a `fresh` turn (one that started with most of the budget) is cut,
   * so a slow wait cannot take every sweep.
   */
  async function sweepWait(wait: WaitRow, client: GithubClient, pollMs: number, signal: AbortSignal, stopAt: number, turnAt: string, fresh: boolean) {
    const now = Date.now(), final = now > at(wait.deadline);
    const budget = final ? deployBudgets.final : deployBudgets.pass;
    const workflows: string[] = JSON.parse(wait.workflows);
    const deadlineEnd = second(at(wait.deadline) + 999);
    // The final range waits out the same listing lag; until then a pass after the deadline is not a final pass yet.
    const upperNow = second(Math.min(now - LISTING_LAG_MS, at(deadlineEnd)));
    const readable = now - LISTING_LAG_MS >= at(deadlineEnd);
    const lo = second(at(wait.merged_at));
    const walk: Walk = wait.walk ? JSON.parse(wait.walk) : { upper: second(at(lo) - 1000), walkedTo: second(at(lo) - 1000), ranges: [] };
    let kept: Kept[] = JSON.parse(wait.kept);
    let found: Found | null = wait.found ? JSON.parse(wait.found) : null;
    // A walk that has read everything up to its frozen bound extends it to the next frozen bound.
    if (!walk.ranges.length && at(walk.upper) < at(upperNow)) {
      walk.ranges.push({ lo: second(at(walk.upper) + 1000), hi: upperNow });
      walk.upper = upperNow;
    }
    const workflowOf = (run: DeployRun) => workflows.find((workflow) => run.name === workflow || String(run.workflowId) === workflow);
    const consider = (run: DeployRun, completedAt: string) => {
      if (!found || at(completedAt) < at(found.completedAt)) found = { runId: run.id, workflow: workflowOf(run) ?? run.name ?? String(run.workflowId), completedAt };
    };
    // GitHub may show a run unfinished for a while after it completed, so a read rules out completions only up to the lag before it.
    const visible = (readAt: string) => new Date(at(readAt) - LISTING_LAG_MS).toISOString();
    /** Kept entry for a run that is not settled by this observation, or null when it no longer needs a recheck. */
    const classify = (run: DeployRun, readAt: string): Kept | null => {
      if (run.status === "completed" && run.conclusion === "success") {
        // shortcut: a run's latest attempt stands for it, so a success replaced by a later failed rerun is not seen; read attempts if that matters.
        // A success without a completion time is unresolved; its completion is no earlier than its creation.
        if (!run.updatedAt) return { id: run.id, seen: run.createdAt, tried: readAt, unresolved: true };
        if (at(run.updatedAt) <= at(wait.deadline)) consider(run, run.updatedAt);
        return null;
      }
      // Read once the listing lag past the deadline is over, a run's next completion can only come later, so it can no longer
      // qualify; read earlier, it may have finished just before the cutoff without GitHub showing it yet, so it stays kept.
      return readable ? null : { id: run.id, seen: visible(readAt), tried: readAt };
    };
    const over = () => signal.aborted || Date.now() >= stopAt;
    // No read starts past the sweep deadline, and every read ends at it, even one a client cannot cancel.
    const bounded = <T>(read: () => Promise<T>) => over()
      ? Promise.reject(new DOMException("Sweep budget used", "AbortError"))
      : Promise.race([read(), new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
    let failed = false, cut = false;
    // A failed request cuts its own phase only: discovery and the kept-run rechecks each keep their progress.
    const failure = (phase: string, error: unknown) => {
      if (error instanceof Error && error.name === "AbortError") return !(cut = over());
      failed = true;
      bb.log.warn(`PR deployment ${phase} for ${wait.repository}#${wait.number} failed: ${errorMessage(error)}`);
      return false;
    };
    try {
      if (!client.pushRuns || !client.compareStatus) throw new Error("GitHub run lookups unavailable");
      const { pushRuns, compareStatus } = client;
      let pages = 0, compares = 0;
      /** Examine one page of a range oldest first; false when the compare budget ran out (the range cursor keeps the progress). */
      const examine = async (range: Range, runs: DeployRun[], readAt: string) => {
        for (const run of runs.filter((value) => afterCursor(value, range.cursor)).sort((left, right) => at(left.createdAt) - at(right.createdAt) || left.id - right.id)) {
          // The page is the oldest unread part of a past range, so every run created before this one's second has been examined.
          const before = second(at(run.createdAt) - 1000);
          if (at(before) > at(walk.walkedTo)) walk.walkedTo = before;
          if (run.event === "push" && run.headBranch === wait.base_branch && workflowOf(run)) {
            let contains = run.headSha === wait.merge_sha;
            if (!contains) {
              if (compares >= budget.compares) return false;
              compares++;
              contains = ["ahead", "identical"].includes(await bounded(() => compareStatus(wait.repository, wait.merge_sha, run.headSha)));
            }
            const entry = contains ? classify(run, readAt) : null;
            if (entry && !kept.some((value) => value.id === run.id)) kept.push(entry);
          }
          range.cursor = { createdAt: run.createdAt, id: run.id };
        }
        return true;
      };
      const done = (range: Range) => { walk.walkedTo = range.hi; walk.ranges.shift(); };
      while (walk.ranges.length && pages < budget.pages) {
        const range = walk.ranges[0]!, readAt = iso();
        const page = await bounded(() => pushRuns(wait.repository, wait.base_branch, `${range.lo}..${range.hi}`, range.page ?? 1));
        pages++;
        if (range.page === undefined) {
          // GitHub caps a filtered listing at 1,000 runs and pages shift as totals change, so a busy range is split until one page holds it.
          if (page.total > 100 && at(range.hi) - at(range.lo) >= 1000) {
            const middle = second((at(range.lo) + at(range.hi)) / 2);
            walk.ranges.splice(0, 1, { lo: range.lo, hi: middle }, { lo: second(at(middle) + 1000), hi: range.hi });
            continue;
          }
          // shortcut: more than 1,000 runs created in one second cannot be listed; the search stays unfinished.
          if (page.total > 1000) break;
          range.total = page.total;
          range.page = Math.max(1, Math.ceil(page.total / 100));
          if (range.page > 1) continue;
        } else if (page.total !== range.total) {
          delete range.page; delete range.total;
          continue;
        }
        if (!(await examine(range, page.runs, readAt))) break;
        if (range.page === 1) done(range);
        else range.page--;
      }
    } catch (error) {
      // A disposed plugin cut the pass; that is no evidence about the wait.
      if (failure("discovery", error)) return;
    }
    if (!cut) try {
      if (!client.workflowRunById) throw new Error("GitHub run lookups unavailable");
      const { workflowRunById } = client;
      // Least recently tried first, and errors per run, so one unreadable run never blocks the others.
      for (const entry of [...kept].sort((left, right) => at(left.tried) - at(right.tried)).slice(0, budget.rechecks)) {
        const readAt = iso();
        try {
          const next = classify(await bounded(() => workflowRunById(wait.repository, entry.id)), readAt);
          kept = kept.filter((value) => value.id !== entry.id);
          if (next) kept.push(next);
        } catch (error) {
          if (error instanceof Error && error.name === "AbortError") throw error;
          Object.assign(entry, { tried: readAt, unresolved: true });
        }
      }
    } catch (error) {
      if (failure("recheck", error)) return;
    }
    const settled = found as Found | null;
    // Completed progress is kept and the wait stays due; a wait cut after others used up the budget keeps its retry priority.
    // A last read that ended past the deadline counts as cut too, so it never settles the wait or charges a final pass.
    if (cut || over()) {
      db.prepare("UPDATE pr_deploy_waits SET walk=?, kept=?, found=?, swept_at=COALESCE(?, swept_at) WHERE project_id=? AND remote_id=? AND state='waiting'")
        .run(JSON.stringify(walk), JSON.stringify(kept), settled ? JSON.stringify(settled) : null, fresh ? turnAt : null, wait.project_id, wait.remote_id);
      return true;
    }
    if (settled && at(walk.walkedTo) >= at(settled.completedAt) && !kept.some((entry) => at(entry.seen) < at(settled.completedAt)))
      return settle(wait, wait.baseline_at && at(settled.completedAt) <= at(wait.baseline_at) ? "satisfied" : "deployed", settled);
    if (final && !failed && !walk.ranges.length && at(walk.upper) >= at(deadlineEnd) && !kept.length && !settled) return settle(wait, "expired", null);
    const passes = final && readable ? wait.final_passes + 1 : wait.final_passes;
    if (final && readable && passes >= FINAL_PASSES) return settle(wait, "unverifiable", null);
    db.prepare("UPDATE pr_deploy_waits SET walk=?, kept=?, found=?, final_passes=?, next_sweep_at=?, swept_at=? WHERE project_id=? AND remote_id=? AND state='waiting'")
      .run(JSON.stringify(walk), JSON.stringify(kept), settled ? JSON.stringify(settled) : null, passes, new Date(Date.now() + pollMs).toISOString(), turnAt, wait.project_id, wait.remote_id);
    return false;
  }

  /**
   * Advance the due post-merge waits of these projects that still have an eligible link, least recently swept first across projects,
   * until `stopAt` or until `signal` aborts; the others keep their state and cost no request. `remaining` counts the due waits a stop
   * left unfinished.
   */
  async function sweep(projectIds: string[], client: GithubClient, signal: AbortSignal, stopAt: number) {
    const startedAt = Date.now(), turnAt = new Date(startedAt).toISOString();
    const polls = new Map<string, number>();
    for (const projectId of projectIds) {
      const config = createGitSyncStore(db).config(projectId);
      if (config.enabled && prEventSettings(db, projectId).events === "on") polls.set(projectId, config.pollMinutes * 60_000);
    }
    const ids = [...polls.keys()];
    // SQLite sorts NULL first, so a wait never swept goes ahead. Turns of one sweep share its start time; a cut one kept its older due
    // time while a finished one moved it a poll ahead, so the cut wait gets the next sweep's first slot.
    const due = ids.length ? db.prepare<string[], WaitRow>(`SELECT * FROM pr_deploy_waits WHERE project_id IN (${ids.map(() => "?").join(",")}) AND state='waiting' AND (next_sweep_at IS NULL OR next_sweep_at <= ?) ORDER BY swept_at, next_sweep_at, deadline`).all(...ids, iso()) : [];
    let advanced = 0;
    for (const [index, wait] of due.entries()) {
      if (signal.aborted || Date.now() >= stopAt) return { advanced, remaining: due.length - index };
      if (!eligibleLinks(db, tasks, wait.project_id, wait.remote_id, wait.identity, "deployed").length) continue;
      advanced++;
      const fresh = stopAt - Date.now() >= (stopAt - startedAt) / 2;
      if (await sweepWait(wait, client, polls.get(wait.project_id)!, signal, stopAt, turnAt, fresh)) return { advanced, remaining: due.length - index };
    }
    return { advanced, remaining: 0 };
  }

  const setState = (id: string, from: string[], state: string, extra: Record<string, unknown> = {}, owned = false) => {
    const columns = Object.keys(extra);
    return db.prepare(`UPDATE pr_event_deliveries SET state=?, updated_at=?${columns.map((column) => `, ${column}=?`).join("")} WHERE id=? AND state IN (${from.map(() => "?").join(",")})${owned ? " AND claim_owner=?" : ""}`)
      .run(state, iso(), ...Object.values(extra), id, ...from, ...(owned ? [owner] : [])).changes > 0;
  };
  /** A move of a row this drainer claimed; it fails once another drainer has recovered the claim. */
  const own = (id: string, from: string[], state: string, extra: Record<string, unknown> = {}) => setState(id, from, state, extra, true);

  /** Why a delivery is no longer due, or null when it still is: the link, the card status and both switches, read now. */
  function stale(row: DeliveryRow): string | null {
    const config = createGitSyncStore(db).config(row.project_id);
    const settings = prEventSettings(db, row.project_id);
    if (!config.enabled || settings.events !== "on") return "off";
    if (row.role === "manager" && settings.manager !== "on") return "manager_off";
    if (!tasks.getTask(row.task_id)) return "card_gone";
    return eligibleLinks(db, tasks, row.project_id, row.remote_id, row.identity, row.kind).includes(row.task_id) ? null : "not_eligible";
  }

  /**
   * Settle rows a restart or a lost reply left half-sent, from the marker in the recipient's queue or history. Only abandoned claims
   * are touched: this drainer's own (its drains run one at a time, so none is in flight here) and others' past the lease.
   */
  async function reconcile() {
    const abandoned = (prefix = "") => `(${prefix}claim_owner IS NULL OR ${prefix}claim_owner=? OR ${prefix}claimed_at IS NULL OR ${prefix}claimed_at < ?)`;
    const lease = new Date(Date.now() - claimLease.ms).toISOString();
    // A claim without a started transport proves nothing went out, so it is offered again.
    db.prepare(`UPDATE pr_event_deliveries SET state='pending', claim_owner=NULL, updated_at=? WHERE state='claimed' AND transport_started_at IS NULL AND ${abandoned()}`).run(iso(), owner, lease);
    const since = new Date(Date.now() - LATE_SEARCH_MS).toISOString();
    // Least recently searched first, so a busy batch of unproven sends cannot starve the rest of the window.
    const rows = db.prepare<[string, string, string], DeliveryRow>(
      `SELECT d.*, e.project_id, e.remote_id, e.identity, e.kind, e.payload FROM pr_event_deliveries d JOIN pr_events e ON e.id=d.event_id
       WHERE ((d.state='sending' AND ${abandoned("d.")}) OR (d.state='unknown' AND d.transport_started_at > ?)) AND d.marker IS NOT NULL
       ORDER BY COALESCE(d.searched_at, ''), d.transport_started_at LIMIT 20`,
    ).all(owner, lease, since);
    for (const row of rows) {
      const search = await searchAttentionMarker(bb, row.thread_id!, row.marker!, row.transport_started_at ?? undefined, row.cursor ? JSON.parse(row.cursor) as HistoryCursor : {});
      // The writes hold only while the row still carries the attempt this search was for: a newer attempt keeps its own state and cursor.
      const same = (state: string, extra: Record<string, unknown>) =>
        db.prepare(`UPDATE pr_event_deliveries SET state=?, updated_at=?${Object.keys(extra).map((column) => `, ${column}=?`).join("")} WHERE id=? AND state=? AND marker=? AND claim_owner IS ?`)
          .run(state, iso(), ...Object.values(extra), row.id, row.state, row.marker, row.claim_owner);
      if (search.receipt) same("sent", { error: null, cursor: null, searched_at: iso() });
      // No marker found is not proof of failure, so the row stays unknown and is never resent.
      else same("unknown", { cursor: JSON.stringify(search.cursor), searched_at: iso(), error: search.error ?? (row.state === "sending" ? "No receipt found after a restart" : null) });
    }
  }

  /** One attempt at a listed row; true when it needed the unfinished environment lookup and was put back for later in the drain. */
  async function deliver(listed: DeliveryRow, environments: EnvironmentRead): Promise<boolean> {
    // The claim rechecks the listed state and the backoff and returns the counters and hold deadline it claimed, so a stale listing
    // never reuses an attempt number or misses a deadline another drainer set meanwhile.
    const claimed = db.prepare<[string, string, string, string, string, string], { attempts: number; lookup_failures: number; held_until: string | null }>(
      "UPDATE pr_event_deliveries SET state='claimed', claim_owner=?, claimed_at=?, transport_started_at=NULL, woken_at=NULL, updated_at=? WHERE id=? AND state=? AND (next_attempt_at IS NULL OR next_attempt_at <= ?) RETURNING attempts, lookup_failures, held_until",
    ).get(owner, iso(), iso(), listed.id, listed.state, iso());
    if (!claimed) return false;
    const row = { ...listed, ...claimed };
    // The lease is renewed for as long as this attempt is active, however long a lookup or a queued send takes.
    const renewal = setInterval(() => {
      try {
        db.prepare("UPDATE pr_event_deliveries SET claimed_at=? WHERE id=? AND claim_owner=? AND state IN ('claimed', 'sending')").run(iso(), row.id, owner);
      } catch { /* a closed database ends the attempt anyway */ }
    }, claimLease.renewMs);
    renewal.unref?.();
    try {
      return (await attemptDelivery(row, environments)) === true;
    } finally {
      clearInterval(renewal);
    }
  }

  async function attemptDelivery(row: DeliveryRow, environments: EnvironmentRead): Promise<boolean | void> {
    const ambiguous = () => void own(row.id, ["claimed"], "no_recipient:ambiguous", { claim_owner: null });
    // A row that was held ends at its deadline wherever it is, through retries, recovery and a resolution that crossed it.
    const expired = () => row.held_until !== null && Date.now() >= Date.parse(row.held_until);
    /** A recipient read failed for a transient reason: offer the row again after a growing delay, never past its hold deadline. */
    const retryLater = (error: string) => {
      if (expired()) return ambiguous();
      const next = backoff(row.lookup_failures + 1);
      own(row.id, ["claimed"], "pending", {
        error, claim_owner: null, lookup_failures: row.lookup_failures + 1, next_attempt_at: row.held_until !== null && Date.parse(row.held_until) < Date.parse(next) ? row.held_until : next,
      });
    };
    const reason = stale(row);
    if (reason) return void own(row.id, ["claimed"], `skipped:${reason}`);
    const attempt = row.attempts + 1, marker = prEventMarker(row.id, attempt);
    const linkOf = () => {
      const saved = db.prepare<[string, string, string], { payload: string }>(
        "SELECT payload FROM task_pr_links WHERE task_id=? AND (json_extract(payload, '$.remoteId')=? OR (json_extract(payload, '$.remoteId') IS NULL AND identity=?))",
      ).get(row.task_id, row.remote_id, row.identity);
      return saved ? prLinkSchema.parse(JSON.parse(saved.payload)) : undefined;
    };
    let threadId: string;
    for (let tries = 1; ; tries++) {
      /** Whether the link still has the identity and owner this resolution used; checked in the transaction that moves the row. */
      let unchanged = () => true;
      if (row.role === "session") {
        if (expired()) return ambiguous();
        const link = linkOf();
        // The link's current identity only: the event's older path may belong to another repository after a rename.
        const owner = link?.ownerThreadId, identity = link ? prIdentity(link) : row.identity;
        let linked: string[] | undefined;
        unchanged = () => {
          const now = linkOf();
          return now?.ownerThreadId === owner && (now ? prIdentity(now) : row.identity) === identity &&
            // A session linked or detached during resolution may change which one is the card's root.
            (!linked || tasks.listTaskThreads(row.task_id).map((thread) => thread.threadId).sort().join() === linked.join());
        };
        const onPr = async (threadIds: string[]) => {
          const found = await environments(false);
          if (!found) return null;
          const on = new Set<string>();
          for (const id of threadIds) {
            // A thread the lookup did not read, or an environment it could not, leaves the lookup incomplete.
            if (!found.seen.has(id)) return null;
            const environmentId = found.environmentOf.get(id);
            if (!environmentId) continue;
            const pr = found.prs.get(environmentId);
            if (!pr || pr.outcome === "unavailable") return null;
            if (pr.outcome === "available" && identityOf(pr.pullRequest.url) === identity) on.add(id);
          }
          return on;
        };
        let recipient: Awaited<ReturnType<typeof resolvePrRecipient>>;
        try {
          recipient = await resolvePrRecipient(bb, tasks, row.task_id, { ownerThreadId: owner, onPr });
        } catch (error) {
          // The lookup is still running: give the row back so the rows that need no lookup go first.
          if (error === LOOKUP_PENDING) return own(row.id, ["claimed"], row.state, { claim_owner: null });
          // An owner named during the failed read is resolved now, not after the backoff (`wake` skipped this claimed row).
          const recorded = db.transaction(() => {
            if (!unchanged()) return false;
            retryLater(errorMessage(error));
            return true;
          })();
          if (recorded) return;
          if (tries === 3) return void retryLater("The PR link kept changing during delivery");
          continue;
        }
        if (recipient === "hold" || !recipient) {
          const settled = db.transaction(() => {
            if (!unchanged()) return false;
            if (!recipient) return void own(row.id, ["claimed"], "no_recipient"), true;
            const until = row.held_until ? Date.parse(row.held_until) : Date.parse(row.created_at) + HOLD_MS;
            if (Date.now() >= until) return ambiguous(), true;
            own(row.id, ["claimed"], "awaiting_owner", {
              claim_owner: null, held_until: new Date(until).toISOString(), next_attempt_at: new Date(Math.min(Date.now() + HOLD_RECHECK_MS, until)).toISOString(),
              error: "Several sessions could take this message (no single root session; could not identify a unique session on the PR); name the one that opened the PR with `bb work-board pr link KEY --url URL --owner thr_…`",
            });
            return true;
          })();
          if (settled) return;
          if (tries === 3) return void retryLater("The PR link kept changing during delivery");
          continue;
        }
        threadId = recipient.threadId;
        linked = recipient.linked;
      } else {
        const lookup = await attentionService(bb).lookupManager(configuredManager(db, row.project_id));
        if (lookup.status === "unavailable") return void retryLater(lookup.error);
        if (lookup.status === "unusable") return void own(row.id, ["claimed"], `skipped:${lookup.cause}`);
        threadId = lookup.threadId;
      }
      const target = threadId;
      // An owner named or a repository renamed while the recipient was being resolved sends the row back to resolution.
      const moved = db.transaction(() => {
        if (!unchanged()) return "changed";
        if (expired()) return ambiguous(), "done";
        // One card's session and manager copies to the same thread make one message.
        if (db.prepare("SELECT 1 FROM pr_event_deliveries WHERE event_id=? AND task_id=? AND id<>? AND thread_id=? AND state IN ('sending', 'sent', 'unknown')").get(row.event_id, row.task_id, row.id, target))
          return void own(row.id, ["claimed"], "skipped:same_thread", { thread_id: target }), "done";
        // `sending` and its start time are written before transport, so a restart can tell a claim from a send that may have gone out.
        return own(row.id, ["claimed"], "sending", { thread_id: target, attempts: attempt, transport_started_at: iso(), marker, cursor: null, searched_at: null }) ? "sending" : "done";
      })();
      if (moved === "sending") break;
      if (moved === "done") return;
      if (tries === 3) return void retryLater("The PR link kept changing during delivery");
    }
    const task = tasks.getTask(row.task_id)!;
    let dropped: string | null = null;
    let receipt: Receipt;
    try {
      receipt = await deliverWithReceipt(bb, threadId, prEventText(row.kind, JSON.parse(row.payload), task.key), marker, { fresh: true, guard: () => !(dropped = stale(row)) });
    } catch (error) {
      receipt = { outcome: "unknown", error: errorMessage(error) };
    }
    // A definite result of this very attempt (same owner and marker) also overrides an `unknown` another drainer set meanwhile.
    const definite = (state: string, extra: Record<string, unknown>) =>
      db.prepare(`UPDATE pr_event_deliveries SET state=?, updated_at=?${Object.keys(extra).map((column) => `, ${column}=?`).join("")} WHERE id=? AND claim_owner=? AND marker=? AND state IN ('sending', 'unknown')`)
        .run(state, iso(), ...Object.values(extra), row.id, owner, marker);
    // The guard refused before the send, which proves nothing went out.
    if (dropped) return void definite(`skipped:${dropped}`, { transport_started_at: null });
    if (receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline") definite("sent", { error: null });
    // Three transport attempts in total: a definite rejection is retried twice at most.
    else if (receipt.outcome === "failed") definite(attempt < MAX_ATTEMPTS ? "pending" : "failed", { error: receipt.error, claim_owner: null });
    // An inline send whose acceptance has not shown yet is searched later like any other unproven write.
    else own(row.id, ["sending"], "unknown", { error: receipt.outcome === "unknown" ? receipt.error : "Awaiting the accepted-input event" });
  }

  /**
   * The environment PR of every thread linked to these cards, read once and within the deadline; null when it failed or ran out of
   * time, so a slow GitHub PR Status never delays delivery.
   */
  function readEnvironments(taskIds: string[]): Promise<Environments | null> {
    const controller = new AbortController();
    const read = async (): Promise<Environments> => {
      const ids = [...new Set(tasks.listTaskThreadsForTasks(taskIds).map((link) => link.threadId))];
      const seen = new Set<string>(), environmentOf = new Map<string, string>();
      for (let offset = 0; offset < ids.length; offset += 200) {
        const batch = ids.slice(offset, offset + 200);
        for (const thread of await bb.sdk.threads.list({ threadIds: batch, limit: batch.length, includeHidden: true, signal: controller.signal })) {
          seen.add(thread.id);
          if (thread.environmentId) environmentOf.set(thread.id, thread.environmentId);
        }
      }
      const prs = await environmentPullRequests(bb, environmentOf.values(), () => !controller.signal.aborted);
      if (controller.signal.aborted) throw new Error("Environment lookup timed out");
      return { seen, environmentOf, prs };
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<null>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, environmentLookup.deadlineMs);
      timer.unref?.();
    });
    return Promise.race([read().catch(() => null), deadline]).finally(() => clearTimeout(timer));
  }

  /** Make this card's held messages about the PR due now, after an owner was named; true when there were any. */
  function wake(link: PrLink) {
    // A held row back in `pending` after a retry or a recovered claim still counts: its deadline marks it.
    return db.prepare("UPDATE pr_event_deliveries SET next_attempt_at=NULL, woken_at=?, updated_at=? WHERE task_id=? AND held_until IS NOT NULL AND state IN ('pending', 'awaiting_owner') AND event_id IN (SELECT id FROM pr_events WHERE remote_id=? OR identity=?)")
      .run(iso(), iso(), link.taskId, link.remoteId ?? "", prIdentity(link)).changes > 0;
  }

  async function drainOnce() {
    await reconcile();
    // Rows woken by an owner designation go first; new and retried rows and due hold rechecks each get their own batch after them,
    // so held rows never crowd out a ready one.
    const batch = (where: string) => db.prepare<[string], DeliveryRow>(
      `SELECT d.*, e.project_id, e.remote_id, e.identity, e.kind, e.payload FROM pr_event_deliveries d JOIN pr_events e ON e.id=d.event_id WHERE ${where} AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?) ORDER BY d.created_at, d.role DESC LIMIT 200`,
    ).all(iso());
    const woken = () => batch("d.woken_at IS NOT NULL AND d.state IN ('pending', 'awaiting_owner')");
    let rows = [...woken(), ...batch("d.woken_at IS NULL AND d.state='pending'"), ...batch("d.woken_at IS NULL AND d.state='awaiting_owner'")];
    // At most one environment lookup per drain, for every session row that needs it. Rows that need it wait for a second pass,
    // so a slow lookup never delays the rows that resolve without it.
    let lookup: Promise<Environments | null> | undefined, settled = false;
    const sessionTasks = [...new Set(rows.filter((row) => row.role === "session").map((row) => row.task_id))];
    const environments = (wait: boolean) => {
      lookup ??= readEnvironments(sessionTasks).finally(() => { settled = true; });
      if (!wait && !settled) throw LOOKUP_PENDING;
      return lookup;
    };
    const attempt = async (row: DeliveryRow, read: EnvironmentRead) => {
      try {
        return await deliver(row, read);
      } catch (error) {
        bb.log.warn(`PR event delivery ${row.id} failed: ${errorMessage(error)}`);
        return false;
      }
    };
    const seen = new Set<string>();
    // A claim clears `woken_at`, so each further batch of woken rows is new; `seen` still bounds the loop if a claim is lost.
    while (rows.length) {
      const waiting: DeliveryRow[] = [];
      for (const row of rows) {
        seen.add(row.id);
        if (await attempt(row, environments)) waiting.push(row);
      }
      for (const row of waiting) await attempt(row, () => environments(true));
      rows = woken().filter((row) => !seen.has(row.id));
    }
  }
  // Drains in this process run one after another; the conditional claim keeps any other drainer from sending a row twice.
  let chain: Promise<void> = Promise.resolve();
  function drain(): Promise<void> {
    chain = chain.then(drainOnce).catch((error: unknown) => bb.log.warn(`PR event drain failed: ${errorMessage(error)}`));
    return chain;
  }

  /** Delivery history goes after 30 days; once-keys, state and waits stay while the PR is linked and 90 days after. */
  function prune(now = Date.now()) {
    db.transaction(() => {
      db.prepare("DELETE FROM pr_event_deliveries WHERE created_at < ?").run(new Date(now - DELIVERY_RETENTION_MS).toISOString());
      const linked = "EXISTS (SELECT 1 FROM task_pr_links l JOIN tasks t ON t.id=l.task_id WHERE t.project_id=s.project_id AND json_extract(l.payload, '$.remoteId')=s.remote_id AND COALESCE(json_extract(l.payload, '$.excluded'), 0)=0)";
      db.prepare(`UPDATE pr_event_state AS s SET unlinked_at = CASE WHEN ${linked} THEN NULL ELSE COALESCE(unlinked_at, ?) END`).run(new Date(now).toISOString());
      const gone = "SELECT project_id, remote_id FROM pr_event_state WHERE unlinked_at < ?", cutoff = new Date(now - UNLINKED_RETENTION_MS).toISOString();
      for (const table of ["pr_events", "pr_deploy_waits"]) db.prepare(`DELETE FROM ${table} WHERE (project_id, remote_id) IN (${gone})`).run(cutoff);
      db.prepare("DELETE FROM pr_event_state WHERE unlinked_at < ?").run(cutoff);
    })();
  }

  function list(taskId: string, limit = 50) {
    return db.prepare<[string, number], { id: string; kind: PrEventKind; once_key: string; payload: string; identity: string; created_at: string; role: string; state: string; thread_id: string | null; attempts: number; error: string | null; updated_at: string }>(
      "SELECT d.id, e.kind, e.once_key, e.payload, e.identity, e.created_at, d.role, d.state, d.thread_id, d.attempts, d.error, d.updated_at FROM pr_event_deliveries d JOIN pr_events e ON e.id=d.event_id WHERE d.task_id=? ORDER BY e.created_at DESC, d.role DESC LIMIT ?",
    ).all(taskId, limit).map((row) => {
      const task = tasks.getTask(taskId);
      const payload: Payload = JSON.parse(row.payload);
      return { deliveryId: row.id, kind: row.kind, role: row.role, state: row.state, threadId: row.thread_id, attempts: row.attempts, error: row.error,
        createdAt: row.created_at, updatedAt: row.updated_at, pr: `${row.identity.replace(/^github:github\.com:/, "")}`, text: prEventText(row.kind, payload, task?.key ?? taskId) };
    });
  }

  return { sweep, drain, prune, list, reconcile, wake };
}
