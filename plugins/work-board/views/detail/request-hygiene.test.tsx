// @vitest-environment jsdom
import { cleanup, fireEvent } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setupPlanHost } from "../plan/test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

it("a task without an epic or attached threads fires no epic, bb-project or pull-request reads while idle", async () => {
  const host = setupPlanHost(harnesses);
  const calls: { method: string; input: unknown }[] = [];
  const rpc = Object.fromEntries(Object.entries(host.rpc).map(([method, fn]) => [method, (input: unknown) => { calls.push({ method, input }); return fn(input); }]));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1" }, { rpc });
  await slot.findByRole("textbox", { name: "Task title" });
  window.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const methods = calls.map((call) => call.method);
  expect(methods).not.toContain("listBbProjects");
  expect(methods).not.toContain("listTaskPullRequests");
  expect(calls.filter((call) => call.method === "listTasks" && (call.input as { type?: string }).type === "epic")).toEqual([]);
});

const COMPONENTS = join(process.cwd(), "components");

it("every data-bb-plugin-root selector in components names the plugin next to it", () => {
  for (const file of readdirSync(COMPONENTS).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))) {
    const source = readFileSync(join(COMPONENTS, file), "utf8");
    for (const match of source.matchAll(/data-bb-plugin-root\]?/g)) {
      const around = source.slice(match.index!, match.index! + match[0].length + 40);
      expect(around, `${file} at ${match.index}`).toMatch(/data-bb-plugin-root\]\[data-bb-plugin="/);
    }
  }
});

it("discards an older pause read when the task changes during loading", async () => {
  const host = setupPlanHost(harnesses);
  const { startManualPause } = await import("../../pause/store");
  startManualPause(host.db, host.task.id, "Waiting", 3600000, "owner");
  let release!: (value: unknown) => void;
  const old = new Promise(resolve => { release = resolve; });
  let reads = 0;
  const rpc = { ...host.rpc, listPauses: async (input: unknown) => {
    const current = await host.harness.callRpc("listPauses", input) as { pauses: Array<Record<string, unknown>>; automatic: string };
    if (++reads === 1) return old;
    return current;
  } };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1" }, { rpc });
  await slot.findByText("Waiting");
  await slot.behavior.emitRealtime("tasks:changed", { taskId: host.task.id, projectId: host.project.id });
  await slot.findByText(/paused by the owner/);
  const current = await host.harness.callRpc("listPauses", { taskId: host.task.id }) as { pauses: Array<Record<string, unknown>>; automatic: string };
  release({ ...current, pauses: current.pauses.map(row => ({ ...row, source: "auto" })) });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(slot.queryByText(/paused automatically/)).toBeNull();
});

it("sends Resume and Extend to the pause RPCs as the owner", async () => {
  const host = setupPlanHost(harnesses);
  const { startManualPause } = await import("../../pause/store");
  startManualPause(host.db, host.task.id, "Waiting", 3600000, "thr_example");
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const spy = (method: string) => async (input: unknown) => { calls.push({ method, input: input as Record<string, unknown> }); return host.harness.callRpc(method, input); };
  const rpc = { ...host.rpc, pauseTask: spy("pauseTask"), resumeTask: spy("resumeTask") };
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1" }, { rpc });
  fireEvent.keyDown(await slot.findByText("Extend ▾"), { key: "ArrowDown" });
  fireEvent.click(await slot.findByRole("menuitem", { name: "+1 h" }));
  await vi.waitFor(() => expect(calls.find(call => call.method === "pauseTask")).toBeTruthy());
  const extended = calls.find(call => call.method === "pauseTask")!.input;
  expect(extended).toMatchObject({ taskId: host.task.id, reason: "Waiting", actor: "owner" });
  expect(Number(extended.durationMs)).toBeGreaterThan(3600000);
  expect(Number(extended.durationMs)).toBeLessThanOrEqual(2 * 3600000);
  await vi.waitFor(async () => expect((await slot.findByText("Resume now")).hasAttribute("disabled")).toBe(false));
  (await slot.findByText("Resume now")).click();
  await vi.waitFor(() => expect(calls.find(call => call.method === "resumeTask")?.input).toEqual({ taskId: host.task.id, actor: "owner" }));
  await vi.waitFor(() => expect(host.db.prepare("SELECT thread_id FROM pause_log WHERE task_id=? AND event='end' AND end_reason='resume'").get(host.task.id)).toEqual({ thread_id: "owner" }));
});
