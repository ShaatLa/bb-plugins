import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { SETTABLE_PLAN_STATES, tasksRpcContract, type PlanAuthor } from "../shared/contract";
import { createPlanStore, PlanError } from "./store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const agent: PlanAuthor = { kind: "agent", threadId: "thr_example", name: "agent (thr_example)" };
const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  // Plans only work in a project whose planning is on; the setting is the owner's, so the store sets it directly.
  store.tasks.updateProject(project.id, { planning: "optional" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Planned work" });
  const plans = createPlanStore(host.bb.storage.database(), store.tasks);
  const save = (input: Record<string, unknown>) =>
    plans.save({ taskId: task.id, summary: "Edit", author: agent, ...input } as Parameters<typeof plans.save>[0]);
  const systemComments = () => store.tasks.listComments(task.id).filter((comment) => comment.kind === "system" && !comment.body.startsWith("Status changed to")).map((comment) => comment.body);
  return { host, store, plans, project, task, save, systemComments };
}

const BODY = "# Plan\n\n## Steps\n- one\n- two\n\n## Risks\nNone.\n";

describe("task plan store", () => {
  it("creates v1 as a draft with base version 0 and numbers later versions", () => {
    const { plans, task, save } = setup();
    expect(plans.get(task.id)).toBeNull();
    const first = save({ op: "replace", baseVersion: 0, body: BODY, summary: "Initial plan" });
    expect(first.version).toMatchObject({ version: 1, baseVersion: 0, op: "create", added: 8, removed: 0 });
    expect(first.plan).toMatchObject({ version: 1, state: "draft", format: "markdown" });
    const second = save({ op: "replace", baseVersion: 1, body: `${BODY}\n## Extra\nMore.\n`, summary: "Add extra" });
    expect(second.version).toMatchObject({ version: 2, baseVersion: 1, op: "replace" });
    const { versions } = plans.listVersions(task.id);
    expect(versions.map((version) => version.version)).toEqual([1, 2]);
    expect(versions[0]).not.toHaveProperty("body");
    expect(plans.get(task.id, 1)?.requested.body).toBe(BODY);
    expect(plans.get(task.id)?.requested.version).toBe(2);
    expect(() => plans.get(task.id, 9)).toThrow(/does not exist.*current version is 2/);
  });

  it("refuses a stale or wrong base version and names the current one", () => {
    const { plans, task, save } = setup();
    expect(() => save({ op: "replace", baseVersion: 3, body: BODY })).toThrow(/no plan yet.*must be 0/);
    expect(() => save({ op: "section", baseVersion: 0, section: "Steps", body: "x" })).toThrow(/no plan to edit/);
    save({ op: "replace", baseVersion: 0, body: BODY });
    save({ op: "replace", baseVersion: 1, body: `${BODY}x\n` });
    const error = (() => {
      try {
        save({ op: "replace", baseVersion: 1, body: "# Other\n" });
      } catch (caught) {
        return caught as PlanError;
      }
    })();
    expect(error).toBeInstanceOf(PlanError);
    expect(error?.code).toBe("plan_conflict");
    expect(error?.message).toMatch(/current version is v2.*edited from v1.*plan show EXA-1.*--base-version 2/);
    expect(() => save({ op: "replace", baseVersion: 0, body: "# Other\n" })).toThrow(/current version is v2/);
    expect(plans.get(task.id)?.version).toBe(2);
  });

  it("refuses a write that changes nothing", () => {
    const { task, save, systemComments } = setup();
    save({ op: "replace", baseVersion: 0, body: BODY });
    expect(() => save({ op: "replace", baseVersion: 1, body: BODY })).toThrow(/No change/);
    expect(() => save({ op: "fragment", baseVersion: 1, find: "None.", replace: "None." })).toThrow(/No change/);
    expect(systemComments()).toHaveLength(1);
    expect(task.id).toBeTruthy();
  });

  it("edits one section or one fragment and records the target", () => {
    const { plans, task, save } = setup();
    save({ op: "replace", baseVersion: 0, body: BODY });
    const section = save({ op: "section", baseVersion: 1, section: "Steps", body: "## Steps\n- only\n", summary: "Trim steps" });
    expect(section.version).toMatchObject({ op: "section", target: "Steps", added: 1, removed: 2 });
    expect(plans.get(task.id)?.requested.body).toBe("# Plan\n\n## Steps\n- only\n\n## Risks\nNone.\n");
    expect(() => save({ op: "section", baseVersion: 2, section: "Missing", body: "x" })).toThrow(/not found.*Plan > Steps/s);
    const fragment = save({ op: "fragment", baseVersion: 2, find: "None.", replace: "Low.", summary: "Rate risk" });
    expect(fragment.version).toMatchObject({ op: "fragment", target: "None." });
    expect(() => save({ op: "fragment", baseVersion: 3, find: "nothing", replace: "x" })).toThrow(/0 matches/);
    expect(() => save({ op: "fragment", baseVersion: 3, find: "#", replace: "x" })).toThrow(/matches/);
  });

  it("restores an earlier version as a new one", () => {
    const { plans, task, save } = setup();
    save({ op: "replace", baseVersion: 0, body: BODY });
    save({ op: "replace", baseVersion: 1, body: "# Changed\n" });
    const restored = save({ op: "restore", baseVersion: 2, restoreVersion: 1, summary: "Back to start" });
    expect(restored.version).toMatchObject({ version: 3, op: "restore", target: "v1" });
    expect(plans.get(task.id)?.requested.body).toBe(BODY);
    expect(() => save({ op: "restore", baseVersion: 3, restoreVersion: 1 })).toThrow(/No change/);
    expect(() => save({ op: "restore", baseVersion: 3, restoreVersion: 9 })).toThrow(/version 9 does not exist/);
  });

  it("enforces the size and summary limits", () => {
    const { task, save, plans } = setup();
    expect(() => save({ op: "replace", baseVersion: 0, body: "a".repeat(256 * 1024 + 1) })).toThrow(/256 KB/);
    expect(() => save({ op: "replace", baseVersion: 0, body: BODY, summary: " " })).toThrow(/summary of what changed is required/);
    expect(() => save({ op: "replace", baseVersion: 0, body: BODY, summary: "s".repeat(301) })).toThrow(/300 characters/);
    expect(() => save({ op: "replace", baseVersion: 0, body: "  \n" })).toThrow(/must not be empty/);
    save({ op: "replace", baseVersion: 0, body: "a".repeat(256 * 1024) });
    expect(plans.head(task.id)?.version).toBe(1);
  });

  it("runs the body and summary through the secret guard", () => {
    const { plans, task, save } = setup();
    const secret = "ghp_" + "a".repeat(36);
    expect(() => save({ op: "replace", baseVersion: 0, body: `token ${secret}` })).toThrow(/secret|token/i);
    expect(() => save({ op: "replace", baseVersion: 0, body: BODY, summary: secret })).toThrow(/secret|token/i);
    expect(plans.head(task.id)).toBeNull();
  });

  it("makes the plan of an archived task read-only", () => {
    const { store, plans, task, save } = setup();
    save({ op: "replace", baseVersion: 0, body: BODY });
    store.tasks.updateTask(task.id, { status: "done" });
    store.tasks.setTaskArchived(task.id, true);
    expect(() => save({ op: "replace", baseVersion: 1, body: "# New\n" })).toThrow(/archived; restore the task/);
    expect(() => plans.submit(task.id, agent, null)).toThrow(/archived/);
    expect(() => plans.setState(task.id, "approved", owner)).toThrow(/archived/);
    expect(plans.get(task.id)?.requested.body).toBe(BODY);
    expect(plans.diff(task.id, 0, 1).added).toBeGreaterThan(0);
  });

  it("moves through the review states and returns to draft on any new version", () => {
    const { plans, task, save, systemComments } = setup();
    expect(() => plans.submit(task.id, agent, null)).toThrow(/no plan to submit/);
    save({ op: "replace", baseVersion: 0, body: BODY });
    expect(plans.submit(task.id, agent, null)).toMatchObject({ outcome: "submitted", plan: { state: "in_review" } });
    // The same reviewer again changes nothing: no new event, only a wake for a thread reviewer.
    expect(plans.submit(task.id, agent, null)).toMatchObject({ outcome: "resent" });
    // A review is bound to one version: an edit during review returns the plan to draft.
    save({ op: "replace", baseVersion: 1, body: `${BODY}a\n`, summary: "Tweak" });
    expect(plans.head(task.id)?.state).toBe("draft");
    plans.submit(task.id, agent, null);
    expect(plans.setState(task.id, "changes_requested", owner).plan.state).toBe("changes_requested");
    expect(plans.setState(task.id, "changes_requested", owner)).toMatchObject({ changed: false });
    // Changes requested needs a new version before a resubmit.
    expect(() => plans.submit(task.id, agent, null)).toThrow(/changes requested; revise it and save a new version/);
    save({ op: "replace", baseVersion: 2, body: `${BODY}b\n`, summary: "Address review" });
    expect(plans.head(task.id)?.state).toBe("draft");
    plans.submit(task.id, agent, null);
    plans.setState(task.id, "approved", owner);
    expect(() => plans.submit(task.id, agent, null)).toThrow(/already approved/);
    save({ op: "replace", baseVersion: 3, body: `${BODY}c\n`, summary: "After approval" });
    expect(plans.head(task.id)?.state).toBe("draft");
    expect(systemComments()).toEqual([
      "Plan v1 by agent (thr_example): Edit · new plan · +8 −0 lines",
      "Plan v1 submitted for review by the owner",
      "Plan v2 by agent (thr_example): Tweak · full rewrite · +1 −0 lines · state in_review → draft",
      "Plan v2 submitted for review by the owner",
      "Plan v2 changes requested by Owner",
      "Plan v3 by agent (thr_example): Address review · full rewrite · +1 −1 lines · state changes_requested → draft",
      "Plan v3 submitted for review by the owner",
      "Plan v3 approved by Owner",
      "Plan v4 by agent (thr_example): After approval · full rewrite · +1 −1 lines · state approved → draft",
    ]);
  });

  it("writes the version log as a system comment with the section, counts and author", () => {
    const { task, save, systemComments, store } = setup();
    save({ op: "replace", baseVersion: 0, body: "# Plan\n\n## Шаги 1–4\n- a\n- b\n", summary: "Initial" });
    save({ op: "section", baseVersion: 1, section: "Шаги 1–4", body: "## Шаги 1–4\n- a\n- c\n- d\n", summary: "Rework steps", author: owner });
    save({ op: "fragment", baseVersion: 2, find: "- d", replace: "- e", summary: "Rename" });
    save({ op: "restore", baseVersion: 3, restoreVersion: 1, summary: "Undo" });
    expect(systemComments().slice(1)).toEqual([
      'Plan v2 by Owner: Rework steps · section "Шаги 1–4" · +2 −1 lines',
      "Plan v3 by agent (thr_example): Rename · fragment · +1 −1 lines",
      "Plan v4 by agent (thr_example): Undo · restored from v1 · +1 −2 lines",
    ]);
    expect(store.tasks.listComments(task.id).at(-1)).toMatchObject({ kind: "system", authorName: "agent (thr_example)" });
  });

  it("diffs versions with defaults previous → current and version 0 as empty", () => {
    const { plans, task, save } = setup();
    expect(() => plans.diff(task.id)).toThrow(/no plan/);
    save({ op: "replace", baseVersion: 0, body: "a\nb\n" });
    save({ op: "replace", baseVersion: 1, body: "a\nc\nd\n" });
    expect(plans.diff(task.id)).toMatchObject({ from: 1, to: 2, added: 2, removed: 1 });
    expect(plans.diff(task.id).patch).toContain("+c");
    expect(plans.diff(task.id, 0, 1)).toMatchObject({ from: 0, to: 1, added: 2, removed: 0 });
    expect(plans.diff(task.id, 2, 2)).toMatchObject({ added: 0, removed: 0 });
    expect(() => plans.diff(task.id, 1, 7)).toThrow(/does not exist/);
  });

  it("removes the plan with its task", () => {
    const { store, host, task, save } = setup();
    save({ op: "replace", baseVersion: 0, body: BODY });
    store.tasks.deleteTask(task.id);
    const db = host.bb.storage.database();
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_plans").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM task_plan_versions").get()).toEqual({ n: 0 });
  });
});

describe("task plan RPC", () => {
  it("returns refusals as results, publishes events and restricts the settable states", async () => {
    const { host, task, store } = setup();
    const { harness } = host;
    const save = (input: Record<string, unknown>) => harness.callRpc("saveTaskPlan", { taskId: task.id, summary: "Edit", author: agent, ...input } as never);
    expect(await harness.callRpc("getTaskPlan", { taskId: task.id })).toEqual({ plan: null });
    const created = await save({ op: "replace", baseVersion: 0, body: BODY });
    expect(created).toMatchObject({ ok: true, plan: { version: 1, state: "draft" }, version: { op: "create" } });
    expect(harness.realtimeSignals).toEqual(
      expect.arrayContaining([
        { channel: "tasks:changed", payload: { taskId: task.id, projectId: task.projectId } },
        { channel: "comments:changed", payload: { taskId: task.id } },
      ]),
    );
    expect(await save({ op: "replace", baseVersion: 0, body: "# x\n" })).toMatchObject({ ok: false, error: { code: "plan_conflict" } });
    expect(await save({ op: "replace", baseVersion: 1, body: BODY })).toMatchObject({ ok: false, error: { code: "plan_no_change" } });
    expect(await save({ op: "replace", baseVersion: 1, body: `x ${"ghp_" + "a".repeat(36)}` })).toMatchObject({ ok: false, error: { code: "secret_detected" } });
    expect(await save({ op: "section", baseVersion: 1, section: "Nope", body: "x" })).toMatchObject({ ok: false, error: { code: "plan_invalid" } });
    // The first submit names its reviewer; a repeat defaults to the reviewer of the latest attempt.
    expect(await harness.callRpc("submitTaskPlan", { taskId: task.id, author: agent })).toMatchObject({ ok: false, error: { code: "plan_invalid", message: expect.stringContaining("--reviewer") } });
    expect(await harness.callRpc("submitTaskPlan", { taskId: task.id, author: agent, reviewer: "owner" })).toMatchObject({ ok: true, outcome: "submitted", delivered: null, plan: { state: "in_review", reviewer: { kind: "owner" } } });
    expect(await harness.callRpc("submitTaskPlan", { taskId: task.id, author: agent })).toMatchObject({ ok: true, outcome: "resent" });
    expect(await harness.callRpc("setTaskPlanState", { taskId: task.id, state: "approved", author: owner })).toMatchObject({ ok: true, plan: { state: "approved" } });
    expect(await harness.callRpc("submitTaskPlan", { taskId: task.id, author: agent })).toMatchObject({ ok: false, error: { code: "plan_state" } });
    expect(tasksRpcContract.setTaskPlanState.input.safeParse({ taskId: task.id, state: "draft", author: owner }).success).toBe(false);
    expect(SETTABLE_PLAN_STATES).toEqual(["in_review", "approved", "changes_requested"]);
    expect(await harness.callRpc("diffTaskPlan", { taskId: task.id })).toMatchObject({ from: 0, to: 1, added: 8 });
    const log = await harness.callRpc("listTaskPlanVersions", { taskId: task.id });
    expect((log as { versions: unknown[] }).versions).toHaveLength(1);
    expect(store.tasks.listComments(task.id).filter((comment) => comment.kind === "system")).toHaveLength(4);
  });
});
