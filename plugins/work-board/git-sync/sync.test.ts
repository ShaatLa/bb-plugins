import { createPlanStore } from "../plans/store";
import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { gitSyncService } from "./service";
import { createGithubClient, GithubError } from "./github";
import { gitSyncConfigSchema, prIdentity, prSnapshotSchema, settledSpreadMs } from "../shared/git-sync";
import {
  archiveRecords,
  captureProject,
  restoreProject,
} from "../archive/storage";
import { createGitSyncStore } from "./store";
import { createDependencyStore } from "../dependencies/store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});
const a = "a".repeat(40),
  b = "b".repeat(40),
  c = "c".repeat(40);
const rawPull = (number = 42, title = "ABC-1 ABC-12 work") => ({
  number,
  node_id: `PR_${number}`,
  html_url: `https://github.com/example/service/pull/${number}`,
  title,
  state: "open" as const,
  draft: false,
  updated_at: "2026-10-25T12:00:00.000Z",
  merged_at: null as string | null,
  merge_commit_sha: a as string | null,
  mergeable: true,
  mergeable_state: "clean",
  head: { sha: a },
  base: { ref: "trunk", sha: a, repo: { full_name: "example/service", id: 123 } },
});
const snapshot = (repository = "example/service", number = 42) =>
  prSnapshotSchema.parse({
    repository,
    number,
    remoteId: `PR_${repository}_${number}`,
    url: `https://github.com/${repository}/pull/${number}`,
    title: "Work",
    state: "open",
    headSha: a,
    mergeSha: null,
    mergedAt: null,
    baseBranch: "trunk",
    updatedAt: "2026-10-25T12:00:00.000Z",
    observedAt: new Date().toISOString(),
    checks: [],
    requirementsKnown: false,
    ci: "no_checks",
    mergeState: "CLEAN",
    mergeable: true,
    review: null,
    unresolvedThreads: null,
    coverage: [],
  });
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  const client = {
    discover: vi.fn(async () => [rawPull()]),
    referenceText: vi.fn(async () => "ABC-1"),
    snapshot: vi.fn(async (repository: string, number: number) =>
      snapshot(repository, number),
    ),
  };
  const service = gitSyncService(host.bb, store, client);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "0.9.0" });
  const project = store.tasks.createProject({
    name: "Example",
    prefix: "ABC",
    color: "blue",
  });
  const tasks = Array.from({ length: 12 }, (_, index) =>
    store.tasks.createTask({
      projectId: project.id,
      title: `Work ${index + 1}`,
    }),
  );
  return { ...host, store, project, task: tasks[0]!, tasks, client, service };
}
it.each([
  ["ABC-1: implement", [0]],
  ["feature/abc-2-fix", [1]],
  ["Fixes ABC-1 and ABC-2", [0, 1]],
  ["Another project DEF-1", []],
  ["No card mentioned", []],
  ["ABC-12 ABC-10 XABC-1 ABC-1_suffix", []],
] as const)("limits a shared worker's environment PR to matching cards: %s", async (text, matches) => {
  const f = setup();
  f.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds?: readonly string[] }) =>
    (threadIds ?? []).map((id) => makeThreadResponse({ id, environmentId: "env_shared" })));
  f.harness.sdk.stub("plugins.callRpc", async () => ({
    env_shared: { outcome: "available", pullRequest: {
      number: 42, title: "Worker PR", state: "open",
      url: "https://github.com/example/service/pull/42", updatedAt: "2026-11-04T00:00:00.000Z",
    } },
  }));
  for (const task of f.tasks.slice(0, 2))
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_shared_worker",
      title: "Shared worker", presetName: "Default", liveStatus: "working" });
  f.client.referenceText.mockResolvedValue(text);
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id,
    config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await f.service.syncProject(f.project.id);
  const data = createGitSyncStore(f.bb.storage.database());
  for (const index of [0, 1]) {
    expect(data.links(f.tasks[index]!.id)).toHaveLength(matches.some((value) => value === index) ? 1 : 0);
    for (const link of data.links(f.tasks[index]!.id))
      expect(link).toMatchObject({ source: "environment", confirmed: false, role: "related" });
  }
  expect(f.client.referenceText).toHaveBeenCalledTimes(1);
  const url = "https://github.com/example/service/pull/42";
  await f.service.handlers.unlinkPr({ taskId: f.task.id, url });
  await f.service.syncProject(f.project.id);
  expect(data.links(f.task.id)[0]).toMatchObject({ excluded: true });
  await f.service.handlers.linkPr({ taskId: f.task.id, url, role: "design", part: null });
  await f.service.syncProject(f.project.id);
  expect(data.links(f.task.id)[0]).toMatchObject({ source: "manual", confirmed: true, excluded: false, role: "design" });
});
it.each([
  ["ABC-1", "feature/other", null],
  ["Work", "feature/ABC-1-fix", null],
  ["Work", "feature/other", "Closes ABC-1"],
])("reads PR reference metadata from GitHub: %s %s %s", async (title, branch, body) => {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ title, body, head: { ref: branch } })));
  const client = createGithubClient({ token: async () => "token", signal: new AbortController().signal, fetcher });
  expect(await client.referenceText("example/service", 42)).toContain("ABC-1");
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("/repos/example/service/pulls/42");
});
it("discovers whole title keys, persists links independently of workers and honors exclusions and explicit roles", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({
    projectId: f.project.id,
    config: gitSyncConfigSchema.parse({ repositories: ["example/service"] }),
  });
  await f.service.syncProject(f.project.id);
  const links = (await f.service.handlers.listPrLinks({ taskId: f.task.id }))
    .links;
  expect(links).toHaveLength(1);
  expect(links[0]?.link).toMatchObject({
    confirmed: false,
    source: "title",
    role: "related",
  });
  expect(
    (await f.service.handlers.listPrLinks({ taskId: f.tasks[1]!.id })).links,
  ).toEqual([]);
  expect(
    (await f.service.handlers.listPrLinks({ taskId: f.tasks[11]!.id })).links,
  ).toHaveLength(1);
  const url = "https://github.com/example/service/pull/42";
  await f.service.handlers.unlinkPr({ taskId: f.task.id, url });
  await f.service.syncProject(f.project.id);
  expect(
    (await f.service.handlers.listPrLinks({ taskId: f.task.id })).links[0]?.link
      .excluded,
  ).toBe(true);
  const cli = await f.harness.runCli([
    "pr",
    "link",
    f.task.key,
    "--url",
    url,
    "--role",
    "design",
    "--json",
  ]);
  expect(cli.exitCode, cli.stderr).toBe(0);
  expect(JSON.parse(cli.stdout).link).toMatchObject({
    confirmed: true,
    source: "manual",
    role: "design",
    excluded: false,
  });
  await f.service.syncProject(f.project.id);
  expect(
    (await f.service.handlers.listPrLinks({ taskId: f.task.id })).links[0]?.link
      .role,
  ).toBe("design");
  expect(f.store.tasks.getTask(f.task.id)?.status).toBe("backlog");
  expect(
    (await f.harness.runCli(["pr", "list", f.task.key, "--json"])).exitCode,
  ).toBe(0);
  expect(
    (
      await f.harness.runCli([
        "pr",
        "link",
        f.task.key,
        "--url",
        url,
        "--role",
        "design",
        "--part",
        "1/2",
      ])
    ).exitCode,
  ).not.toBe(0);
});
it("keeps same-number PRs from different repositories separate and preserves last good state on failure", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({
    projectId: f.project.id,
    config: gitSyncConfigSchema.parse({
      repositories: ["example/service", "example/infra"],
      titleDiscovery: false,
    }),
  });
  for (const repository of ["example/service", "example/infra"])
    await f.service.handlers.linkPr({
      taskId: f.task.id,
      url: `https://github.com/${repository}/pull/42`,
      role: "delivers",
      part: null,
    });
  await f.service.syncProject(f.project.id);
  f.client.snapshot.mockRejectedValueOnce(new Error("Bearer do-not-echo-this"));
  const result = await f.service.syncProject(f.project.id);
  expect(result.errors.join()).not.toContain("do-not-echo");
  const values = (await f.service.handlers.listPrLinks({ taskId: f.task.id }))
    .links;
  expect(values).toHaveLength(2);
  expect(values.filter((value) => value.stale)).toHaveLength(1);
  expect(values.every((value) => value.snapshot?.state === "open")).toBe(true);
  expect(f.store.tasks.listComments(f.task.id)).toEqual([]);
});
it("exports v8 config and links/exclusions, excludes CI snapshots, and restores without duplicating or fetching", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({
    projectId: f.project.id,
    config: gitSyncConfigSchema.parse({
      repositories: ["example/service"],
      enabled: true,
      overlapRules: [{ pattern: "migrations/**", match: "added" }],
    }),
  });
  await f.service.handlers.linkPr({
    taskId: f.task.id,
    url: "https://github.com/example/service/pull/42",
    role: "delivers",
    part: "1/2",
  });
  await f.service.handlers.unlinkPr({
    taskId: f.task.id,
    url: "https://github.com/example/service/pull/43",
  });
  await f.service.syncProject(f.project.id);
  const capture = captureProject(f.bb, f.store, f.project.id);
  const records = await archiveRecords(f.store, capture, async () => {});
  expect(capture.manifest.version).toBe(22);
  expect(capture.manifest.gitSync?.repositories).toEqual(["example/service"]);
  expect(JSON.stringify(records)).not.toContain('"checks":');
  expect(
    records.find((record) => record.task.id === f.task.id)?.pullRequests,
  ).toHaveLength(2);
  const dest = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(dest);
  const target = createStore(dest.bb);
  restoreProject(
    dest.bb,
    target,
    { manifest: capture.manifest, records },
    new Map(),
    false,
  );
  restoreProject(
    dest.bb,
    target,
    { manifest: capture.manifest, records },
    new Map(),
    false,
  );
  const data = createGitSyncStore(dest.bb.storage.database());
  expect(data.config(f.project.id).overlapRules).toEqual([{ pattern: "migrations/**", match: "added" }]);
  expect(data.links(f.task.id)).toHaveLength(2);
  expect(
    data.snapshot(f.project.id, data.links(f.task.id)[0]!).snapshot,
  ).toBeNull();
});
function githubFixture(
  options: {
    merged?: boolean;
    mergedAt?: string;
    compare?: string;
    conclusion?: string;
    descendant?: boolean;
    queued?: boolean;
    headSha?: string;
    baseSha?: string;
    queueError?: boolean;
  } = {},
) {
  const requests: string[] = [];
  let token: string | undefined;
  let mergedAt = options.mergedAt ?? "2026-10-25T12:00:00.000Z";
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    let value: unknown = [];
    if (url.pathname.endsWith("/pulls/42"))
      value = {
        ...rawPull(),
        head: { sha: options.headSha ?? a },
        base: { ...rawPull().base, sha: options.baseSha ?? a },
        ...(options.merged
          ? {
              state: "closed",
              merged_at: mergedAt,
              merge_commit_sha: b,
            }
          : {}),
      };
    else if (url.pathname.endsWith("/check-runs"))
      value = {
        check_runs: [
          {
            id: 1,
            name: "test",
            head_sha: a,
            status: "completed",
            conclusion: "failure",
            html_url: null,
            started_at: "2026-10-25T12:01:00Z",
            completed_at: "2026-10-25T12:02:00Z",
            app: { id: 1, slug: "ci" },
          },
          {
            id: 2,
            name: "test",
            head_sha: a,
            status: "completed",
            conclusion: "success",
            html_url: null,
            started_at: "2026-10-25T12:03:00Z",
            completed_at: "2026-10-25T12:04:00Z",
            app: { id: 1, slug: "ci" },
          },
          ...(options.queued
            ? [
                {
                  id: 4,
                  name: "test",
                  head_sha: a,
                  status: "queued",
                  conclusion: null,
                  html_url: null,
                  started_at: null,
                  completed_at: null,
                  app: { id: 1, slug: "ci" },
                },
              ]
            : []),
          {
            id: 3,
            name: "old-head",
            head_sha: c,
            status: "completed",
            conclusion: "failure",
            html_url: null,
            started_at: null,
            completed_at: null,
            app: null,
          },
        ],
      };
    else if (url.pathname === "/graphql")
      value = {
        data: {
          repository: {
            pullRequest: {
              reviewDecision: "REVIEW_REQUIRED",
              mergeQueueEntry: options.queueError ? null : { id: "MQ_entry" },
              autoMergeRequest: { enabledAt: "2026-10-25T12:00:00Z" },
              mergeStateStatus: "BLOCKED",
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
        ...(options.queueError ? { errors: [{ message: "Resource not accessible", path: ["repository", "pullRequest", "mergeQueueEntry"] }] } : {}),
      };
    else if (url.pathname.endsWith("/required_status_checks"))
      return new Response("{}", { status: 404 });
    else if (url.pathname.endsWith("/actions/runs")) {
      const base = {
        workflow_id: 1,
        name: "Publish",
        head_branch: "trunk",
        event: "push",
        status: "completed",
        html_url: "https://github.com/example/service/actions/runs/1",
        created_at: "2026-10-25T12:02:00.000Z",
        run_attempt: 1,
        head_repository: { id: 123 },
      };
      value = {
        workflow_runs: [
          { ...base, id: 1, head_sha: b, conclusion: "cancelled" },
          ...(options.descendant === false
            ? []
            : [
                {
                  ...base,
                  id: 2,
                  head_sha: c,
                  conclusion: options.conclusion ?? "success",
                },
              ]),
        ],
      };
    } else if (url.pathname.includes("/compare/"))
      value = { status: options.compare ?? "ahead" };
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return {
    client: createGithubClient({
      token: async () => token,
      signal: new AbortController().signal,
      fetcher,
    }),
    requests,
    setToken: (value: string) => { token = value; },
    setMergedAt: (value: string) => { mergedAt = value; },
  };
}
it("shares branch rule requests briefly per credential and refreshes them", async () => {
  vi.useFakeTimers();
  const f = githubFixture();
  const config = gitSyncConfigSchema.parse({});
  const snapshot = () => f.client.snapshot("example/service", 42, config);
  await snapshot();
  await snapshot();
  const paths = () => f.requests.filter((path) => path.includes("/protection/") || path.includes("/rules/branches/"));
  expect(paths()).toHaveLength(2);
  f.setToken("another-account");
  await snapshot();
  expect(paths()).toHaveLength(4);
  await vi.advanceTimersByTimeAsync(30_001);
  await snapshot();
  expect(paths()).toHaveLength(6);
});
it("keeps shared branch-rule requests inside their cancellation scope", async () => {
  const f = githubFixture();
  const config = gitSyncConfigSchema.parse({});
  const first = new AbortController();
  const run = f.client.withSignal(first.signal);
  await run.snapshot("example/service", 42, config);
  await run.snapshot("example/service", 42, config);
  const paths = () => f.requests.filter((path) => path.includes("/protection/") || path.includes("/rules/branches/"));
  expect(paths()).toHaveLength(2);
  first.abort();
  await f.client.withSignal(new AbortController().signal).snapshot("example/service", 42, config);
  expect(paths()).toHaveLength(4);
});
it("uses the latest CI attempt on the current head and keeps CI success separate from merge/review blockers", async () => {
  const f = githubFixture();
  const value = await f.client.snapshot(
    "example/service",
    42,
    gitSyncConfigSchema.parse({ requiredChecks: ["test", "security"] }),
  );
  expect(value.checks.map((check) => [check.name, check.state])).toEqual([
    ["test", "passed"],
    ["security", "pending"],
  ]);
  expect(value.ci).toBe("pending");
  expect(value.mergeState).toBe("BLOCKED");
  expect(value.unresolvedThreads).toBe(1);
  expect(value.inMergeQueue).toBe(true);
  expect(value.queueEntryId).toBe("MQ_entry");
  expect(value.autoMerge).toBe(true);
});
it("reads the merge queue as unknown when GraphQL reports an error on that field", async () => {
  const value = await githubFixture({ queueError: true }).client.snapshot("example/service", 42, gitSyncConfigSchema.parse({}));
  expect(value.inMergeQueue).toBeNull();
  expect(value.queueEntryId).toBeUndefined();
  expect(value.review).toBe("REVIEW_REQUIRED");
});
it.each(["success", "failure"])(
  "covers a cancelled merge run only through a proven descendant (%s)",
  async (conclusion) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T13:00:00Z"));
    const f = githubFixture({ merged: true, conclusion });
    const value = await f.client.snapshot(
      "example/service",
      42,
      gitSyncConfigSchema.parse({ postMergeWorkflows: ["Publish"] }),
    );
    expect(value.coverage[0]).toMatchObject({
      state: conclusion === "success" ? "passed" : "failed",
      superseded: true,
      originalRunId: 1,
      runId: 2,
      sha: c,
    });
  },
);
it.each([
  { compare: "diverged" },
  { descendant: false },
  { compare: "behind" },
])(
  "keeps cancelled coverage pending when a descendant cannot be established: %j",
  async (options) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-25T13:00:00Z"));
    const f = githubFixture({ merged: true, ...options });
    const value = await f.client.snapshot(
      "example/service",
      42,
      gitSyncConfigSchema.parse({ postMergeWorkflows: ["Publish"] }),
    );
    expect(value.coverage[0]).toMatchObject({
      state: "pending",
      superseded: false,
      runId: 1,
    });
  },
);

it("keeps background sync disabled until enabled and shares a repository discovery scan across projects", async () => {
  const f = setup();
  await f.service.runDue();
  expect(f.client.discover).not.toHaveBeenCalled();
  const other = f.store.tasks.createProject({
    name: "Other",
    prefix: "DEF",
    color: "red",
  });
  const otherTask = f.store.tasks.createTask({
    projectId: other.id,
    title: "Other work",
  });
  f.client.discover.mockResolvedValue([rawPull(42, "ABC-1 DEF-1")]);
  for (const projectId of [f.project.id, other.id])
    await f.service.handlers.setGitSyncConfig({
      projectId,
      config: gitSyncConfigSchema.parse({
        repositories: ["example/service"],
        enabled: true,
      }),
    });
  await f.service.runDue();
  expect(f.client.discover).toHaveBeenCalledTimes(1);
  expect(
    (await f.service.handlers.listPrLinks({ taskId: otherTask.id })).links,
  ).toHaveLength(1);
  await f.service.runDue();
  expect(f.client.discover).toHaveBeenCalledTimes(1);
});

it("reconciles a repository rename while preserving explicit delivery role and immutable remote ID", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({
    projectId: f.project.id,
    config: gitSyncConfigSchema.parse({
      repositories: ["example/service"],
      titleDiscovery: false,
    }),
  });
  await f.service.handlers.linkPr({
    taskId: f.task.id,
    url: "https://github.com/example/service/pull/42",
    role: "delivers",
    part: "1/2",
  });
  f.client.snapshot.mockResolvedValue(snapshot("example/renamed"));
  await f.service.syncProject(f.project.id);
  const result = (await f.service.handlers.listPrLinks({ taskId: f.task.id }))
    .links;
  expect(result).toHaveLength(1);
  expect(result[0]?.link).toMatchObject({
    repository: "example/renamed",
    role: "delivers",
    part: "1/2",
    confirmed: true,
  });
  expect(
    (await f.service.handlers.getGitSyncConfig({ projectId: f.project.id }))
      .config.repositories,
  ).toEqual(["example/renamed"]);
  expect(result[0]?.stale).toBe(false);
});

it("uses authenticated conditional requests without sharing cached bodies across credentials", async () => {
  let token = "first-account";
  const seen: { auth: string | null; etag: string | null }[] = [];
  const fetcher: typeof fetch = vi.fn(async (_url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({
      auth: headers.get("Authorization"),
      etag: headers.get("If-None-Match"),
    });
    if (headers.has("If-None-Match"))
      return new Response(null, { status: 304 });
    return new Response("[]", {
      status: 200,
      headers: { etag: '"version-one"' },
    });
  });
  const client = createGithubClient({
    token: async () => token,
    signal: new AbortController().signal,
    fetcher,
  });
  await client.discover("example/service", 7);
  await client.discover("example/service", 7);
  expect(seen[2]?.etag).toBe('"version-one"');
  token = "second-account";
  await client.discover("example/service", 7);
  expect(seen[4]).toEqual({ auth: "Bearer second-account", etag: null });
});

it("backs off on rate limits and honors cancellation without echoing provider response bodies", async () => {
  const fetcher: typeof fetch = vi.fn(
    async () =>
      new Response("sensitive provider text", {
        status: 429,
        headers: { "retry-after": "120" },
      }),
  );
  const controller = new AbortController();
  const client = createGithubClient({
    token: async () => undefined,
    signal: controller.signal,
    fetcher,
  });
  await expect(client.discover("example/service", 7)).rejects.toThrow(
    "rate limit",
  );
  await expect(client.discover("example/service", 7)).rejects.toThrow(
    "rate limit",
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
  const aborted = new AbortController();
  aborted.abort();
  const stopped = createGithubClient({
    token: async () => undefined,
    signal: aborted.signal,
    fetcher,
  });
  await expect(stopped.discover("example/service", 7)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("marks a queued re-run pending even before it gets a start timestamp", async () => {
  const f = githubFixture({ queued: true });
  const value = await f.client.snapshot(
    "example/service",
    42,
    gitSyncConfigSchema.parse({ requiredChecks: ["test"] }),
  );
  expect(value.checks.find((check) => check.name === "test")?.state).toBe(
    "pending",
  );
  expect(value.ci).toBe("pending");
});
it("does not reuse a passing result after the PR head changes", async () => {
  const f = githubFixture({ headSha: c });
  const value = await f.client.snapshot(
    "example/service",
    42,
    gitSyncConfigSchema.parse({}),
  );
  expect(value.headSha).toBe(c);
  expect(value.checks.every((check) => check.sha === c)).toBe(true);
  expect(value.ci).toBe("failing");
});

it("retains terminal merge history without polling old merged PRs, while explicit sync forces refresh", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({
    projectId: f.project.id,
    config: gitSyncConfigSchema.parse({
      repositories: ["example/service"],
      titleDiscovery: false,
    }),
  });
  await f.service.handlers.linkPr({
    taskId: f.task.id,
    url: "https://github.com/example/service/pull/42",
    role: "delivers",
    part: null,
  });
  f.client.snapshot.mockResolvedValue({
    ...snapshot(),
    state: "merged",
    mergedAt: "2020-01-01T00:00:00.000Z",
    mergeSha: b,
  });
  await f.service.syncProject(f.project.id);
  await f.service.syncProject(f.project.id);
  expect(f.client.snapshot).toHaveBeenCalledTimes(1);
  await f.service.handlers.syncGit({ projectId: f.project.id });
  expect(f.client.snapshot).toHaveBeenCalledTimes(2);
});

it("offers unique GitHub repositories from BB projects without changing sync configuration", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [
    { id: "proj_a", gitRemoteUrl: "https://github.com/Example/Service.git" },
    { id: "proj_b", gitRemoteUrl: "git@github.com:example/service.git" },
    { id: "proj_c", gitRemoteUrl: "ssh://git@github.com/example/infra.git" },
    { id: "proj_d", gitRemoteUrl: "https://gitlab.com/example/other.git" },
    {
      id: "proj_e",
      gitRemoteUrl: "https://evil.test/github.com/example/spoof.git",
    },
    { id: "proj_f", gitRemoteUrl: null },
  ]);
  const result = await f.service.handlers.getGitSyncConfig({
    projectId: f.project.id,
  });
  expect(result.availableRepositories).toEqual([
    "example/infra",
    "example/service",
  ]);
  expect(result.config).toMatchObject({ enabled: false, repositories: [] });
});

it("refreshes only PR subscribers after polling and leaves unrelated task indexes alone", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await f.service.handlers.linkPr({ taskId: f.task.id, url: "https://github.com/example/service/pull/42", role: "delivers", part: null });
  const before = f.harness.realtimeSignals.length;
  await f.service.syncProject(f.project.id);
  const signals = f.harness.realtimeSignals.slice(before);
  expect(signals).toEqual([{ channel: "prs:changed", payload: { taskId: f.task.id, projectId: f.project.id } }]);
  const summary = await f.service.handlers.prSummaries({ taskIds: f.tasks.map((task) => task.id) });
  expect(summary.summaries).toMatchObject([{ taskId: f.task.id, total: 1, stale: false }]);
});

it("reads project links once and does not publish an observedAt-only refresh", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await f.service.handlers.linkPr({ taskId: f.task.id, url: "https://github.com/example/service/pull/42", role: "related", part: null });
  const db = f.bb.storage.database();
  const prepare = vi.spyOn(db, "prepare");
  await f.service.syncProject(f.project.id);
  const before = f.harness.realtimeSignals.length;
  prepare.mockClear();
  f.client.snapshot.mockImplementation(async () => ({ ...snapshot(), observedAt: new Date(Date.now() + 1000).toISOString() }));
  await f.service.syncProject(f.project.id);
  expect(f.harness.realtimeSignals.slice(before)).toEqual([]);
  expect(prepare.mock.calls.filter(([sql]) => String(sql).includes("SELECT l.payload FROM task_pr_links l JOIN tasks t") && String(sql).includes("ORDER BY l.task_id, l.identity"))).toHaveLength(1);
  f.client.snapshot.mockImplementation(async () => ({ ...snapshot(), ci: "failing" }));
  await f.service.syncProject(f.project.id);
  expect(f.harness.realtimeSignals.slice(before)).toContainEqual({ channel: "prs:changed", payload: { taskId: f.task.id, projectId: f.project.id } });
});

it("backs off failed PRs, advances to later PRs, and lets force retry immediately", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  for (const number of [42, 43]) await f.service.handlers.linkPr({ taskId: f.task.id, url: `https://github.com/example/service/pull/${number}`, role: "related", part: null });
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (number === 42) throw new Error("unavailable");
    return snapshot(repository, number);
  });
  await f.service.syncProject(f.project.id);
  expect(f.client.snapshot.mock.calls.map(([, number]) => number)).toEqual([42, 43]);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  expect(f.client.snapshot.mock.calls.map(([, number]) => number)).toEqual([43]);
  await f.service.syncProject(f.project.id, true);
  expect(f.client.snapshot.mock.calls.map(([, number]) => number)).toContain(42);
  f.client.snapshot.mockClear();
  vi.setSystemTime(new Date("2026-11-11T12:05:00.000Z"));
  await f.service.syncProject(f.project.id);
  expect(f.client.snapshot.mock.calls.map(([, number]) => number)).not.toContain(42);
  vi.setSystemTime(new Date("2026-11-11T12:15:00.000Z"));
  await f.service.syncProject(f.project.id);
  expect(f.client.snapshot.mock.calls.map(([, number]) => number)).toContain(42);
});

it("resumes with untouched PRs after a snapshot deadline", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  for (const number of [42, 43, 44]) await f.service.handlers.linkPr({ taskId: f.task.id, url: `https://github.com/example/service/pull/${number}`, role: "related", part: null });
  let hang = true;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (number === 43 && hang) return new Promise<ReturnType<typeof snapshot>>(() => {});
    return snapshot(repository, number);
  });
  const first = f.service.syncProject(f.project.id);
  await vi.waitFor(() => expect(f.client.snapshot).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  expect((await first).errors[0]).toContain("timed out");
  hang = false;
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  expect(f.client.snapshot.mock.calls[0]?.[1]).toBe(44);
});

it("refreshes dependency advice when a predecessor PR changes without moving either task", async () => {
  const f = setup();
  const dependent = f.tasks.find(task => task.id !== f.task.id)!;
  const { createDependencyStore } = await import("../dependencies/store");
  const dependencies = createDependencyStore(f.bb.storage.database(), f.store.tasks);
  dependencies.add(dependent.id, f.task.id);
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await f.service.handlers.linkPr({ taskId: f.task.id, url: "https://github.com/example/service/pull/42", role: "delivers", part: null });
  const before = f.harness.realtimeSignals.length;
  await f.service.syncProject(f.project.id);
  expect(f.harness.realtimeSignals.slice(before)).toContainEqual({ channel: "prs:changed", payload: { taskId: dependent.id, projectId: f.project.id } });
  expect(dependencies.list(dependent.id).blockedBy).toHaveLength(1);
});

it("fetches files once per open head and refetches after the head changes", async () => {
  const f = githubFixture();
  const config = gitSyncConfigSchema.parse({});
  const first = await f.client.snapshot("example/service", 42, config);
  const second = await f.client.snapshot("example/service", 42, config, first);
  expect(f.requests.filter(path => path.includes("/pulls/42/files"))).toHaveLength(1);
  await f.client.snapshot("example/service", 42, config, { ...second, headSha: b });
  expect(f.requests.filter(path => path.includes("/pulls/42/files"))).toHaveLength(2);
  const changedBase = githubFixture({ baseSha: b });
  const refreshed = await changedBase.client.snapshot("example/service", 42, config, second);
  expect(refreshed.baseSha).toBe(b);
  expect(changedBase.requests.filter(path => path.includes("/pulls/42/files"))).toHaveLength(1);
  const { baseSha: _baseSha, ...legacy } = second;
  await f.client.snapshot("example/service", 42, config, legacy);
  expect(f.requests.filter(path => path.includes("/pulls/42/files"))).toHaveLength(3);
});

it("abandons a sync run that hangs so later syncs are not blocked", async () => {
  vi.useFakeTimers();
  try {
    const f = setup();
    await f.service.handlers.setGitSyncConfig({
      projectId: f.project.id,
      config: gitSyncConfigSchema.parse({ repositories: ["example/service"], enabled: true }),
    });
    f.client.discover.mockImplementationOnce(() => new Promise(() => {}));
    const first = f.service.handlers.syncGit({ projectId: f.project.id });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await expect(first).resolves.toMatchObject({ checked: 0, errors: [expect.stringContaining("timed out during title discovery")] });
    expect(f.harness.logEntries).toContainEqual(expect.objectContaining({ level: "warn", message: expect.stringContaining("during title discovery") }));
    vi.useRealTimers();
    await expect(f.service.handlers.syncGit({ projectId: f.project.id })).resolves.toMatchObject({ errors: [] });
  } finally {
    vi.useRealTimers();
  }
});

it("aborts a timed-out fetch and allows a later sync without late writes", async () => {
  vi.useFakeTimers();
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  const service = gitSyncService(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "ABC", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Work" });
  service.handlers.setGitSyncConfig({ projectId: project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"] }) });
  let signal: AbortSignal | undefined;
  let release!: (response: Response) => void;
  const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
    if (!signal) {
      signal = init?.signal as AbortSignal;
      return new Promise<Response>((resolve) => { release = resolve; });
    }
    return Promise.resolve(new Response("[]"));
  });
  vi.stubGlobal("fetch", fetcher);
  vi.stubEnv("GH_TOKEN", "test");
  try {
    const first = service.syncProject(project.id);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect((await first).errors[0]).toContain("timed out");
    expect(signal!.aborted).toBe(true);
    expect((await service.syncProject(project.id)).errors).toEqual([]);
    release(new Response(JSON.stringify([rawPull(42, "ABC-1 late")])));
    await vi.advanceTimersByTimeAsync(0);
    expect((await service.handlers.listPrLinks({ taskId: task.id })).links).toEqual([]);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  }
});

it("advances only confirmed delivering open PRs from early statuses", async () => {
  const f = setup();
  const url = "https://github.com/example/service/pull/42";
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  for (const task of f.tasks.slice(0, 8)) f.store.tasks.updateTask(task.id, { status: "todo" });
  for (const task of f.tasks.slice(0, 8)) await f.service.handlers.linkPr({ taskId: task.id, url, role: "delivers", part: null });
  await f.service.handlers.linkPr({ taskId: f.tasks[1]!.id, url, role: "related", part: null });
  await f.service.handlers.linkPr({ taskId: f.tasks[2]!.id, url, role: "design", part: null });
  await f.service.handlers.unlinkPr({ taskId: f.tasks[3]!.id, url });
  const data = createGitSyncStore(f.bb.storage.database());
  data.saveLink({ ...data.links(f.tasks[4]!.id)[0]!, confirmed: false });
  f.store.tasks.updateTask(f.tasks[5]!.id, { status: "done" });
  f.store.tasks.updateTask(f.tasks[6]!.id, { status: "canceled" });
  f.store.tasks.updateTask(f.tasks[7]!.id, { status: "in_review" });
  await f.service.syncProject(f.project.id);
  expect(f.tasks.slice(0, 8).map(task => f.store.tasks.getTask(task.id)!.status)).toEqual(["in_review", "todo", "todo", "todo", "todo", "done", "canceled", "in_review"]);
});

it("skips a card whose plan is not approved in a required project while the sync succeeds and the approved card advances", async () => {
  const f = setup();
  const url = "https://github.com/example/service/pull/42";
  f.store.tasks.updateProject(f.project.id, { planning: "required" });
  const plans = createPlanStore(f.bb.storage.database(), f.store.tasks);
  const author = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
  for (const task of f.tasks.slice(0, 2)) {
    f.store.tasks.updateTask(task.id, { status: "todo" });
    plans.save({ taskId: task.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    // The first plan version moved the card to Planning; this test is about the gate on a card waiting in Todo.
    f.store.tasks.updateTask(task.id, { status: "todo" });
  }
  plans.setState(f.tasks[1]!.id, "approved", { kind: "person", threadId: null, name: "Owner" });
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  for (const task of f.tasks.slice(0, 2)) await f.service.handlers.linkPr({ taskId: task.id, url, role: "delivers", part: null });
  const result = await f.service.syncProject(f.project.id);
  expect(result.errors).toEqual([]);
  expect(f.tasks.slice(0, 2).map(task => f.store.tasks.getTask(task.id)!.status)).toEqual(["todo", "in_review"]);
});

it("uses custom workflow status IDs and does not reverse a closed PR", async () => {
  const f = setup();
  const statuses = [...f.project.statuses!, { id: "ready_custom", name: "Ready custom" }, { id: "review_custom", name: "Review custom" }];
  f.store.tasks.updateProject(f.project.id, { statuses, workflowPolicy: { bugfixStatus: null, doneStatus: "done", inProgressStatus: null, reviewStatus: "review_custom", testingStatus: null, planningStatus: null, earlyStatuses: ["ready_custom"], ownerDecisionLabel: null } });
  f.store.tasks.updateTask(f.task.id, { status: "ready_custom" });
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await f.service.handlers.linkPr({ taskId: f.task.id, url: "https://github.com/example/service/pull/42", role: "delivers", part: null });
  f.client.snapshot.mockResolvedValueOnce({ ...snapshot(), state: "draft" });
  await f.service.syncProject(f.project.id);
  expect(f.store.tasks.getTask(f.task.id)!.status).toBe("review_custom");
  f.client.snapshot.mockResolvedValueOnce({ ...snapshot(), state: "closed" });
  await f.service.syncProject(f.project.id, true);
  expect(f.store.tasks.getTask(f.task.id)!.status).toBe("review_custom");
});

it("shares post-merge pages within a run but isolates credentials and runs", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-25T13:00:00Z"));
  const f = githubFixture({ merged: true });
  const config = gitSyncConfigSchema.parse({ postMergeWorkflows: ["Publish"] });
  const controller = new AbortController();
  const run = f.client.withSignal(controller.signal);
  const first = await run.snapshot("example/service", 42, config);
  const second = await run.snapshot("example/service", 42, gitSyncConfigSchema.parse({ postMergeWorkflows: ["Other"] }));
  expect(first.coverage[0]?.state).toBe("passed");
  expect(second.coverage[0]?.state).toBe("pending");
  const pages = () => f.requests.filter((path) => path.includes("/actions/runs?"));
  expect(pages()).toHaveLength(1);
  f.setMergedAt("2026-10-25T12:03:00.000Z");
  expect((await run.snapshot("example/service", 42, config)).coverage[0]?.state).toBe("pending");
  expect(pages()).toHaveLength(1);
  f.setToken("different");
  await run.snapshot("example/service", 42, config);
  expect(pages()).toHaveLength(2);
  controller.abort();
  await expect(run.snapshot("example/service", 42, config)).rejects.toThrow();
  await f.client.withSignal(new AbortController().signal).snapshot("example/service", 42, config);
  expect(pages()).toHaveLength(3);
});

it("loads unique attached threads in batches of at most 200", async () => {
  const f = setup();
  for (let i = 0; i < 201; i++)
    f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId: `thr_${i}`, title: "Worker", presetName: "Default", liveStatus: "working" });
  f.store.tasks.upsertTaskThread({ taskId: f.tasks[1]!.id, threadId: "thr_0", title: "Worker", presetName: "Default", liveStatus: "working" });
  const sizes: number[] = [];
  f.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds?: readonly string[] }) => { sizes.push(threadIds!.length); return []; });
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await f.service.syncProject(f.project.id);
  expect(sizes).toEqual([200, 1]);
});

it("aborts an in-flight thread batch and does not start another after the sync deadline", async () => {
  vi.useFakeTimers();
  try {
    const f = setup();
    for (let i = 0; i < 201; i++) f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId: `thr_batch_${i}`, title: "Worker", presetName: "Default", liveStatus: "working" });
    let signal: AbortSignal | undefined;
    let release!: (rows: never[]) => void;
    let calls = 0;
    f.harness.sdk.stub("threads.list", async (input: { signal?: AbortSignal }) => {
      calls++;
      signal = input.signal;
      return new Promise<never[]>(resolve => { release = resolve; });
    });
    await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
    const result = f.service.syncProject(f.project.id);
    await vi.waitFor(() => expect(signal).toBeDefined());
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect((await result).errors[0]).toContain("timed out during worker thread lookup");
    expect(signal!.aborted).toBe(true);
    release([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
  } finally { vi.useRealTimers(); }
});

const deploy = (state: "passed" | "failed" | "pending") => [{ workflow: "Deploy", state, runId: null, sha: null, url: null, superseded: false, originalRunId: null }];
const merged = (number: number, mergedAt: string, coverage: ReturnType<typeof deploy> | [] = []) => ({ ...snapshot("example/service", number), state: "merged" as const, mergedAt, mergeSha: b, coverage });
async function linkAll(f: ReturnType<typeof setup>, numbers: number[], taskId = f.task.id) {
  for (const number of numbers) await f.service.handlers.linkPr({ taskId, url: `https://github.com/example/service/pull/${number}`, role: "related", part: null });
}
const fetched = (f: ReturnType<typeof setup>) => f.client.snapshot.mock.calls.map(([, number]) => number);
const spread = (number: number) => settledSpreadMs(prIdentity({ repository: "example/service", number }));

it("re-reads a settled merged PR hourly and a pending one on every pass, while force reads both", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, postMergeWorkflows: ["Deploy"] }) });
  await linkAll(f, [42, 43]);
  f.client.snapshot.mockImplementation(async (_repository, number) => merged(number, "2026-11-10T12:00:00.000Z", deploy(number === 42 ? "passed" : "pending")));
  await f.service.syncProject(f.project.id);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([43]);
  f.client.snapshot.mockClear();
  // Due once it would go stale before the next pass (55 min), less its fixed per-PR spread.
  const dueAt = Date.parse("2026-11-11T12:55:00.000Z") - spread(42);
  vi.setSystemTime(dueAt - 1);
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([43]);
  f.client.snapshot.mockClear();
  vi.setSystemTime(dueAt);
  await f.service.syncProject(f.project.id);
  expect(fetched(f).sort()).toEqual([42, 43]);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id, true);
  expect(fetched(f).sort()).toEqual([42, 43]);
});

it("gives a settled merged PR a final in-window read before polling stops at its cutoff", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T11:40:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, postMergeWorkflows: ["Deploy"] }) });
  await linkAll(f, [42]);
  // Merged seven days before 12:30, so polling stops then.
  f.client.snapshot.mockImplementation(async (_repository, number) => merged(number, "2026-11-04T12:30:00.000Z", deploy("failed")));
  await f.service.syncProject(f.project.id);
  f.client.snapshot.mockClear();
  // The clamp makes it due 45 min after the read (50 min to the cutoff, less one poll), less its spread.
  vi.setSystemTime(Date.parse("2026-11-11T12:25:00.000Z") - spread(42) - 1000);
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([]);
  f.client.snapshot.mockImplementation(async (_repository, number) => merged(number, "2026-11-04T12:30:00.000Z", deploy("passed")));
  vi.setSystemTime(new Date("2026-11-11T12:26:00.000Z"));
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([42]);
  f.client.snapshot.mockClear();
  vi.setSystemTime(new Date("2026-11-11T12:31:00.000Z"));
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([]);
  const { links } = await f.service.handlers.listPrLinks({ taskId: f.task.id });
  expect(links[0]).toMatchObject({ stale: false, snapshot: { coverage: [{ state: "passed" }] } });
  expect((await f.service.handlers.prSummaries({ taskIds: [f.task.id] })).summaries).toMatchObject([{ stale: false }]);
});

it("keeps a continuously due open group ahead of a due merged PR, which is read once the open PRs are done", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, postMergeWorkflows: ["Deploy"] }) });
  const open = [42, 43, 44, 45, 46, 47];
  await linkAll(f, [...open, 50, 60]);
  let slow = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    // Each read takes 70 s once overloaded, so a pass fits three PRs into its three-minute budget.
    if (slow) vi.setSystemTime(Date.now() + 70_000);
    return number === 50 ? merged(number, "2026-11-11T11:00:00.000Z", deploy("pending")) : number === 60 ? merged(number, "2020-01-01T00:00:00.000Z") : snapshot(repository, number);
  });
  await f.service.syncProject(f.project.id);
  slow = true;
  const passUntil = async (number: number, force: boolean) => {
    for (let pass = 1; pass <= 8; pass++) {
      vi.setSystemTime(Math.max(Date.now(), start + pass * 5 * 60_000));
      f.client.snapshot.mockClear();
      const result = await f.service.syncProject(f.project.id, force);
      expect(result.deferred).toBeGreaterThan(0);
      if (fetched(f).includes(number)) return pass;
    }
    return Infinity;
  };
  expect(await passUntil(50, false)).toBe(Infinity);
  slow = false;
  vi.setSystemTime(Date.now() + 5 * 60_000);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  const order = fetched(f);
  expect(order).toContain(50);
  expect(Math.max(...open.map((number) => order.indexOf(number)))).toBeLessThan(order.indexOf(50));
});

it("reads a due open PR before overdue merged PRs that fill a scheduled pass", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, postMergeWorkflows: ["Deploy"] }) });
  await linkAll(f, [42, 50, 51, 52, 53, 54, 55]);
  let slow = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    // Each read takes 70 s once overloaded, so a pass fits three PRs into its three-minute budget.
    if (slow) vi.setSystemTime(Date.now() + 70_000);
    return number === 42 ? snapshot(repository, number) : merged(number, "2026-11-11T11:00:00.000Z", deploy("pending"));
  });
  await f.service.syncProject(f.project.id);
  slow = true;
  vi.setSystemTime(start + 10 * 60_000);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([42, 50, 51]);
  // PR 42 has been due 12 min, PRs 52 to 55 for 22 min: four overdue merged PRs, more than the pass can read.
  vi.setSystemTime(start + 22 * 60_000);
  f.client.snapshot.mockClear();
  await expect(f.service.syncProject(f.project.id)).resolves.toMatchObject({ checked: 3 });
  expect(fetched(f)[0]).toBe(42);
});

it("keeps a known merged PR whose refresh failed in the merged class of a scheduled pass", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, postMergeWorkflows: ["Deploy"] }) });
  await linkAll(f, [42, 50]);
  let failing = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (number === 50 && failing) throw new GithubError(502, "down");
    return number === 42 ? snapshot(repository, number) : merged(number, "2026-11-11T11:00:00.000Z", deploy("pending"));
  });
  await f.service.syncProject(f.project.id);
  failing = true;
  vi.setSystemTime(start + 5 * 60_000);
  await f.service.syncProject(f.project.id);
  // PR 50 failed 20 min ago, past its backoff; PR 42 has been due for 1 min.
  vi.setSystemTime(start + 11 * 60_000);
  f.bb.storage.database().prepare("UPDATE git_pr_snapshots SET last_attempt_at=? WHERE identity=?").run(start - 9 * 60_000, prIdentity({ repository: "example/service", number: 50 }));
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([42, 50]);
});

it("orders a forced pass by last attempt with open PRs first, so history does not displace open work", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  let slow = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (slow) vi.setSystemTime(Date.now() + 70_000);
    return number === 50 ? merged(number, "2026-11-10T12:00:00.000Z") : number >= 60 ? merged(number, "2026-11-01T12:00:00.000Z") : snapshot(repository, number);
  });
  // Terminal history (8+ days past merge) was read first, so it has the oldest attempts.
  await linkAll(f, [60, 61]);
  await f.service.syncProject(f.project.id, true);
  vi.setSystemTime(start + 60_000);
  await linkAll(f, [42, 43, 50]);
  await f.service.syncProject(f.project.id);
  slow = true;
  const passes: number[][] = [];
  for (let pass = 1; pass <= 3; pass++) {
    vi.setSystemTime(Math.max(Date.now(), start + pass * 5 * 60_000));
    f.client.snapshot.mockClear();
    await f.service.syncProject(f.project.id, true);
    passes.push(fetched(f));
  }
  for (const numbers of passes) expect(numbers.slice(0, 2)).toEqual([42, 43]);
  expect(new Set(passes.flat())).toEqual(new Set([42, 43, 50, 60, 61]));
  expect(passes[0]![2]).toBe(60);
});

it("stops starting PRs at the budget, publishes what it committed and reports a deferral as ok", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, enabled: true }) });
  await linkAll(f, [42, 43, 44, 45, 46]);
  f.client.snapshot.mockImplementation(async (repository, number) => {
    vi.setSystemTime(Date.now() + 70_000);
    return snapshot(repository, number);
  });
  const before = f.harness.realtimeSignals.length;
  await expect(f.service.runDue()).resolves.toBeUndefined();
  expect(f.client.snapshot).toHaveBeenCalledTimes(3);
  expect(f.harness.realtimeSignals.slice(before)).toContainEqual({ channel: "prs:changed", payload: { taskId: f.task.id, projectId: f.project.id } });
  expect(f.harness.logEntries).toContainEqual(expect.objectContaining({ level: "info", message: expect.stringContaining("checked 3 PRs and deferred 2 to the next pass") }));
  const manual = await f.service.handlers.syncGit({ projectId: f.project.id });
  expect(manual).toEqual({ checked: 3, errors: ["2 PRs deferred to the next pass"] });
});

it("counts each failed PR snapshot, finishes later projects and only then fails the scheduled run", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  const config = gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, enabled: true });
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config });
  await linkAll(f, [42, 43, 44, 45, 46, 47]);
  const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "green" });
  const otherTask = f.store.tasks.createTask({ projectId: other.id, title: "Other work" });
  await f.service.handlers.setGitSyncConfig({ projectId: other.id, config });
  await linkAll(f, [77], otherTask.id);
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (number === 42 || number === 43) throw new GithubError(503, "GitHub request failed (HTTP 503)");
    vi.setSystemTime(Date.now() + 70_000);
    return snapshot(repository, number);
  });
  await expect(f.service.runDue()).rejects.toThrow(`project ${f.project.id}: 2 GitHub request failures (3 PRs checked)`);
  expect(fetched(f)).toContain(77);
  expect(f.harness.logEntries).toContainEqual(expect.objectContaining({ level: "info", message: expect.stringContaining("checked 3 PRs and deferred 1") }));
  const manual = await f.service.handlers.syncGit({ projectId: f.project.id });
  expect(manual.errors.filter((error) => error.includes("HTTP 503"))).toHaveLength(1);
  expect(manual.errors.filter((error) => error.includes("deferred to the next pass"))).toHaveLength(1);
});

it("tolerates optional lookup and permission failures next to a successful snapshot", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, enabled: true }) });
  await linkAll(f, [42, 43]);
  f.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds?: readonly string[] }) =>
    (threadIds ?? []).map((id) => makeThreadResponse({ id, environmentId: "env_one" })));
  f.harness.sdk.stub("plugins.callRpc", async () => ({ env_one: { outcome: "available", pullRequest: {
    number: 44, title: "Worker PR", state: "open", url: "https://github.com/example/service/pull/44", updatedAt: "2026-11-04T00:00:00.000Z" } } }));
  f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId: "thr_example", title: "Worker", presetName: "Default", liveStatus: "working" });
  f.client.referenceText.mockRejectedValue(new Error("unavailable"));
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (number === 42) throw new GithubError(404, "GitHub request failed (HTTP 404)");
    return snapshot(repository, number);
  });
  await expect(f.service.runDue()).resolves.toBeUndefined();
  expect(f.harness.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("tolerated 2 optional"))).toHaveLength(1);
});

it("publishes committed snapshots from the deadline itself and ignores a late fetch", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [42, 43]);
  let release!: (value: ReturnType<typeof snapshot>) => void;
  f.client.snapshot.mockImplementation(async (repository, number) =>
    number === 43 ? new Promise<ReturnType<typeof snapshot>>((resolve) => { release = resolve; }) : snapshot(repository, number));
  const before = f.harness.realtimeSignals.length;
  const first = f.service.syncProject(f.project.id);
  await vi.waitFor(() => expect(f.client.snapshot).toHaveBeenCalledTimes(2));
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  await expect(first).resolves.toMatchObject({ checked: 1, timedOut: true });
  const published = f.harness.realtimeSignals.slice(before).filter((signal) => signal.channel === "prs:changed");
  expect(published).toEqual([{ channel: "prs:changed", payload: { taskId: f.task.id, projectId: f.project.id } }]);
  const after = f.harness.realtimeSignals.length;
  release({ ...snapshot("example/service", 43), ci: "failing" });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.harness.realtimeSignals.slice(after)).toEqual([]);
  const { links } = await f.service.handlers.listPrLinks({ taskId: f.task.id });
  expect(links.find((link) => link.link.number === 43)?.snapshot).toBeNull();
});

it("signals a stale-to-current refresh even when the PR facts are unchanged", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [42]);
  await f.service.syncProject(f.project.id);
  vi.setSystemTime(new Date("2026-11-11T12:10:00.000Z"));
  expect((await f.service.handlers.prSummaries({ taskIds: [f.task.id] })).summaries).toMatchObject([{ stale: true }]);
  const before = f.harness.realtimeSignals.length;
  await f.service.syncProject(f.project.id);
  expect(f.harness.realtimeSignals.slice(before)).toEqual([{ channel: "prs:changed", payload: { taskId: f.task.id, projectId: f.project.id } }]);
  expect((await f.service.handlers.prSummaries({ taskIds: [f.task.id] })).summaries).toMatchObject([{ stale: false }]);
});

it("shows terminal and settled observations as current, and errors and unobserved PRs as stale", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [42, 43, 44]);
  await linkAll(f, [45], f.tasks[1]!.id);
  f.client.snapshot.mockImplementation(async (repository, number) =>
    number === 43 ? merged(number, "2026-11-10T12:00:00.000Z") : number === 44 ? merged(number, "2020-01-01T00:00:00.000Z")
      : number === 45 ? Promise.reject(new Error("unavailable")) : snapshot(repository, number));
  await f.service.syncProject(f.project.id);
  vi.setSystemTime(new Date("2026-11-11T12:10:00.000Z"));
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id);
  // The open PR and the failed one (its 5 min backoff has passed) are read; settled and terminal PRs are not.
  expect(fetched(f)).toEqual([42, 45]);
  const summaries = (await f.service.handlers.prSummaries({ taskIds: [f.task.id, f.tasks[1]!.id] })).summaries;
  expect(summaries).toMatchObject([{ taskId: f.task.id, total: 3, stale: false }, { taskId: f.tasks[1]!.id, stale: true }]);
  expect((await f.service.handlers.listPrLinks({ taskId: f.task.id })).links.map((link) => link.stale)).toEqual([false, false, false]);
  await linkAll(f, [46], f.tasks[2]!.id);
  expect((await f.service.handlers.prSummaries({ taskIds: [f.tasks[2]!.id] })).summaries).toMatchObject([{ stale: true }]);
});

it("does not re-remember evidence links a project already has", async () => {
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  for (const task of f.tasks.slice(0, 3))
    f.store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Reviewer", body: "Approved",
      evidence: { kind: "review", pr: 42, head: a, verdict: "approve", thread: "thr_example", recordedByThread: "thr_example" } });
  await f.service.syncProject(f.project.id);
  expect((await f.service.handlers.listPrLinks({ taskId: f.tasks[2]!.id })).links).toHaveLength(1);
  const db = f.bb.storage.database();
  const prepare = vi.spyOn(db, "prepare");
  const before = f.harness.realtimeSignals.length;
  const rows = (db.prepare("SELECT count(*) AS n FROM task_pr_links").get() as { n: number }).n;
  prepare.mockClear();
  await f.service.syncProject(f.project.id);
  expect(prepare.mock.calls.filter(([sql]) => String(sql).includes("FROM task_pr_links WHERE task_id = ?"))).toHaveLength(0);
  expect((db.prepare("SELECT count(*) AS n FROM task_pr_links").get() as { n: number }).n).toBe(rows);
  expect(f.harness.realtimeSignals.slice(before)).toEqual([]);
});

it("keeps open PRs ahead of hourly PRs that come due together", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [42, 43, 44, 50]);
  let slow = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (slow) vi.setSystemTime(Date.now() + 70_000);
    return number === 50 ? merged(number, "2026-11-10T12:00:00.000Z") : snapshot(repository, number);
  });
  await f.service.syncProject(f.project.id);
  const duePass = Math.ceil((55 * 60_000 - spread(50)) / (5 * 60_000));
  for (let pass = 1; pass < duePass; pass++) {
    vi.setSystemTime(start + pass * 5 * 60_000);
    await f.service.syncProject(f.project.id);
  }
  // The settled PR comes due now, later than the open PRs became due.
  slow = true;
  vi.setSystemTime(start + duePass * 5 * 60_000);
  f.client.snapshot.mockClear();
  await expect(f.service.syncProject(f.project.id)).resolves.toMatchObject({ checked: 3, deferred: 1 });
  expect(fetched(f)).toEqual([42, 43, 44]);
});

it("signals a dependent when a forced read renews expired merged-delivery evidence", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-11T12:00:00.000Z"));
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false, enabled: true }) });
  const dependent = f.tasks[1]!;
  createDependencyStore(f.bb.storage.database(), f.store.tasks).add(dependent.id, f.task.id);
  await f.service.handlers.linkPr({ taskId: f.task.id, url: "https://github.com/example/service/pull/42", role: "delivers", part: null });
  f.client.snapshot.mockImplementation(async (_repository, number) => merged(number, "2026-11-01T12:00:00.000Z"));
  await f.service.syncProject(f.project.id, true);
  // Exactly one poll later the evidence has expired (validUntil > now fails), so the identical read renews it.
  vi.setSystemTime(new Date("2026-11-11T12:05:00.000Z"));
  expect((await f.harness.callRpc("listTaskCardMeta", { taskIds: [dependent.id] }) as { metadata: { advisories: unknown[] }[] }).metadata[0]!.advisories).toEqual([]);
  const before = f.harness.realtimeSignals.length;
  await f.service.syncProject(f.project.id, true);
  expect(f.harness.realtimeSignals.slice(before)).toContainEqual({ channel: "prs:changed", payload: { taskId: dependent.id, projectId: f.project.id } });
  // Within one poll of that read the evidence is current, so an identical read stays silent.
  vi.setSystemTime(new Date("2026-11-11T12:06:00.000Z"));
  const again = f.harness.realtimeSignals.length;
  await f.service.syncProject(f.project.id, true);
  expect(f.harness.realtimeSignals.slice(again)).toEqual([]);
});

it("judges the previous observation's freshness when the read commits, not when the pass queued it", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [42]);
  await f.service.syncProject(f.project.id);
  // Queued at 4:59, fresh; the read takes 2 s, so it commits after the 5 min limit.
  vi.setSystemTime(start + 4 * 60_000 + 59_000);
  f.client.snapshot.mockImplementation(async (repository, number) => {
    vi.setSystemTime(Date.now() + 2_000);
    return snapshot(repository, number);
  });
  const before = f.harness.realtimeSignals.length;
  await f.service.syncProject(f.project.id);
  expect(f.harness.realtimeSignals.slice(before)).toEqual([{ channel: "prs:changed", payload: { taskId: f.task.id, projectId: f.project.id } }]);
});

it("promotes terminal history in bounded time under repeated saturated forced passes", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [60]);
  let slow = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    // Three 70 s reads fill the three-minute budget.
    if (slow) vi.setSystemTime(Date.now() + 70_000);
    return number === 60 ? merged(number, "2026-11-01T12:00:00.000Z") : snapshot(repository, number);
  });
  await f.service.syncProject(f.project.id, true);
  vi.setSystemTime(start + 60_000);
  await linkAll(f, [42, 43, 44]);
  await f.service.syncProject(f.project.id);
  slow = true;
  const passes: number[][] = [];
  for (let pass = 1; pass <= 4; pass++) {
    vi.setSystemTime(Math.max(Date.now(), start + pass * 5 * 60_000));
    f.client.snapshot.mockClear();
    await f.service.syncProject(f.project.id, true);
    passes.push(fetched(f));
  }
  // Open work fills the first passes; the terminal PR left unread since pass 1 goes first once it has waited 15 min.
  expect(passes[0]).toEqual([42, 43, 44]);
  expect(passes.findIndex((numbers) => numbers.includes(60))).toBe(3);
  expect(passes[3]![0]).toBe(60);
});

it("keeps an old closed PR on its plain hourly due time, without the settled spread", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [42]);
  f.client.snapshot.mockImplementation(async (repository, number) => ({ ...snapshot(repository, number), state: "closed" as const, updatedAt: "2026-09-01T00:00:00.000Z" }));
  await f.service.syncProject(f.project.id);
  f.client.snapshot.mockClear();
  vi.setSystemTime(start + 55 * 60_000 - 1);
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([]);
  vi.setSystemTime(start + 55 * 60_000);
  await f.service.syncProject(f.project.id);
  expect(fetched(f)).toEqual([42]);
});

it("starts the forced wait when the queue is built, so a pass cut by the hard deadline still promotes the unread PR", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start - 10 * 60_000);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [60]);
  f.client.snapshot.mockImplementation(async (repository, number) => number === 60 ? merged(number, "2026-11-01T12:00:00.000Z") : snapshot(repository, number));
  await f.service.syncProject(f.project.id, true);
  vi.setSystemTime(start - 5 * 60_000);
  await linkAll(f, [42, 43, 44]);
  await f.service.syncProject(f.project.id);
  // The first open read hangs until the 4 min deadline; the terminal PR behind it is never reached.
  let mode: "hang" | "slow" = "hang";
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (mode === "hang") return new Promise<ReturnType<typeof snapshot>>(() => {});
    vi.setSystemTime(Date.now() + 70_000);
    return number === 60 ? merged(number, "2026-11-01T12:00:00.000Z") : snapshot(repository, number);
  });
  vi.setSystemTime(start);
  f.client.snapshot.mockClear();
  const cut = f.service.syncProject(f.project.id, true);
  await vi.advanceTimersByTimeAsync(4 * 60_000);
  await expect(cut).resolves.toMatchObject({ timedOut: true, checked: 0 });
  expect(fetched(f)).not.toContain(60);
  mode = "slow";
  const passes: number[][] = [];
  for (const minute of [5, 10, 15]) {
    vi.setSystemTime(Math.max(Date.now(), start + minute * 60_000));
    f.client.snapshot.mockClear();
    await f.service.syncProject(f.project.id, true);
    passes.push(fetched(f));
  }
  // Waiting since the cut pass at 0 min, it goes first at 15 min although open work filled the passes between.
  expect(passes[0]).not.toContain(60);
  expect(passes[1]).not.toContain(60);
  expect(passes[2]![0]).toBe(60);
});

it("drops the forced wait of a PR that leaves eligibility, so re-linking it starts a fresh wait", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.parse("2026-11-11T12:00:00.000Z");
  vi.setSystemTime(start);
  const f = setup();
  await f.service.handlers.setGitSyncConfig({ projectId: f.project.id, config: gitSyncConfigSchema.parse({ repositories: ["example/service"], titleDiscovery: false }) });
  await linkAll(f, [60]);
  let slow = false;
  f.client.snapshot.mockImplementation(async (repository, number) => {
    if (slow) vi.setSystemTime(Date.now() + 70_000);
    return number === 60 ? merged(number, "2026-11-01T12:00:00.000Z") : snapshot(repository, number);
  });
  await f.service.syncProject(f.project.id, true);
  vi.setSystemTime(start + 60_000);
  await linkAll(f, [42, 43, 44]);
  await f.service.syncProject(f.project.id);
  slow = true;
  // A saturated forced pass leaves PR 60 waiting; it is then excluded and a pass runs without it.
  vi.setSystemTime(start + 5 * 60_000);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id, true);
  expect(fetched(f)).not.toContain(60);
  await f.service.handlers.unlinkPr({ taskId: f.task.id, url: "https://github.com/example/service/pull/60" });
  vi.setSystemTime(start + 10 * 60_000);
  await f.service.syncProject(f.project.id, true);
  // Re-linked an hour later, it waits behind open work again instead of jumping ahead at once.
  vi.setSystemTime(start + 70 * 60_000);
  await linkAll(f, [60]);
  f.client.snapshot.mockClear();
  await f.service.syncProject(f.project.id, true);
  expect(fetched(f)).toEqual([42, 43, 44]);
});
