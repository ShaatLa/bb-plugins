import { setTimeout as sleep } from "node:timers/promises";
import { GithubError, type CiState, type RequiredRule } from "./github";

/** The exit-code contract agents rely on; do not renumber. */
export const CI_EXIT = { green: 0, red: 1, cancelled: 2, noVerdict: 3 } as const;
export const CI_POLL_MS = 20_000;
// A run registers seconds after a push or `gh pr ready` (once 40 s); the PR head can lag as long.
export const CI_GRACE_MS = 120_000;
const FAILURES_TOLERATED = 5;

type VerdictName = "green" | "red" | "cancelled" | "no-verdict";
export type CiVerdict = { exitCode: number; verdict: VerdictName; message: string; failed?: string[] };
type Wait = { wait: string };
const NAMES: Record<number, VerdictName> = { 0: "green", 1: "red", 2: "cancelled", 3: "no-verdict" };
const verdict = (exitCode: number, message: string, failed?: string[]): CiVerdict =>
  ({ exitCode, verdict: NAMES[exitCode]!, message, ...(failed ? { failed } : {}) });

/** Whether the PR head is the SHA being judged: the SHA, a wait for it to arrive, or a verdict. */
export function assessCiHead(headSha: string, expected: string | undefined, matched: boolean, sinceStartMs: number): { sha: string } | Wait | CiVerdict {
  if (expected === undefined || headSha === expected) return { sha: headSha };
  if (matched) return verdict(CI_EXIT.cancelled, `superseded: the PR head moved from ${expected} to ${headSha}`);
  if (sinceStartMs < CI_GRACE_MS) return { wait: `the PR head is still ${headSha}` };
  return verdict(CI_EXIT.noVerdict, `the PR head is ${headSha}, not ${expected}: push that commit, or pass the SHA you mean with --head`);
}

type RuleState = "passed" | "failed" | "cancelled" | "pending" | "missing" | "unknown";

/**
 * The state of one required rule on the head. Actions checks that started before the PR was marked ready belong
 * to the draft run, which `gh pr ready` replaces, so they count as not reported yet.
 */
function ruleState(state: CiState, rule: RequiredRule, readyAt: number): RuleState {
  const matches = state.checks.filter((check) =>
    check.name === rule.context && (rule.appId === null || rule.appId === check.appId) &&
    !(check.app === "github-actions" && check.startedAt !== null && Date.parse(check.startedAt) < readyAt));
  if (!matches.length) return "missing";
  const states = matches.map((check) => check.state);
  if (states.some((value) => value === "passed" || value === "skipped" || value === "neutral")) return "passed";
  if (states.includes("failed")) return "failed";
  if (states.includes("pending")) return "pending";
  if (states.includes("cancelled")) return "cancelled";
  return "unknown";
}

/**
 * The verdict for a head that is the judged SHA. It waits while any workflow run started after the PR became ready
 * is still going, then judges every required check GitHub lists for the base branch.
 */
export function assessCiChecks(state: CiState, sinceStartMs: number, sinceHeadMs: number, now: number): Wait | CiVerdict {
  if (state.state === "closed") return verdict(CI_EXIT.noVerdict, "the PR is closed");
  if (state.state === "draft")
    return sinceStartMs < CI_GRACE_MS
      ? { wait: "the PR is a draft" }
      : verdict(CI_EXIT.noVerdict, "the PR is a draft, so its CI run does not count: run `gh pr ready` first");
  if (state.dirty) return verdict(CI_EXIT.noVerdict, "the PR conflicts with its base (DIRTY), so CI cannot pass: rebase it");
  if (state.required === null)
    return verdict(CI_EXIT.noVerdict, "the required check set is unknown: the server's GitHub token cannot read branch protection or rulesets");
  if (!state.required.length) return verdict(CI_EXIT.noVerdict, "the base branch requires no status checks, so there is nothing to wait for");
  const readyAt = state.readyAt ? Date.parse(state.readyAt) : 0;
  const runs = state.runs.filter((run) => Date.parse(run.createdAt) >= readyAt);
  const active = runs.find((run) => run.status !== "completed");
  if (active) return { wait: `run ${active.name ?? active.id} ${active.status}: ${active.url}` };
  const rules = state.required.map((rule) => ({ name: rule.context, state: ruleState(state, rule, readyAt) }));
  const named = (wanted: RuleState) => rules.filter((rule) => rule.state === wanted).map((rule) => rule.name);
  if (named("failed").length) return verdict(CI_EXIT.red, `red: required checks failed: ${named("failed").join(", ")}`, named("failed"));
  if (named("cancelled").length) return verdict(CI_EXIT.cancelled, `cancelled: ${named("cancelled").join(", ")}`);
  if (named("pending").length) return { wait: `waiting for ${named("pending").join(", ")}` };
  if (named("unknown").length) return verdict(CI_EXIT.noVerdict, `required checks ended without a usable conclusion: ${named("unknown").join(", ")}`);
  const missing = named("missing");
  if (missing.length) {
    const since = readyAt ? Math.min(sinceHeadMs, now - readyAt) : sinceHeadMs;
    if (!runs.length && since < CI_GRACE_MS) return { wait: "no CI run registered yet" };
    if (runs.some((run) => run.conclusion === "cancelled")) return verdict(CI_EXIT.cancelled, `run cancelled before reporting ${missing.join(", ")}`);
    return verdict(CI_EXIT.noVerdict, runs.length
      ? `the runs on this head finished without reporting ${missing.join(", ")}`
      : `no CI run for this head ${CI_GRACE_MS / 60_000} min after it was first seen${state.readyAt ? " or marked ready" : ""}`);
  }
  return verdict(CI_EXIT.green, `green: ${rules.length} required check${rules.length === 1 ? "" : "s"} passed (${rules.map((rule) => rule.name).join(", ")})`);
}

export type CiWaitResult = CiVerdict & { url: string; sha: string; waitedMs: number; last: string };

/** Poll a PR until its required checks give a verdict for one head, or the timeout passes. */
export async function waitForPrCi(
  client: { ciState(repository: string, number: number): Promise<CiState> },
  input: { repository: string; number: number; head?: string; timeoutMs: number },
  signal: AbortSignal,
  clock: { now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<unknown> } = { now: Date.now, sleep: (ms, s) => sleep(ms, undefined, { signal: s }) },
): Promise<CiWaitResult> {
  const started = clock.now();
  let expected = input.head, matched = false, headAt = started, failures = 0, last = "starting", url = "", sha = input.head ?? "";
  const done = (result: CiVerdict): CiWaitResult => ({ ...result, url, sha, waitedMs: clock.now() - started, last });
  for (;;) {
    try {
      const state = await client.ciState(input.repository, input.number);
      url = state.url;
      const head = assessCiHead(state.headSha, expected, matched, clock.now() - started);
      if ("exitCode" in head) return done(head);
      if ("wait" in head) last = head.wait;
      else {
        if (!matched) headAt = clock.now();
        matched = true;
        expected = sha = head.sha;
        const step = assessCiChecks(state, clock.now() - started, clock.now() - headAt, clock.now());
        if ("exitCode" in step) return done(step);
        last = step.wait;
      }
      failures = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      if (!matched && error instanceof GithubError && [401, 403, 404].includes(error.status))
        return done(verdict(CI_EXIT.noVerdict, `GitHub cannot read this PR (HTTP ${error.status}): check the URL and the server's gh login`));
      // GitHub 5xx or the network is far more often transient than lasting; five polls in a row is not.
      if (++failures >= FAILURES_TOLERATED)
        return done(verdict(CI_EXIT.noVerdict, `GitHub failed ${failures} polls in a row: ${error instanceof Error ? error.message : String(error)}`));
    }
    if (clock.now() + CI_POLL_MS - started > input.timeoutMs)
      return done(verdict(CI_EXIT.noVerdict, `timed out after ${Math.round(input.timeoutMs / 60_000)} min; last seen: ${last}`));
    await clock.sleep(CI_POLL_MS, signal);
  }
}
