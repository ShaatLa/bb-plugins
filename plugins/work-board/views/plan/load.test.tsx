// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { BODY, setupPlanHost } from "./test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function counted(host: ReturnType<typeof setupPlanHost>, getTaskByKey?: (real: () => unknown) => unknown) {
  const calls = { getTaskByKey: 0 };
  const rpc = {
    ...host.rpc,
    getTaskByKey: (input: unknown) => {
      calls.getTaskByKey += 1;
      return getTaskByKey ? getTaskByKey(() => host.rpc.getTaskByKey!(input)) : host.rpc.getTaskByKey!(input);
    },
  };
  return { calls, rpc };
}

it("reads the task once and refetches only for its own id or an unscoped change", async () => {
  const host = setupPlanHost(harnesses);
  await host.save({ baseVersion: 0, body: BODY });
  const other = host.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
  const elsewhere = host.store.tasks.createTask({ projectId: other.id, title: "Elsewhere" });
  const { calls, rpc } = counted(host);
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1/plan" }, { rpc });
  await waitFor(() => expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("Release plan"));
  await sleep(300);
  expect(calls.getTaskByKey).toBe(1);
  const lookupsAfter = async (payload: Record<string, unknown>) => {
    const before = calls.getTaskByKey;
    await slot.behavior.emitRealtime("tasks:changed", payload);
    await sleep(300);
    return calls.getTaskByKey - before;
  };
  expect(await lookupsAfter({ taskId: elsewhere.id, projectId: other.id })).toBe(0);
  expect(await lookupsAfter({ taskId: host.task.id, projectId: host.project.id })).toBe(1);
  expect(await lookupsAfter({})).toBe(1);
});

it("shows the error with a Retry that recovers into the plan", async () => {
  const host = setupPlanHost(harnesses);
  await host.save({ baseVersion: 0, body: BODY });
  let failing = true;
  const { rpc } = counted(host, (real) => (failing ? Promise.reject(new Error("lookup failed")) : real()));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1/plan" }, { rpc });
  expect((await slot.findByRole("alert")).textContent).toContain("lookup failed");
  failing = false;
  fireEvent.click(slot.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("Release plan"));
  expect(slot.queryByRole("alert")).toBeNull();
});

it("keeps the loaded plan when a later refetch fails", async () => {
  const host = setupPlanHost(harnesses);
  await host.save({ baseVersion: 0, body: BODY });
  let failing = false;
  const { rpc } = counted(host, (real) => (failing ? Promise.reject(new Error("later failure")) : real()));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1/plan" }, { rpc });
  await waitFor(() => expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("Release plan"));
  failing = true;
  await slot.behavior.emitRealtime("tasks:changed", { taskId: host.task.id, projectId: host.project.id });
  await sleep(300);
  expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("Release plan");
  expect(slot.queryByText("later failure")).toBeNull();
});
