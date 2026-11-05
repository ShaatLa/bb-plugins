import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { createDependencyStore } from "../dependencies/store";
import { createGitSyncStore } from "../git-sync/store";
import { gitSyncConfigSchema, prLinkSchema, prSnapshotSchema } from "../shared/git-sync";
import { registerTasksCli } from "../cli";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map(host => host.harness.dispose())); });
function fixture() {
  const host = createFakePluginHost({ pluginId: "work-board" }); hosts.push(host);
  const store = createStore(host.bb); registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Advice", prefix: "ADV", color: "blue" });
  const predecessor = store.tasks.createTask({ projectId: project.id, title: "Predecessor", status: "in_review" });
  const dependent = store.tasks.createTask({ projectId: project.id, title: "Owner step", executionTarget: "owner" });
  const dependencies = createDependencyStore(host.bb.storage.database(), store.tasks); dependencies.add(dependent.id, predecessor.id);
  const git = createGitSyncStore(host.bb.storage.database());
  const config = gitSyncConfigSchema.parse({ enabled: true, repositories: ["org/repo"] }); git.setConfig(project.id, config);
  const date = new Date().toISOString();
  const link = prLinkSchema.parse({ taskId: predecessor.id, repository: "org/repo", number: 1, url: "https://github.com/org/repo/pull/1", source: "manual", role: "delivers", confirmed: true, createdAt: date, updatedAt: date });
  const snapshot = prSnapshotSchema.parse({ repository: link.repository, number: 1, remoteId: "1", url: link.url, title: "Delivery", state: "merged", headSha: "a".repeat(40), mergeSha: "b".repeat(40), mergedAt: date, baseBranch: "main", updatedAt: date, observedAt: date, checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [] });
  git.saveLink(link); git.saveSnapshot(project.id, link, snapshot);
  const read = async (taskId = dependent.id) => (await host.harness.callRpc("listTaskCardMeta", { taskIds: [taskId] }) as { metadata: { advisories: unknown[] }[] }).metadata[0]!.advisories;
  return { ...host, store, project, predecessor, dependent, dependencies, git, config, link, snapshot, read };
}

it("reports merged delivery evidence without changing workflow or dependencies, including CLI output", async () => {
  const f = fixture();
  expect(await f.read()).toMatchObject([{ kind: "merged-predecessor", predecessor: { key: f.predecessor.key, status: "in_review" }, pr: { number: 1, mergeSha: "b".repeat(40) }, checkedAt: f.snapshot.observedAt }]);
  const json = await f.harness.runCli(["show", f.dependent.key, "--json"]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).advisories).toHaveLength(1);
  const shown = await f.harness.runCli(["show", f.dependent.key]);
  expect(shown.stdout).toContain("Check acceptance criteria");
  expect(shown.stdout).toContain(f.link.url);
  const listed = await f.harness.runCli(["list", "--project", f.project.id, "--json"]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).tasks.find((task: { id: string }) => task.id === f.dependent.id).advisories).toHaveLength(1);
  expect(f.store.tasks.getTask(f.predecessor.id)?.status).toBe("in_review");
  expect(f.dependencies.list(f.dependent.id).blockedBy).toHaveLength(1);
  f.store.tasks.updateTask(f.predecessor.id, { status: "done" });
  expect(await f.read()).toEqual([]);
});

it("excludes unrelated/design/excluded/unconfirmed links and unknown or stale merge data", async () => {
  const f = fixture();
  for (const patch of [{ role: "related" as const }, { role: "design" as const }, { excluded: true }, { confirmed: false }]) {
    f.git.saveLink({ ...f.link, ...patch }); expect(await f.read()).toEqual([]);
  }
  f.git.saveLink(f.link);
  for (const patch of [{ mergeSha: null }, { mergedAt: null }, { state: "closed" as const }, { observedAt: new Date(Date.now() - 301_000).toISOString() }, { observedAt: new Date(Date.now() + 60_000).toISOString() }]) {
    f.git.saveSnapshot(f.project.id, f.link, { ...f.snapshot, ...patch }); expect(await f.read()).toEqual([]);
  }
  f.git.saveSnapshot(f.project.id, f.link, f.snapshot);
  f.git.fail(f.project.id, f.link, "provider unavailable"); expect(await f.read()).toEqual([]);
  f.git.saveSnapshot(f.project.id, f.link, f.snapshot);
  f.git.setConfig(f.project.id, { ...f.config, enabled: false }); expect(await f.read()).toEqual([]);
  f.git.setConfig(f.project.id, { ...f.config, repositories: [] }); expect(await f.read()).toEqual([]);
});

it("reports In Progress without live sessions with last attachment and activity, excluding owner actions and unknown reads", async () => {
  const f = fixture();
  const task = f.store.tasks.createTask({ projectId: f.project.id, title: "Stopped", status: "in_progress" });
  const thread = makeThreadResponse({ id: "thr_old", archivedAt: Date.now() - 10_000 });
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: thread.id, title: "Previous worker", presetName: "Attached", liveStatus: "idle" });
  f.harness.sdk.stub("threads.list", async ({ threadIds }: { threadIds?: string[] }) => threadIds ? [thread] as never : []);
  expect(await f.read(task.id)).toMatchObject([{ kind: "no-live-session", lastAttachment: { threadId: "thr_old", title: "Previous worker" }, lastActivityAt: expect.any(String) }]);
  f.store.tasks.updateTask(task.id, { executionTarget: "owner" }); expect(await f.read(task.id)).toEqual([]);
  f.store.tasks.updateTask(task.id, { executionTarget: "agent", status: "todo" }); expect(await f.read(task.id)).toEqual([]);
  f.store.tasks.updateTask(task.id, { status: "in_progress" });
  // A different uncached thread fails its read: incomplete diagnostics must not establish abandonment advice.
  f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_unknown", title: "Unknown", presetName: "Attached", liveStatus: "working" });
  f.harness.sdk.stub("threads.list", async () => { throw new Error("offline"); });
  expect(await f.read(task.id)).toEqual([]);
});
