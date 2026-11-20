// @vitest-environment jsdom
import type { ComponentType } from "react";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PlanNote } from "../../shared/contract";
import { createPlanNoteStore } from "../../plans/notes";
import { createPlanStore } from "../../plans/store";
import { BODY, setupPlanHost } from "./test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.getSelection()?.removeAllRanges();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

const planTab = () =>
  app.tabs.find((candidate) => candidate.id === "plan" && candidate.context.kind === "thread") as unknown as { component: ComponentType<{ threadId: string; environment: null; params: unknown }> };
const OWNER = { kind: "person", threadId: null, name: "You" };

async function open(versions: string[] = [BODY]) {
  const host = setupPlanHost(harnesses);
  for (const [index, body] of versions.entries()) await host.save({ baseVersion: index, body, summary: `Version ${index + 1}` });
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  host.harness.sdk.stub("threads.send", async () => undefined);
  const call = <T = any>(method: string, input: Record<string, unknown> = {}) => host.harness.callRpc(method as never, { taskId: host.task.id, ...input } as never) as Promise<T>;
  const slot = renderSlot(planTab(), { threadId: "thr_1", environment: null, params: { taskKey: "EXA-1" } }, { rpc: host.rpc });
  const notes = () => call<{ notes: PlanNote[] }>("listPlanNotes").then((result) => result.notes);
  const refresh = () => slot.behavior.emitRealtime("tasks:changed", { taskId: host.task.id, projectId: host.project.id });
  // Notes made behind the page's back arrive like a live update.
  const note = async (input: Record<string, unknown>) => {
    const created = (await call<{ note: PlanNote }>("createPlanNote", input)).note;
    await refresh();
    return created;
  };
  return { ...host, slot, call, note, notes, refresh };
}

/** Selects `text` inside the rendered plan, as a pointer drag would, and tells the page the selection changed. */
function select(container: HTMLElement, text: string) {
  const root = container.querySelector(".tiptap")!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const at = node.data.indexOf(text);
    if (at === -1) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + text.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    return;
  }
  throw new Error(`"${text}" is not in the plan`);
}

const ready = (slot: { container: HTMLElement }) => waitFor(() => expect(slot.container.querySelectorAll(".tiptap h2")).toHaveLength(2));
const list = (slot: Awaited<ReturnType<typeof open>>["slot"]) => within(slot.getByRole("group", { name: "Plan notes" }));

describe("selecting text to leave a note", () => {
  it("shows a toolbar for a selection, opens a popover for Comment and stores the note with its anchor", async () => {
    const { slot, notes } = await open();
    await ready(slot);
    expect(slot.queryByRole("toolbar", { name: "Note on selection" })).toBeNull();
    select(slot.container, "second step");
    const toolbar = await slot.findByRole("toolbar", { name: "Note on selection" });
    fireEvent.click(within(toolbar).getByRole("button", { name: "Comment" }));
    expect(slot.queryByRole("toolbar", { name: "Note on selection" })).toBeNull();
    const dialog = await slot.findByRole("dialog", { name: "Add note" });
    expect(within(dialog).getByText("“second step”")).toBeTruthy();
    const add = within(dialog).getByRole("button", { name: "Add note" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Note" }), { target: { value: "Name the owner of this step." } });
    fireEvent.click(add);
    await waitFor(() => expect(slot.queryByRole("dialog", { name: "Add note" })).toBeNull());
    const item = await waitFor(() => list(slot).getByText("Name the owner of this step.").closest("li")!);
    expect(within(item).getByText("N1")).toBeTruthy();
    expect(within(item).getByText("Draft")).toBeTruthy();
    expect(within(item).getByText("“second step”")).toBeTruthy();
    const [stored] = await notes();
    expect(stored).toMatchObject({ kind: "comment", exact: "second step", headingPath: "Release plan > Steps", madeOnVersion: 1, state: "draft", body: "Name the owner of this step." });
    expect(stored!.prefix).toContain("first step");
    expect(stored!.suffix).toContain("Risks");
    expect(slot.getByRole("button", { name: "Send feedback (1)" })).toBeTruthy();
  });

  it("renders the toolbar and the popover in document.body under the plugin scope, outside the panel", async () => {
    const { slot } = await open();
    await ready(slot);
    select(slot.container, "second step");
    const toolbar = await slot.findByRole("toolbar", { name: "Note on selection" });
    const scope = toolbar.parentElement!;
    expect(scope.getAttribute("data-bb-plugin")).toBe("work-board");
    expect(scope.parentElement).toBe(document.body);
    expect(slot.container.contains(toolbar)).toBe(false);
    expect(toolbar.style.position).toBe("fixed");
    const prevented = !fireEvent.mouseDown(toolbar);
    expect(prevented).toBe(true);

    fireEvent.click(within(toolbar).getByRole("button", { name: "Comment" }));
    const popover = await slot.findByRole("dialog", { name: "Add note" });
    expect(popover.parentElement!.getAttribute("data-bb-plugin")).toBe("work-board");
    expect(popover.parentElement!.parentElement).toBe(document.body);
    expect(slot.container.contains(popover)).toBe(false);
  });

  it("opens the popover on a full mouse press on Comment even when the selection is lost on the way, and the note can be added", async () => {
    const { slot, notes } = await open();
    await ready(slot);
    select(slot.container, "second step");
    const comment = within(await slot.findByRole("toolbar", { name: "Note on selection" })).getByRole("button", { name: "Comment" });
    // What a real mouse sends, in order; a press inside the toolbar must not count as outside.
    fireEvent.pointerDown(comment);
    fireEvent.mouseDown(comment);
    // A host that clears the selection on a press does so after the press; the toolbar is gone before the click.
    window.getSelection()!.removeAllRanges();
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    fireEvent.pointerUp(comment);
    fireEvent.mouseUp(comment);
    fireEvent.click(comment, { detail: 1 });
    const popover = await slot.findByRole("dialog", { name: "Add note" });
    const box = within(popover).getByRole("textbox", { name: "Note" });
    fireEvent.pointerDown(box);
    fireEvent.mouseDown(box);
    fireEvent.change(box, { target: { value: "Needs a rollback." } });
    const add = within(popover).getByRole("button", { name: "Add note" });
    fireEvent.pointerDown(add);
    fireEvent.mouseDown(add);
    fireEvent.pointerUp(add);
    fireEvent.mouseUp(add);
    fireEvent.click(add);
    await waitFor(() => expect(list(slot).getByText("Needs a rollback.")).toBeTruthy());
    expect(await notes()).toMatchObject([{ kind: "comment", body: "Needs a rollback." }]);
  });

  it("closes the toolbar and the popover on Escape and on a press outside", async () => {
    const { slot } = await open();
    await ready(slot);
    select(slot.container, "second step");
    await slot.findByRole("toolbar", { name: "Note on selection" });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(slot.queryByRole("toolbar", { name: "Note on selection" })).toBeNull();

    select(slot.container, "second step");
    await slot.findByRole("toolbar", { name: "Note on selection" });
    fireEvent.pointerDown(slot.container.querySelector("header")!);
    expect(slot.queryByRole("toolbar", { name: "Note on selection" })).toBeNull();

    select(slot.container, "second step");
    fireEvent.click(within(await slot.findByRole("toolbar", { name: "Note on selection" })).getByRole("button", { name: "Comment" }));
    const popover = await slot.findByRole("dialog", { name: "Add note" });
    fireEvent.pointerDown(within(popover).getByRole("textbox", { name: "Note" }));
    expect(slot.queryByRole("dialog", { name: "Add note" })).not.toBeNull();
    fireEvent.keyDown(within(popover).getByRole("textbox", { name: "Note" }), { key: "Escape" });
    expect(slot.queryByRole("dialog", { name: "Add note" })).toBeNull();

    select(slot.container, "second step");
    fireEvent.click(within(await slot.findByRole("toolbar", { name: "Note on selection" })).getByRole("button", { name: "Comment" }));
    await slot.findByRole("dialog", { name: "Add note" });
    fireEvent.pointerDown(slot.container.querySelector("header")!);
    expect(slot.queryByRole("dialog", { name: "Add note" })).toBeNull();
  });

  it("creates a Remove note at once and asks for an optional reason in the list", async () => {
    const { slot, notes } = await open();
    await ready(slot);
    select(slot.container, "Nothing known.");
    fireEvent.click(within(await slot.findByRole("toolbar", { name: "Note on selection" })).getByRole("button", { name: "Remove" }));
    const reason = await slot.findByRole("textbox", { name: "Reason for N1 (optional)" });
    expect(await notes()).toMatchObject([{ kind: "remove", exact: "Nothing known.", body: "", headingPath: "Release plan > Risks" }]);
    fireEvent.change(reason, { target: { value: "Out of scope." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(list(slot).getByText("Out of scope.")).toBeTruthy());
    expect((await notes())[0]!.body).toBe("Out of scope.");
  });

  it("ignores a selection outside the plan text and offers no toolbar on an older version or in compare mode", async () => {
    const { slot } = await open([BODY, `${BODY}\nMore.\n`]);
    await ready(slot);
    const range = document.createRange();
    range.selectNodeContents(slot.container.querySelector("header")!);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    act(() => void document.dispatchEvent(new Event("selectionchange")));
    expect(slot.queryByRole("toolbar", { name: "Note on selection" })).toBeNull();

    fireEvent.keyDown(slot.getByRole("combobox", { name: "Plan version" }), { key: "Enter" });
    fireEvent.click(await slot.findByRole("option", { name: "v1" }));
    await slot.findByText("Viewing v1 of v2");
    await waitFor(() => select(slot.container, "second step"));
    await waitFor(() => expect(slot.container.querySelector(".tiptap")?.textContent).not.toContain("More."));
    select(slot.container, "second step");
    expect(slot.queryByRole("toolbar", { name: "Note on selection" })).toBeNull();
    expect(slot.queryByRole("button", { name: /Send feedback/ })).toBeNull();
    expect(slot.queryByRole("button", { name: "Add general note" })).toBeNull();
  });
});

describe("general notes, Send feedback and Approve", () => {
  it("adds a general note from the header and keeps Send feedback disabled until a draft exists", async () => {
    const { slot, notes } = await open();
    await ready(slot);
    const send = slot.getByRole("button", { name: "Send feedback (0)" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.pointerMove(send.parentElement!);
    expect((await slot.findAllByText("Add a note first: select text in the plan or add a general note")).length).toBeGreaterThan(0);
    fireEvent.click(slot.getByRole("button", { name: "Add general note" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "General note" }), { target: { value: "Add a rollback step." } });
    fireEvent.click(slot.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(list(slot).getByText("Add a rollback step.")).toBeTruthy());
    expect(within(list(slot).getByText("Add a rollback step.").closest("li")!).getByText("General note")).toBeTruthy();
    expect(await notes()).toMatchObject([{ kind: "general", exact: null }]);
    expect((slot.getByRole("button", { name: "Send feedback (1)" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends the drafts through sendPlanFeedback and says the agent was told", async () => {
    const { slot, harness, note, call } = await open();
    await note({ kind: "general", body: "Add a rollback step." });
    await note({ kind: "general", body: "And a test plan." });
    const calls: unknown[] = [];
    const original = harness.callRpc.bind(harness);
    vi.spyOn(harness, "callRpc").mockImplementation(((method: string, input: unknown) => (calls.push([method, input]), original(method as never, input as never))) as never);
    fireEvent.click(await slot.findByRole("button", { name: "Send feedback (2)" }));
    await slot.findByText("Feedback sent to the agent");
    expect(calls).toContainEqual(["sendPlanFeedback", { taskId: expect.any(String), author: OWNER }]);
    await waitFor(() => expect(slot.getByText("Changes requested")).toBeTruthy());
    expect((await call<{ notes: PlanNote[] }>("listPlanNotes")).notes.map((entry) => entry.state)).toEqual(["sent", "sent"]);
    expect((slot.getByRole("button", { name: "Send feedback (0)" }) as HTMLButtonElement).disabled).toBe(true);
    expect(list(slot).getAllByText("Sent")).toHaveLength(2);
  });

  it("scopes drafts per author: a reviewer thread's draft is shown with its author, is not counted, and cannot be edited or sent by the owner", async () => {
    const { slot, store, db, task, note, refresh } = await open();
    const plans = createPlanStore(db, store.tasks);
    plans.submit(task.id, { kind: "agent", threadId: "thr_example", name: "agent (thr_example)" }, "thr_reviewer");
    createPlanNoteStore(db, store.tasks, plans.head).createByReviewer({ taskId: task.id, by: { kind: "agent", threadId: "thr_reviewer", name: "agent (thr_reviewer)" }, version: 1, body: "Reviewer's draft." });
    await refresh();
    const group = await slot.findByRole("group", { name: "Plan notes" });
    const item = (await within(group).findByText("Reviewer's draft.")).closest("li")!;
    expect(within(item).getByRole("button", { name: "Open thread thr_reviewer" })).toBeTruthy();
    expect(within(group).queryByText(/Drafts to send/)).toBeNull();
    expect(within(item).queryByRole("button", { name: /Edit|Delete/ })).toBeNull();
    expect((slot.getByRole("button", { name: "Send feedback (0)" }) as HTMLButtonElement).disabled).toBe(true);
    // The owner's own draft is counted alone, and the owner can approve over the reviewer's draft once theirs is gone.
    await note({ kind: "general", body: "My draft." });
    expect(await slot.findByRole("button", { name: "Send feedback (1)" })).toBeTruthy();
  });

  it("names every thread that was not reached after a decision, and confirms it was saved", async () => {
    const { slot, harness, store, db, task, note } = await open();
    createPlanStore(db, store.tasks).submit(task.id, { kind: "agent", threadId: "thr_submitter", name: "agent (thr_submitter)" }, "thr_reviewer");
    await note({ kind: "general", body: "Add a rollback step." });
    harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_example") throw new Error("gone");
      return undefined;
    });
    fireEvent.click(await slot.findByRole("button", { name: "Send feedback (1)" }));
    await slot.findByText("Feedback saved, but not delivered to thr_example; tell them yourself");
    expect((harness.sdk.callsTo("threads.send") as Array<[{ threadId: string }]>).map((entry) => entry[0].threadId)).toEqual(["thr_submitter", "thr_example"]);
    expect(list(slot).getByText("Sent")).toBeTruthy();
  });

  it("keeps the notes sent and says so when the agent could not be notified", async () => {
    const { slot, harness, note } = await open();
    await note({ kind: "general", body: "Add a rollback step." });
    harness.sdk.stub("threads.send", async () => {
      throw new Error("gone");
    });
    fireEvent.click(await slot.findByRole("button", { name: "Send feedback (1)" }));
    await slot.findByText("Saved, but the agent could not be notified");
    expect(list(slot).getByText("Sent")).toBeTruthy();
  });

  it("explains why Approve is disabled, then approves after a confirmation with a note", async () => {
    const { slot, harness, note, call } = await open();
    await ready(slot);
    await note({ kind: "general", body: "Draft note." });
    await slot.findByRole("button", { name: "Send feedback (1)" });
    const approve = slot.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.pointerMove(approve.parentElement!);
    expect((await slot.findAllByText("Send or delete the 1 draft note first")).length).toBeGreaterThan(0);

    fireEvent.click(list(slot).getByRole("button", { name: "Delete N1" }));
    await waitFor(() => expect((slot.getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(false));
    const calls: unknown[] = [];
    const original = harness.callRpc.bind(harness);
    vi.spyOn(harness, "callRpc").mockImplementation(((method: string, input: unknown) => (calls.push([method, input]), original(method as never, input as never))) as never);
    fireEvent.click(slot.getByRole("button", { name: "Approve" }));
    expect(await slot.findByText("Approve plan v1?")).toBeTruthy();
    fireEvent.change(slot.getByRole("textbox", { name: "Approval note" }), { target: { value: "Go ahead." } });
    fireEvent.click(slot.getByRole("button", { name: "Approve plan" }));
    await slot.findByText("Approval sent to the agent");
    expect(calls).toContainEqual(["approvePlan", { taskId: expect.any(String), author: OWNER, note: "Go ahead." }]);
    expect((await call<{ plan: { state: string } }>("getTaskPlan")).plan.state).toBe("approved");
    await waitFor(() => expect(slot.getByText("Approved")).toBeTruthy());
    const done = slot.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    fireEvent.pointerMove(done.parentElement!);
    expect((await slot.findAllByText("Plan v1 is already approved")).length).toBeGreaterThan(0);
  });
});

describe("the notes list", () => {
  it("shows the agent's reply as addressed in a version, and lets the owner resolve and reopen", async () => {
    const { slot, note, call, refresh, save } = await open();
    await note({ kind: "comment", exact: "second step", prefix: "first step", suffix: "Risks", headingPath: "Release plan > Steps", body: "Say who does it." });
    await call("sendPlanFeedback", { author: OWNER });
    await save({ baseVersion: 1, body: BODY.replace("second step", "second step (owner: Sam)"), summary: "Name the owner" });
    await call("replyPlanNote", { number: 1, body: "Added the owner.", addressed: true, author: { kind: "agent", threadId: "thr_example", name: "agent (thr_example)" } });
    await refresh();
    const item = await waitFor(() => list(slot).getByText("Added the owner.").closest("li")!);
    expect(within(item).getByText("Addressed")).toBeTruthy();
    expect(within(item).getByText(/addressed in v2/)).toBeTruthy();
    expect(within(item).getByRole("button", { name: "Open thread thr_example" })).toBeTruthy();
    expect(within(item).queryByRole("button", { name: "Edit N1" })).toBeNull();
    expect(within(item).queryByRole("button", { name: "Delete N1" })).toBeNull();

    fireEvent.click(within(item).getByRole("button", { name: "Resolve N1" }));
    await waitFor(() => expect(within(list(slot).getByText("Added the owner.").closest("li")!).getByText("Resolved")).toBeTruthy());
    fireEvent.click(list(slot).getByRole("button", { name: "Reopen N1" }));
    await waitFor(() => expect(within(list(slot).getByText("Added the owner.").closest("li")!).getByText("Draft")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Send feedback (1)" })).toBeTruthy();
  });

  it("marks a note whose quote is gone as Unanchored and keeps its quote, without highlighting a wrong place", async () => {
    const painted = new Map<string, unknown[]>();
    vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    vi.stubGlobal("CSS", { highlights: { set: (name: string, value: { ranges: Range[] }) => painted.set(name, value.ranges), delete: (name: string) => painted.delete(name) } });
    const { slot, note } = await open();
    await note({ kind: "comment", exact: "a sentence that was deleted", prefix: "", suffix: "", headingPath: "Release plan > Steps", body: "Old remark." });
    await note({ kind: "comment", exact: "first step", prefix: "Steps ", suffix: " second", headingPath: "Release plan > Steps", body: "Placed remark." });
    await ready(slot);
    await waitFor(() => expect(list(slot).getByText("Placed remark.")).toBeTruthy());
    const lost = await waitFor(() => list(slot).getByText("Old remark.").closest("li")!);
    expect(within(lost).getByText("Unanchored")).toBeTruthy();
    expect(within(lost).getByText("“a sentence that was deleted”")).toBeTruthy();
    expect(within(lost).queryByRole("button", { name: /Show N1/ })).toBeNull();
    const placed = list(slot).getByText("Placed remark.").closest("li")!;
    expect(within(placed).queryByText("Unanchored")).toBeNull();
    await waitFor(() => expect(painted.get("wb-plan-note")).toHaveLength(1));
    expect(painted.get("wb-plan-note")![0]!.toString()).toBe("first step");
  });

  it("scrolls to a note's passage and pulses its highlight when the note is clicked", async () => {
    const painted = new Map<string, Range[]>();
    vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
    vi.stubGlobal("CSS", { highlights: { set: (name: string, value: { ranges: Range[] }) => painted.set(name, value.ranges), delete: (name: string) => painted.delete(name) } });
    const { slot, note } = await open();
    await note({ kind: "comment", exact: "Nothing known.", prefix: "Risks", suffix: "", headingPath: "Release plan > Risks", body: "Be specific." });
    await ready(slot);
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    fireEvent.click(await slot.findByRole("button", { name: "Show N1 in the plan" }));
    expect(scroll.mock.contexts.at(-1)).toMatchObject({ tagName: "P", textContent: "Nothing known." });
    await waitFor(() => expect(painted.get("wb-plan-note-active")?.[0]?.toString()).toBe("Nothing known."));
    await waitFor(() => expect(painted.has("wb-plan-note-active")).toBe(false), { timeout: 4000 });
  });

  it("works without the Custom Highlight API", async () => {
    const { slot, note } = await open();
    await note({ kind: "comment", exact: "first step", prefix: "", suffix: "", headingPath: null, body: "Fine." });
    await ready(slot);
    fireEvent.click(await slot.findByRole("button", { name: "Show N1 in the plan" }));
    expect(list(slot).getByText("Fine.")).toBeTruthy();
  });

  it("edits and deletes draft notes only", async () => {
    const { slot, note, notes, call, refresh } = await open();
    await note({ kind: "general", body: "First." });
    await note({ kind: "general", body: "Second." });
    await slot.findByText("First.");
    fireEvent.click(list(slot).getByRole("button", { name: "Edit N1" }));
    fireEvent.change(slot.getByRole("textbox", { name: "Text of N1" }), { target: { value: "First, reworded." } });
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await slot.findByText("First, reworded.");
    fireEvent.click(list(slot).getByRole("button", { name: "Delete N2" }));
    await waitFor(() => expect(slot.queryByText("Second.")).toBeNull());
    expect((await notes()).map((entry) => entry.body)).toEqual(["First, reworded."]);
    await call("sendPlanFeedback", { author: OWNER });
    await refresh();
    await waitFor(() => expect(slot.queryByRole("button", { name: "Edit N1" })).toBeNull());
    expect(list(slot).getByText("Sent")).toBeTruthy();
  });
});

describe("the notes column", () => {
  it("opens on the drafts: the Notes tab and the expanded Notes section, with Contents one click away", async () => {
    const { slot, note } = await open();
    await note({ kind: "general", body: "One." });
    await note({ kind: "general", body: "Two." });
    await ready(slot);
    const tabs = within(slot.getByRole("tablist", { name: "Plan sidebar" }));
    await waitFor(() => expect(tabs.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Contents", "Notes (2)"]));
    expect(tabs.getByRole("tab", { name: "Notes (2)" }).getAttribute("aria-selected")).toBe("true");
    const section = slot.getByRole("region", { name: "Notes" });
    expect(section.className).not.toContain("@[56rem]:hidden");
    const toggle = within(section).getByRole("button", { name: "Notes (2)" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(section).getByRole("heading", { name: "Drafts to send (2)" })).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(tabs.getByRole("tab", { name: "Contents" }));
    expect(tabs.getByRole("tab", { name: "Contents" }).getAttribute("aria-selected")).toBe("true");
    const aside = slot.container.querySelector("aside")!;
    expect(slot.container.querySelector(".tiptap")!.compareDocumentPosition(aside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(aside.className).toContain("@[56rem]:order-last");
  });

  it("stays on Contents with the Notes section collapsed when no note is a draft", async () => {
    const { slot, note, call, refresh } = await open();
    await note({ kind: "general", body: "Sent already." });
    await call("sendPlanFeedback", { author: OWNER });
    await refresh();
    await ready(slot);
    const tabs = within(slot.getByRole("tablist", { name: "Plan sidebar" }));
    await waitFor(() => expect(tabs.getByRole("tab", { name: "Notes (1)" })).toBeTruthy());
    await waitFor(() => expect(tabs.getByRole("tab", { name: "Contents" }).getAttribute("aria-selected")).toBe("true"));
    expect(within(slot.getByRole("region", { name: "Notes" })).getByRole("button", { name: "Notes (1)" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("puts drafts under their own header above the sent and answered notes", async () => {
    const { slot, note, call } = await open();
    await note({ kind: "general", body: "Went out." });
    await call("sendPlanFeedback", { author: OWNER });
    await note({ kind: "general", body: "Still a draft." });
    const group = await slot.findByRole("group", { name: "Plan notes" });
    await within(group).findByText("Still a draft.");
    const headings = within(group).getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings).toEqual(["Drafts to send (1)", "Sent and answered"]);
    expect(within(within(group).getByRole("list", { name: "Drafts to send (1)" })).getByText("Still a draft.")).toBeTruthy();
    expect(within(within(group).getByRole("list", { name: "Sent and answered" })).getByText("Went out.")).toBeTruthy();
  });

  it("explains how to start when there are no notes, with the general note one click away", async () => {
    const { slot, notes } = await open();
    await ready(slot);
    const section = slot.getByRole("region", { name: "Notes" });
    expect(within(section).getByRole("button", { name: "Notes (0)" }).getAttribute("aria-expanded")).toBe("true");
    expect(section.textContent).toContain("Select text in the plan to comment on it, or add a general note");
    fireEvent.click(within(section).getByRole("button", { name: "add a general note" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "General note" }), { target: { value: "From the hint." } });
    fireEvent.click(slot.getByRole("button", { name: "Add note" }));
    await waitFor(() => expect(list(slot).getByText("From the hint.")).toBeTruthy());
    expect(await notes()).toMatchObject([{ kind: "general", body: "From the hint." }]);
  });

  it("shows notes read-only on an older version and in compare mode", async () => {
    const { slot, note, call } = await open([BODY, `${BODY}\nMore.\n`]);
    await note({ kind: "general", body: "Draft on current." });
    await call("sendPlanFeedback", { author: OWNER });
    await note({ kind: "general", body: "Later draft." });
    await slot.findByText("Draft on current.");
    expect(await list(slot).findByRole("button", { name: "Edit N2" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Compare with previous" }));
    await slot.findByRole("group", { name: "Plan changes" });
    expect(list(slot).getByText("Later draft.")).toBeTruthy();
    expect(list(slot).queryByRole("button", { name: "Edit N2" })).toBeNull();
    expect(slot.queryByRole("tablist", { name: "Plan sidebar" })).toBeNull();
  });
});
