import { describe, expect, it } from "vitest";
import { CI_EXIT, CI_GRACE_MS, CI_POLL_MS, assessCiChecks, waitForPrCi } from "./ci-wait";
import { createGithubClient, GithubError, type CiState } from "./github";

const A = "a".repeat(40), B = "b".repeat(40);
const T0 = Date.parse("2026-11-11T12:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();
const REQUIRED = [{ context: "CI complete", appId: null }, { context: "PR metadata", appId: null }];

function state(patch: Partial<CiState> = {}): CiState {
  return {
    url: "https://github.com/o/r/pull/7", headSha: A, state: "open", dirty: false, readyAt: null, required: REQUIRED,
    checks: [
      { name: "CI complete", app: "github-actions", appId: 15368, state: "passed", url: null, startedAt: iso(T0 + 60_000) },
      { name: "PR metadata", app: "github-actions", appId: 15368, state: "passed", url: null, startedAt: iso(T0 + 30_000) },
    ],
    runs: [{ id: 2, name: "CI", status: "completed", conclusion: "success", url: "https://github.com/o/r/actions/runs/2", createdAt: iso(T0 + 10_000) }],
    ...patch,
  };
}
const judge = (value: CiState, sinceHead = 600_000, now = T0 + 600_000) => assessCiChecks(value, sinceHead, sinceHead, now);

describe("assessCiChecks", () => {
  it("is green only when every required check passed on the head", () => {
    expect(judge(state())).toMatchObject({ exitCode: CI_EXIT.green });
    const partial = state({ checks: state().checks.slice(0, 1) });
    expect(judge(partial)).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("PR metadata") });
  });

  it("reports failed required check names and ignores failures of optional checks", () => {
    const red = state({ checks: [...state().checks.slice(1), { name: "CI complete", app: "github-actions", appId: 15368, state: "failed", url: null, startedAt: iso(T0 + 60_000) }] });
    expect(judge(red)).toMatchObject({ exitCode: CI_EXIT.red, failed: ["CI complete"] });
    const optional = state({ checks: [...state().checks, { name: "Wiz scan", app: "wiz", appId: 1, state: "failed", url: null, startedAt: null }] });
    expect(judge(optional)).toMatchObject({ exitCode: CI_EXIT.green });
  });

  it("waits while a run on the head is still going, even if required checks look settled", () => {
    const running = state({ runs: [{ ...state().runs[0]!, status: "in_progress", conclusion: null }] });
    expect(judge(running)).toEqual({ wait: expect.stringContaining("in_progress") });
  });

  it("never judges the finished draft run once the PR was marked ready", () => {
    const readyAt = T0 + 300_000;
    const draftRun = { id: 1, name: "CI", status: "completed", conclusion: "failure", url: "https://github.com/o/r/actions/runs/1", createdAt: iso(T0) };
    const draftChecks: CiState["checks"] = [
      { name: "CI complete", app: "github-actions", appId: 15368, state: "failed", url: null, startedAt: iso(T0 + 60_000) },
      { name: "PR metadata", app: "github-actions", appId: 15368, state: "passed", url: null, startedAt: iso(T0 + 30_000) },
    ];
    // Right after `gh pr ready`: only the draft run exists, its CI complete failed by design.
    const justReady = state({ readyAt: iso(readyAt), runs: [draftRun], checks: draftChecks });
    expect(judge(justReady, 10_000, readyAt + 10_000)).toEqual({ wait: "no CI run registered yet" });
    // The ready run registered and is running; the gate job has not started, so its old check is still the latest.
    const readyRun = { id: 3, name: "CI", status: "in_progress", conclusion: null, url: "https://github.com/o/r/actions/runs/3", createdAt: iso(readyAt + 5_000) };
    expect(judge(state({ readyAt: iso(readyAt), runs: [draftRun, readyRun], checks: draftChecks }), 60_000, readyAt + 60_000)).toEqual({ wait: expect.stringContaining("in_progress") });
    // The ready run finished green.
    const finished = state({
      readyAt: iso(readyAt),
      runs: [draftRun, { ...readyRun, status: "completed", conclusion: "success" }],
      checks: [
        { name: "CI complete", app: "github-actions", appId: 15368, state: "passed", url: null, startedAt: iso(readyAt + 600_000) },
        { name: "PR metadata", app: "github-actions", appId: 15368, state: "passed", url: null, startedAt: iso(readyAt + 20_000) },
      ],
    });
    expect(judge(finished, 700_000, readyAt + 700_000)).toMatchObject({ exitCode: CI_EXIT.green });
  });

  it("accepts non-Actions checks that ran before the PR was marked ready", () => {
    const value = state({
      readyAt: iso(T0 + 1_000),
      required: [{ context: "Wiz scan", appId: null }],
      checks: [{ name: "Wiz scan", app: "commit-status", appId: null, state: "passed", url: null, startedAt: null }],
      runs: [],
    });
    expect(judge(value)).toMatchObject({ exitCode: CI_EXIT.green });
  });

  it("gives no verdict for DIRTY, an unknown or empty required set, a closed PR or no run after the grace period", () => {
    expect(judge(state({ dirty: true }))).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("DIRTY") });
    expect(judge(state({ required: null }))).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("unknown") });
    expect(judge(state({ required: [] }))).toMatchObject({ exitCode: CI_EXIT.noVerdict });
    expect(judge(state({ state: "closed" }))).toMatchObject({ exitCode: CI_EXIT.noVerdict });
    const none = state({ runs: [], checks: [] });
    expect(judge(none, 30_000)).toEqual({ wait: "no CI run registered yet" });
    expect(judge(none, CI_GRACE_MS + 1)).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("no CI run") });
  });

  it("treats a cancelled required check or run as cancelled", () => {
    const value = state({ checks: [{ ...state().checks[0]!, state: "cancelled" }, state().checks[1]!] });
    expect(judge(value)).toMatchObject({ exitCode: CI_EXIT.cancelled });
  });
});

function fakeClock() {
  let now = T0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; } };
}

describe("waitForPrCi", () => {
  const input = { repository: "o/r", number: 7, timeoutMs: 45 * 60_000 };

  it("polls until the head turns green and reports the judged SHA", async () => {
    const states = [state({ runs: [{ ...state().runs[0]!, status: "queued", conclusion: null }] }), state()];
    let calls = 0;
    const result = await waitForPrCi({ ciState: async () => states[Math.min(calls++, 1)]! }, input, new AbortController().signal, fakeClock());
    expect(result).toMatchObject({ exitCode: CI_EXIT.green, sha: A, waitedMs: CI_POLL_MS });
    expect(calls).toBe(2);
  });

  it("returns superseded when the head moves after it was matched", async () => {
    const states = [state({ runs: [{ ...state().runs[0]!, status: "in_progress", conclusion: null }] }), state({ headSha: B })];
    let calls = 0;
    const result = await waitForPrCi({ ciState: async () => states[Math.min(calls++, 1)]! }, { ...input, head: A }, new AbortController().signal, fakeClock());
    expect(result).toMatchObject({ exitCode: CI_EXIT.cancelled, message: expect.stringContaining("superseded") });
  });

  it("gives no verdict when the requested head never arrives", async () => {
    const result = await waitForPrCi({ ciState: async () => state({ headSha: B }) }, { ...input, head: A }, new AbortController().signal, fakeClock());
    expect(result).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("not " + A) });
  });

  it("stops at the timeout and after repeated GitHub failures, and fails fast on a missing PR", async () => {
    const pending = state({ runs: [{ ...state().runs[0]!, status: "in_progress", conclusion: null }] });
    const timedOut = await waitForPrCi({ ciState: async () => pending }, { ...input, timeoutMs: 60_000 }, new AbortController().signal, fakeClock());
    expect(timedOut).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("timed out") });
    let calls = 0;
    const flaky = await waitForPrCi({ ciState: async () => { calls++; throw new GithubError(502, "bad gateway"); } }, input, new AbortController().signal, fakeClock());
    expect(flaky).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("5 polls") });
    expect(calls).toBe(5);
    const missing = await waitForPrCi({ ciState: async () => { throw new GithubError(404, "not found"); } }, input, new AbortController().signal, fakeClock());
    expect(missing).toMatchObject({ exitCode: CI_EXIT.noVerdict, message: expect.stringContaining("HTTP 404") });
  });
});

describe("ciState", () => {
  it("reads head checks, statuses, required rules, runs and the last ready time from GitHub", async () => {
    const routes: Record<string, unknown> = {
      "/repos/o/r/pulls/7": { number: 7, node_id: "PR_1", html_url: "https://github.com/o/r/pull/7", title: "T", state: "open", draft: false, updated_at: iso(T0), mergeable_state: "clean", head: { sha: A }, base: { ref: "main", sha: B, repo: { full_name: "o/r", id: 1 } } },
      [`/repos/o/r/commits/${A}/check-runs?filter=latest&per_page=100&page=1`]: { check_runs: [
        { id: 1, name: "CI complete", head_sha: A, status: "completed", conclusion: "failure", html_url: null, started_at: iso(T0), completed_at: iso(T0), app: { id: 15368, slug: "github-actions" } },
        { id: 9, name: "CI complete", head_sha: A, status: "in_progress", conclusion: null, html_url: null, started_at: iso(T0 + 1000), completed_at: null, app: { id: 15368, slug: "github-actions" } },
      ] },
      [`/repos/o/r/commits/${A}/statuses?per_page=100&page=1`]: [{ context: "Wiz", state: "success", target_url: null }],
      // Like simple-life-app/anvil: no classic protection (404), required checks come from a ruleset.
      "/repos/o/r/rules/branches/main?per_page=100&page=1": [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "CI complete" }] } }],
      [`/repos/o/r/actions/runs?head_sha=${A}&per_page=100`]: { workflow_runs: [{ id: 3, workflow_id: 1, name: "CI", head_sha: A, head_branch: "x", event: "pull_request", status: "in_progress", conclusion: null, html_url: "https://github.com/o/r/actions/runs/3", created_at: iso(T0), head_repository: { id: 1 } }] },
      "/repos/o/r/issues/7/events?per_page=100&page=1": [{ event: "ready_for_review", created_at: iso(T0 - 5000) }, { event: "labeled", created_at: iso(T0) }, { event: "ready_for_review", created_at: iso(T0 - 1000) }],
    };
    const fetcher = (async (url: string) => {
      const path = url.replace("https://api.github.com", "");
      if (!(path in routes)) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify(routes[path]), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const client = createGithubClient({ token: async () => "t", signal: new AbortController().signal, fetcher });
    const value = await client.ciState("o/r", 7);
    expect(value).toMatchObject({
      headSha: A, state: "open", dirty: false, readyAt: iso(T0 - 1000), required: [{ context: "CI complete", appId: null }],
      runs: [{ id: 3, status: "in_progress" }],
    });
    expect(value.checks).toEqual([
      expect.objectContaining({ name: "CI complete", state: "pending" }),
      expect.objectContaining({ name: "Wiz", app: "commit-status", state: "passed" }),
    ]);
  });
});

describe("bb work-board pr wait", () => {
  it("validates the PR URL and refuses a short head SHA before calling GitHub", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { createStore } = await import("../api");
    const { registerTasksCli } = await import("../cli");
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
    registerTasksCli(bb, createStore(bb), { status: "ok" } as never);
    const badUrl = await harness.runCli(["pr", "wait", "--url", "https://github.com/o/r/issues/7"]).catch((error: Error) => error);
    expect(String((badUrl as Error).message ?? JSON.stringify(badUrl))).toContain("not a GitHub pull request URL");
    const shortSha = await harness.runCli(["pr", "wait", "--url", "https://github.com/o/r/pull/7", "--head", "abc123"]).catch((error: Error) => error);
    expect(String((shortSha as Error).message ?? JSON.stringify(shortSha))).toContain("full 40-character SHA");
    const help = await harness.runCli(["pr"]);
    expect(help.stdout).toContain("wait --url URL");
    await harness.dispose();
  });
});
