import { z } from "zod";
import { BUILD_REASON, INHERIT_WAIT_MS, INHERITABLE, inheritable, queuePullRequest, type MassCancel } from "./ci-classify";
import { alertProblemId, CLASS_ORDER, codeBrokenVerdict } from "./ci-problems";
import type { CiInsights } from "./ci-insights";
import type { ClassifiedJob, FailureClass, JobRecord, PoolQueueState, Signal } from "./ci-jobs-types";
import { jobRef, poolRef, queueRef, runRef } from "./ci-refs";
import type { GitHubRequest } from "./metrics";

// Server-only. Observer threads get short, classified CI event lines pushed to them so agents watching CI do not poll.
// Safety rule for every line built here: labels, ids, names and links only; never log text, signature matches or env values.

export const OBSERVER_TYPES = ["queue", "loss", "red", "stall", "mass", "deploy"] as const;
export type ObserverType = typeof OBSERVER_TYPES[number];
export const OBSERVER_TYPE_SETTINGS = { queue: "observeQueueRemoval", loss: "observeRunnerLoss", red: "observeDefaultRed", stall: "observePoolStall", mass: "observeMassCancel", deploy: "observeDeployments" } as const;
export const OBSERVER_TYPE_LABELS: Record<ObserverType, string> = { queue: "merge queue removals", loss: "runner losses", red: "default-branch red", stall: "pool stalls", mass: "mass cancels", deploy: "deployments" };
export const enabledEvents = (values: Partial<Record<string, unknown>>) => Object.fromEntries(OBSERVER_TYPES.map((type) => [type, values[OBSERVER_TYPE_SETTINGS[type]] !== false])) as Record<ObserverType, boolean>;

// --- observer thread list (setting value: comma-separated BB thread ids) ---
export const MAX_OBSERVERS = 10;
const THREAD_ID = /^thr_[a-z0-9]+$/;
export const parseObserverThreads = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
export const isThreadId = (id: string) => THREAD_ID.test(id);
export const observerThreadsSchema = z.string().max(2000).superRefine((value, context) => {
  const ids = parseObserverThreads(value);
  for (const id of ids) if (!isThreadId(id)) context.addIssue({ code: "custom", message: `"${id.slice(0, 40)}" is not a BB thread id (thr_ followed by lowercase letters and digits)` });
  if (ids.length > MAX_OBSERVERS) context.addIssue({ code: "custom", message: `At most ${MAX_OBSERVERS} observer threads are allowed` });
});

// --- persisted state ---
/** Shared by all repositories: when each thread subscribed and each event type was switched on. Older events are never sent. */
export const globalStateSchema = z.object({ threads: z.record(z.string(), z.number()), types: z.record(z.string(), z.number()) });
export type ObserverGlobal = { threads: Record<string, number>; types: Partial<Record<ObserverType, number>> };
const renderedSchema = z.object({ key: z.string(), type: z.enum(OBSERVER_TYPES), at: z.number(), text: z.string() });
export type Rendered = z.infer<typeof renderedSchema>;
/** Per repository: keys already announced (with the time), events waiting for the next digest, deployments already seen in a final state. */
export const repoStateSchema = z.object({ sent: z.record(z.string(), z.number()), pending: z.array(renderedSchema), pendingSince: z.number().nullable(), deploys: z.record(z.string(), z.number()) });
export type ObserverRepoState = z.infer<typeof repoStateSchema>;
export const emptyGlobal = (): ObserverGlobal => ({ threads: {}, types: {} });
export const emptyRepoState = (): ObserverRepoState => ({ sent: {}, pending: [], pendingSince: null, deploys: {} });

// --- lines ---
export const PREFIX = "[CI Dashboard]";
const MAX_LINE = 400, MAX_TESTS = 3, MAX_JOBS = 4, MAX_DIGEST = 30;
const squash = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
/** One line, at most ~400 characters; the link at the end is never the part that gets cut. */
export const fit = (body: string, url?: string, tag = "") => `${clip(squash(body), MAX_LINE - tag.length - (url ? url.length + 1 : 0))}${tag}${url ? ` ${url}` : ""}`;
/** Marks a line with the open problem it is about, so an agent can claim it with ci_dashboard_manage. Never clipped. */
const problemTag = (problem?: string) => problem ? ` · problem ${problem}` : "";
/** Names the ref to pass to ci_dashboard_metrics (ref=...) for the details this line leaves out. Never clipped. */
const inspectTag = (ref: string) => ` · inspect ${ref}`;
const runUrl = (repository: string, runId: number) => `https://github.com/${repository}/actions/runs/${runId}`;
const jobUrl = (repository: string, job: Pick<JobRecord, "runId" | "jobId">) => `${runUrl(repository, job.runId)}/job/${job.jobId}`;
const sha7 = (sha: string) => sha.slice(0, 7) || "unknown";
const more = (items: string[], max: number) => items.length > max ? `${items.slice(0, max).join(", ")}, +${items.length - max}` : items.join(", ");
const completedAt = (job: JobRecord) => Date.parse(job.completedAt ?? job.createdAt);

export type ObserverEvent = {
  type: ObserverType; key: string;
  /** When the thing happened; events from before the type or the thread was switched on are never sent. */
  at: number;
  /** "once": one message per key for as long as the key is remembered. "quiet": a key that reopens (a stall) is repeated only after the quiet window. */
  dedupe: "once" | "quiet";
  /** `problem`: the id of the open problem this event maps to, when it does (passed in by the caller, which knows the open problems). */
  render: (tests?: string[] | null, problem?: string) => string;
  /** Id the event's problem would have; it counts only while that problem is open (events of info signals or old runs are not problems). */
  problem?: string;
  /** Present when the line can name failed tests; the caller looks them up only for events that are really going out. */
  tests?: { run: { id: number; attempt: number }; jobs: JobRecord[] };
  /** A queue removal to confirm against the PR's RemovedFromMergeQueueEvent at or after `since` before it goes out. */
  removal?: { pullRequest: number; since: number };
};

// Failures nobody caused: cancelled by the run itself, by concurrency or by a person.
const NOT_OWN = new Set<FailureClass>(["collateral_cancel", "superseded", "manual_cancel"]);
// A group run that only failed through an aggregator or cancellations (e.g. the group ahead left the queue) did not remove its PR.
const OWN_FAILURE = (c: ClassifiedJob) => !NOT_OWN.has(c.class) && c.class !== "consequence";
const TEST_CLASSES = new Set<FailureClass>(["real", "flake", "unknown", "transient"]);
// Each merge queue group runs on its own merge commit, so losses are counted per PR head across its groups (retry budgets are per head);
// without a known PR head (no stored pull_request run before the group) the PR number stands in.
const lossKey = (job: JobRecord) => job.event !== "merge_group" ? job.headSha : job.prHead ?? `pr:${queuePullRequest(job.headBranch) ?? job.headSha}`;
/** Sets `prHead` on merge queue jobs: the head sha of the PR's latest pull_request job created at or before the group job. */
export function attachPrHeads(jobs: JobRecord[], classified: ClassifiedJob[]): void {
  const heads = new Map<number, { at: string; sha: string }[]>();
  for (const j of jobs) if (j.event === "pull_request" && j.headSha) for (const pr of j.pullRequests) heads.set(pr, [...(heads.get(pr) ?? []), { at: j.createdAt, sha: j.headSha }]);
  for (const list of heads.values()) list.sort((a, b) => a.at.localeCompare(b.at));
  for (const { job } of classified) {
    if (job.event !== "merge_group") continue;
    const list = heads.get(queuePullRequest(job.headBranch) ?? -1) ?? [];
    let found: string | undefined;
    for (const head of list) { if (head.at > job.createdAt) break; found = head.sha; }
    if (found) job.prHead = found;
  }
}
// Losses in a group the queue invalidated never count against the head's budget.
// Nor do losses in a group whose removal GitHub never confirmed (`rejected` queue keys): the PR stayed queued, the group was superseded.
const headLosses = (classified: ClassifiedJob[], job: JobRecord, rejected: ReadonlySet<string>) => classified.filter((c) => c.class === "runner_loss" && lossKey(c.job) === lossKey(job)
  && !(c.job.event === "merge_group" && (invalidated(classified, c.job.runId, c.job.attempt)
    || (rejected.has(`queue:${c.job.runId}:${c.job.attempt}`) && !(c.job.runId === job.runId && c.job.attempt === job.attempt))))).length;
/** Repeated losses on one head are rarely the runners' fault alone: flag them from this count on. */
const SUSPECT_REPEATS = 3;
const lossCount = (classified: ClassifiedJob[], job: JobRecord, limit: number, rejected: ReadonlySet<string>) => {
  const n = headLosses(classified, job, rejected);
  return `${n}${limit > 0 ? `/${limit}` : ""}`;
};
const suspect = (classified: ClassifiedJob[], job: JobRecord, rejected: ReadonlySet<string>) =>
  headLosses(classified, job, rejected) >= SUSPECT_REPEATS ? "; suspected PR-induced (repeat on same head)" : "";

const inheritedFrom = ({ job, class: cls }: ClassifiedJob) => INHERITABLE.has(cls) ? job.inheritedFrom?.pullRequest : undefined;
const describeJob = (classified: ClassifiedJob[], limit: number, rejected: ReadonlySet<string>) => (c: ClassifiedJob) => { const { job, class: cls, reason, flakeLabel } = c, from = inheritedFrom(c);
  return `${job.jobName}: ${cls}${reason.startsWith(BUILD_REASON) ? ` (${BUILD_REASON})` : ""}${flakeLabel ? ` ${flakeLabel}` : ""}${from === undefined ? "" : ` inherited from #${from}`}${cls === "runner_loss" ? ` (${lossCount(classified, job, limit, rejected)} on this head${suspect(classified, job, rejected)})` : ""}`; };
// The queue invalidated or rebuilt the group: its jobs were cancelled and none failed on its own. A group that ran to its own failure
// (fail-fast cancels siblings) is not invalidated, even if it was built on a predecessor that later left the queue.
// Any cancelled job in a group whose PR stayed queued means the queue rebuilt it: its losses never stand alone.
const superseded = (classified: ClassifiedJob[], runId: number, attempt: number) => classified.some((c) => c.job.runId === runId && c.job.attempt === attempt && NOT_OWN.has(c.class));
const invalidated = (classified: ClassifiedJob[], runId: number, attempt: number) => {
  const jobs = classified.filter((c) => c.job.runId === runId && c.job.attempt === attempt);
  return jobs.some((c) => NOT_OWN.has(c.class)) && !jobs.some(OWN_FAILURE);
};

/** 1. A merge queue run attempt with a job that failed (or was cancelled with its own failure): the PR leaves the queue. */
/** With `now`, an attempt waits (up to INHERIT_WAIT_MS) for its inherited-failure check instead of going out charged to its own PR. */
export function queueRemovalEvents(repository: string, classified: ClassifiedJob[], limit = 0, now?: number, rejected: ReadonlySet<string> = new Set()): ObserverEvent[] {
  const attempts = new Map<string, ClassifiedJob[]>();
  for (const c of classified) if (c.job.event === "merge_group" && !NOT_OWN.has(c.class)) attempts.set(`${c.job.runId}:${c.job.attempt}`, [...(attempts.get(`${c.job.runId}:${c.job.attempt}`) ?? []), c]);
  return [...attempts.values()].filter((jobs) => jobs.some(OWN_FAILURE) && !invalidated(classified, jobs[0]!.job.runId, jobs[0]!.job.attempt)
    && !(now !== undefined && jobs.some((c) => inheritable(c) && c.job.inheritedFrom === undefined && now - Math.max(...jobs.map((j) => completedAt(j.job))) < INHERIT_WAIT_MS))).map((jobs): ObserverEvent => {
    const { runId, attempt, headBranch } = jobs[0]!.job, pr = queuePullRequest(headBranch);
    // Every own failure inherited from the same PR: the headline says so instead of charging this PR.
    const origins = new Set(jobs.filter(OWN_FAILURE).map(inheritedFrom)), origin = origins.size === 1 ? [...origins][0] : undefined;
    const verb = origin === undefined ? "removed from merge queue" : `removed (inherited from #${origin})`;
    const started = Math.min(...jobs.map((c) => Date.parse(c.job.startedAt ?? c.job.createdAt)).filter(Number.isFinite));
    return {
      ...(pr === null ? {} : { removal: { pullRequest: pr, since: Number.isFinite(started) ? started : completedAt(jobs[0]!.job) } }),
      type: "queue", key: `queue:${runId}:${attempt}`, dedupe: "once", at: Math.max(...jobs.map((c) => completedAt(c.job))),
      tests: jobs.some((c) => TEST_CLASSES.has(c.class)) ? { run: { id: runId, attempt }, jobs: jobs.map((c) => c.job) } : undefined,
      render: (tests) => fit(`${pr === null ? `Merge queue run failed${origin === undefined ? "" : ` (inherited from #${origin})`}` : `PR #${pr} ${verb}`} · ${more(jobs.map(describeJob(classified, limit, rejected)), MAX_JOBS)}${tests?.length ? ` · failed tests: ${more(tests.map((name) => clip(squash(name), 100)), MAX_TESTS)}` : ""}`, runUrl(repository, runId), inspectTag(queueRef(runId, attempt))),
    };
  });
}

/**
 * 2. A runner lost on a default-branch push run, with the losses counted on the same head commit.
 * A merge queue loss normally rides inside its removal message; it stands alone only when `standaloneQueueLoss` says the attempt led to no removal,
 * and never for a group the queue invalidated.
 */
export function runnerLossEvents(repository: string, classified: ClassifiedJob[], defaultBranch: string | null, limit: number,
  standaloneQueueLoss: (runId: number, attempt: number) => boolean = () => false, rejected: ReadonlySet<string> = new Set()): ObserverEvent[] {
  return classified.filter((c) => c.class === "runner_loss").filter(({ job }) => job.completedAt && (job.event === "merge_group"
    ? standaloneQueueLoss(job.runId, job.attempt) && !superseded(classified, job.runId, job.attempt)
    : job.event === "push" && defaultBranch !== null && job.headBranch === defaultBranch)).map(({ job }): ObserverEvent => ({
    type: "loss", key: `loss:${job.jobId}`, dedupe: "once", at: completedAt(job),
    problem: `runner_loss:${job.jobId}`,
    render: (_tests, problem) => fit(`Runner lost · ${job.jobName} · runner ${job.runnerName ?? "unknown"} · ${lossCount(classified, job, limit, rejected)} losses on head ${sha7(job.headSha)}${suspect(classified, job, rejected)}`, jobUrl(repository, job), problemTag(problem) + inspectTag(jobRef(job.jobId))) }));
}

export const classCounts = (jobs: ClassifiedJob[]) => CLASS_ORDER.map((cls) => [cls, jobs.filter((c) => c.class === cls).length] as const).filter(([, n]) => n > 0).map(([cls, n]) => `${n} ${cls}`).join(", ") || "none stored";

/** 3. The latest run of a workflow on the default branch failed (run-level alert kind "main"). `streaks` maps an alert's run to the runs of its failure streak, as Investigate uses them. */
export function defaultRedEvents(repository: string, classified: ClassifiedJob[], alerts: CiInsights["alerts"], streaks: ReadonlyMap<number, number[]> = new Map()): ObserverEvent[] {
  return alerts.filter((alert) => alert.kind === "main").flatMap((alert): ObserverEvent[] => {
    const ofRun = classified.filter((c) => c.job.runId === alert.runId);
    // Jobs not stored yet: wait, the line needs the classes.
    if (!ofRun.length) return [];
    const attempt = Math.max(...ofRun.map((c) => c.job.attempt)), jobs = ofRun.filter((c) => c.job.attempt === attempt);
    const runIds = streaks.get(alert.runId) ?? [alert.runId], verdict = codeBrokenVerdict(classified.filter((c) => runIds.includes(c.job.runId)), runIds);
    const at = Math.max(Date.parse(alert.createdAt), ...jobs.map((c) => completedAt(c.job)));
    return [{ type: "red", key: `red:${alert.runId}:${attempt}`, dedupe: "once", at, problem: alertProblemId(alert),
      render: (_tests, problem) => fit(`${alert.name} red on ${alert.branch} · jobs: ${classCounts(jobs)} · Code looks broken: ${verdict}`, runUrl(repository, alert.runId), problemTag(problem) + inspectTag(runRef(alert.runId, attempt))) }];
  });
}

/** 4. A newly opened pool stall signal. */
export function stallEvent(signal: Signal, pools: PoolQueueState[], now: number): ObserverEvent {
  const pool = signal.where.pool ?? "unknown", queued = pools.find((state) => state.pool === pool)?.queued ?? 0, minutes = Math.max(0, Math.floor((now - Date.parse(signal.since)) / 60_000));
  return { type: "stall", key: signal.id, dedupe: "quiet", at: now, problem: signal.id, render: (_tests, problem) => fit(`Pool ${pool} stalled · ${queued} queued, no job start for ${minutes} min`, undefined, problemTag(problem) + inspectTag(poolRef(pool))) };
}

/** 5. A newly opened mass-cancel signal; `groups` are the analysis' mass cancels the signal id refers to. */
export function massCancelEvent(signal: Signal, groups: MassCancel[]): ObserverEvent | null {
  const group = groups.find((item) => `mass_cancel:${item.since}` === signal.id);
  if (!group) return null;
  const pool = signal.where.pool;
  return { type: "mass", key: signal.id, dedupe: "once", at: Date.parse(group.until), problem: signal.id,
    render: (_tests, problem) => fit(`${group.jobs.length} jobs lost/cancelled within 2 min${pool ? ` in ${pool}` : ""} · ${group.runIds.length} runs`, undefined, problemTag(problem) + inspectTag(runRef(Math.max(...group.runIds)))) };
}

// --- deployments ---
const deploymentRow = z.object({ id: z.number(), environment: z.string().nullable().optional(), sha: z.string().optional(), created_at: z.string() });
const statusRow = z.object({ state: z.string(), created_at: z.string(), log_url: z.string().nullable().optional() });
const FINAL = new Set(["success", "failure", "error"]);

/**
 * 6. Deployments that reached a final status. At most one list request plus `maxStatuses` status requests per call; deployments seen in a final state
 * (or superseded) are remembered in `state.deploys` and cost nothing afterwards. Older than `since` are ignored.
 */
/** How a failed deployment's run failed: only on a by-design gate step (refused, with the step), on anything else, or not stored yet (null). */
export type DeployRunOutcome = (runId: number) => { refused: string } | "failed" | null;
const DEPLOY_WAIT_MS = 10 * 60_000;
/** Classifies a deployment run from its classified jobs: a run that failed only on refusal steps (plus their consequences) was refused, not broken. */
export function deployRunOutcome(classified: ClassifiedJob[]): DeployRunOutcome {
  return (runId) => {
    const own = classified.filter((c) => c.job.runId === runId && !NOT_OWN.has(c.class) && c.class !== "consequence");
    if (!own.length) return null;
    const refused = own.filter((c) => c.class === "refused");
    return refused.length === own.length ? { refused: refused[0]!.evidence ?? refused[0]!.job.failedSteps[0] ?? "gate step" } : "failed";
  };
}
export async function deploymentEvents({ request, repository, state, since, now, maxStatuses = 10, runOutcome = () => null }: { request: GitHubRequest; repository: string; state: ObserverRepoState; since: number; now: number; maxStatuses?: number; runOutcome?: DeployRunOutcome }): Promise<ObserverEvent[]> {
  const list = z.array(deploymentRow).parse((await request(`/repos/${repository}/deployments?per_page=30`)).body);
  for (const [id, seen] of Object.entries(state.deploys)) if (seen < since) delete state.deploys[id];
  const events: ObserverEvent[] = [];
  const open = list.filter((d) => Date.parse(d.created_at) >= since && state.deploys[String(d.id)] === undefined).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at)).slice(0, maxStatuses);
  for (const d of open) {
    let status: z.infer<typeof statusRow> | undefined;
    try { status = z.array(statusRow).parse((await request(`/repos/${repository}/deployments/${d.id}/statuses?per_page=1`)).body)[0]; }
    catch (error) { if (/Budget exhausted|403|429/.test(String(error))) break; continue; }
    if (!status) continue;
    if (status.state === "inactive") { state.deploys[String(d.id)] = now; continue; }
    if (!FINAL.has(status.state)) continue;
    const environment = d.environment || "unknown", url = status.log_url && /^https:\/\//.test(status.log_url) ? status.log_url : undefined;
    let label = status.state;
    if (status.state !== "success") {
      // A gate step refusing a stale candidate is by design and needs no action; only a real failure should read "failure".
      const runId = Number(url?.match(/\/actions\/runs\/(\d+)/)?.[1]);
      const outcome = Number.isFinite(runId) ? runOutcome(runId) : "failed";
      if (outcome === null && now - Date.parse(status.created_at) < DEPLOY_WAIT_MS) continue; // the run's jobs are not stored yet: look again next loop
      if (outcome && outcome !== "failed") label = `refused (${outcome.refused})`;
    }
    state.deploys[String(d.id)] = Date.parse(status.created_at);
    events.push({ type: "deploy", key: `deploy:${d.id}:${status.state}`, dedupe: "once", at: Date.parse(status.created_at),
      render: () => fit(`Deploy ${environment} ${label} · ${sha7(d.sha ?? "")} · deployment ${d.id}`, url) });
  }
  return events;
}

// --- noise control ---
export type ObserverConfig = { enabled: Record<ObserverType, boolean>; quietMs: number; batchMs: number; /** How long a sent key is remembered (the job-history window plus a day). */ historyMs: number; now: number };
const MAX_REMEMBERED = 3000;

/**
 * Brings the shared state in line with the settings: each subscribed thread and each enabled type gets a start time (now, when first seen),
 * and anything no longer subscribed/enabled is forgotten, so switching it on again starts from "now" instead of replaying history.
 * Returns the threads that subscribed in this call.
 */
export function syncGlobal(global: ObserverGlobal, threads: string[], enabled: Record<ObserverType, boolean>, now: number): string[] {
  const added = threads.filter((id) => global.threads[id] === undefined);
  for (const id of Object.keys(global.threads)) if (!threads.includes(id)) delete global.threads[id];
  for (const id of added) global.threads[id] = now;
  for (const type of OBSERVER_TYPES) {
    if (threads.length && enabled[type]) global.types[type] ??= now;
    else delete global.types[type];
  }
  return added;
}

/** Picks the events to announce: type on, not older than the type's start, and not already sent (or, for reopening keys, not within the quiet window). Marks them sent. */
const REMOVAL_GRACE_MS = 15 * 60_000;
/**
 * Keeps a queue removal only once GitHub shows the PR's RemovedFromMergeQueueEvent at or after the group run started.
 * Unconfirmed removals are retried on later loops and given up after a grace period; a failed lookup falls back to sending.
 */
export async function confirmRemovals(events: ObserverEvent[], state: ObserverRepoState, lastRemoval: (pullRequest: number) => Promise<number | null>, rejected: Set<string>, now: number): Promise<ObserverEvent[]> {
  const lookups = new Map<number, Promise<number | null>>(), out: ObserverEvent[] = [];
  for (const event of events) {
    const removal = event.removal;
    if (!removal || state.sent[event.key] !== undefined) { out.push(event); continue; }
    if (rejected.has(event.key)) continue;
    if (!lookups.has(removal.pullRequest)) lookups.set(removal.pullRequest, lastRemoval(removal.pullRequest));
    let removedAt: number | null;
    try { removedAt = await lookups.get(removal.pullRequest)!; } catch { out.push(event); continue; }
    // A minute of slack: GitHub may stamp the removal a moment before the run records its start.
    // The removal must follow the group run: after it started and within the grace period after it ended (a later one is another group's).
    if (removedAt !== null && removedAt >= removal.since - 60_000 && removedAt <= event.at + REMOVAL_GRACE_MS) out.push(event);
    else if (now - event.at > REMOVAL_GRACE_MS) rejected.add(event.key);
  }
  return out;
}

export function acceptEvents(state: ObserverRepoState, global: ObserverGlobal, events: ObserverEvent[], { enabled, quietMs, historyMs, now }: ObserverConfig): ObserverEvent[] {
  for (const [key, at] of Object.entries(state.sent)) if (at < now - historyMs) delete state.sent[key];
  const accepted: ObserverEvent[] = [];
  for (const event of events) {
    const start = global.types[event.type];
    if (!enabled[event.type] || start === undefined || event.at < start) continue;
    const prior = state.sent[event.key];
    if (prior !== undefined && (event.dedupe === "once" || now - prior < quietMs)) continue;
    state.sent[event.key] = now;
    accepted.push(event);
  }
  const keys = Object.entries(state.sent);
  if (keys.length > MAX_REMEMBERED) state.sent = Object.fromEntries(keys.sort((a, b) => b[1] - a[1]).slice(0, MAX_REMEMBERED));
  return accepted;
}

/**
 * Turns announced events into messages per subscribed thread (a thread never gets events from before it subscribed).
 * Without batching every event is its own message; with batching events wait in `state.pending` and leave as one digest once the oldest has waited `batchMs`.
 */
export function dispatch(state: ObserverRepoState, items: Rendered[], global: ObserverGlobal, { batchMs, now }: Pick<ObserverConfig, "batchMs" | "now">): { threadId: string; text: string }[] {
  const out: { threadId: string; text: string }[] = [];
  const deliver = (list: Rendered[]) => {
    for (const threadId of Object.keys(global.threads)) {
      const mine = list.filter((item) => item.at >= global.threads[threadId]!);
      if (!mine.length) continue;
      const lines = mine.slice(0, MAX_DIGEST).map((item) => `- ${item.text}`);
      out.push({ threadId, text: mine.length === 1 ? `${PREFIX} ${mine[0]!.text}` : [`${PREFIX} ${mine.length} CI events`, ...lines, ...(mine.length > MAX_DIGEST ? [`- … +${mine.length - MAX_DIGEST} more`] : [])].join("\n") });
    }
  };
  if (batchMs === 0) {
    for (const item of [...state.pending, ...items]) deliver([item]);
    state.pending = []; state.pendingSince = null;
    return out;
  }
  state.pending.push(...items);
  if (!state.pending.length) { state.pendingSince = null; return out; }
  state.pendingSince ??= now;
  if (now - state.pendingSince >= batchMs) { deliver(state.pending); state.pending = []; state.pendingSince = null; }
  return out;
}

/** First message to a newly subscribed thread. */
export function subscriptionNotice(repositories: string[], enabled: Record<ObserverType, boolean>, quietMinutes: number, batchMinutes: number) {
  const types = OBSERVER_TYPES.filter((type) => enabled[type]).map((type) => OBSERVER_TYPE_LABELS[type]).join(", ") || "no event types";
  return fit(`${PREFIX} Subscribed to CI events for ${repositories.join(", ") || "no repositories"}: ${types}; quiet window ${quietMinutes} min${batchMinutes > 0 ? `; digest every ${batchMinutes} min` : ""}`);
}
