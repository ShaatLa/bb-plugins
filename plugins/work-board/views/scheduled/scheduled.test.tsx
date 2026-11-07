// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { makeTask } from "../../test-fixtures.js";
import { parseTasksRoute, tasksRouteToSubPath } from "../../shell/routes.js";
import { scheduledRpcContract, type ScheduleRun } from "../../shared/scheduled.js";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../../app"));
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PRESET_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const R1 = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-11-07T10:00:00.000Z";
const project = { id: PROJECT_ID, name: "Ops", prefix: "OPS", nextTaskNumber: 5, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: NOW };
const preset = { id: PRESET_ID, name: "Nightly agent", providerId: "p", modelId: "m1", reasoningLevel: "medium", serviceTier: null, permissionMode: "default", environmentKind: "current", baseBranch: null, machineId: null, instructions: "", builtin: false, createdAt: NOW };
const schedule = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, projectId: PROJECT_ID, templateTaskId: "01HZZZZZZZZZZZZZZZZZZZZZT9", title: `Report ${id.slice(0, 2)}`,
  rule: { kind: "daily", time: "09:00", timezone: "Europe/Berlin" }, target: { kind: "preset", presetId: PRESET_ID },
  enabled: true, nextDueAt: "2026-11-08T08:00:00.000Z", createdAt: NOW, updatedAt: NOW, overlapRunIds: [], ...overrides,
});
const run = (overrides: Partial<ScheduleRun> = {}): ScheduleRun => ({
  id: R1, scheduleId: S1, projectId: PROJECT_ID, scheduleTitle: "Report 11", occurrenceKey: "k1", scheduledFor: "2026-11-07T08:00:00.000Z", state: "failed", taskId: null, threadId: null,
  queueId: null, requestId: null, reason: "Target thread was archived", startedAt: null, finishedAt: null, resolvedAt: null, createdAt: NOW, updatedAt: NOW, pushState: "failed",
  pushChannels: [], pushError: "no devices", execution: null, overlapRunIds: [], missCount: 1, historical: false, ...overrides,
});

/** Every scheduled call is validated against the real contract, so shape drift fails the test. */
function scheduledRpc(handlers: Record<string, (input: any) => unknown>) {
  const calls: Array<{ method: string; input: any }> = [];
  const rpc: Record<string, (input: unknown) => unknown> = {
    listProjects: () => ({ projects: [project] }), listFolders: () => ({ folders: [] }), listPresets: () => ({ presets: [preset] }),
    sidebarSummary: () => ({ projects: [] }), listTasks: () => ({ tasks: [] }), getTask: (input: unknown) => ({ task: makeTask({ id: (input as { taskId: string }).taskId, key: "OPS-9", title: "Template" }) }),
    getTaskByKey: () => ({ task: null }), getBoardPreferences: () => ({}),
    previewSchedule: () => ({ dates: ["2026-11-08T08:00:00.000Z"] }),
  };
  for (const [method, handler] of Object.entries(handlers)) {
    const contract = (scheduledRpcContract as Record<string, { input: { parse: (value: unknown) => unknown } }>)[method];
    rpc[method] = (input: unknown) => {
      calls.push({ method, input: contract ? contract.input.parse(input) : input });
      return handler(input);
    };
  }
  return { rpc, calls };
}
const open = (subPath: string, rpc: Record<string, (input: unknown) => unknown>) => renderSlot(app.navPanels[0]!, { subPath }, { rpc });

it("routes the Scheduled page through its own sub path and top toolbar button", async () => {
  expect(parseTasksRoute("scheduled")).toEqual({ kind: "scheduled", tab: "all" });
  expect(parseTasksRoute("scheduled?tab=results")).toEqual({ kind: "scheduled", tab: "results" });
  expect(parseTasksRoute("scheduled?tab=bogus")).toEqual({ kind: "scheduled", tab: "all" });
  expect(tasksRouteToSubPath({ kind: "scheduled", tab: "history" })).toBe("scheduled?tab=history");
  const { rpc } = scheduledRpc({ listSchedules: () => ({ schedules: [], nextCursor: null }) });
  const slot = open("all", rpc);
  fireEvent.click(await slot.findByRole("button", { name: "Scheduled" }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "scheduled" } });
});

it("lists schedules with timezone, next run and runs management actions", async () => {
  let enabled = true;
  const { rpc, calls } = scheduledRpc({
    listSchedules: () => ({ schedules: [schedule(S1, { enabled, nextDueAt: enabled ? "2026-11-08T08:00:00.000Z" : null })], nextCursor: null }),
    runSchedule: () => ({ run: run({ state: "running", reason: null }) }),
    setScheduleEnabled: (input) => { enabled = input.enabled; return { schedule: schedule(S1, { enabled }) }; },
    deleteSchedule: () => ({ deleted: false }),
  });
  const slot = open("scheduled", rpc);
  const row = (await slot.findByText("Report 11")).closest("li")!;
  expect(within(row).getByText("Daily at 09:00 · Europe/Berlin")).toBeTruthy();
  expect(within(row).getByText(/Next: .*\(Europe\/Berlin\)/)).toBeTruthy();
  expect(within(row).getByText("New session · Nightly agent")).toBeTruthy();

  fireEvent.click(within(row).getByRole("button", { name: "Run now" }));
  await waitFor(() => expect(calls.find((call) => call.method === "runSchedule")?.input.idempotencyKey).toBeTruthy());

  fireEvent.click(within(row).getByRole("button", { name: "Pause" }));
  await waitFor(() => expect(calls.find((call) => call.method === "setScheduleEnabled")?.input).toEqual({ scheduleId: S1, enabled: false }));
  await within(row).findByText("Paused");
  expect(within(row).getByRole("button", { name: "Resume" })).toBeTruthy();

  // A refused delete must stay visible; the row is not removed optimistically.
  fireEvent.keyDown(within(row).getByRole("button", { name: "More actions for Report 11" }), { key: "ArrowDown" });
  fireEvent.click(await slot.findByRole("menuitem", { name: "Delete schedule…" }));
  fireEvent.click(await slot.findByRole("button", { name: "Delete schedule" }));
  expect((await slot.findByRole("alert")).textContent).toContain("was not deleted");
  expect(slot.queryByText("Report 11")).toBeTruthy();
});

it("shows attention reasons and push delivery, and drives retry, cancel and dismiss", async () => {
  const runs = [
    run(),
    run({ id: "44444444-4444-4444-8444-444444444444", state: "queued", reason: "Waiting for a busy thread", pushState: "not_attempted", missCount: 3 }),
  ];
  const { rpc, calls } = scheduledRpc({
    listScheduleRuns: () => ({ runs, nextCursor: null }),
    retryScheduleRun: () => ({ run: run({ state: "starting" }) }),
    cancelScheduleRun: () => ({ run: run({ state: "canceled" }) }),
    resolveScheduleRun: () => ({ run: run({ resolvedAt: NOW }) }),
  });
  const slot = open("scheduled?tab=attention", rpc);
  const failed = (await slot.findByText("Target thread was archived")).closest("li")!;
  expect(within(failed).getByText("Push failed: no devices")).toBeTruthy();
  expect(calls.find((call) => call.method === "listScheduleRuns")?.input.needsAttention).toBe(true);

  fireEvent.click(within(failed).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(calls.find((call) => call.method === "retryScheduleRun")?.input).toMatchObject({ runId: R1 }));

  const queued = (await slot.findByText("Waiting for a busy thread")).closest("li")!;
  expect(within(queued).getByText("Missed 3×")).toBeTruthy();
  fireEvent.click(within(queued).getByRole("button", { name: "Cancel queued run" }));
  await waitFor(() => expect(calls.some((call) => call.method === "cancelScheduleRun")).toBe(true));

  fireEvent.click(within(failed).getByRole("button", { name: "Dismiss" }));
  const dialog = await slot.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(calls.find((call) => call.method === "resolveScheduleRun")?.input).toEqual({ runId: R1, note: "Dismissed from Scheduled." }));
});

it("pages through durable results by cursor even when the schedule is gone", async () => {
  const task = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT2", key: "OPS-2", title: "Nightly report 2026-11-06", status: "done", projectId: PROJECT_ID });
  const source = { taskId: task.id, scheduleId: S2, scheduleTitle: "Deleted report", role: "recurring_run" as const, scheduledFor: "2026-11-06T08:00:00.000Z", startedAt: "2026-11-06T08:00:05.000Z", runId: null, occurrenceKey: "k" };
  const { rpc, calls } = scheduledRpc({
    listScheduleResults: (input) => input.cursor ? { results: [], nextCursor: null } : { results: [{ task, source }], nextCursor: "c1" },
  });
  const slot = open("scheduled?tab=results", rpc);
  const row = (await slot.findByText("OPS-2 · Nightly report 2026-11-06")).closest("li")!;
  expect(within(row).getByText("From “Deleted report”")).toBeTruthy();
  fireEvent.click(within(row).getByRole("button", { name: /OPS-2/ }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "task/OPS-2" } });
  fireEvent.click(slot.getByRole("button", { name: "Next" }));
  await slot.findByText("No results yet");
  expect(calls.at(-1)?.input.cursor).toBe("c1");
  fireEvent.click(slot.getByRole("button", { name: "Previous" }));
  await slot.findByText("OPS-2 · Nightly report 2026-11-06");
});

it("creates a schedule with a preset target and server-computed preview", async () => {
  const { rpc, calls } = scheduledRpc({
    listSchedules: () => ({ schedules: [], nextCursor: null }),
    createSchedule: (input) => ({ schedule: schedule(S1, { title: input.title }) }),
  });
  const slot = open("scheduled", rpc);
  fireEvent.click(await slot.findByRole("button", { name: "New schedule" }));
  const create = await slot.findByRole("button", { name: "Create schedule" });
  expect(within(slot.getByRole("dialog")).getByRole("button", { name: "Project" })).toBeTruthy();
  expect((create as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(slot.getByLabelText("Schedule title"), { target: { value: "Morning digest" } });
  await slot.findByText(/Next runs/);
  expect((create as HTMLButtonElement).disabled).toBe(true); // a target is still required
  fireEvent.click(slot.getByRole("button", { name: "Preset" }));
  fireEvent.click(await slot.findByRole("option", { name: /Nightly agent/ }));
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(create);
  await waitFor(() => expect(calls.find((call) => call.method === "createSchedule")?.input).toMatchObject({
    projectId: PROJECT_ID, title: "Morning digest", target: { kind: "preset", presetId: PRESET_ID }, rule: { kind: "daily", time: "09:00" }, enabled: true,
  }));
});

it("requires choosing a target for imported unassigned schedules", async () => {
  const unassigned = schedule(S1, { enabled: false, nextDueAt: null, target: { kind: "unassigned" } });
  const { rpc } = scheduledRpc({
    listSchedules: () => ({ schedules: [unassigned], nextCursor: null }),
    getSchedule: () => ({ schedule: unassigned, task: makeTask({ key: "OPS-9", title: "Report 11", projectId: PROJECT_ID }), dependencyIds: [] }),
  });
  const slot = open("scheduled", rpc);
  const row = (await slot.findByText("Report 11")).closest("li")!;
  expect(within(row).getAllByText("Choose target").length).toBeGreaterThan(0);
  expect((within(row).getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(row).getByRole("button", { name: "Run now" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(row).getByRole("button", { name: "Edit" }));
  const save = await slot.findByRole("button", { name: "Save changes" });
  expect((save as HTMLButtonElement).disabled).toBe(true);
  expect(slot.getByText(/Choose where this schedule runs/)).toBeTruthy();
});

it("shows the scheduled-source banner on a task detail", async () => {
  const task = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT3", key: "OPS-3", title: "Run result", projectId: PROJECT_ID, scheduledRole: "recurring_run" });
  const source = { taskId: task.id, scheduleId: S1, scheduleTitle: "Report 11", role: "recurring_run" as const, scheduledFor: "2026-11-06T08:00:00.000Z", startedAt: null, runId: null, occurrenceKey: "k" };
  const { rpc } = scheduledRpc({ getTaskSchedule: () => ({ source }) });
  Object.assign(rpc, { getTaskByKey: () => ({ task }), listTaskDependencies: () => ({ blockedBy: [], blocks: [] }), listTaskThreads: () => ({ threads: [] }) });
  const slot = open("task/OPS-3", rpc);
  const banner = await slot.findByRole("note", { name: "Scheduled task source" });
  expect(banner.textContent).toContain("Created by schedule “Report 11”");
  expect(banner.textContent).toContain("not started yet");
  fireEvent.click(within(banner).getByRole("button", { name: "Open Scheduled" }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "scheduled?tab=results" } });
});


it("resolves a saved thread name before opening the picker and batches duplicate targets", async () => {
  const saved = schedule(S1, { target: { kind: "thread", threadId: "thr_manager" } });
  const { rpc } = scheduledRpc({ listSchedules: () => ({ schedules: [saved, schedule(S2, { target: saved.target })], nextCursor: null }), getSchedule: () => ({ schedule: saved, task: makeTask({ key: "OPS-9" }), dependencyIds: [] }) });
  const list = vi.fn().mockResolvedValue([makeThreadResponse({ id: "thr_manager", title: "Manager" })]);
  const slot = renderSlot(app.navPanels[0]!, { subPath: "scheduled" }, { rpc, sdk: { threads: { list } } });
  await slot.findAllByText("Existing thread · Manager");
  expect(list.mock.calls[0]?.[0]).toMatchObject({ threadIds: ["thr_manager"], limit: 1 });
  fireEvent.click(within((await slot.findByText("Report 11")).closest("li")!).getByRole("button", { name: "Edit" }));
  const picker = await slot.findByRole("button", { name: "Target thread" });
  await waitFor(() => expect(picker.textContent).toContain("Manager"));
  expect(picker.textContent).not.toContain("thr_manager");
  expect(list.mock.calls.every(([input]) => input.threadIds?.length === 1)).toBe(true);
});

it("shares a scheduled template link for agent editing without dispatch or mutation", async () => {
  const { rpc, calls } = scheduledRpc({ listSchedules: () => ({ schedules: [schedule(S1)], nextCursor: null }) });
  const slot = open("scheduled", rpc);
  fireEvent.click(await slot.findByRole("button", { name: "Share OPS-9 with agent" }));
  await slot.findByText("Task link copied. Paste it into the agent chat.");
  expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "[OPS-9](/plugins/work-board/work-board/task/OPS-9)" }]);
  expect(calls.every(call => call.method.startsWith("list") || call.method.startsWith("get"))).toBe(true);
});

it("reports a refused task-link clipboard write", async () => {
  const { rpc } = scheduledRpc({ listSchedules: () => ({ schedules: [schedule(S1)], nextCursor: null }) });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "scheduled" }, { rpc, experimental_copyToClipboard: async () => false });
  fireEvent.click(await slot.findByRole("button", { name: "Share OPS-9 with agent" }));
  await slot.findByText("Could not copy task link.");
  expect(slot.queryByText("Task link copied. Paste it into the agent chat.")).toBeNull();
});
