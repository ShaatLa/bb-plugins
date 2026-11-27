// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
afterEach(() => { cleanup(); window.localStorage.clear(); });

const ID_A = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const project = { prefix: "EXA", nextTaskNumber: 5, color: "blue", folderId: null, linkedBbProjectId: null, createdAt: "2026-07-15T00:00:00.000Z", id: ID_A, name: "Alpha" };
const created = (input: Record<string, unknown>) => makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT1", projectId: String(input.projectId), key: "EXA-5", title: String(input.title) });

function dialog(extra: Record<string, (input: unknown) => unknown>) {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const handlers: Record<string, (input: unknown) => unknown> = {
    listProjects: () => ({ projects: [project] }), listFolders: () => ({ folders: [] }), listPresets: () => ({ presets: [] }), sidebarSummary: () => ({ projects: [] }),
    listTasks: () => ({ tasks: [] }), listLabels: () => ({ labels: [] }), listBbProjects: () => ({ bbProjects: [] }),
    scheduleOptions: () => ({ mode: "spawn_gate", defaultArgs: "--card {key} --role impl", presets: [] }),
    createTask: (raw) => ({ ok: true, task: created(rpcInput(raw)) }),
    ...extra,
  };
  const rpc = Object.fromEntries(Object.entries(handlers).map(([method, handler]) => [method, (input: unknown) => { calls.push({ method, input: (input ?? {}) as Record<string, unknown> }); return handler(input); }]));
  return { calls, slot: renderSlot(app.navPanels[0]!, { subPath: ID_A }, { rpc }) };
}
async function openForm(slot: ReturnType<typeof dialog>["slot"]) {
  fireEvent.click((await slot.findAllByRole("button", { name: /New task/ }))[0]!);
  fireEvent.click(await slot.findByRole("button", { name: /^Task\b/ }));
  fireEvent.click(await slot.findByRole("checkbox", { name: "Start later" }));
  fireEvent.change(await slot.findByLabelText("Task title"), { target: { value: "Night job" } });
  fireEvent.change(await slot.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
}

it("creates the card, then schedules it with the launch arguments", async () => {
  const { calls, slot } = dialog({ scheduleStart: () => ({ scheduledStart: {} }) });
  await openForm(slot);
  expect((await slot.findByLabelText("Launch arguments") as HTMLInputElement).placeholder).toBe("--card {key} --role impl");
  fireEvent.change(slot.getByLabelText("Launch arguments"), { target: { value: "--card {key} --role check" } });
  await waitFor(() => expect((slot.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Create task" }));
  await waitFor(() => expect(calls.some((call) => call.method === "scheduleStart")).toBe(true));
  expect(calls.map((call) => call.method).filter((method) => method === "createTask" || method === "scheduleStart")).toEqual(["createTask", "scheduleStart"]);
  expect(calls.find((call) => call.method === "scheduleStart")!.input).toMatchObject({ taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1", actor: "owner", launch: { kind: "gate", args: ["--card", "{key}", "--role", "check"] }, at: new Date("2099-01-01T02:00").toISOString() });
});

it("keeps the dialog open on the new card when the schedule is refused, and Retry schedules that card without creating another", async () => {
  let refuse = true;
  const { calls, slot } = dialog({ scheduleStart: () => { if (refuse) throw new Error("The builder refuses these arguments (no_scope)"); return { scheduledStart: {} }; } });
  await openForm(slot);
  await waitFor(() => expect((slot.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Create task" }));
  const alert = await slot.findByText(/was created, but its start was not scheduled/, undefined, { timeout: 5000 });
  expect(alert.textContent).toContain("no_scope");
  expect(slot.getByRole("link", { name: "EXA-5" })).toBeTruthy();
  refuse = false;
  await waitFor(() => expect((slot.getByRole("button", { name: "Retry scheduling" }) as HTMLButtonElement).disabled).toBe(false), { timeout: 5000 });
  fireEvent.click(slot.getByRole("button", { name: "Retry scheduling" }));
  await waitFor(() => expect(calls.filter((call) => call.method === "scheduleStart")).toHaveLength(2), { timeout: 5000 });
  expect(calls.filter((call) => call.method === "createTask")).toHaveLength(1);
  expect(calls.filter((call) => call.method === "scheduleStart").map((call) => call.input.taskId)).toEqual(["01HZZZZZZZZZZZZZZZZZZZZZT1", "01HZZZZZZZZZZZZZZZZZZZZZT1"]);
});

it("cannot create the card while the launch policy is unreadable", async () => {
  const { calls, slot } = dialog({ scheduleOptions: () => ({ mode: null, error: "could not read the Spawn Gate launch policy (timeout); try again", defaultArgs: "", presets: [] }) });
  await openForm(slot);
  expect((await slot.findByRole("alert")).textContent).toContain("could not read the Spawn Gate launch policy");
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect((slot.getByRole("button", { name: "Create task" }) as HTMLButtonElement).disabled).toBe(true);
  expect(calls.some((call) => call.method === "createTask")).toBe(false);
});
