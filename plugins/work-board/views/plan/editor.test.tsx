// @vitest-environment jsdom
import type { ComponentType } from "react";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { planDrafts } from "./data";
import { requestPlanEdit } from "./open";
import { BODY, setupPlanHost } from "./test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  planDrafts.clear();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

const tab = app.tabs.find((candidate) => candidate.id === "plan" && candidate.context.kind === "thread") as unknown as { component: ComponentType<{ threadId: string; environment: null; params: unknown }> };

async function open(bodies: string[] = [BODY]) {
  const host = setupPlanHost(harnesses);
  for (const [index, body] of bodies.entries()) await host.save({ baseVersion: index, body, summary: `Version ${index + 1}` });
  const mount = (rpc = host.rpc) => renderSlot(tab, { threadId: "thr_1", environment: null, params: { taskKey: "EXA-1" } }, { rpc });
  return { ...host, mount, slot: mount() };
}
type Slot = Awaited<ReturnType<typeof open>>["slot"];

const saveCalls = (slot: Slot) => slot.inspection.rpcCalls.filter((call: { method: string }) => call.method === "saveTaskPlan");
const editor = (slot: Slot) => slot.findByRole("textbox", { name: "Plan Markdown" }) as Promise<HTMLTextAreaElement>;
const summary = (slot: Slot) => slot.getByRole("textbox", { name: "Summary of change" });
const planNow = async (host: { harness: FakePluginHarness; task: { id: string } }) =>
  (await host.harness.callRpc("getTaskPlan", { taskId: host.task.id })) as { plan: { version: number; requested: { body: string; author: { kind: string; name: string }; summary: string } } };

describe("Plan editor", () => {
  it("edits the exact Markdown source and saves it as a person with the base version and a summary", async () => {
    const host = await open();
    const { slot } = host;
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    const textarea = await editor(slot);
    expect(textarea.value).toBe(BODY);
    expect(textarea.className).toContain("font-mono");
    fireEvent.change(textarea, { target: { value: `${BODY}\n## Rollback\n\nRevert.\n` } });
    fireEvent.change(summary(slot), { target: { value: "Add rollback" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveCalls(slot)).toHaveLength(1));
    expect(saveCalls(slot)[0].input).toEqual({
      op: "replace",
      taskId: host.task.id,
      baseVersion: 1,
      summary: "Add rollback",
      body: `${BODY}\n## Rollback\n\nRevert.\n`,
      author: { kind: "person", threadId: null, name: "You" },
    });
    await waitFor(() => expect(slot.queryByRole("textbox", { name: "Plan Markdown" })).toBeNull());
    const { plan } = await planNow(host);
    expect(plan).toMatchObject({ version: 2, requested: { author: { kind: "person" }, summary: "Add rollback" } });
    expect(planDrafts.size).toBe(0);
  });

  it("requires a summary", async () => {
    const { slot } = await open();
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(await editor(slot), { target: { value: "# Changed\n" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect((await slot.findByRole("alert")).textContent).toMatch(/summary/);
    expect(saveCalls(slot)).toHaveLength(0);
    fireEvent.change(summary(slot), { target: { value: "   " } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    expect(saveCalls(slot)).toHaveLength(0);
    expect((summary(slot) as HTMLInputElement).maxLength).toBe(300);
  });

  it("shows a refusal inline", async () => {
    const { slot } = await open();
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    await editor(slot);
    fireEvent.change(summary(slot), { target: { value: "Nothing changed" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent?.length).toBeGreaterThan(0));
    expect(slot.getByRole("textbox", { name: "Plan Markdown" })).toBeTruthy();
    expect(saveCalls(slot)).toHaveLength(1);
  });

  it("handles a conflict: shows the new version number and overwrites with the new base", async () => {
    const host = await open();
    const { slot } = host;
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(await editor(slot), { target: { value: "# Mine\n" } });
    fireEvent.change(summary(slot), { target: { value: "My rewrite" } });
    await host.save({ baseVersion: 1, body: "# Theirs\n", summary: "Agent edit" });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText("The plan changed to v2 while you were editing.");
    expect(saveCalls(slot)).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() => expect(saveCalls(slot)).toHaveLength(2));
    expect(saveCalls(slot)[1].input).toMatchObject({ baseVersion: 2, body: "# Mine\n", summary: "My rewrite" });
    await waitFor(async () => expect((await planNow(host)).plan).toMatchObject({ version: 3, requested: { body: "# Mine\n" } }));
  });

  it("keeps the person's text when they choose to see the new version", async () => {
    const host = await open();
    const { slot } = host;
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(await editor(slot), { target: { value: "# Mine\n" } });
    fireEvent.change(summary(slot), { target: { value: "My rewrite" } });
    await host.save({ baseVersion: 1, body: "# Theirs\n", summary: "Agent edit" });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    fireEvent.click(await slot.findByRole("button", { name: "Show the new version" }));
    await slot.findByText("Unsaved draft from v1");
    await waitFor(() => expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("Theirs"));
    fireEvent.click(slot.getByRole("button", { name: "Copy my text" }));
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites.map((write: { text: string }) => write.text)).toEqual(["# Mine\n"]));
    expect(planDrafts.get(host.task.id)?.text).toBe("# Mine\n");
  });

  it("announces a new version while editing and keeps the text", async () => {
    const host = await open();
    const { slot } = host;
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(await editor(slot), { target: { value: "# Mine\n" } });
    await host.save({ baseVersion: 1, body: "# Theirs\n" });
    await slot.behavior.emitRealtime("tasks:changed", { taskId: host.task.id, projectId: host.project.id });
    await slot.findByText("v2 is available");
    expect((await editor(slot)).value).toBe("# Mine\n");
  });

  it("keeps an unsaved draft per task across a tab switch, and Cancel drops it", async () => {
    const host = await open();
    fireEvent.click(await host.slot.findByRole("button", { name: "Edit" }));
    fireEvent.change(await editor(host.slot), { target: { value: "# Draft\n" } });
    fireEvent.change(summary(host.slot), { target: { value: "WIP" } });
    cleanup();

    const again = host.mount();
    await again.findByText("Unsaved draft from v1");
    fireEvent.click(again.getByRole("button", { name: "Continue editing" }));
    expect((await editor(again)).value).toBe("# Draft\n");
    expect((summary(again) as HTMLInputElement).value).toBe("WIP");
    fireEvent.click(again.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(again.queryByRole("textbox", { name: "Plan Markdown" })).toBeNull());
    expect(again.queryByText(/Unsaved draft/)).toBeNull();
    expect(planDrafts.size).toBe(0);
  });

  it("does not keep a draft for an editor that was opened and left unchanged", async () => {
    const { slot } = await open();
    fireEvent.click(await slot.findByRole("button", { name: "Edit" }));
    await editor(slot);
    expect(planDrafts.size).toBe(0);
  });

  it("offers no editing for an archived task", async () => {
    const host = setupPlanHost(harnesses);
    await host.save({ baseVersion: 0, body: BODY });
    await host.harness.callRpc("updateTask", { taskId: host.task.id, status: "done" });
    await host.harness.callRpc("archiveTask", { taskId: host.task.id, archived: true });
    const slot = renderSlot(tab, { threadId: "thr_1", environment: null, params: { taskKey: "EXA-1" } }, { rpc: host.rpc });
    await slot.findByRole("button", { name: "History" });
    expect(slot.queryByRole("button", { name: "Edit" })).toBeNull();
    requestPlanEdit("EXA-1");
    await slot.findByRole("button", { name: "History" });
    expect(slot.queryByRole("textbox", { name: "Plan Markdown" })).toBeNull();
  });

  it("writes the first plan of a task without one", async () => {
    const host = setupPlanHost(harnesses);
    const slot = renderSlot(tab, { threadId: "thr_1", environment: null, params: { taskKey: "EXA-1" } }, { rpc: host.rpc });
    await slot.findByText("No plan yet");
    expect(slot.getByText(/bb work-board plan set/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Write plan" }));
    fireEvent.change(await editor(slot), { target: { value: "# First plan\n" } });
    fireEvent.change(summary(slot), { target: { value: "Initial" } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saveCalls(slot)[0]?.input).toMatchObject({ baseVersion: 0, op: "replace", body: "# First plan\n" }));
    await waitFor(() => expect(slot.container.querySelector(".tiptap h1")?.textContent).toBe("First plan"));
  });

  it("opens straight in the editor when Write plan asked for it", async () => {
    const host = setupPlanHost(harnesses);
    requestPlanEdit("EXA-1");
    const slot = renderSlot(tab, { threadId: "thr_1", environment: null, params: { taskKey: "EXA-1" } }, { rpc: host.rpc });
    expect((await editor(slot)).value).toBe("");
  });
});
