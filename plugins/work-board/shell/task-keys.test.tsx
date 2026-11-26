// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { Editor } from "@tiptap/core";
import type { ResolvedTaskKey } from "../shared/task-keys";
import { taskHref } from "../shared/task-link";

vi.unmock("./task-keys");
const app = await loadPluginApp(() => import("../app"));
const { LinkedText } = await import("../components/linked-text");
const { TasksEditor } = await import("../editor/tasks-editor");
const { resetTaskKeysForTest } = await import("./task-keys");
afterEach(cleanup);
afterEach(resetTaskKeysForTest);

const card = (key: string, extra: Partial<ResolvedTaskKey> = {}): ResolvedTaskKey =>
  ({ key, currentKey: key, title: `Title of ${key}`, status: "todo", statusName: "Todo", archived: false, ...extra });

type Answer = (keys: string[]) => ResolvedTaskKey[] | Promise<ResolvedTaskKey[]>;
function mount(ui: React.ReactNode, answer: Answer) {
  const calls: string[][] = [];
  const resolveTaskKeys = vi.fn(async ({ keys }: { keys: string[] }) => {
    calls.push(keys);
    return { tasks: await answer(keys) };
  });
  const slot = renderSlot({ ...app.navPanels[0]!, component: () => <>{ui}</> }, { subPath: "" }, { rpc: { resolveTaskKeys } as never });
  return { slot, calls, resolveTaskKeys };
}
const known = (...keys: string[]): Answer => (asked) => asked.filter((key) => keys.includes(key)).map((key) => card(key));
const anchors = (root: HTMLElement) => [...root.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);

describe("LinkedText", () => {
  it("links a known key in place and leaves an unknown key, code, a link label and a URL alone", async () => {
    const text = "EXA-1 and OTH-9, `EXA-1`, [EXA-1](/docs), https://example.com/EXA-1/x";
    const { slot } = mount(<LinkedText text={text} />, known("EXA-1"));
    await waitFor(() => expect(anchors(slot.container)[0]).toEqual(["EXA-1", taskHref("EXA-1")]));
    expect(anchors(slot.container)).toEqual([
      ["EXA-1", taskHref("EXA-1")], ["EXA-1", "/docs"], ["https://example.com/EXA-1/x", "https://example.com/EXA-1/x"],
    ]);
    expect(slot.container.querySelector("code")?.textContent).toBe("EXA-1");
    expect(slot.container.textContent).toContain("EXA-1 and OTH-9, ");
    expect(slot.container.querySelector("a")?.getAttribute("title")).toBe("EXA-1 · Title of EXA-1 · Todo");
  });

  it("points an old key at the card's current key", async () => {
    const { slot } = mount(<LinkedText text="see OLD-3" />, (keys) => keys.map((key) => card(key, { currentKey: "EXA-7" })));
    await waitFor(() => expect(anchors(slot.container)).toEqual([["OLD-3", taskHref("EXA-7")]]));
    expect(slot.container.textContent).toBe("see OLD-3");
  });
});

describe("batching", () => {
  it("sends one call for three texts and two editors that mention five keys", async () => {
    const ui = <>
      <LinkedText text="EXA-1 EXA-2" /><LinkedText text="EXA-2 EXA-3" /><LinkedText text="EXA-1" />
      <TasksEditor value="EXA-4 text" onChange={() => {}} readOnly /><TasksEditor value="EXA-5 EXA-1" onChange={() => {}} readOnly />
    </>;
    const { slot, calls } = mount(ui, known("EXA-1", "EXA-4"));
    await waitFor(() => expect(slot.container.querySelectorAll("a[data-task-key]").length).toBe(2));
    expect(calls).toHaveLength(1);
    expect([...calls[0]!].sort()).toEqual(["EXA-1", "EXA-2", "EXA-3", "EXA-4", "EXA-5"]);
  });

  it("splits 1,201 distinct keys into calls of 500, 500 and 201 and ends every key found or missing", async () => {
    const keys = Array.from({ length: 1201 }, (_, index) => `EXA-${index + 1}`);
    const { slot, calls } = mount(<LinkedText text={keys.join(" ")} />, (asked) => asked.filter((_, index) => index % 2 === 0).map((key) => card(key)));
    await waitFor(() => expect(slot.container.querySelectorAll("a").length).toBe(601));
    expect(calls.map((call) => call.length).sort((a, b) => b - a)).toEqual([500, 500, 201]);
  });
});

describe("invalidation", () => {
  it("drops an older answer that arrives after a change, then links the key the new answer knows", async () => {
    let created = false;
    const releases: Array<() => void> = [];
    const { slot, calls } = mount(<LinkedText text="EXA-5" />, (keys) => {
      const answer = created ? keys.map((key) => card(key)) : [];
      if (created) return answer;
      return new Promise<ResolvedTaskKey[]>((resolve) => releases.push(() => resolve(answer)));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    created = true;
    await slot.emitRealtime("tasks:changed", { taskId: "t" });
    releases[0]!(); // the older "missing" answer arrives late
    await waitFor(() => expect(anchors(slot.container)).toEqual([["EXA-5", taskHref("EXA-5")]]));
    expect(calls).toHaveLength(2);
  });

  it("turns a link plain in every mounted consumer when its card is deleted, without a remount", async () => {
    let exists = true;
    const { slot } = mount(<><LinkedText text="EXA-1" /><TasksEditor value="EXA-1" onChange={() => {}} readOnly /></>, (keys) => exists ? keys.map((key) => card(key)) : []);
    await waitFor(() => expect(slot.container.querySelectorAll("a").length).toBe(2));
    exists = false;
    await slot.emitRealtime("tasks:changed", { taskId: "t" });
    await waitFor(() => expect(slot.container.querySelectorAll("a").length).toBe(0));
    expect(slot.container.textContent).toContain("EXA-1");
  });

  it("keeps a link while the refreshed answer is pending", async () => {
    let release!: () => void;
    let second = false;
    const { slot, calls } = mount(<LinkedText text="EXA-1" />, (keys) => {
      if (!second) { second = true; return keys.map((key) => card(key)); }
      return new Promise<ResolvedTaskKey[]>((resolve) => { release = () => resolve(keys.map((key) => card(key))); });
    });
    await waitFor(() => expect(slot.container.querySelectorAll("a").length).toBe(1));
    await slot.emitRealtime("projects:changed", { projectId: null });
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(slot.container.querySelectorAll("a").length).toBe(1);
    release();
  });

  it("leaves keys plain after a failed call, and the next invalidation resolves them", async () => {
    let fail = true;
    const { slot, calls } = mount(<LinkedText text="EXA-1" />, (keys) => {
      if (fail) throw new Error("offline");
      return keys.map((key) => card(key));
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(slot.container.querySelectorAll("a").length).toBe(0);
    expect(calls).toHaveLength(1);
    fail = false;
    await slot.emitRealtime("tasks:changed", { taskId: "t" });
    await waitFor(() => expect(slot.container.querySelectorAll("a").length).toBe(1));
  });
});

describe("TasksEditor", () => {
  const doc = "Known EXA-1, unknown OTH-9, code `EXA-1`, [EXA-1](https://example.com), and a block:\n\n```\nEXA-1\n```\n";

  it("decorates only the known key in plain text and leaves the Markdown as stored", async () => {
    let editor: Editor | undefined;
    const { slot } = mount(<TasksEditor value={doc} onChange={() => {}} readOnly onEditorReady={(e) => { editor = e; }} />, known("EXA-1"));
    await waitFor(() => expect(slot.container.querySelectorAll("a[data-task-key]").length).toBe(1));
    const link = slot.container.querySelector("a[data-task-key]")!;
    expect([link.textContent, link.getAttribute("href"), link.getAttribute("title")]).toEqual(["EXA-1", taskHref("EXA-1"), "EXA-1 · Title of EXA-1 · Todo"]);
    expect(slot.container.querySelectorAll("a").length).toBe(2); // the decorated key and the real Markdown link
    expect(editor!.storage.markdown.getMarkdown()).toBe(doc.trimEnd());
  });

  it("opens the card through Work Board navigation on a plain click, not on a modified one", async () => {
    const go = vi.fn();
    let editor: Editor | undefined;
    const { slot } = mount(
      <TasksEditor value="EXA-1" onChange={() => {}} onOpenTask={(taskKey) => go({ kind: "task", taskKey })} onEditorReady={(e) => { editor = e; }} />,
      (keys) => keys.map((key) => card(key, { currentKey: "EXA-7" })),
    );
    await waitFor(() => expect(slot.container.querySelector("a[data-task-key]")).toBeTruthy());
    const link = slot.container.querySelector("a[data-task-key]")!;
    expect(link.getAttribute("data-task-key")).toBe("EXA-7");
    const click = (init: MouseEventInit = {}) => {
      const event = new MouseEvent("click", { button: 0, cancelable: true, ...init });
      Object.defineProperty(event, "target", { value: link });
      return editor!.view.someProp("handleClick", (handle) => handle(editor!.view, 1, event));
    };
    expect(click({ metaKey: true })).toBeFalsy();
    expect(click({ shiftKey: true })).toBeFalsy();
    expect(go).not.toHaveBeenCalled();
    expect(click()).toBe(true);
    expect(go).toHaveBeenCalledWith({ kind: "task", taskKey: "EXA-7" });
  });
});
