import { alertStreak, type CiInsights, type Run } from "./ci-insights";
import type { Actor, ClassifiedJob, FailureClass, JobRecord, PoolQueueState, RerunSummary, Signal } from "./ci-jobs-types";
import type { MassCancel } from "./ci-classify";
import type { Handled, Problem } from "./ci-signals-contract";

/** Server titles carry internal wording; problems and the card show the plain one. */
export function signalTitle(signal: Pick<Signal, "kind" | "title" | "where">) {
  const { pool, jobName, branch } = signal.where;
  if (signal.kind === "pool_stall") return `Runner pool stalled: ${pool}`;
  if (signal.kind === "runner_loss" && jobName) return `Runner lost${branch ? ` on ${branch}` : ""}: ${jobName}`;
  if (signal.kind === "mass_cancel") return `Many runners lost${pool ? ` in ${pool}` : ""}`;
  return signal.title;
}

export const alertProblemId = (alert: Pick<CiInsights["alerts"][number], "kind" | "runId">) => `run:${alert.kind}:${alert.runId}`;

/** Open critical/warning signals plus run-level alerts, most severe first, then newest. Info signals are not problems. */
// One-off events (runner losses, reruns) stop being problems after this; ongoing states (stalls, red branches) stay until they clear.
export const EVENT_PROBLEM_MS = 6 * 3_600_000;
export function buildProblems(repository: string, open: Signal[], alerts: CiInsights["alerts"], handled: Record<string, Handled>, now = Date.now()): Problem[] {
  const fromSignals = open.filter((signal) => signal.severity !== "info" && (signal.kind === "pool_stall" || now - Date.parse(signal.since) <= EVENT_PROBLEM_MS)).map((signal): Problem => ({
    id: signal.id, severity: signal.severity === "critical" ? "critical" : "warning", title: signalTitle(signal), what: signal.what, impact: signal.impact,
    where: signal.where, since: signal.since, handled: handled[signal.id] ?? null,
  }));
  const fromAlerts = alerts.map((alert): Problem => {
    const main = alert.kind === "main", id = alertProblemId(alert);
    return {
      id, severity: main ? "critical" : "warning", title: `${alert.name} · ${alert.branch}: ${main ? "latest run failed" : `${alert.consecutive} consecutive failures`}`,
      what: main ? `The latest run of ${alert.name} on ${alert.branch} failed${alert.consecutive > 1 ? ` (${alert.consecutive} failures in a row)` : ""}.` : `The last ${alert.consecutive} runs of ${alert.name} on ${alert.branch} all failed.`,
      impact: main ? "The default branch is red, so merges and new pull requests build on a failing base." : "Every new run of this workflow on this branch keeps failing until it is fixed.",
      where: { runId: alert.runId, branch: alert.branch, url: `https://github.com/${repository}/actions/runs/${alert.runId}` }, since: alert.createdAt, handled: handled[id] ?? null,
    };
  });
  return [...fromSignals, ...fromAlerts].sort((a, b) => Number(b.severity === "critical") - Number(a.severity === "critical") || Date.parse(b.since) - Date.parse(a.since) || a.id.localeCompare(b.id));
}

// Failures nobody needs to act on: the next run delivers.
const BENIGN = new Set<ClassifiedJob["class"]>(["refused", "consequence", "superseded", "manual_cancel", "collateral_cancel"]);
/** Drops run-level alerts whose latest stored attempt has only benign failures. Jobs not stored yet (unknown) keep the alert. */
export function withoutBenignAlerts(alerts: CiInsights["alerts"], classified: ClassifiedJob[]): CiInsights["alerts"] {
  return alerts.filter((alert) => {
    const ofRun = classified.filter((c) => c.job.runId === alert.runId);
    const latest = Math.max(...ofRun.map((c) => c.job.attempt));
    return !ofRun.length || !ofRun.filter((c) => c.job.attempt === latest).every((c) => BENIGN.has(c.class));
  });
}

export type ContextSection = { title: string; lines: string[] };
export type ProblemContextInput = {
  repository: string; classified: ClassifiedJob[]; reruns: RerunSummary[]; massCancels: MassCancel[]; pools: PoolQueueState[]; alerts: CiInsights["alerts"];
  defaultBranch: string | null; backfill?: { remaining: number; failed: number; pausedUntil: string | null }; coverage: string | null;
  analysisAt: number | null; polledAt: string | null; now: number;
  // From memory and the local store only; every field is optional so older callers and legacy history still work.
  runs?: Run[]; deployments?: { environment?: string; ref?: string; sha?: string; created_at: string }[]; liveJobs?: JobRecord[];
  windowDays?: number; notes?: string; actors?: Record<Actor, string>;
};

const DAY = 86_400_000;
export const CLASS_ORDER: FailureClass[] = ["runner_loss", "timeout", "transient", "flake", "real", "refused", "consequence", "superseded", "manual_cancel", "collateral_cancel", "unknown"];
// Generic defaults; a team's own limits and links belong in the investigateNotes setting, never here.
const ACTIONS: Partial<Record<FailureClass, [string, Actor | null]>> = {
  runner_loss: ["let the next run supersede it, or re-run failed jobs once", "owner_sre"], refused: ["no action, the next run delivers", null],
  transient: ["re-run failed jobs", "pr_author"], flake: ["track and fix the flaky test", "lead"], real: ["fix the code", "pr_author"],
};
const DEFAULT_ACTORS: Record<Actor, string> = { owner_sre: "Runner owner / SRE", pr_author: "PR author", lead: "Lead", manager: "Manager" };
// Never shrunk or cut by seedPrompt.
const PROTECTED = new Set(["Verdict", "Problem", "Suggested action", "Team notes"]);

const LIST_CAP = 20, EVIDENCE_JOBS = 5, TEXT_CAP = 500, PROMPT_CAP = 12_000;
// Classes that explain themselves through another job; they stay out of the detailed evidence.
const SECONDARY = new Set<ClassifiedJob["class"]>(["consequence", "superseded", "manual_cancel", "collateral_cancel"]);
const clip = (text: string, max = TEXT_CAP) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
const runUrl = (repository: string, runId: number) => `https://github.com/${repository}/actions/runs/${runId}`;
const jobUrl = (repository: string, job: Pick<JobRecord, "runId" | "jobId">) => `${runUrl(repository, job.runId)}/job/${job.jobId}`;
const kv = (label: string, value: string | number | null | undefined, indent = "") => value === null || value === undefined || value === "" ? [] : [`${indent}- ${label}: ${value}`];
const capped = (rows: string[]) => rows.length > LIST_CAP ? [...rows.slice(0, LIST_CAP), `- … ${rows.length - LIST_CAP} more`] : rows;
const timeOf = (job: JobRecord) => job.completedAt ?? job.startedAt ?? job.createdAt;
const newestFirst = (a: ClassifiedJob, b: ClassifiedJob) => Date.parse(timeOf(b.job)) - Date.parse(timeOf(a.job));
function duration(job: JobRecord) {
  if (!job.startedAt || !job.completedAt) return null;
  const seconds = Math.max(0, Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function evidence(repository: string, defaultBranch: string | null, { job, class: cls, reason, evidence: found }: ClassifiedJob): string[] {
  const failures = job.annotations.filter((annotation) => annotation.level === "failure");
  const sub = "  ";
  return [
    `- Job: ${job.jobName} (job id ${job.jobId})`,
    ...kv("Workflow", job.workflowName, sub), ...kv("Run", `${job.runId}, attempt ${job.attempt}: ${runUrl(repository, job.runId)}`, sub), ...kv("Job URL", jobUrl(repository, job), sub),
    ...kv("Branch", job.headBranch ? `${job.headBranch}${job.headBranch === defaultBranch ? " (default branch)" : ""}` : null, sub), ...kv("Commit", job.headSha, sub),
    ...kv("Pull requests", job.pullRequests.map((number) => `#${number}`).join(", "), sub), ...kv("Event", job.event, sub),
    ...kv("Pool", job.pool, sub), ...kv("Runner", job.runnerName ? `${job.runnerName}${job.runnerGroup ? ` (group ${job.runnerGroup})` : ""}` : null, sub), ...kv("Labels", job.labels.join(", "), sub),
    ...kv("Status", `${job.status}${job.conclusion ? ` / ${job.conclusion}` : ""}`, sub), ...kv("Started", job.startedAt, sub), ...kv("Completed", job.completedAt, sub), ...kv("Duration", duration(job), sub),
    ...kv("Failed steps", job.failedSteps.join(", "), sub),
    ...kv("Classification", `${cls} — ${reason}${found ? `; evidence: ${clip(found)}` : ""}`, sub),
    ...(failures.length ? [`${sub}- Failure annotations:`, ...failures.slice(0, LIST_CAP).map((annotation) => `${sub}  - ${clip(`${annotation.title ? `${annotation.title}: ` : ""}${annotation.message}`)}`)] : []),
    ...(job.logExcerpt ? [`${sub}- Log excerpt (up to 30 lines before the first error):`, ...job.logExcerpt.split("\n").slice(0, 30).map((line) => `${sub}  | ${clip(line, 300)}`)] : []),
  ];
}
const brief = (repository: string, { job, class: cls, reason }: ClassifiedJob) =>
  `- ${timeOf(job)} · ${job.jobName} · ${cls} (${reason}) · ${job.conclusion ?? job.status} · ${jobUrl(repository, job)}${job.runnerName ? ` · ${job.runnerName}` : ""}`;

/**
 * Verdict "Code looks broken" for the failing jobs of some runs: any real failure = yes; jobs of a run that are not stored or unclassifiable = unknown;
 * a flake is nondeterminism, not broken code, so red on flakes only reads "no" with the reason. Shared by Investigate prompts and observer messages.
 */
export function codeBrokenVerdict(ofRuns: ClassifiedJob[], runIds: number[]): "yes" | "no" | "no (red on flakes only)" | "unknown" {
  const unstored = runIds.filter((id) => !ofRuns.some((c) => c.job.runId === id));
  return ofRuns.some((c) => c.class === "real") ? "yes"
    : !ofRuns.length || unstored.length || ofRuns.some((c) => c.class === "unknown") ? "unknown"
      : ofRuns.some((c) => c.class === "flake") ? "no (red on flakes only)" : "no";
}

/** Everything the dashboard already knows about one problem, as plain-text sections; sections without data are left out. Pure: no GitHub requests. */
export function problemContext(problem: Problem, input: ProblemContextInput): ContextSection[] {
  const { repository, classified, reruns, massCancels, pools, alerts, defaultBranch, backfill, coverage, analysisAt, polledAt, now } = input;
  const history = input.runs ?? [], windowDays = input.windowDays ?? 14;
  const { where } = problem, prefix = problem.id.split(":")[0] ?? "";
  const alert = prefix === "run" ? alerts.find((item) => alertProblemId(item) === problem.id) : undefined;
  const group = prefix === "mass_cancel" ? massCancels.find((item) => `mass_cancel:${item.since}` === problem.id) : undefined;
  const runId = where.runId ?? alert?.runId;
  const ofRun = runId === undefined ? [] : classified.filter((c) => c.job.runId === runId);
  const attempt = where.attempt ?? (ofRun.length ? Math.max(...ofRun.map((c) => c.job.attempt)) : undefined);
  const sameAttempt = ofRun.filter((c) => c.job.attempt === attempt);
  const primary = where.jobId !== undefined ? sameAttempt.filter((c) => c.job.jobId === where.jobId) : sameAttempt.filter((c) => !SECONDARY.has(c.class)).slice(0, EVIDENCE_JOBS);
  const others = sameAttempt.filter((c) => !primary.includes(c));
  const sections: ContextSection[] = [];
  const add = (title: string, lines: string[]) => { if (lines.length) sections.push({ title, lines }); };

  // The runs the problem is about: every run of the streak for a run-level alert, the run group of a mass cancel, otherwise the one run.
  const streak = alert ? alertStreak(history, alert) : [];
  const runIds = alert ? (streak.length ? streak.map((run) => run.id) : [alert.runId]) : group ? group.runIds : runId === undefined ? [] : [runId];
  const ofRuns = classified.filter((c) => runIds.includes(c.job.runId));
  const presentClasses = CLASS_ORDER.filter((cls) => ofRuns.some((c) => c.class === cls));
  const unstored = runIds.filter((id) => !ofRuns.some((c) => c.job.runId === id));
  const broken = codeBrokenVerdict(ofRuns, runIds);
  add("Verdict", [
    runIds.length ? `Runs checked: ${runIds.length}${alert ? ` (the consecutive-failure streak)` : ""}` : "Runs checked: none (the problem is not tied to a run)",
    `Non-success jobs by class: ${!runIds.length ? "none (no run involved)" : ofRuns.length ? [...presentClasses, ...(presentClasses.includes("real") ? [] : ["real" as const])].map((cls) => `${ofRuns.filter((c) => c.class === cls).length} ${cls}`).join(", ") : "not stored yet"}`,
    ...(unstored.length && ofRuns.length ? [`Jobs of ${unstored.length} run(s) are not stored yet`] : []),
    `Code looks broken: ${broken}`,
  ]);

  add("Problem", [
    `Problem: ${problem.title} (${problem.severity})`, `What happened: ${problem.what}`, `Impact: ${problem.impact}`, `Since: ${streak.at(-1)?.created_at ?? problem.since}`, "Where:",
    ...kv("Repository", repository), ...kv("Problem id", problem.id), ...kv("Kind", prefix === "run" ? `run-level alert (${problem.id.split(":")[1]})` : prefix),
    ...kv("Pool", where.pool), ...kv("Run id", where.runId), ...kv("Attempt", where.attempt), ...kv("Job id", where.jobId), ...kv("Job", where.jobName), ...kv("Runner", where.runnerName),
    ...kv("Branch", where.branch ?? undefined), ...kv("Commit", where.headSha), ...kv("Pull requests", where.pullRequests?.length ? where.pullRequests.map((number) => `#${number}`).join(", ") : undefined),
    ...kv("Run URL", runId === undefined ? undefined : runUrl(repository, runId)),
    ...kv("Job URL", where.jobId !== undefined && runId !== undefined ? jobUrl(repository, { runId, jobId: where.jobId }) : undefined), ...kv("Link", where.url),
  ]);
  const failingRuns = runIds.slice(0, LIST_CAP).map((id) => {
    const row = history.find((run) => run.id === id), job = ofRuns.find((c) => c.job.runId === id)?.job, title = row?.display_title;
    const sha = row?.head_sha || job?.headSha, pr = title?.match(/\(#(\d+)\)/)?.[1] ?? row?.pull_requests?.[0] ?? job?.pullRequests[0];
    return `- Run ${id}${row ? ` (${row.created_at})` : ""}: commit ${sha ? sha.slice(0, 12) : "unknown"}${title ? ` "${clip(title, 200)}"` : ""}${pr ? ` · PR #${pr}` : ""} · ${runUrl(repository, id)}`;
  });
  add("Failing runs", [...failingRuns, ...(runIds.length > LIST_CAP ? [`- … ${runIds.length - LIST_CAP} older run(s)`] : [])]);

  if (runIds.length) {
    const latest = Math.max(...runIds), anchorRun = history.find((run) => run.id === latest), anchorJob = ofRuns[0]?.job;
    const workflow = alert?.name ?? anchorRun?.name ?? anchorJob?.workflowName, branch = alert?.branch ?? anchorRun?.head_branch ?? anchorJob?.headBranch;
    const newer = new Map<number, { sha: string; conclusion: string | null; state: string }>();
    for (const run of history) if (run.id > latest && run.name === workflow && run.head_branch === branch) newer.set(run.id, { sha: run.head_sha ?? "", conclusion: run.conclusion, state: run.conclusion ?? "not finished" });
    for (const job of input.liveJobs ?? []) if (job.runId > latest && job.workflowName === workflow && job.headBranch === branch && !newer.get(job.runId)?.conclusion) newer.set(job.runId, { sha: job.headSha, conclusion: null, state: job.status });
    const ordered = [...newer].sort((a, b) => a[0] - b[0]);
    const finished = ordered.filter(([, run]) => run.conclusion && !["cancelled", "skipped"].includes(run.conclusion)).at(-1);
    const healing = (name: string) => {
      if (!finished) return "unknown (no newer run has finished)";
      const [id, run] = finished;
      if (run.conclusion === "success") return `yes (passed in run ${id})`;
      if (classified.some((c) => c.job.runId === id && c.job.jobName === name)) return `no (failed again in run ${id})`;
      return classified.some((c) => c.job.runId === id) ? `yes (did not fail in run ${id})` : `unknown (jobs of run ${id} are not stored)`;
    };
    add("Current state", [
      ...(ordered.length ? [`Newer runs of ${workflow} on ${branch} after the latest failure (run ${latest}):`, ...capped(ordered.map(([id, run]) => `- Run ${id}: commit ${run.sha ? run.sha.slice(0, 12) : "unknown"} · ${run.state} · ${runUrl(repository, id)}`))]
        : [`No newer run of ${workflow} on ${branch} since run ${latest}.`]),
      ...capped([...new Set(ofRuns.map((c) => c.job.jobName))].map((name) => `- Job "${name}" failed before; self-healing: ${healing(name)}`)),
    ]);
  }
  const environments = new Map<string, NonNullable<ProblemContextInput["deployments"]>[number]>();
  for (const d of input.deployments ?? []) if (d.environment && Date.parse(d.created_at) > Date.parse(environments.get(d.environment)?.created_at ?? "0")) environments.set(d.environment, d);
  add("Deploy state", environments.size ? ["Latest deployment per environment (stored history):", ...capped([...environments].sort((a, b) => a[0].localeCompare(b[0])).map(([name, d]) => `- ${name}: ref ${d.ref ?? "unknown"}${d.sha ? ` (commit ${d.sha.slice(0, 12)})` : ""}, deployed ${d.created_at}`))]
    : input.deployments?.length ? ["Stored deployment history has no environment details yet; they appear after the next full refresh."] : []);
  add("Evidence (job records)", primary.flatMap((c) => evidence(repository, defaultBranch, c)));
  const rerun = runId === undefined ? undefined : reruns.find((item) => item.runId === runId);
  add("Same run", [
    ...capped(others.map((c) => brief(repository, c))),
    ...(rerun ? [`Run ${rerun.runId} (${rerun.workflowName}): ${rerun.attempts} attempt(s), outcomes ${rerun.outcomes.map((o) => o ?? "?").join(" → ")}, final ${rerun.finalConclusion ?? "unknown"}, repeated runner time ${Math.round(rerun.repeatedRunnerMs / 60000)} min`] : []),
  ]);
  if (group) add("Mass runner loss", [
    `${group.jobs.length} jobs on ${group.runners.length} runners in ${group.runIds.length} runs between ${group.since} and ${group.until}:`,
    ...capped([...group.jobs].sort(newestFirst).map((c) => `- ${timeOf(c.job)} · ${c.job.jobName} · ${runUrl(repository, c.job.runId)} · ${c.job.runnerName ?? "no runner"} · ${c.class}`)),
  ]);
  if (prefix === "pool_stall" && where.pool) {
    const state = pools.find((pool) => pool.pool === where.pool);
    const line = (pool: PoolQueueState) => `${pool.pool}: ${pool.queued} queued, ${pool.inProgress} running, oldest queued ${pool.oldestQueuedAt ?? "none"}, last start ${pool.lastStartedAt ?? "none"}`;
    add("Pool stall", [
      state ? `Stalled pool — ${line(state)}` : `Stalled pool: ${where.pool} (no live state in memory)`,
      ...(state?.queuedRunIds.length ? ["Queued runs:", ...capped(state.queuedRunIds.map((id) => `- ${runUrl(repository, id)}`))] : []),
      ...(pools.some((pool) => pool.pool !== where.pool) ? ["Other pools:", ...capped(pools.filter((pool) => pool.pool !== where.pool).map((pool) => `- ${line(pool)}`))] : []),
    ]);
  }
  if (alert) {
    const recent = classified.filter((c) => c.job.workflowName === alert.name && c.job.headBranch === alert.branch).sort(newestFirst).slice(0, 10);
    add("Run-level alert", [
      `Workflow: ${alert.name}`, `Branch: ${alert.branch}${alert.branch === defaultBranch ? " (default branch)" : ""}`, `Consecutive failures: ${alert.consecutive}`, `Latest failed run: ${runUrl(repository, alert.runId)} (${alert.createdAt})`,
      ...(recent.length ? ["Last classified failures of this workflow on this branch (infrastructure vs real):", ...recent.map((c) => brief(repository, c))] : []),
    ]);
  }
  const anchor = primary[0]?.job;
  if (anchor) {
    const losses = classified.filter((c) => c.class === "runner_loss");
    // The stored history only reaches back to its coverage; the rate divides by the days actually covered (at least one).
    const windowStart = Math.max(now - windowDays * DAY, coverage ? Date.parse(coverage) : 0), days = Math.max((now - windowStart) / DAY, 1);
    const rate = (count: number) => `${count} (${(count / days).toFixed(1)}/day)`;
    add("Recent pattern (stored job history)", [
      `Window: ${new Date(windowStart).toISOString()} to ${new Date(now).toISOString()} (${days.toFixed(1)} days)`,
      ...(anchor.pool ? kv("Runner losses in pool " + anchor.pool, rate(losses.filter((c) => c.job.pool === anchor.pool).length)) : []),
      ...kv(`Runner losses of job "${anchor.jobName}"`, rate(losses.filter((c) => c.job.jobName === anchor.jobName).length)),
      ...(anchor.runnerName ? kv("Runner losses on runner " + anchor.runnerName, rate(losses.filter((c) => c.job.runnerName === anchor.runnerName).length)) : []),
      ...kv(`Flaky occurrences of job "${anchor.jobName}"`, rate(classified.filter((c) => c.class === "flake" && c.job.jobName === anchor.jobName).length)),
    ]);
  }
  add("Freshness", [
    `Now: ${new Date(now).toISOString()}`, ...kv("Analysis computed", analysisAt === null ? "not yet" : new Date(analysisAt).toISOString()), ...kv("Job history covers from", coverage ?? "no stored jobs"),
    ...kv("Job backfill", backfill ? `${backfill.remaining} run(s) left to fetch, ${backfill.failed} failed${backfill.pausedUntil ? `, paused until ${backfill.pausedUntil}` : ""}` : null), ...kv("Live pool poll", polledAt ?? "none yet"),
    ...kv("Default branch", defaultBranch),
  ]);
  const actors = input.actors ?? DEFAULT_ACTORS;
  add("Suggested action", presentClasses.flatMap((cls) => ACTIONS[cls] ? [`- ${cls}: ${ACTIONS[cls]![0]} (who: ${ACTIONS[cls]![1] ? actors[ACTIONS[cls]![1]!] : "nobody"})`] : []));
  add("Team notes", input.notes?.trim() ? input.notes.trim().split("\n") : []);
  return sections;
}

const render = (sections: ContextSection[], dropped: number[]) => sections.flatMap(({ title, lines }, index) => ["", `## ${title}`, ...lines, ...(dropped[index] ? [`- … ${dropped[index]} more line(s) omitted to keep the prompt short`] : [])]).join("\n");

/** Plain-text first message for the BB session that investigates one problem. Lists shrink to fit the cap; the instructions never do. */
export function seedPrompt(repository: string, problem: Problem, context: ContextSection[] = problemContext(problem, { repository, classified: [], reruns: [], massCancels: [], pools: [], alerts: [], defaultBranch: null, coverage: null, analysisAt: null, polledAt: null, now: Date.now() })) {
  const head = `Investigate a CI problem in ${repository}: ${problem.title}.`;
  const tail = [
    "", "## How to dig further (read-only)",
    "- ci_dashboard_metrics tool (view: signals | stall | losses | failures | reruns), or `bb plugin rpc call delivery-dashboard ci --input-file <json>`.",
    `- gh run view <runId> --repo ${repository} --log-failed`, `- gh run view <runId> --repo ${repository} --json jobs`, `- gh api repos/${repository}/actions/jobs/<jobId>/logs`,
    "", "## Your task",
    "Classify the root cause: infrastructure, flaky test, real failure, or tool/network. Give the evidence, propose the fix and say who should act. Find the root cause and report back.",
    "Do not re-run workflows, cancel runs or change CI configuration unless the owner asks.",
  ].join("\n");
  const budget = PROMPT_CAP - head.length - tail.length - 1;
  const kept = context.map((section) => ({ ...section, lines: section.title === "Team notes" ? section.lines : section.lines.map((line) => clip(line, 600)) })), dropped = kept.map(() => 0);
  let body = render(kept, dropped);
  while (body.length > budget) {
    // Shrink the largest list first; Verdict, Problem, Suggested action and Team notes keep their lines.
    let target = -1, size = 0;
    kept.forEach((section, index) => { const length = section.lines.join("\n").length; if (!PROTECTED.has(section.title) && section.lines.length > 1 && length > size) { target = index; size = length; } });
    if (target < 0) { body = body.slice(0, budget); break; }
    kept[target]!.lines.pop(); dropped[target]!++;
    body = render(kept, dropped);
  }
  return [head, body, tail].join("\n");
}
