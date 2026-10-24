import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveGithubToken } from "./auth";

const run = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ stdout: string }>>());
vi.mock("node:child_process", () => ({
  execFile: Object.assign(vi.fn(), { [Symbol.for("nodejs.util.promisify.custom")]: run }),
}));
beforeEach(() => {
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  run.mockReset();
  run.mockResolvedValue({ stdout: "keyring-token\n" });
});
afterEach(() => vi.unstubAllEnvs());
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
  run.mockRejectedValue(new Error("sensitive-output"));
  expect(await resolveGithubToken(undefined, signal())).toEqual({ token: undefined, source: "anonymous" });
});

test("abort never falls back to unauthenticated requests", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(resolveGithubToken(undefined, controller.signal)).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
