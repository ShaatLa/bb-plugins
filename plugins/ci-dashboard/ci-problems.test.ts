import { expect, test } from "vitest";
import { alertProblemId, buildProblems, withoutBenignAlerts, EVENT_PROBLEM_MS, problemContext, seedPrompt, type ProblemContextInput } from "./ci-problems";
import type { Run } from "./ci-insights";
import type { Signal } from "./ci-jobs-types";
import { handledSchema, type Problem } from "./ci-signals-contract";
import { at, classify, failed, failure, LOSS, REPO } from "./test-support";

const now = Date.parse("2026-01-10T12:00:00Z");
const signal = (id: string, kind: Signal["kind"], ageMs: number): Signal => ({
  id, kind, severity: "critical", title: id, what: "what", impact: "impact", where: { pool: "self-hosted" },
  since: new Date(now - ageMs).toISOString(), until: null, actor: "owner_sre", open: true,
});

test("one-off events stop being problems after the event window while ongoing stalls stay", () => {
  const open = [signal("recent-loss", "mass_cancel", EVENT_PROBLEM_MS - 1), signal("old-loss", "mass_cancel", EVENT_PROBLEM_MS + 1), signal("old-stall", "pool_stall", 2 * EVENT_PROBLEM_MS)];
  expect(buildProblems("acme/widgets", open, [], {}, now).map((p) => p.id).sort()).toEqual(["old-stall", "recent-loss"]);
});

test("a run-level alert is dropped only when its latest stored attempt has nothing but refusals, consequences and cancels", () => {
  const alert = { kind: "main" as const, workflowId: 1, name: "CI", branch: "main", runId: 7, createdAt: at(0), consecutive: 1 };
  const of = (...jobs: [string, number?][]) => jobs.map(([cls, attempt = 1], index) => classify(failed({ runId: 7, jobId: index + 1, attempt }), cls as never));
  const kept = (classified: ReturnType<typeof of>) => withoutBenignAlerts([alert], classified).length === 1;
  expect(kept(of(["refused"], ["consequence"]))).toBe(false);
  expect(kept(of(["refused"], ["superseded"], ["manual_cancel"], ["collateral_cancel"]))).toBe(false);
  expect(kept(of(["refused"], ["real"]))).toBe(true);
  expect(kept(of(["refused"], ["runner_loss"]))).toBe(true);
  expect(kept(of(["refused"], ["unknown"]))).toBe(true);
  expect(kept([])).toBe(true);
  expect(kept([classify(failed({ runId: 8 }), "refused")])).toBe(true);
  // Only the latest attempt counts: an earlier real failure was rerun into a refusal.
  expect(kept(of(["real", 1], ["refused", 2]))).toBe(false);
  expect(kept(of(["refused", 1], ["real", 2]))).toBe(true);
});

// --- investigate context ---
const base = (over: Partial<ProblemContextInput> = {}): ProblemContextInput => ({ repository: REPO, classified: [], reruns: [], massCancels: [], pools: [], alerts: [], defaultBranch: "main", coverage: at(-600),
  backfill: { remaining: 3, failed: 1, pausedUntil: null }, analysisAt: Date.parse(at(9)), polledAt: at(9, 30), now: Date.parse(at(10)), ...over });
const problem = (id: string, where: Problem["where"], over: Partial<Problem> = {}): Problem => ({ id, severity: "warning", title: `Title of ${id}`, what: "something happened", impact: "something is blocked", where, since: at(5), handled: null, ...over });
const titles = (sections: { title: string }[]) => sections.map((section) => section.title);
const text = (sections: { title: string; lines: string[] }[]) => sections.flatMap((section) => section.lines).join("\n");

test("a job problem carries the job record, its run, the rerun summary and the recent pattern", () => {
  const lost = failed({ runId: 7, jobId: 70, jobName: "Build", runnerName: "runner-a", runnerGroup: "pool-group", labels: ["self-hosted", "linux"], pullRequests: [12], failedSteps: [], annotations: [failure(LOSS)], logExcerpt: "line one\nline two" }, 5);
  const sibling = failed({ runId: 7, jobId: 71, jobName: "Lint", annotations: [failure("lint exploded")] }, 6);
  const elsewhere = [failed({ runId: 8, jobId: 80, jobName: "Build", runnerName: "runner-a" }, 4), failed({ runId: 9, jobId: 90, jobName: "Other", runnerName: "runner-b" }, 3), failed({ runId: 10, jobId: 100, jobName: "Build", runnerName: "runner-c" }, 2)];
  const classified = [classify(lost, "runner_loss"), classify(sibling, "real"), ...elsewhere.map((j) => classify(j, "runner_loss")), classify(failed({ runId: 11, jobId: 110, jobName: "Build" }, 1), "flake")];
  const reruns = [{ runId: 7, event: "pull_request", workflowName: "CI", headSha: lost.headSha, headBranch: "feature", attempts: 2, outcomes: ["failure", "success"], finalConclusion: "success", repeatedRunnerMs: 120_000 }];
  const sections = problemContext(problem("runner_loss:70", { runId: 7, attempt: 1, jobId: 70, jobName: "Build", pool: "self-hosted", runnerName: "runner-a", branch: "feature", pullRequests: [12], url: `https://github.com/${REPO}/actions/runs/7/job/70` }), base({ classified, reruns }));
  expect(titles(sections)).toEqual(["Verdict", "Problem", "Failing runs", "Current state", "Evidence (job records)", "Same run", "Recent pattern (stored job history)", "Freshness", "Suggested action"]);
  const all = text(sections);
  for (const fact of ["Problem id: runner_loss:70", "Kind: runner_loss", `Run URL: https://github.com/${REPO}/actions/runs/7`, `Job URL: https://github.com/${REPO}/actions/runs/7/job/70`,
    "Runner: runner-a (group pool-group)", "Labels: self-hosted, linux", "Pull requests: #12", "Duration: 3m 0s", LOSS, "| line one", "| line two", "Classification: runner_loss",
    "Lint · real", "2 attempt(s), outcomes failure → success", "repeated runner time 2 min",
    "Runner losses in pool self-hosted: 4", 'Runner losses of job "Build": 3', "Runner losses on runner runner-a: 2", 'Flaky occurrences of job "Build": 1',
    "Job history covers from", "3 run(s) left to fetch, 1 failed", "Live pool poll"]) expect(all).toContain(fact);
});

test("sections without data are left out", () => {
  expect(titles(problemContext(problem("flake:5", { jobId: 5 }), base({ backfill: undefined, coverage: null, analysisAt: null, polledAt: null })))).toEqual(["Verdict", "Problem", "Freshness"]);
});

test("mass runner loss lists every job of the group, capped", () => {
  const jobs = Array.from({ length: 25 }, (_, i) => classify(failed({ runId: 100 + i, jobId: 1000 + i, runnerName: `runner-${i}` }, 5), "runner_loss"));
  const group = { since: at(5), until: at(6), runners: jobs.map((c) => c.job.runnerName!), runIds: jobs.map((c) => c.job.runId), jobs };
  const sections = problemContext(problem("mass_cancel:" + at(5), { pool: "self-hosted" }, { severity: "critical" }), base({ classified: jobs, massCancels: [group] }));
  expect(titles(sections)).toEqual(["Verdict", "Problem", "Failing runs", "Current state", "Mass runner loss", "Freshness", "Suggested action"]);
  const lines = sections.find((section) => section.title === "Mass runner loss")!.lines;
  expect(lines[0]).toContain("25 jobs on 25 runners in 25 runs");
  expect(lines).toHaveLength(1 + 20 + 1);
  expect(lines.at(-1)).toBe("- … 5 more");
  expect(lines[1]).toMatch(/runs\/1\d\d · runner-\d+ · runner_loss$/);
});

test("a pool stall shows the stalled pool and the other pools", () => {
  const pools = [{ pool: "self-hosted", queued: 4, inProgress: 0, oldestQueuedAt: at(1), lastStartedAt: at(0), queuedRunIds: [41, 42] }, { pool: "ubuntu-latest", queued: 0, inProgress: 2, oldestQueuedAt: null, lastStartedAt: at(8), queuedRunIds: [] }];
  const sections = problemContext(problem("pool_stall:self-hosted", { pool: "self-hosted" }, { severity: "critical" }), base({ pools }));
  expect(titles(sections)).toEqual(["Verdict", "Problem", "Pool stall", "Freshness"]);
  const stall = text([sections.find((section) => section.title === "Pool stall")!]);
  for (const fact of ["Stalled pool — self-hosted: 4 queued, 0 running", `oldest queued ${at(1)}`, `last start ${at(0)}`, `actions/runs/41`, `actions/runs/42`, "- ubuntu-latest: 0 queued, 2 running"]) expect(stall).toContain(fact);
});

test("a run-level alert includes the recent classified failures of that workflow on that branch", () => {
  const alert = { kind: "main" as const, workflowId: 1, name: "CI", branch: "main", runId: 55, createdAt: at(9), consecutive: 2 };
  const same = Array.from({ length: 12 }, (_, i) => classify(failed({ runId: 40 + i, jobId: 400 + i, headBranch: "main", workflowName: "CI" }, i), i === 11 ? "runner_loss" : "real"));
  const noise = [classify(failed({ runId: 99, jobId: 990, headBranch: "other" }), "real"), classify(failed({ runId: 98, jobId: 980, workflowName: "Other", headBranch: "main" }), "real")];
  const current = classify(failed({ runId: 55, jobId: 550, headBranch: "main", jobName: "Deploy" }, 9), "real");
  const sections = problemContext(problem(alertProblemId(alert), { runId: 55, branch: "main", url: `https://github.com/${REPO}/actions/runs/55` }, { severity: "critical" }), base({ classified: [...same, ...noise, current], alerts: [alert] }));
  expect(titles(sections)).toEqual(["Verdict", "Problem", "Failing runs", "Current state", "Evidence (job records)", "Run-level alert", "Recent pattern (stored job history)", "Freshness", "Suggested action"]);
  const block = sections.find((section) => section.title === "Run-level alert")!.lines;
  expect(block).toEqual(expect.arrayContaining(["Workflow: CI", "Branch: main (default branch)", "Consecutive failures: 2"]));
  const rows = block.filter((line) => line.startsWith("- "));
  expect(rows).toHaveLength(10);
  expect(rows.join("\n")).not.toContain("runs/99");
  expect(rows.join("\n")).not.toContain("runs/98");
  expect(text(sections)).toContain("Kind: run-level alert (main)");
});

test("the prompt stays under the cap by shortening lists and annotations, never the instructions", () => {
  const long = "x".repeat(2000);
  const jobs = Array.from({ length: 5 }, (_, i) => classify(failed({ runId: 7, jobId: 70 + i, annotations: Array.from({ length: 20 }, () => failure(long)), logExcerpt: Array.from({ length: 30 }, () => long).join("\n") }), "real"));
  const target = problem("rerun_failed:7:1", { runId: 7, attempt: 1 });
  const sections = problemContext(target, base({ classified: jobs }));
  expect(text(sections)).not.toContain("x".repeat(501 + 300));
  const prompt = seedPrompt(REPO, target, sections);
  expect(prompt.length).toBeLessThanOrEqual(12_000);
  expect(prompt).toContain("omitted to keep the prompt short");
  for (const fact of ["Do not re-run workflows, cancel runs or change CI configuration unless the owner asks.", "gh run view <runId>", "Classify the root cause", "ci_dashboard_metrics", "Problem: Title of rerun_failed:7:1 (warning)"]) expect(prompt).toContain(fact);
  expect(seedPrompt(REPO, target).length).toBeLessThan(12_000);
});

// --- investigate prompt: verdict, streak, commits, current state, deploys, rates, actions, notes ---
const run = (id: number, minute: number, conclusion: string | null, over: Partial<Run> = {}): Run => ({ id, created_at: at(minute), conclusion, workflow_id: 1, name: "CI", head_branch: "main", event: "push", head_sha: `${id}`.padStart(40, "a"), ...over });
const streakAlert = { kind: "main" as const, workflowId: 1, name: "CI", branch: "main", runId: 52, createdAt: at(3), consecutive: 3 };
const alertProblem = () => problem(alertProblemId(streakAlert), { runId: 52, branch: "main" }, { severity: "critical" });
const section = (sections: { title: string; lines: string[] }[], title: string) => sections.find((item) => item.title === title)?.lines ?? [];
const streakRuns = [run(49, 0, "success"), run(50, 1, "failure", { display_title: "Add retry to uploads (#123)" }), run(51, 2, "failure", { display_title: "Tidy docs", pull_requests: [77] }), run(52, 3, "failure")];
const onMain = (id: number, cls: Parameters<typeof classify>[1], over: Partial<Parameters<typeof failed>[0]> = {}) => classify(failed({ runId: id, jobId: id * 10, headBranch: "main", event: "push", ...over }, id - 40), cls);

test("Verdict is the first section and counts the non-success jobs of every run of the streak", () => {
  const classified = [onMain(50, "runner_loss"), onMain(51, "refused", { jobId: 511 }), onMain(52, "runner_loss", { jobId: 521 })];
  const sections = problemContext(alertProblem(), base({ classified, alerts: [streakAlert], runs: streakRuns }));
  expect(sections[0]!.title).toBe("Verdict");
  expect(section(sections, "Verdict")).toEqual(["Runs checked: 3 (the consecutive-failure streak)", "Non-success jobs by class: 2 runner_loss, 1 refused, 0 real", "Code looks broken: no"]);
});

test.each<[string, ReturnType<typeof onMain>[], string]>([
  ["a real failure", [onMain(52, "real")], "yes"],
  ["a flake on the default branch", [onMain(52, "flake")], "no (red on flakes only)"],
  ["flakes with their consequences", [onMain(52, "flake"), onMain(52, "consequence", { jobId: 2 })], "no (red on flakes only)"],
  ["a flake and a real failure", [onMain(52, "flake"), onMain(52, "real", { jobId: 2 })], "yes"],
  ["only infrastructure, refusals and cancels", [onMain(52, "runner_loss"), onMain(52, "refused", { jobId: 2 }), onMain(52, "transient", { jobId: 3 }), onMain(52, "timeout", { jobId: 4 }), onMain(52, "superseded", { jobId: 5 })], "no"],
  ["an unrecognised cause", [onMain(52, "unknown")], "unknown"],
  ["jobs that are not stored yet", [], "unknown"],
])("Code looks broken with %s: %s", (_name, classified, expected) => {
  const sections = problemContext(problem("run:main:52", { runId: 52 }), base({ classified, alerts: [streakAlert], runs: [streakRuns[3]!] }));
  expect(section(sections, "Verdict")).toContain(`Code looks broken: ${expected}`);
});

test("a run whose jobs are not stored keeps the verdict unknown unless something real is found", () => {
  const sections = problemContext(alertProblem(), base({ classified: [onMain(52, "runner_loss")], alerts: [streakAlert], runs: streakRuns }));
  expect(section(sections, "Verdict")).toEqual(expect.arrayContaining(["Jobs of 2 run(s) are not stored yet", "Code looks broken: unknown"]));
});

test("Since of a run-level alert is the start of the streak, not the latest run", () => {
  const sections = problemContext(alertProblem(), base({ alerts: [streakAlert], runs: streakRuns }));
  expect(text([section(sections, "Problem").length ? { title: "Problem", lines: section(sections, "Problem") } : { title: "", lines: [] }])).toContain(`Since: ${at(1)}`);
  expect(text(sections)).not.toContain(`Since: ${at(5)}`);
  // Without stored run history it falls back to the problem's own time.
  expect(section(problemContext(alertProblem(), base({ alerts: [streakAlert] })), "Problem").join("\n")).toContain(`Since: ${at(5)}`);
});

test("each failing run lists its commit, title and PR number without extra requests", () => {
  const sections = problemContext(alertProblem(), base({ classified: [onMain(52, "real", { pullRequests: [88] })], alerts: [streakAlert], runs: streakRuns }));
  const rows = section(sections, "Failing runs");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toContain(`Run 52 (${at(3)}): commit ${"52".padStart(40, "a").slice(0, 12)} · PR #88`);
  expect(rows[1]).toContain('"Tidy docs" · PR #77');
  expect(rows[2]).toContain('"Add retry to uploads (#123)" · PR #123');
  expect(section(problemContext(problem("run:main:60", { runId: 60 }), base({ alerts: [{ ...streakAlert, runId: 60 }] })), "Failing runs")[0]).toContain("commit unknown");
});

test("Current state lists newer runs, including live ones, and whether each failed job has since passed", () => {
  const classified = [onMain(52, "real", { jobName: "Unit tests" }), onMain(52, "refused", { jobId: 2, jobName: "Release gate" }), onMain(52, "runner_loss", { jobId: 3, jobName: "Lint" }), onMain(53, "real", { jobId: 4, jobName: "Unit tests" })];
  const live = failed({ runId: 54, jobId: 90, status: "in_progress", conclusion: null, headBranch: "main", workflowName: "CI", headSha: "f".repeat(40) });
  const runs = [...streakRuns, run(53, 4, "failure"), run(54, 5, null), run(55, 6, "success", { name: "Other" }), run(56, 7, "success", { head_branch: "feature" })];
  const state = section(problemContext(alertProblem(), base({ classified, alerts: [streakAlert], runs, liveJobs: [live] })), "Current state").join("\n");
  expect(state).toContain("Run 53: commit");
  expect(state).toMatch(/Run 54: commit f{12} · in_progress/);
  expect(state).not.toMatch(/Run 5[56]/);
  expect(state).toContain('Job "Unit tests" failed before; self-healing: no (failed again in run 53)');
  expect(state).toContain('Job "Release gate" failed before; self-healing: yes (did not fail in run 53)');
  const healed = section(problemContext(alertProblem(), base({ classified, alerts: [streakAlert], runs: [...streakRuns, run(53, 4, "success")] })), "Current state").join("\n");
  expect(healed).toContain('Job "Lint" failed before; self-healing: yes (passed in run 53)');
  expect(section(problemContext(alertProblem(), base({ classified, alerts: [streakAlert], runs: streakRuns })), "Current state").join("\n")).toContain("No newer run of CI on main since run 52.");
  expect(section(problemContext(alertProblem(), base({ classified: classified.slice(0, 3), alerts: [streakAlert], runs: [...streakRuns, run(53, 4, "failure")] })), "Current state").join("\n")).toContain("self-healing: unknown (jobs of run 53 are not stored)");
});

test("Deploy state shows the latest deployment per environment from stored history", () => {
  const deployments = [{ environment: "production", ref: "main", sha: "b".repeat(40), created_at: at(2) }, { environment: "production", ref: "old", created_at: at(1) }, { environment: "staging", ref: "feature", created_at: at(3) }];
  const lines = section(problemContext(alertProblem(), base({ alerts: [streakAlert], runs: streakRuns, deployments })), "Deploy state");
  expect(lines).toEqual(["Latest deployment per environment (stored history):", `- production: ref main (commit ${"b".repeat(12)}), deployed ${at(2)}`, `- staging: ref feature, deployed ${at(3)}`]);
  expect(section(problemContext(alertProblem(), base({ alerts: [streakAlert], deployments: [{ created_at: at(1) }] })), "Deploy state")[0]).toContain("no environment details");
  expect(section(problemContext(alertProblem(), base({ alerts: [streakAlert], deployments: [] })), "Deploy state")).toEqual([]);
});

test("Recent pattern states its window and a per-day rate for every count", () => {
  const lost = Array.from({ length: 6 }, (_, i) => classify(failed({ runId: 7 + i, jobId: 70 + i, jobName: "Build", runnerName: "runner-a", failedSteps: [], annotations: [failure(LOSS)] }), "runner_loss"));
  const lines = section(problemContext(problem("runner_loss:70", { runId: 7, jobId: 70 }), base({ classified: lost, coverage: new Date(Date.parse(at(10)) - 3 * 86_400_000).toISOString(), windowDays: 14 })), "Recent pattern (stored job history)");
  expect(lines[0]).toBe(`Window: ${new Date(Date.parse(at(10)) - 3 * 86_400_000).toISOString()} to ${new Date(Date.parse(at(10))).toISOString()} (3.0 days)`);
  expect(lines).toEqual(expect.arrayContaining(['- Runner losses of job "Build": 6 (2.0/day)', "- Runner losses in pool self-hosted: 6 (2.0/day)"]));
  // History older than the configured window is not counted into the window.
  expect(section(problemContext(problem("runner_loss:70", { runId: 7, jobId: 70 }), base({ classified: lost, coverage: at(-6000), windowDays: 2 })), "Recent pattern (stored job history)")[0]).toContain("(2.0 days)");
});

test("Suggested action covers each class present, with who acts, and uses the configured actor names", () => {
  const classes = ["runner_loss", "refused", "transient", "flake", "real"] as const;
  const classified = classes.map((cls, i) => onMain(52, cls, { jobId: i + 1 }));
  const lines = section(problemContext(alertProblem(), base({ classified, alerts: [streakAlert], runs: streakRuns })), "Suggested action");
  expect(lines).toEqual([
    "- runner_loss: let the next run supersede it, or re-run failed jobs once (who: Runner owner / SRE)", "- transient: re-run failed jobs (who: PR author)", "- flake: track and fix the flaky test (who: Lead)",
    "- real: fix the code (who: PR author)", "- refused: no action, the next run delivers (who: nobody)"]);
  const renamed = section(problemContext(alertProblem(), base({ classified: [onMain(52, "real")], alerts: [streakAlert], runs: streakRuns, actors: { owner_sre: "SRE", pr_author: "Author", lead: "TL", manager: "EM" } })), "Suggested action");
  expect(renamed).toEqual(["- real: fix the code (who: Author)"]);
  expect(section(problemContext(alertProblem(), base({ classified: [onMain(52, "superseded")], alerts: [streakAlert], runs: streakRuns })), "Suggested action")).toEqual([]);
});

test("Team notes are appended verbatim, and Verdict, Suggested action and notes survive the size cap", () => {
  const notes = "Rerun limit: once per commit.\n\nIncident log: https://example.invalid/incidents\n" + "n".repeat(900);
  const long = "x".repeat(2000);
  const jobs = [onMain(52, "real", { annotations: Array.from({ length: 20 }, () => failure(long)), logExcerpt: Array.from({ length: 30 }, () => long).join("\n") }), ...Array.from({ length: 4 }, (_, i) => onMain(52, "real", { jobId: 600 + i, annotations: Array.from({ length: 20 }, () => failure(long)) }))];
  const sections = problemContext(alertProblem(), base({ classified: jobs, alerts: [streakAlert], runs: streakRuns, notes }));
  expect(section(sections, "Team notes")).toEqual(notes.split("\n"));
  const prompt = seedPrompt(REPO, alertProblem(), sections);
  expect(prompt.length).toBeLessThanOrEqual(12_000);
  expect(prompt).toContain("omitted to keep the prompt short");
  for (const fact of ["## Verdict", "Code looks broken: yes", "## Suggested action", "- real: fix the code", "## Team notes", "Rerun limit: once per commit.", "Incident log: https://example.invalid/incidents", "n".repeat(900), "## Your task"]) expect(prompt).toContain(fact);
  expect(prompt.indexOf("## Verdict")).toBeLessThan(prompt.indexOf("## Problem"));
  expect(section(problemContext(alertProblem(), base({ alerts: [streakAlert] })), "Team notes")).toEqual([]);
});

test("handled entries stored before claims still parse; fix_pending carries a ref of at most 80 characters", () => {
  const at = "2026-01-10T12:00:00Z";
  expect(handledSchema.parse({ state: "investigating", threadId: "thr_worker", at })).toEqual({ state: "investigating", threadId: "thr_worker", at });
  expect(handledSchema.parse({ state: "dismissed", at })).toEqual({ state: "dismissed", at });
  expect(handledSchema.parse({ state: "fix_pending", ref: "#12", by: "agent", threadId: "thr_worker", at })).toMatchObject({ state: "fix_pending", ref: "#12", by: "agent" });
  expect(handledSchema.parse({ state: "fix_pending", ref: "FIX-1", at }).by).toBeUndefined();
  for (const bad of [{ state: "fix_pending", ref: "x".repeat(81), at }, { state: "released", at }, { state: "fix_pending", by: "bot", at }]) expect(handledSchema.safeParse(bad).success).toBe(false);
});
