// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { requestPlanEdit, takePlanEditRequest } from "./open";
import { BODY, setupPlanHost } from "./test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  takePlanEditRequest("EXA-1");
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function openDetail(openTab: () => boolean) {
  const host = setupPlanHost(harnesses);
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1" }, { rpc: host.rpc, experimental_panel: { openTab } });
  return { ...host, slot };
}
const card = async (slot: ReturnType<typeof openDetail>["slot"]) => within(await slot.findByRole("region", { name: "Plan" }));

describe("Plan card in the task detail", () => {
  it("says there is no plan and where agents create one", async () => {
    const { slot } = openDetail(() => true);
    const plan = await card(slot);
    await plan.findByText("No plan yet");
    expect(plan.getByText(/bb work-board plan set/)).toBeTruthy();
    expect(plan.getByRole("button", { name: "Write plan" })).toBeTruthy();
    expect(plan.queryByRole("button", { name: /Open plan/ })).toBeNull();
  });

  it("sits between the description and the current state", async () => {
    const { slot } = openDetail(() => true);
    const region = await slot.findByRole("region", { name: "Plan" });
    const current = slot.getByRole("region", { name: "Current state" });
    expect(region.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(slot.container.querySelector(".tiptap")!.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows version, state, author, time and the summary of the last version, not the plan itself", async () => {
    const host = openDetail(() => true);
    await host.save({ baseVersion: 0, body: BODY, summary: "First draft" });
    await host.save({ baseVersion: 1, body: `${BODY}\nMore.\n`, summary: "Added a closing note" });
    const plan = await card(host.slot);
    await plan.findByText("v2");
    expect(plan.getByText("Draft")).toBeTruthy();
    expect(plan.getByText(/Updated by agent \(thr_example\)/)).toBeTruthy();
    expect(plan.getByText("Added a closing note")).toBeTruthy();
    expect(plan.queryByText("Release plan")).toBeNull();
    expect(plan.queryByRole("button", { name: "Write plan" })).toBeNull();
  });

  it("puts the state badge in the card header next to the title, with the version on the right", async () => {
    const host = openDetail(() => true);
    await host.save({ baseVersion: 0, body: BODY });
    const plan = await card(host.slot);
    const title = await plan.findByRole("heading", { name: "Plan" });
    const badge = plan.getByText("Draft");
    const version = plan.getByText("v1");
    expect(title.parentElement).toBe(badge.parentElement);
    expect(title.compareDocumentPosition(badge) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(badge.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(version.parentElement).toBe(title.parentElement);
  });

  it("refreshes when the task changes", async () => {
    const host = openDetail(() => true);
    await host.save({ baseVersion: 0, body: BODY });
    const plan = await card(host.slot);
    await plan.findByText("v1");
    await host.save({ baseVersion: 1, body: `${BODY}\nMore.\n`, summary: "Second" });
    await host.harness.callRpc("setTaskPlanState", { taskId: host.task.id, state: "approved", author: { kind: "person", threadId: null, name: "You" } });
    await host.slot.behavior.emitRealtime("tasks:changed", { taskId: host.task.id, projectId: host.project.id });
    await plan.findByText("v2");
    expect(plan.getByText("Approved")).toBeTruthy();
  });

  it("opens the plan tab with the task key as params and a title", async () => {
    const openTab = vi.fn(() => true);
    const host = openDetail(openTab);
    await host.save({ baseVersion: 0, body: BODY });
    fireEvent.click(await (await card(host.slot)).findByRole("button", { name: "Open plan for EXA-1" }));
    expect(openTab).toHaveBeenCalledTimes(1);
    expect(openTab).toHaveBeenCalledWith({
      tab: expect.objectContaining({ id: "plan", availability: "action" }),
      params: { taskKey: "EXA-1" },
      title: "Plan · EXA-1",
    });
    expect(host.slot.navigateCalls).toEqual([]);
  });

  it("tries the Work Board page's tab when the thread tab is declined, then the plan route", async () => {
    const openTab = vi.fn((options: { tab: { context: { kind: string } } }) => options.tab.context.kind === "nav-panel");
    const host = openDetail(openTab as never);
    await host.save({ baseVersion: 0, body: BODY });
    fireEvent.click(await (await card(host.slot)).findByRole("button", { name: "Open plan for EXA-1" }));
    expect(openTab.mock.calls.map(([options]) => options.tab.context)).toEqual([{ kind: "thread" }, { kind: "nav-panel", panelId: "work-board" }]);
    expect(host.slot.navigateCalls).toEqual([]);
  });

  it("navigates to the plan route when there is no side panel", async () => {
    const openTab = vi.fn(() => false);
    const host = openDetail(openTab);
    await host.save({ baseVersion: 0, body: BODY });
    fireEvent.click(await (await card(host.slot)).findByRole("button", { name: "Open plan for EXA-1" }));
    expect(openTab).toHaveBeenCalledTimes(2);
    expect(host.slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "task/EXA-1/plan" } });
  });

  it("copies the plan link as Markdown from the icon button without opening the plan", async () => {
    const openTab = vi.fn(() => true);
    const host = openDetail(openTab);
    await host.save({ baseVersion: 0, body: BODY });
    fireEvent.click(await (await card(host.slot)).findByRole("button", { name: "Copy link" }));
    expect(openTab).not.toHaveBeenCalled();
    await waitFor(() => expect(host.slot.inspection.experimental_clipboardWrites).toEqual([{ text: "[EXA-1 plan](/plugins/work-board/work-board/task/EXA-1/plan)" }]));
  });

  it("Write plan opens the plan and asks it to start editing", async () => {
    const openTab = vi.fn(() => true);
    const host = openDetail(openTab);
    fireEvent.click(await (await card(host.slot)).findByRole("button", { name: "Write plan" }));
    expect(openTab).toHaveBeenCalledWith(expect.objectContaining({ params: { taskKey: "EXA-1" } }));
    expect(takePlanEditRequest("EXA-1")).toBe(true);
    requestPlanEdit("EXA-1");
  });

  it("offers no Write plan for an archived task", async () => {
    const host = setupPlanHost(harnesses);
    await host.harness.callRpc("updateTask", { taskId: host.task.id, status: "done" });
    await host.harness.callRpc("archiveTask", { taskId: host.task.id, archived: true });
    const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1" }, { rpc: host.rpc, experimental_panel: { openTab: () => true } });
    const plan = await card(slot);
    await plan.findByText("No plan yet");
    expect(plan.queryByRole("button", { name: "Write plan" })).toBeNull();
  });

  it("shows the counts of open, draft and addressed notes next to the meta", async () => {
    const host = openDetail(() => true);
    await host.save({ baseVersion: 0, body: BODY });
    const plan = await card(host.slot);
    await plan.findByText("v1");
    expect(plan.queryByTestId("note-counts")).toBeNull();
    const owner = { kind: "person", threadId: null, name: "You" };
    const call = (method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, { taskId: host.task.id, ...input } as never) as Promise<any>;
    for (const body of ["One.", "Two.", "Three."]) await call("createPlanNote", { kind: "general", body });
    await call("sendPlanFeedback", { author: owner });
    await call("createPlanNote", { kind: "general", body: "Four." });
    await call("replyPlanNote", { number: 1, body: "Done.", addressed: true, author: { kind: "agent", threadId: "thr_example", name: "agent (thr_example)" } });
    await host.slot.behavior.emitRealtime("tasks:changed", { taskId: host.task.id, projectId: host.project.id });
    await waitFor(() => expect(plan.getByTestId("note-counts").textContent).toBe(" · 2 open notes · 1 draft · 1 addressed"));
    expect(plan.getByText("Changes requested")).toBeTruthy();
  });
});
