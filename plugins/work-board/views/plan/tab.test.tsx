// @vitest-environment jsdom
import type { ComponentType } from "react";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { BODY, setupPlanHost } from "./test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

const planTab = (context: "thread" | "nav-panel" = "thread") => {
  const tab = app.tabs.find((candidate) => candidate.id === "plan" && candidate.context.kind === context);
  // The collector types tabs as a union of contexts; the plan tab's props are the same in both.
  return tab as unknown as { component: ComponentType<{ threadId: string; environment: null; params: unknown }>; availability: string };
};

async function open(options: { versions?: string[]; taskKey?: string } = {}) {
  const host = setupPlanHost(harnesses);
  const bodies = options.versions ?? [BODY];
  for (const [index, body] of bodies.entries()) await host.save({ baseVersion: index, body, summary: `Version ${index + 1}` });
  const slot = renderSlot(planTab(), { threadId: "thr_1", environment: null, params: { taskKey: options.taskKey ?? "EXA-1" } }, { rpc: host.rpc });
  return { ...host, slot };
}

const rendered = (slot: { container: HTMLElement }) => [...slot.container.querySelectorAll(".tiptap h1, .tiptap h2")].map((heading) => heading.textContent);
const tocLabels = (slot: { getByRole: (role: string, options: { name: string }) => HTMLElement }) =>
  within(slot.getByRole("navigation", { name: "Table of contents" })).getAllByRole("button").map((button) => button.textContent).filter((text) => !text?.startsWith("Contents"));

async function pickVersion(slot: Awaited<ReturnType<typeof open>>["slot"], label: string) {
  fireEvent.keyDown(await slot.findByRole("combobox", { name: "Plan version" }), { key: "Enter" });
  fireEvent.click(await slot.findByRole("option", { name: label }));
}

describe("Plan tab", () => {
  it("is an action tab in both contexts", () => {
    expect(planTab("thread").availability).toBe("action");
    expect(planTab("nav-panel").availability).toBe("action");
  });

  it("renders the plan read-only with the task, state and version", async () => {
    const { slot } = await open();
    await waitFor(() => expect(rendered(slot)).toEqual(["Release plan", "Steps", "Risks"]));
    expect(slot.getByRole("button", { name: /Planned work/ })).toBeTruthy();
    expect(slot.getByText("Draft")).toBeTruthy();
    expect(slot.getByRole("combobox", { name: "Plan version" }).textContent).toContain("v1 current");
    expect(slot.container.querySelector(".tiptap")?.getAttribute("contenteditable")).toBe("false");
  });

  it("keeps the state badge next to the title, and the version and actions together on the right", async () => {
    const { slot } = await open();
    const title = await slot.findByRole("button", { name: /Planned work/ });
    const badge = await slot.findByText("Draft");
    expect(badge.parentElement).toBe(title.parentElement);
    const version = await slot.findByRole("combobox", { name: "Plan version" });
    const actions = ["Edit", "History", "Compare with previous", "Plan actions"].map((name) => slot.getByRole("button", { name }));
    expect(new Set([version.parentElement, ...actions.map((button) => button.closest("div"))]).size).toBe(1);
    expect((slot.getByRole("button", { name: "Compare with previous" }) as HTMLButtonElement).disabled).toBe(true);
    expect(slot.getByText(/Updated by/)).toBeTruthy();
    expect(slot.getByRole("button", { name: "Open thread thr_example" })).toBeTruthy();
  });

  it("hides the plan of a project whose planning is off on every way in, while another project's plan stays accessible", async () => {
    const { slot, store, project, rpc, harness } = await open();
    await waitFor(() => expect(rendered(slot)).toHaveLength(3));
    // A change of the setting while the tab is open replaces the plan with a message.
    store.tasks.updateProject(project.id, { planning: "off" });
    await slot.behavior.emitRealtime("projects:changed", { projectId: project.id });
    await slot.findByText("Planning is off for this project");
    expect(slot.container.querySelector(".tiptap")).toBeNull();
    // A tab opened afterwards (a persisted tab or an old link) never reads the plan.
    cleanup();
    const reopened = renderSlot(planTab(), { threadId: "thr_1", environment: null, params: { taskKey: "EXA-1" } }, { rpc });
    await reopened.findByText("Planning is off for this project");
    expect(reopened.inspection.rpcCalls.map((call: { method: string }) => call.method)).not.toContain("listTaskPlanVersions");
    expect(reopened.inspection.rpcCalls.map((call: { method: string }) => call.method)).not.toContain("getTaskPlan");
    // Another project keeps its plan.
    cleanup();
    const other = store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
    store.tasks.updateProject(other.id, { planning: "optional" });
    const otherTask = store.tasks.createTask({ projectId: other.id, title: "Other work" });
    await harness.callRpc("saveTaskPlan", { taskId: otherTask.id, summary: "Plan", author: { kind: "agent", threadId: "thr_example", name: "agent (thr_example)" }, op: "replace", baseVersion: 0, body: BODY } as never);
    const accessible = renderSlot(planTab(), { threadId: "thr_1", environment: null, params: { taskKey: "OTH-1" } }, { rpc });
    await waitFor(() => expect(rendered(accessible)).toHaveLength(3));
  });

  it("puts the table of contents after the text in the DOM, so the wide layout shows it on the right", async () => {
    const { slot } = await open();
    await waitFor(() => expect(rendered(slot)).toHaveLength(3));
    const toc = slot.getByRole("navigation", { name: "Table of contents" });
    expect(slot.container.querySelector(".tiptap")!.compareDocumentPosition(toc) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(toc.closest("aside")!.className).toContain("@[56rem]:order-last");
  });

  it("shows a clear message for an unknown task and for missing params", async () => {
    const unknown = await open({ taskKey: "EXA-99" });
    await unknown.slot.findByText("Task EXA-99 was not found.");
    cleanup();
    const missing = renderSlot(planTab(), { threadId: "thr_1", environment: null, params: null }, { rpc: unknown.rpc });
    expect(missing.getByText(/No task selected/)).toBeTruthy();
  });

  it("lists the headings in the table of contents, leaves out a # line in a code block and scrolls on click", async () => {
    const { slot } = await open();
    await waitFor(() => expect(rendered(slot)).toHaveLength(3));
    expect(tocLabels(slot)).toEqual(["Release plan", "Steps", "Risks"]);
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    fireEvent.click(within(slot.getByRole("navigation", { name: "Table of contents" })).getByRole("button", { name: "Risks" }));
    expect(scroll.mock.contexts.at(-1)).toMatchObject({ tagName: "H2", textContent: "Risks" });
  });

  it("highlights the heading the reader is at while scrolling", async () => {
    let notify: (entries: unknown[]) => void = () => {};
    const observed: Element[] = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: unknown[]) => void) { notify = callback; }
      observe(element: Element) { observed.push(element); }
      unobserve() {}
      disconnect() {}
    });
    const { slot } = await open();
    await waitFor(() => expect(observed.map((element) => element.textContent)).toEqual(["Release plan", "Steps", "Risks"]));
    const toc = within(slot.getByRole("navigation", { name: "Table of contents" }));
    notify([{ target: observed[2], isIntersecting: true, boundingClientRect: { top: 0 }, rootBounds: null }]);
    await waitFor(() => expect(toc.getByRole("button", { name: "Risks" }).getAttribute("aria-current")).toBe("location"));
    expect(toc.getByRole("button", { name: "Steps" }).getAttribute("aria-current")).toBeNull();
  });

  it("shows an older version read-only with a banner and goes back to the current one", async () => {
    const { slot } = await open({ versions: ["# First\n\nOld text.\n", "# Second\n\nNew text.\n"] });
    await waitFor(() => expect(rendered(slot)).toEqual(["Second"]));
    await pickVersion(slot, "v1");
    await slot.findByText("Viewing v1 of v2");
    await waitFor(() => expect(rendered(slot)).toEqual(["First"]));
    expect(slot.queryByRole("button", { name: "Edit" })).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Back to current" }));
    await waitFor(() => expect(rendered(slot)).toEqual(["Second"]));
    expect(slot.queryByText(/Viewing v1/)).toBeNull();
  });

  it("lists the history with author, summary and line counts, and opens a version from it", async () => {
    const { slot } = await open({ versions: ["# First\n\nOld text.\n", "# Second\n\nNew text.\n"] });
    fireEvent.click(await slot.findByRole("button", { name: "History" }));
    const history = within(await slot.findByRole("list", { name: "Plan history" }));
    expect(history.getAllByRole("listitem")).toHaveLength(2);
    expect(history.getByText("v2 (current)")).toBeTruthy();
    expect(history.getByText("Version 1")).toBeTruthy();
    expect(history.getAllByText("agent (thr_example)")).toHaveLength(2);
    expect(history.getAllByText("replace").length).toBeGreaterThan(0);
    fireEvent.click(history.getByText("v1").closest("button")!);
    await slot.findByText("Viewing v1 of v2");
  });

  it("compares a version with the previous one as a source diff with word-level highlights", async () => {
    const { slot } = await open({ versions: [BODY, BODY.replace("- [ ] second step", "- [ ] third step").replace("Nothing known.\n", "")] });
    fireEvent.click(await slot.findByRole("button", { name: "Compare with previous" }));
    const diff = await slot.findByRole("group", { name: "Plan changes" });
    const added = [...diff.querySelectorAll('[data-diff="add"]')].map((row) => row.textContent);
    const removed = [...diff.querySelectorAll('[data-diff="del"]')].map((row) => row.textContent);
    expect(added).toEqual(["+- [ ] third step"]);
    expect(removed).toEqual(["−- [ ] second step", "−Nothing known."]);
    expect(diff.querySelector("ins")?.textContent).toBe("third");
    expect(diff.querySelector("del")?.textContent).toBe("second");
    expect(slot.getByRole("combobox", { name: "Compare from" }).textContent).toContain("v1");
    expect(slot.getByRole("combobox", { name: "Compare to" }).textContent).toContain("v2 current");
    fireEvent.click(slot.getByRole("button", { name: "Close compare" }));
    await waitFor(() => expect(rendered(slot)).toHaveLength(3));
  });

  it("follows a new version while on the current one, and only announces it while viewing an older one", async () => {
    const { slot, save, task, project } = await open({ versions: ["# One\n", "# Two\n"] });
    await waitFor(() => expect(rendered(slot)).toEqual(["Two"]));
    await save({ baseVersion: 2, body: "# Three\n" });
    await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: project.id });
    await waitFor(() => expect(rendered(slot)).toEqual(["Three"]));
    expect(slot.queryByText(/is available/)).toBeNull();

    await pickVersion(slot, "v1");
    await waitFor(() => expect(rendered(slot)).toEqual(["One"]));
    await save({ baseVersion: 3, body: "# Four\n" });
    await slot.behavior.emitRealtime("tasks:changed", { taskId: task.id, projectId: project.id });
    await slot.findByText("v4 is available");
    expect(rendered(slot)).toEqual(["One"]);
    fireEvent.click(slot.getByRole("button", { name: "Show" }));
    await waitFor(() => expect(rendered(slot)).toEqual(["Four"]));
    expect(slot.queryByText(/is available/)).toBeNull();
  });

  it("copies the Markdown of the version on screen and the plan link", async () => {
    const { slot } = await open({ versions: ["# First\n", "# Second\n"] });
    await pickVersion(slot, "v1");
    await waitFor(() => expect(rendered(slot)).toEqual(["First"]));
    const menu = async (name: string) => {
      fireEvent.keyDown(slot.getByRole("button", { name: "Plan actions" }), { key: "Enter" });
      fireEvent.click(await slot.findByRole("menuitem", { name }));
    };
    await menu("Copy Markdown");
    await menu("Copy link");
    await waitFor(() => expect(slot.inspection.experimental_clipboardWrites).toHaveLength(2));
    expect(slot.inspection.experimental_clipboardWrites.map((write: { text: string }) => write.text)).toEqual([
      "# First\n",
      "[EXA-1 plan](/plugins/work-board/work-board/task/EXA-1/plan)",
    ]);
  });
});
