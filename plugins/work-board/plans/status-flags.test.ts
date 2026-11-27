import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import type { PlanAuthor } from "../shared/contract";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { planGatedStatuses, workflowPolicySchema } from "../shared/workflow-policy";
import { createPlanStore } from "./store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const author: PlanAuthor = { kind: "agent", threadId: "thr_author", name: "agent (thr_author)" };
const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };
const filesSdk = {
  read: async ({ path }: { path: string }) => {
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) throw new Error(`Path does not exist: ${path}`);
    const contents = await readFile(path);
    const contentEncoding = isUtf8(contents) ? "utf8" : "base64";
    return { path, content: contents.toString(contentEncoding), contentEncoding, sizeBytes: stats.size };
  },
};
/** A status list with extra statuses after `after`, as the owner's status editor would send it. */
const withStatus = (statuses: readonly { id: string; name: string; requiresApprovedPlan?: boolean }[], extra: { id: string; name: string; requiresApprovedPlan?: boolean }, after: string) => {
  const at = statuses.findIndex((status) => status.id === after) + 1;
  return [...statuses.slice(0, at), extra, ...statuses.slice(at)];
};

function setup(planning: "off" | "optional" | "required" = "off") {
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: { files: filesSdk as never, threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => ({}) } },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  if (planning !== "off") store.tasks.updateProject(project.id, { planning });
  const plans = createPlanStore(host.bb.storage.database(), store.tasks);
  const card = (title: string, input: Record<string, unknown> = {}) => store.tasks.createTask({ projectId: project.id, title, status: "todo", ...input });
  const current = () => store.tasks.getProject(project.id)!;
  const move = (taskId: string, status: string) => host.harness.callRpc("updateTask", { taskId, status, authorName: "You" } as never) as Promise<{ ok: boolean }>;
  const sent = () => host.harness.sdk.callsTo("threads.send") as Array<[{ threadId: string }]>;
  return { ...host, store, project, plans, card, current, move, sent };
}

describe("status flags", () => {
  it("prefills the flags on the first switch to required and never again, so the owner's edits survive later switches", () => {
    const f = setup("optional");
    expect(f.current()).toMatchObject({ planFlagsInitialized: false });
    expect(planGatedStatuses(f.current())).toEqual([]);
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    // In progress and every later status, never canceled; the marker is set.
    expect(planGatedStatuses(f.current())).toEqual(["in_progress", "in_review", "done"]);
    expect(f.current().planFlagsInitialized).toBe(true);
    // The owner unmarks Done; switching away and back keeps that.
    f.store.tasks.updateProject(f.project.id, { statuses: f.current().statuses!.map((status) => (status.id === "done" ? { ...status, requiresApprovedPlan: false } : status)) });
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    expect(planGatedStatuses(f.current())).toEqual(["in_progress", "in_review"]);
  });

  it("does not bring a flag back after the owner cleared every one, even through optional and a second required", () => {
    const f = setup("required");
    f.store.tasks.updateProject(f.project.id, { statuses: f.current().statuses!.map((status) => ({ ...status, requiresApprovedPlan: false })) });
    expect(planGatedStatuses(f.current())).toEqual([]);
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    expect(planGatedStatuses(f.current())).toEqual([]);
  });

  it("keeps the owner's first manual edit made in optional mode: the later switch to required prefills nothing", () => {
    const f = setup("optional");
    f.store.tasks.updateProject(f.project.id, { statuses: withStatus(DEFAULT_TASK_STATUSES, { id: "ready", name: "Ready", requiresApprovedPlan: true }, "todo"), workflowPolicy: workflowPolicySchema.parse({ ...f.current().workflowPolicy, planningStatus: null }) });
    expect(f.current()).toMatchObject({ planFlagsInitialized: true });
    expect(planGatedStatuses(f.current())).toEqual(["ready"]);
    f.store.tasks.updateProject(f.project.id, { planning: "required" });
    expect(planGatedStatuses(f.current())).toEqual(["ready"]);
  });

  it("gates a marked status before In progress, and reaches an unmarked custom status after it without a plan", async () => {
    const f = setup("required");
    const task = f.card("Work");
    // A status added after In progress while required gets the position default (marked); the owner can unmark it.
    f.store.tasks.updateProject(f.project.id, { statuses: withStatus(f.current().statuses!, { id: "waiting", name: "Waiting" }, "in_progress") });
    expect(planGatedStatuses(f.current())).toContain("waiting");
    await expect(f.move(task.id, "waiting")).rejects.toThrow(/enters Waiting only after its plan is approved/);
    f.store.tasks.updateProject(f.project.id, { statuses: f.current().statuses!.map((status) => (status.id === "waiting" ? { ...status, requiresApprovedPlan: false } : status)) });
    expect(await f.move(task.id, "waiting")).toMatchObject({ ok: true });
    // The owner marks a status before the zone's start: entering it is gated, and moving between marked statuses is free.
    const other = f.card("Other");
    f.store.tasks.updateProject(f.project.id, { statuses: withStatus(f.current().statuses!, { id: "ready", name: "Ready", requiresApprovedPlan: true }, "todo") });
    await expect(f.move(other.id, "ready")).rejects.toThrow(/enters Ready only after its plan is approved/);
    f.plans.save({ taskId: other.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    f.plans.setState(other.id, "approved", owner);
    expect(await f.move(other.id, "ready")).toMatchObject({ ok: true });
    expect(await f.move(other.id, "in_progress")).toMatchObject({ ok: true });
    expect(await f.move(other.id, "ready")).toMatchObject({ ok: true });
  });

  it("cannot mark canceled, and a new status gets the default only while the project requires planning", () => {
    const f = setup("optional");
    f.store.tasks.updateProject(f.project.id, { statuses: f.current().statuses!.map((status) => (status.id === "canceled" ? { ...status, requiresApprovedPlan: true } : status)) });
    expect(f.current().statuses!.find((status) => status.id === "canceled")).not.toHaveProperty("requiresApprovedPlan");
    f.store.tasks.updateProject(f.project.id, { statuses: withStatus(f.current().statuses!, { id: "later", name: "Later" }, "in_progress") });
    expect(f.current().statuses!.find((status) => status.id === "later")).not.toHaveProperty("requiresApprovedPlan");
  });

  it("reserves review gate role changes for project settings while the gate is enabled", async () => {
    const f = setup();
    const dir = await mkdtemp(join(tmpdir(), "workflow-policy-"));
    directories.push(dir);
    const path = join(dir, "policy.json");
    const args = ["project", "update", "EXA", "--workflow-policy-file", path];
    f.store.tasks.updateProject(f.project.id, { doneRequiresReview: "on" });
    const before = f.current().workflowPolicy;
    for (const role of ["doneStatus", "inProgressStatus", "reviewStatus", "testingStatus"]) {
      await writeFile(path, JSON.stringify({ [role]: "todo" }));
      for (const ctx of [{}, { threadId: "thr_example" }]) {
        const refused = await f.harness.runCli(args, ctx);
        expect(refused.stderr).toContain("workflow roles of a project with Done after review are changed by the owner in the project settings");
        expect(f.current().workflowPolicy).toEqual(before);
      }
    }
    await writeFile(path, JSON.stringify({ bugfixStatus: "todo" }));
    expect((await f.harness.runCli(args)).exitCode).toBe(0);
    f.store.tasks.updateProject(f.project.id, { doneRequiresReview: "off" });
    // A policy file replaces the whole policy: the earlier bugfix mapping is kept explicitly, since resetting it to its default names an unlisted status.
    await writeFile(path, JSON.stringify({ doneStatus: "todo", bugfixStatus: "todo" }));
    expect((await f.harness.runCli(args)).exitCode).toBe(0);
    expect(f.current().workflowPolicy?.doneStatus).toBe("todo");
  });

  it("is not changed by a CLI status file: an existing status keeps its flag and a new one gets the default", async () => {
    const f = setup("required");
    const dir = await mkdtemp(join(tmpdir(), "status-flags-"));
    directories.push(dir);
    const path = join(dir, "statuses.json");
    // The file clears In progress, marks Backlog and Canceled, and adds two statuses.
    const statuses = [
      ...f.current().statuses!.map((status) => ({ ...status, requiresApprovedPlan: status.id === "backlog" || status.id === "canceled" })),
      { id: "extra_marked", name: "Extra marked", requiresApprovedPlan: false },
    ];
    statuses.splice(statuses.findIndex((status) => status.id === "in_progress") + 1, 0, { id: "mid", name: "Mid", requiresApprovedPlan: false } as never);
    await writeFile(path, JSON.stringify(statuses));
    const result = await f.harness.runCli(["project", "update", "EXA", "--statuses-file", path]);
    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    // In progress, In review and Done stay marked, Backlog and Canceled stay unmarked, and both new statuses follow position (after In progress: marked; the last one is after Done: marked).
    expect(planGatedStatuses(f.current())).toEqual(["in_progress", "mid", "in_review", "done", "extra_marked"]);
    expect(f.current().statuses!.find((status) => status.id === "backlog")).not.toHaveProperty("requiresApprovedPlan");
    // project show lists the marked statuses.
    expect((await f.harness.runCli(["project", "show", "EXA"])).stdout).toMatch(/Plan-gated statuses\s+in_progress, mid, in_review, done, extra_marked/);
  });
});

describe("executor notices do not depend on the gate", () => {
  function inProgressWithExecutor(f: ReturnType<typeof setup>, status = "in_progress") {
    const task = f.card("Work", { status });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_executor", presetName: "Default", title: "Executor", liveStatus: "working" });
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    f.plans.setState(task.id, "approved", owner);
    return task;
  }
  const invalidate = (f: ReturnType<typeof setup>, taskId: string) => f.harness.callRpc("saveTaskPlan", { taskId, summary: "More", author, op: "replace", baseVersion: 1, body: "# Plan\n\nMore.\n" } as never);

  it("notifies an executor in an optional project that never entered required (position rule), while every move stays free", async () => {
    const f = setup("optional");
    const task = inProgressWithExecutor(f);
    expect(await f.move(task.id, "in_review")).toMatchObject({ ok: true });
    expect(await f.move(task.id, "todo")).toMatchObject({ ok: true });
    await f.move(task.id, "in_progress");
    await invalidate(f, task.id);
    expect(f.sent().map((entry) => entry[0].threadId)).toEqual(["thr_executor"]);
  });

  it("follows the owner's flags once they are initialized, in optional mode too", async () => {
    const f = setup("optional");
    // The owner marks only Done; In progress is no longer "in work" for notices.
    f.store.tasks.updateProject(f.project.id, { statuses: f.current().statuses!.map((status) => (status.id === "done" ? { ...status, requiresApprovedPlan: true } : status)) });
    const working = inProgressWithExecutor(f);
    await invalidate(f, working.id);
    expect(f.sent()).toEqual([]);
    const done = f.card("Finished", { status: "done" });
    f.store.tasks.upsertTaskThread({ taskId: done.id, threadId: "thr_finisher", presetName: "Default", title: "Finisher", liveStatus: "working" });
    f.plans.save({ taskId: done.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    f.plans.setState(done.id, "approved", owner);
    await invalidate(f, done.id);
    expect(f.sent().map((entry) => entry[0].threadId)).toEqual(["thr_finisher"]);
  });
});
