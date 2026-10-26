import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { gitSyncService } from "./service";
import { createGithubClient } from "./github";
import { gitSyncConfigSchema, prSnapshotSchema } from "../shared/git-sync";
import {
  archiveRecords,
  captureProject,
  restoreProject,
} from "../archive/storage";
import { createGitSyncStore } from "./store";

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
  base: { ref: "trunk", repo: { full_name: "example/service", id: 123 } },
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
  expect(capture.manifest.version).toBe(8);
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
  expect(data.links(f.task.id)).toHaveLength(2);
  expect(
    data.snapshot(f.project.id, data.links(f.task.id)[0]!).snapshot,
  ).toBeNull();
});
function githubFixture(
  options: {
    merged?: boolean;
    compare?: string;
    conclusion?: string;
    descendant?: boolean;
    queued?: boolean;
    headSha?: string;
  } = {},
) {
  const requests: string[] = [];
  const fetcher: typeof fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    requests.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    let value: unknown = [];
    if (url.pathname.endsWith("/pulls/42"))
      value = {
        ...rawPull(),
        head: { sha: options.headSha ?? a },
        ...(options.merged
          ? {
              state: "closed",
              merged_at: "2026-10-25T12:00:00.000Z",
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
              mergeQueueEntry: { id: "MQ_entry" },
              autoMergeRequest: { enabledAt: "2026-10-25T12:00:00Z" },
              mergeStateStatus: "BLOCKED",
              reviewThreads: {
                nodes: [{ isResolved: false }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
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
      token: async () => undefined,
      signal: new AbortController().signal,
      fetcher,
    }),
    requests,
  };
}
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
  expect(value.autoMerge).toBe(true);
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
