import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveGithubToken } from "./auth";

const run = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ stdout: string }>>());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: run }),
}));
let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(clock += 10_000_000);
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  run.mockReset();
  run.mockResolvedValue({ stdout: "keyring-token\n" });
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
const signal = () => new AbortController().signal;

test("explicit override precedes system credentials", async () => {
  vi.stubEnv("GH_TOKEN", "env-token");
  expect(await resolveGithubToken("override", signal())).toEqual({ token: "override", source: "plugin" });
  expect(run).not.toHaveBeenCalled();
});

test("uses GH_TOKEN before GITHUB_TOKEN without starting gh", async () => {
  vi.stubEnv("GH_TOKEN", "gh-env-token");
  vi.stubEnv("GITHUB_TOKEN", "github-env-token");
  expect(await resolveGithubToken(undefined, signal())).toEqual({ token: "gh-env-token", source: "environment" });
  vi.stubEnv("GH_TOKEN", "");
  expect(await resolveGithubToken(undefined, signal())).toEqual({ token: "github-env-token", source: "environment" });
  expect(run).not.toHaveBeenCalled();
});

test("reads the active github.com account through gh without persisting its token", async () => {
  expect(await resolveGithubToken("", signal())).toEqual({ token: "keyring-token", source: "gh" });
  expect(run.mock.calls[0][1]).toEqual(["auth", "token", "--hostname", "github.com"]);
});

test("tries BB's fallback executable paths and degrades to anonymous without CLI error output", async () => {
  run.mockRejectedValueOnce(new Error("not on PATH"));
  expect(await resolveGithubToken(undefined, signal())).toMatchObject({ source: "gh" });
  expect(run.mock.calls[1][0]).toBe("/opt/homebrew/bin/gh");
  vi.advanceTimersByTime(300_001);
  run.mockRejectedValue(new Error("sensitive-output"));
  expect(await resolveGithubToken(undefined, signal())).toEqual({ token: undefined, source: "anonymous" });
});

test("abort never falls back to unauthenticated requests", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(resolveGithubToken(undefined, controller.signal)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});

test("shares lookups and expires successes and failures", async () => {
  const a = resolveGithubToken(undefined, signal()), b = resolveGithubToken(undefined, signal());
  await Promise.all([a, b]); expect(run).toHaveBeenCalledTimes(1);
  await resolveGithubToken(undefined, signal()); expect(run).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(300_001); run.mockRejectedValue(new Error("private"));
  await resolveGithubToken(undefined, signal()); expect(run).toHaveBeenCalledTimes(4);
  await resolveGithubToken(undefined, signal()); expect(run).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(30_001); await resolveGithubToken(undefined, signal()); expect(run).toHaveBeenCalledTimes(7);
});
