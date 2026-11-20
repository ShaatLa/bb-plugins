import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { registerDelegation } from "../delegate";
import type { PlanAuthor } from "../shared/contract";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { effectiveInProgressStatus, inPositionZone, inWorkNow, inWorkZone } from "../shared/workflow-policy";
import { createPlanStore } from "./store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

const author: PlanAuthor = { kind: "agent", threadId: "thr_author", name: "agent (thr_author)" };
const owner: PlanAuthor = { kind: "person", threadId: null, name: "Owner" };
const PLAN = "# Plan\n\n## Steps\nDo it.\n";
const WITH_TESTING = [...DEFAULT_TASK_STATUSES.slice(0, 4), { id: "in_testing", name: "Testing" }, ...DEFAULT_TASK_STATUSES.slice(4)];

type SentCall = [{ threadId: string; input: Array<{ text: string }> }];

function setup(planning: "off" | "optional" | "required" = "required", options: { onSend?: () => void; onSpawn?: () => void; threads?: Record<string, Partial<ReturnType<typeof makeThreadResponse>>> } = {}) {
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active", ...options.threads?.[threadId] }),
        send: async () => {
          options.onSend?.();
          return {};
        },
        spawn: async () => {
          options.onSpawn?.();
          return { id: "thr_spawned" };
        },
      },
    },
  });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  registerDelegation(host.bb, store);
  registerTasksCli(host.bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue", linkedBbProjectId: "proj_example" });
  store.tasks.updateProject(project.id, { planning });
  const plans = createPlanStore(host.bb.storage.database(), store.tasks);
  const card = (title: string, input: Record<string, unknown> = {}) => store.tasks.createTask({ projectId: project.id, title, status: "todo", ...input });
  const withPlan = (taskId: string, state: "draft" | "in_review" | "changes_requested" | "approved") => {
    const before = store.tasks.getTask(taskId)!.status;
    plans.save({ taskId, op: "replace", baseVersion: 0, body: PLAN, summary: "Plan", author });
    // The first version moves a Backlog or Todo card to Planning; these tests are about the gate, so the card stays where it was.
    store.tasks.updateTask(taskId, { status: before });
    if (state === "in_review") plans.submit(taskId, author, null);
    if (state === "changes_requested") plans.setState(taskId, "changes_requested", owner);
    if (state === "approved") plans.setState(taskId, "approved", owner);
  };
  const call = (method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<any>;
  const cli = (...args: string[]) => host.harness.runCli(args);
  const status = (taskId: string) => store.tasks.getTask(taskId)!.status;
  const sent = () => host.harness.sdk.callsTo("threads.send") as SentCall[];
  const preset = store.tasks.createPreset({ name: "Worker", providerId: "claude-code", modelId: "claude-sonnet-5", reasoningLevel: "high", serviceTier: "fast", permissionMode: "full", environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "", builtin: false });
  return { ...host, store, project, plans, card, withPlan, call, cli, status, sent, preset };
}

describe("status gate in a project that requires planning", () => {
  it.each([
    ["has no plan", undefined, /EXA-1 has no plan; with planning required a card enters In Progress only after its plan is approved/],
    ["has a draft plan", "draft", /EXA-1 plan v1 is draft; with planning required a card enters In Progress only after its plan is approved \(`bb work-board plan show EXA-1`\)/],
    ["has a plan in review", "in_review", /plan v1 is in review;/],
    ["has a plan with changes requested", "changes_requested", /plan v1 is changes requested;/],
  ] as const)("refuses the entry of a card that %s through the CLI, updateTask and boardMove", async (_label, state, message) => {
    const { card, withPlan, cli, call, status } = setup();
    const task = card("Work");
    if (state) withPlan(task.id, state);
    const refused = await cli("update", task.key, "--status", "in_progress");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(message);
    await expect(call("updateTask", { taskId: task.id, status: "in_progress", authorName: "You" })).rejects.toThrow(message);
    await expect(call("boardMove", { taskId: task.id, status: "in_progress", authorName: "You" })).rejects.toThrow(message);
    expect(status(task.id)).toBe("todo");
  });

  it("allows the entry once the plan is approved, and always for an epic", async () => {
    const { card, withPlan, cli, call, status } = setup();
    const task = card("Work");
    withPlan(task.id, "approved");
    expect((await cli("update", task.key, "--status", "in_progress")).exitCode).toBe(0);
    expect(status(task.id)).toBe("in_progress");
    const epic = card("Epic", { type: "epic" });
    expect(await call("updateTask", { taskId: epic.id, status: "in_progress", authorName: "You" })).toMatchObject({ ok: true });
    const another = card("Another");
    withPlan(another.id, "approved");
    expect(await call("boardMove", { taskId: another.id, status: "in_progress", authorName: "You" })).toMatchObject({ ok: true });
  });

  it("gates the whole work zone: In review, a custom status after In progress and Done, but not Backlog, Todo or canceled", async () => {
    const { card, store, project, call, status } = setup();
    store.tasks.updateProject(project.id, { statuses: WITH_TESTING });
    const task = card("Work");
    for (const target of ["in_review", "in_testing", "done"]) {
      await expect(call("updateTask", { taskId: task.id, status: target, authorName: "You" })).rejects.toThrow(/with planning required a card enters .* only after its plan is approved/);
    }
    // Statuses before the zone and canceled are open to a card without an approved plan.
    for (const target of ["backlog", "todo", "canceled", "todo"]) expect(await call("updateTask", { taskId: task.id, status: target, authorName: "You" })).toMatchObject({ ok: true });
    expect(status(task.id)).toBe("todo");
  });

  it("never refuses a move inside the zone or out of it, a reorder, or an edit of a card already there", async () => {
    const { card, store, project, withPlan, call, status } = setup();
    // Cards cannot be created in the zone in a required project, so these two are created while planning is off.
    store.tasks.updateProject(project.id, { planning: "off" });
    const task = card("Work", { status: "in_progress" });
    const other = card("Other", { status: "in_progress" });
    store.tasks.updateProject(project.id, { planning: "required" });
    withPlan(task.id, "approved");
    // The plan loses approval with a new version: the card is not pushed out and keeps moving.
    store.tasks.updateTask(task.id, { title: "Edited while unapproved" });
    expect(await call("saveTaskPlan", { taskId: task.id, summary: "More", author, op: "replace", baseVersion: 1, body: `${PLAN}More.\n` })).toMatchObject({ ok: true, plan: { state: "draft" } });
    expect(status(task.id)).toBe("in_progress");
    expect(await call("updateTask", { taskId: task.id, status: "in_review", authorName: "You" })).toMatchObject({ ok: true });
    expect(await call("updateTask", { taskId: task.id, status: "done", authorName: "You" })).toMatchObject({ ok: true });
    expect(await call("updateTask", { taskId: task.id, status: "todo", authorName: "You" })).toMatchObject({ ok: true });
    expect(await call("boardMove", { taskId: other.id, status: "in_progress", beforeTaskId: null, afterTaskId: null, authorName: "You" })).toMatchObject({ ok: true });
  });

  it("refuses the creation of a non-epic card in the work zone, and allows Backlog, canceled and epics", async () => {
    const { project, cli, call } = setup();
    const create = (input: Record<string, unknown>) => call("createTask", { projectId: project.id, title: "New", ...input });
    await expect(create({ status: "in_progress" })).rejects.toThrow(/cannot be created in In Progress: it has no plan yet/);
    await expect(create({ status: "done" })).rejects.toThrow(/cannot be created in Done/);
    const refused = await cli("create", "--project", "EXA", "--title", "Via CLI", "--status", "in_progress");
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("cannot be created in In Progress");
    expect(await create({ status: "backlog" })).toMatchObject({ ok: true });
    expect(await create({ status: "canceled" })).toMatchObject({ ok: true });
    expect(await create({ status: "in_progress", type: "epic" })).toMatchObject({ ok: true });
  });

  it("refuses a cross-project move that would put a gated child in the destination's zone, and names it", async () => {
    const { store, project, plans, withPlan, call } = setup();
    // Source: a custom status that sits before In progress. Destination: the same id sits inside its zone.
    const source = store.tasks.createProject({ name: "Source", prefix: "SRC", color: "red" });
    store.tasks.updateProject(source.id, { statuses: [...DEFAULT_TASK_STATUSES.slice(0, 2), { id: "ready", name: "Ready" }, ...DEFAULT_TASK_STATUSES.slice(2)], planning: "optional" });
    store.tasks.updateProject(project.id, { statuses: [...DEFAULT_TASK_STATUSES.slice(0, 3), { id: "ready", name: "Ready" }, ...DEFAULT_TASK_STATUSES.slice(3)] });
    const epic = store.tasks.createTask({ projectId: source.id, title: "Epic", type: "epic", status: "ready" });
    const child = store.tasks.createTask({ projectId: source.id, title: "Child", status: "ready", epicId: epic.id });
    withPlan(child.id, "draft");
    await expect(call("moveTaskToProject", { taskId: epic.id, projectId: project.id, authorName: "You" })).rejects.toThrow(new RegExp(`${child.key} plan v1 is draft.*the whole family stays in SRC because of ${child.key}`));
    expect(store.tasks.getTask(epic.id)!.projectId).toBe(source.id);
    expect(store.tasks.getTask(child.id)!.projectId).toBe(source.id);
    // Once the child's plan is approved, the family (with the exempt epic) moves.
    plans.setState(child.id, "approved", owner);
    expect(await call("moveTaskToProject", { taskId: epic.id, projectId: project.id, authorName: "You" })).toMatchObject({ ok: true });
    expect(store.tasks.getTask(child.id)!.projectId).toBe(project.id);
  });
});

describe("status gate in the other planning modes", () => {
  it.each(["optional", "off"] as const)("moves and creates anything in %s, whatever the plan state", async (mode) => {
    const { card, withPlan, cli, call, status, project } = setup(mode);
    const draft = card("Draft");
    if (mode === "optional") withPlan(draft.id, "draft");
    expect((await cli("update", draft.key, "--status", "in_review")).exitCode).toBe(0);
    expect(status(draft.id)).toBe("in_review");
    const bare = card("Bare");
    expect(await call("boardMove", { taskId: bare.id, status: "in_progress", authorName: "You" })).toMatchObject({ ok: true });
    expect(await call("createTask", { projectId: project.id, title: "Direct", status: "in_progress" })).toMatchObject({ ok: true });
  });

  it("derives the effective In progress status and the work zone from the policy and the project's order", () => {
    expect(effectiveInProgressStatus({})).toBe("in_progress");
    expect(effectiveInProgressStatus({ workflowPolicy: { inProgressStatus: "in_testing" } })).toBe("in_testing");
    // null falls back to in_progress when the project has it, and to none when it does not.
    expect(effectiveInProgressStatus({ workflowPolicy: { inProgressStatus: null } })).toBe("in_progress");
    expect(effectiveInProgressStatus({ workflowPolicy: { inProgressStatus: null }, statuses: [{ id: "todo" }, { id: "done" }] })).toBeNull();
    const names = ["backlog", "todo", "in_progress", "in_review", "in_testing", "done", "canceled"];
    // The work zone is the marked statuses, whatever their order; canceled is never in it.
    const flagged = { statuses: WITH_TESTING.map((status) => ({ ...status, requiresApprovedPlan: ["in_progress", "in_testing"].includes(status.id) || status.id === "canceled" })) };
    expect(names.map((status) => inWorkZone(flagged, status))).toEqual([false, false, true, false, true, false, false]);
    expect(names.map((status) => inWorkZone({ statuses: WITH_TESTING }, status))).toEqual([false, false, false, false, false, false, false]);
    // The position rule only prefills and drives the notices of a project whose flags were never set up.
    expect(names.map((status) => inPositionZone({ statuses: WITH_TESTING }, status))).toEqual([false, false, true, true, true, true, false]);
    expect(inPositionZone({ workflowPolicy: { inProgressStatus: "in_review" }, statuses: WITH_TESTING }, "in_progress")).toBe(false);
    expect(inPositionZone({ workflowPolicy: { inProgressStatus: null }, statuses: [{ id: "todo" }, { id: "done" }] }, "done")).toBe(false);
    expect(names.map((status) => inWorkNow({ planFlagsInitialized: false, statuses: WITH_TESTING }, status))).toEqual([false, false, true, true, true, true, false]);
    expect(names.map((status) => inWorkNow({ planFlagsInitialized: true, ...flagged }, status))).toEqual([false, false, true, false, true, false, false]);
  });
});

describe("conversion and cancellation races", () => {
  it("gates a combined type and status update on the resulting type, in both directions", async () => {
    const { card, call, store } = setup();
    const epic = card("Epic", { type: "epic" });
    await expect(call("updateTask", { taskId: epic.id, type: "task", status: "done", authorName: "You" })).rejects.toThrow(/has no plan; with planning required a card enters Done/);
    expect(store.tasks.getTask(epic.id)).toMatchObject({ type: "epic", status: "todo" });
    const plain = card("Plain");
    expect(await call("updateTask", { taskId: plain.id, type: "epic", status: "in_progress", authorName: "You" })).toMatchObject({ ok: true });
    expect(store.tasks.getTask(plain.id)).toMatchObject({ type: "epic", status: "in_progress" });
  });

  it("keeps a card canceled during an existing-thread send canceled while the accepted thread stays linked", async () => {
    let cancel = () => {};
    const f = setup("required", { onSend: () => cancel() });
    const task = f.card("Work");
    f.withPlan(task.id, "approved");
    cancel = () => void f.store.tasks.updateTask(task.id, { status: "canceled" });
    await f.call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    expect(f.status(task.id)).toBe("canceled");
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([expect.objectContaining({ threadId: "thr_existing" })]);
  });

  it("keeps a card canceled during a preset spawn canceled, with no Status changed comment", async () => {
    let cancel = () => {};
    const f = setup("optional", { onSpawn: () => cancel() });
    const task = f.card("Work");
    cancel = () => void f.store.tasks.updateTask(task.id, { status: "canceled" });
    await f.call("delegate", { taskId: task.id, presetId: f.preset.id });
    expect(f.status(task.id)).toBe("canceled");
    expect(f.store.tasks.listTaskThreads(task.id)).toEqual([expect.objectContaining({ threadId: "thr_spawned" })]);
    expect(f.store.tasks.listComments(task.id).some((comment) => comment.body.includes("Status changed"))).toBe(false);
  });
});

describe("transfers and status moves during a dispatch or a delivery", () => {
  /** The source project starts work in a custom status that the destination does not have. */
  function twoProjects(setupResult: ReturnType<typeof setup>) {
    const { store, project } = setupResult;
    store.tasks.updateProject(project.id, { statuses: [...DEFAULT_TASK_STATUSES.slice(0, 3), { id: "busy", name: "Busy" }, ...DEFAULT_TASK_STATUSES.slice(3)], workflowPolicy: { bugfixStatus: null, doneStatus: "done", inProgressStatus: "busy", reviewStatus: null, testingStatus: null, planningStatus: null, earlyStatuses: ["todo"], ownerDecisionLabel: null } });
    return store.tasks.createProject({ name: "Destination", prefix: "DST", color: "red" });
  }

  it.each(["existing thread", "preset spawn"] as const)("uses the card's own project after it moved during a %s dispatch", async (kind) => {
    let transfer = () => {};
    const f = setup("optional", { onSend: () => transfer(), onSpawn: () => transfer() });
    const destination = twoProjects(f);
    const task = f.card("Work");
    transfer = () => void f.store.tasks.moveTaskToProject(task.id, destination.id);
    if (kind === "existing thread") await f.call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    else await f.call("delegate", { taskId: task.id, presetId: f.preset.id });
    // The thread stays attached; the card takes the destination's In progress status, not the source's custom one.
    expect(f.store.tasks.getTask(task.id)).toMatchObject({ projectId: destination.id, status: "in_progress" });
    expect(f.store.tasks.listTaskThreads(task.id)).toHaveLength(1);
    // Project-scoped subscribers hear about the card in the project it ended up in.
    const published = f.harness.realtimeSignals.filter((signal) => signal.channel === "tasks:changed" && (signal.payload as { taskId: string }).taskId === task.id);
    expect(published.at(-1)!.payload).toEqual({ taskId: task.id, projectId: destination.id });
  });

  it.each([
    ["in work at the commit, moved out during the delivery", "in_progress", "todo", 1],
    ["not in work at the commit, moved in during the delivery", "todo", "in_progress", 0],
  ] as const)("captures executor eligibility at the committed transition: %s", async (_label, from, during, notices) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const f = setup("optional");
    // Only the decision message to the plan author is slow; the notice goes to a different thread.
    f.harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_author") await hold;
      return {};
    });
    const task = f.card("Work", { status: from });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_executor", presetName: "Default", title: "Executor", liveStatus: "working" });
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 0, body: PLAN, summary: "Plan", author });
    f.plans.setState(task.id, "approved", owner);
    await f.call("createPlanNote", { taskId: task.id, kind: "general", body: "Stop." });
    const pending = f.call("sendPlanFeedback", { taskId: task.id, author: owner });
    // The decision is committed while the delivery to the author is still pending.
    await vi.waitFor(() => expect(f.plans.head(task.id)?.state).toBe("changes_requested"));
    f.store.tasks.updateTask(task.id, { status: during });
    release();
    await pending;
    expect(f.sent().filter((entry) => entry[0].threadId === "thr_executor")).toHaveLength(notices);
  });
});

describe("automatic moves", () => {
  it("dispatch to an existing thread in a required project keeps the status, carries the advisory and keeps the attachment", async () => {
    const { card, withPlan, call, status, sent, store } = setup();
    const draft = card("Draft");
    withPlan(draft.id, "draft");
    const bare = card("Bare");
    for (const task of [draft, bare]) {
      await call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
      expect(status(task.id)).toBe("todo");
      expect(store.tasks.listTaskThreads(task.id)).toHaveLength(1);
    }
    const prompts = sent().map((entry) => entry[0].input[0]!.text);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("## Plan warning\n\nPlan v1 is draft (not approved)");
    expect(prompts[1]).toContain("No plan yet: planning is required in this project");
  });

  it("moves the card when the plan is approved, and in optional mode regardless of the plan", async () => {
    const approved = setup();
    const task = approved.card("Approved");
    approved.withPlan(task.id, "approved");
    await approved.call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    expect(approved.status(task.id)).toBe("in_progress");
    expect(approved.sent()[0]![0].input[0]!.text).not.toContain("Plan warning");
    const optional = setup("optional");
    const draft = optional.card("Draft");
    optional.withPlan(draft.id, "draft");
    await optional.call("delegateToThread", { taskId: draft.id, threadId: "thr_existing" });
    expect(optional.status(draft.id)).toBe("in_progress");
    // The advisory still applies in optional mode.
    expect(optional.sent()[0]![0].input[0]!.text).toContain("Plan v1 is draft (not approved)");
  });

  it("skips the move for a preset spawn too, keeps the attachment and dispatches once", async () => {
    const { card, withPlan, call, status, harness, preset, store } = setup();
    const draft = card("Draft");
    withPlan(draft.id, "draft");
    await call("delegate", { taskId: draft.id, presetId: preset.id });
    expect(status(draft.id)).toBe("todo");
    expect(store.tasks.listTaskThreads(draft.id)).toEqual([expect.objectContaining({ threadId: "thr_spawned" })]);
    expect(harness.sdk.callsTo("threads.spawn")).toHaveLength(1);
    expect((harness.sdk.callsTo("threads.spawn")[0] as any[])[0].prompt).toContain("Plan v1 is draft (not approved)");
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("treats the planning status like Todo for both delegate paths: the card moves only when the gate allows, and otherwise stays in Planning with its attachment", async () => {
    const f = setup();
    const approved = f.card("Approved", { status: "planning" });
    f.withPlan(approved.id, "approved");
    await f.call("delegateToThread", { taskId: approved.id, threadId: "thr_existing" });
    expect(f.status(approved.id)).toBe("in_progress");
    const spawnApproved = f.card("Spawn approved", { status: "planning" });
    f.withPlan(spawnApproved.id, "approved");
    await f.call("delegate", { taskId: spawnApproved.id, presetId: f.preset.id });
    expect(f.status(spawnApproved.id)).toBe("in_progress");
    const draft = f.card("Draft", { status: "planning" });
    f.withPlan(draft.id, "draft");
    await f.call("delegateToThread", { taskId: draft.id, threadId: "thr_existing" });
    expect(f.status(draft.id)).toBe("planning");
    expect(f.store.tasks.listTaskThreads(draft.id)).toHaveLength(1);
    const spawnDraft = f.card("Spawn draft", { status: "planning" });
    f.withPlan(spawnDraft.id, "draft");
    await f.call("delegate", { taskId: spawnDraft.id, presetId: f.preset.id });
    expect(f.status(spawnDraft.id)).toBe("planning");
    expect(f.store.tasks.listTaskThreads(spawnDraft.id)).toHaveLength(1);
  });

  it("keeps a card in Planning with one advisory when approval ended between the prompt and the move", async () => {
    let lose = () => {};
    const f = setup("required", { onSend: () => lose() });
    const task = f.card("Approved", { status: "planning" });
    f.withPlan(task.id, "approved");
    lose = () => void f.plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: `${PLAN}Changed.\n`, summary: "Edit", author });
    await f.call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    expect(f.status(task.id)).toBe("planning");
    const texts = f.sent().map((entry) => entry[0].input[0]!.text);
    expect(texts).toHaveLength(2);
    expect(texts[1]).toContain("The card was not moved to In progress");
  });

  it("does not promote out of a status that carries the planning name but is closed", async () => {
    const f = setup("optional");
    f.store.tasks.updateProject(f.project.id, {
      statuses: f.store.tasks.getProject(f.project.id)!.statuses!.filter((status) => status.id !== "planning").map((status) => (status.id === "done" ? { ...status, name: "Planning" } : status)),
      workflowPolicy: { ...f.store.tasks.getProject(f.project.id)!.workflowPolicy!, planningStatus: "done" },
    });
    const task = f.card("Closed", { status: "done" });
    await f.call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    expect(f.status(task.id)).toBe("done");
  });

  it("decides at move time: a prompt built while approved is followed by exactly one advisory notice when approval ended before the move", async () => {
    let lose = () => {};
    const { card, withPlan, call, status, sent, plans, store } = setup("required", { onSend: () => lose() });
    const task = card("Approved");
    withPlan(task.id, "approved");
    lose = () => void plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: `${PLAN}Changed.\n`, summary: "Edit", author });
    await call("delegateToThread", { taskId: task.id, threadId: "thr_existing" });
    expect(status(task.id)).toBe("todo");
    expect(store.tasks.listTaskThreads(task.id)).toHaveLength(1);
    const texts = sent().map((entry) => entry[0].input[0]!.text);
    expect(texts).toHaveLength(2);
    expect(texts[0]).not.toContain("Plan warning");
    expect(texts[1]).toContain("EXA-1 · Plan v2 is draft (not approved)");
    expect(texts[1]).toContain("The card was not moved to In progress");
    // The preset path behaves the same.
    let loseAgain = () => {};
    const spawned = setup("required", { onSpawn: () => loseAgain() });
    const other = spawned.card("Approved");
    spawned.withPlan(other.id, "approved");
    loseAgain = () => void spawned.plans.save({ taskId: other.id, op: "replace", baseVersion: 1, body: `${PLAN}Changed.\n`, summary: "Edit", author });
    await spawned.call("delegate", { taskId: other.id, presetId: spawned.preset.id });
    expect(spawned.status(other.id)).toBe("todo");
    expect(spawned.sent().map((entry) => entry[0].threadId)).toEqual(["thr_spawned"]);
    expect(spawned.sent()[0]![0].input[0]!.text).toContain("Plan v2 is draft (not approved)");
  });
});

describe("advisory", () => {
  it("shows in show text and JSON, and in the attach output, only while the plan is not approved", async () => {
    const { card, withPlan, cli, plans } = setup("optional");
    const task = card("Work");
    expect((await cli("show", task.key)).stdout).not.toContain("Plan warning");
    expect(JSON.parse((await cli("show", task.key, "--json")).stdout)).toMatchObject({ planning: "optional", planWarning: null });
    withPlan(task.id, "draft");
    const text = (await cli("show", task.key)).stdout;
    expect(text).toContain("Plan warning\nPlan v1 is draft (not approved): taking this card into work is not recommended until it is approved");
    expect(JSON.parse((await cli("show", task.key, "--json")).stdout).planWarning).toContain("not approved");
    const attach = await cli("attach", task.key, "--thread", "thr_example");
    expect(attach.stdout).toContain("Attached thr_example to EXA-1\nPlan v1 is draft (not approved)");
    plans.setState(task.id, "approved", owner);
    expect((await cli("show", task.key)).stdout).not.toContain("Plan warning");
    expect((await cli("attach", task.key, "--thread", "thr_example")).stdout).not.toContain("not approved");
  });

  it("also covers a non-epic card with no plan in a required project, and never an epic", async () => {
    const { card, cli } = setup("required");
    const task = card("Bare");
    expect((await cli("show", task.key)).stdout).toContain("No plan yet: planning is required in this project");
    expect(JSON.parse((await cli("show", task.key, "--json")).stdout).planWarning).toContain("No plan yet");
    expect((await cli("attach", task.key, "--thread", "thr_example")).stdout).toContain("No plan yet");
    const epic = card("Epic", { type: "epic" });
    expect((await cli("show", epic.key)).stdout).not.toContain("No plan yet");
    expect(JSON.parse((await cli("show", epic.key, "--json")).stdout).planWarning).toBeNull();
  });
});

describe("notice to executors", () => {
  function executors(setupResult: ReturnType<typeof setup>, taskId: string) {
    for (const [threadId, liveStatus] of [["thr_executor", "working"], ["thr_author", "working"], ["thr_done", "completed"]] as const)
      setupResult.store.tasks.upsertTaskThread({ taskId, threadId, presetName: "Default", title: threadId, liveStatus });
  }

  it("fires on a new version, owner feedback and setTaskPlanState out of approved, once per executor and never for the changing actor", async () => {
    const f = setup("optional", { threads: { thr_done: { status: "idle" } } });
    const task = f.card("Work", { status: "in_progress" });
    executors(f, task.id);
    f.withPlan(task.id, "approved");
    // A new version: the saving thread is left out, the completed thread is not active.
    await f.call("saveTaskPlan", { taskId: task.id, summary: "More", author, op: "replace", baseVersion: 1, body: `${PLAN}More.\n` });
    expect(f.sent().map((entry) => entry[0].threadId)).toEqual(["thr_executor"]);
    expect(f.sent()[0]![0].input[0]!.text).toContain("EXA-1 · plan v2 is draft (a new version was saved); it is no longer approved");
    // Owner feedback: the decision-message recipients (the version's author) get no extra notice.
    f.plans.setState(task.id, "approved", owner);
    await f.call("createPlanNote", { taskId: task.id, kind: "general", body: "Stop." });
    const before = f.sent().length;
    await f.call("sendPlanFeedback", { taskId: task.id, author: owner });
    const after = f.sent().slice(before).map((entry) => [entry[0].threadId, entry[0].input[0]!.text.includes("changes were requested")]);
    expect(after).toEqual([["thr_author", false], ["thr_executor", true]]);
    // setTaskPlanState out of approved.
    f.plans.save({ taskId: task.id, op: "replace", baseVersion: 2, body: `${PLAN}Three.\n`, summary: "x", author });
    f.plans.setState(task.id, "approved", owner);
    const sentBefore = f.sent().length;
    await f.call("setTaskPlanState", { taskId: task.id, state: "changes_requested", author: owner });
    expect(f.sent().slice(sentBefore).map((entry) => entry[0].threadId)).toEqual(["thr_author", "thr_executor"]);
  });

  it("reads who is active from the live thread: an idle linked session is not woken, and an executing Parent-thread link is told", async () => {
    const f = setup("optional", { threads: { thr_idle: { status: "idle" }, thr_parent: { status: "active" }, thr_gone: { deletedAt: 1 } } });
    const task = f.card("Work", { status: "in_progress" });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_idle", presetName: "Default", title: "Idle", liveStatus: "working" });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_parent", presetName: "Parent thread", title: "Parent", liveStatus: "idle" });
    f.store.tasks.upsertTaskThread({ taskId: task.id, threadId: "thr_gone", presetName: "Default", title: "Gone", liveStatus: "working" });
    f.withPlan(task.id, "approved");
    await f.call("saveTaskPlan", { taskId: task.id, summary: "More", author, op: "replace", baseVersion: 1, body: `${PLAN}More.\n` });
    expect(f.sent().map((entry) => entry[0].threadId)).toEqual(["thr_parent"]);
  });

  it("gives an executor that is also the attempt's submitter exactly one message when the owner requests changes", async () => {
    const f = setup("optional");
    const task = f.card("Work", { status: "in_progress" });
    executors(f, task.id);
    f.withPlan(task.id, "draft");
    f.plans.submit(task.id, { kind: "agent", threadId: "thr_executor", name: "agent (thr_executor)" }, null);
    f.plans.setState(task.id, "approved", owner);
    await f.call("createPlanNote", { taskId: task.id, kind: "general", body: "Stop." });
    await f.call("sendPlanFeedback", { taskId: task.id, author: owner });
    const texts = f.sent().filter((entry) => entry[0].threadId === "thr_executor").map((entry) => entry[0].input[0]!.text);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain("YOUR PLAN WAS NOT APPROVED");
  });

  it("is silent for a card outside the work zone, when planning is off, when the plan was not approved, and keeps the change when delivery fails", async () => {
    const f = setup("optional");
    const todo = f.card("Todo");
    executors(f, todo.id);
    f.withPlan(todo.id, "approved");
    await f.call("saveTaskPlan", { taskId: todo.id, summary: "More", author: { ...author, threadId: "thr_other", name: "agent (thr_other)" }, op: "replace", baseVersion: 1, body: `${PLAN}More.\n` });
    expect(f.sent()).toEqual([]);
    const working = f.card("Working", { status: "in_progress" });
    executors(f, working.id);
    f.withPlan(working.id, "draft");
    await f.call("saveTaskPlan", { taskId: working.id, summary: "More", author, op: "replace", baseVersion: 1, body: `${PLAN}More.\n` });
    expect(f.sent()).toEqual([]);
    f.plans.setState(working.id, "approved", owner);
    f.harness.sdk.stub("threads.send", async () => {
      throw new Error("thread is gone");
    });
    expect(await f.call("saveTaskPlan", { taskId: working.id, summary: "Again", author, op: "replace", baseVersion: 2, body: `${PLAN}Again.\n` })).toMatchObject({ ok: true, plan: { version: 3, state: "draft" } });
  });
});

describe("planning setting", () => {
  it("refuses plan commands, RPCs and reviewer commands when off, keeps the data, and restores it when turned on", async () => {
    const f = setup("optional");
    const task = f.card("Work");
    f.withPlan(task.id, "in_review");
    f.store.tasks.updateProject(f.project.id, { planning: "off" });
    const hint = /planning is off for project EXA; the owner can enable it in the project settings/;
    for (const args of [["plan", "show", task.key], ["plan", "notes", task.key], ["plan", "submit", task.key, "--reviewer", "owner"], ["plan", "reviews", task.key], ["plan", "approve", task.key, "--version", "1"], ["plan", "note", task.key, "--version", "1", "--body", "x"]]) {
      const result = await f.harness.runCli(args, { threadId: "thr_reviewer" });
      expect(result.exitCode, args.join(" ")).not.toBe(0);
      expect(result.stderr).toMatch(hint);
    }
    for (const method of ["getTaskPlan", "listTaskPlanVersions", "listPlanNotes", "listPlanReviews"]) await expect(f.call(method, { taskId: task.id })).rejects.toThrow(hint);
    expect(await f.call("approvePlan", { taskId: task.id, author: owner })).toMatchObject({ ok: false, error: { code: "planning_off", message: expect.stringMatching(hint) } });
    expect(await f.call("saveTaskPlan", { taskId: task.id, summary: "x", author, op: "replace", baseVersion: 1, body: "# x\n" })).toMatchObject({ ok: false, error: { code: "planning_off" } });
    // The data is untouched, and nothing of the plan is gated, advised or noticed.
    expect(f.plans.capture(task.id)).toMatchObject({ version: 1, state: "in_review" });
    expect((await f.cli("update", task.key, "--status", "in_progress")).exitCode).toBe(0);
    const shown = JSON.parse((await f.cli("show", task.key, "--json", "--with-plan")).stdout);
    expect(shown).toMatchObject({ planning: "off", plan: null });
    expect(shown).not.toHaveProperty("planWarning");
    expect((await f.cli("show", task.key, "--with-plan")).stdout).not.toContain("Plan v1 (in_review)\n# Plan");
    expect((await f.cli("show", task.key)).stdout).toContain("planning is off for this project");
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    expect(await f.call("getTaskPlan", { taskId: task.id })).toMatchObject({ plan: { version: 1, state: "in_review" } });
  });

  it("records each change of planning with its time and old value, logs it, and records nothing for the same value", async () => {
    const f = setup("off");
    expect(f.store.tasks.getProject(f.project.id)).toMatchObject({ planningChangedAt: null, planningPrevious: null });
    expect((await f.cli("project", "show", "EXA")).stdout).toMatch(/Planning changed\s+-/);
    await f.call("updateProject", { projectId: f.project.id, planning: "optional" });
    const first = f.store.tasks.getProject(f.project.id)!;
    expect(first).toMatchObject({ planning: "optional", planningPrevious: "off" });
    expect(Date.parse(first.planningChangedAt!)).toBeGreaterThan(Date.now() - 60_000);
    expect(f.harness.logEntries).toContainEqual({ level: "info", message: "planning for EXA: off → optional" });
    // The same value, and an update of another field, leave the record alone and log nothing.
    const logged = f.harness.logEntries.length;
    await f.call("updateProject", { projectId: f.project.id, planning: "optional" });
    await f.call("updateProject", { projectId: f.project.id, name: "Renamed" });
    expect(f.store.tasks.getProject(f.project.id)).toMatchObject({ planningChangedAt: first.planningChangedAt, planningPrevious: "off" });
    expect(f.harness.logEntries).toHaveLength(logged);
    await f.call("updateProject", { projectId: f.project.id, planning: "required" });
    expect(f.store.tasks.getProject(f.project.id)).toMatchObject({ planning: "required", planningPrevious: "optional" });
    expect(f.harness.logEntries).toContainEqual({ level: "info", message: "planning for EXA: optional → required" });
    // project show, config get and --json expose it.
    const when = f.store.tasks.getProject(f.project.id)!.planningChangedAt!;
    expect((await f.cli("project", "show", "EXA")).stdout).toMatch(new RegExp(`Planning changed\\s+${when}, was optional`));
    expect(JSON.parse((await f.cli("project", "show", "EXA", "--json")).stdout).project).toMatchObject({ planning: "required", planningChangedAt: when, planningPrevious: "optional" });
    const get = (await f.cli("config", "get", "planning", "--project", "EXA")).stdout;
    expect(get).toContain("planning=required");
    expect(get).toContain(`planningChangedAt=${when}`);
    expect(get).toContain("planningPrevious=optional");
    expect(JSON.parse((await f.cli("config", "get", "planning", "--project", "EXA", "--json")).stdout).values).toEqual({ planning: "required", planningChangedAt: when, planningPrevious: "optional", planGatedStatuses: ["in_progress", "in_review", "done"] });
  });

  it("is changed by the owner only: project update and config set refuse it, with and without a thread id", async () => {
    const f = setup("off");
    for (const threadId of [undefined, "thr_agent"]) {
      for (const args of [["project", "update", "EXA", "--planning", "required"], ["project", "update", "EXA", "--planning", "off"], ["config", "set", "planning", "required", "--project", "EXA"]]) {
        const result = await f.harness.runCli(args, threadId ? { threadId } : undefined);
        expect(result.exitCode, args.join(" ")).not.toBe(0);
        expect(result.stderr).toContain("planning is changed by the owner in the project settings");
      }
    }
    expect(f.store.tasks.getProject(f.project.id)!.planning).toBe("off");
    // config get and project show display it.
    expect((await f.cli("config", "get", "planning", "--project", "EXA")).stdout).toContain("planning=off");
    expect((await f.cli("project", "show", "EXA")).stdout).toMatch(/Planning\s+off/);
    // The app's updateProject RPC is the owner's path and sets it.
    await f.call("updateProject", { projectId: f.project.id, planning: "required" });
    expect(f.store.tasks.getProject(f.project.id)!.planning).toBe("required");
  });
});
