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

it("renders the plan in the main area with a way back to the task", async () => {
  const host = setupPlanHost(harnesses);
  await host.save({ baseVersion: 0, body: BODY });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1/plan" }, { rpc: host.rpc });
  await waitFor(() => expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("Release plan"));
  fireEvent.click(slot.getByRole("button", { name: "Back to EXA-1" }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "task/EXA-1" } });
});

it("opens the task from the plan header", async () => {
  const host = setupPlanHost(harnesses);
  await host.save({ baseVersion: 0, body: BODY });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1/plan" }, { rpc: host.rpc });
  fireEvent.click(await slot.findByRole("button", { name: /Planned work/ }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "task/EXA-1" } });
});
