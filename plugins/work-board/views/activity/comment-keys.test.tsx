// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DisplayComment } from "../../shared/contract.js";
import type { ResolvedTaskKey } from "../../shared/task-keys.js";
import { CommentCard } from "./task-activity.js";

const cards = vi.hoisted(() => new Map<string, unknown>());
vi.mock("../../shell/task-keys.js", () => ({ useTaskKeys: () => (key: string) => cards.get(key) }));
vi.mock("../../shell/data.js", () => ({ useMentionItems: () => [], useTasksQuery: () => ({ data: [] }), useTasksRpc: () => ({ call: vi.fn() }) }));
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  useBbNavigate: () => ({ toThread: vi.fn(), toPluginPanel: vi.fn(), openUrl: () => false }),
  useSdk: () => ({}),
  useSettings: () => ({ values: undefined, isLoading: false }),
  Markdown: ({ content }: { content: string }) => <div data-testid="markdown">{content}</div>,
}));
afterEach(() => { cleanup(); cards.clear(); });

const card = (key: string, currentKey = key): ResolvedTaskKey => ({ key, currentKey, title: "Linked card", status: "todo", statusName: "Todo", archived: false });
const entry = (body: string) => ({
  comment: {
    id: "01HZZZZZZZZZZZZZZZZZZZZZU1", taskId: "01HZZZZZZZZZZZZZZZZZZZZZT1", kind: "user", authorName: "You", presetName: null, threadId: null,
    threadTitle: null, body, notifiedCount: 0, createdAt: "2026-07-15T00:00:00.000Z", provider: null,
  } satisfies DisplayComment,
  attachments: [],
});
const show = (body: string) => render(<CommentCard entry={entry(body)} nowMs={Date.parse("2026-07-15T00:01:00.000Z")} />);

const markdown = () => screen.getByTestId("markdown").textContent;

it("keeps the host Markdown for a plain comment and links its existing key to the card's current key", () => {
  cards.set("OLD-3", card("OLD-3", "EXA-7"));
  show("Blocked by OLD-3 for now");
  expect(markdown()).toBe("Blocked by [OLD-3](/plugins/work-board/work-board/task/EXA-7) for now");
});

it("keeps the native thread mention and links the key in one comment", () => {
  cards.set("EXA-1", card("EXA-1"));
  show("See EXA-1 and /projects/proj_example/threads/thr_example");
  expect(markdown()).toBe("See [EXA-1](/plugins/work-board/work-board/task/EXA-1) and @thread:thr_example");
});

it("leaves a key in inline code and an unknown key as written", () => {
  cards.set("EXA-1", card("EXA-1"));
  show("Run `EXA-1` after ISO-9001");
  expect(markdown()).toBe("Run `EXA-1` after ISO-9001");
});

it("sends a comment with task mentions through the editor", async () => {
  const view = show("Look at [EXA-5](bbtask://01HZZZZZZZZZZZZZZZZZZZZZT5)");
  await waitFor(() => expect(view.container.querySelector(".tiptap")).toBeTruthy());
  expect(screen.queryByTestId("markdown")).toBeNull();
});
