import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createTasksStore } from "../db";
import { deliverCommentToLatestAgent, QUEUED_NOTICE_SEPARATOR } from ".";

function setup(
  getThread: (threadId: string) => ReturnType<typeof makeThreadResponse> = (
    threadId,
  ) => makeThreadResponse({ id: threadId, status: "active" }),
) {
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      threads: {
        get: async ({ threadId }) => getThread(threadId),
        send: async () => undefined,
      },
    },
  });
  const db = host.bb.storage.database();
  const store = createTasksStore(db);
  const project = store.createProject({
    name: "Plugin",
    prefix: "PLUG",
    color: "blue",
  });
  const task = store.createTask({ projectId: project.id, title: "Steer work" });
  return { ...host, db, store, task };
}

const input = {
  commentId: "01J00000000000000000000000",
  authorName: "Sawyer",
  body: "Please include the regression test.",
};

describe("comment notification delivery", () => {
  it("notifies only the latest replying agent despite newer unrelated task activity", async () => {
    const { bb, db, harness, store, task } = setup();
    const older = store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "First agent",
      threadId: "thr_first",
      body: "First reply",
    });
    const latest = store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Second agent",
      threadId: "thr_second",
      body: "Latest reply",
    });
    store.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_second",
      presetName: "Default",
      title: "Second agent",
      liveStatus: "working",
    });
    const unrelated = store.upsertTaskThread({
      taskId: task.id,
      threadId: "thr_first",
      presetName: "Default",
      title: "First agent",
      liveStatus: "working",
    });
    db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(
      "2026-07-16T10:00:00.000Z",
      older.id,
    );
    db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(
      "2026-07-16T11:00:00.000Z",
      latest.id,
    );
    db.prepare("UPDATE task_threads SET updated_at = ? WHERE id = ?").run(
      "2026-07-16T12:00:00.000Z",
      unrelated.id,
    );

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        {
          threadId: "thr_second",
          originPluginId: "work-board",
          input: [
            {
              type: "text",
              text:
                "**Work Board** · `New comment`\n" +
                "- Task: [PLUG-1](/plugins/work-board/work-board/task/PLUG-1)\n" +
                "- From: Sawyer\n\nPlease include the regression test.\n\n" +
                "Treat this as updated context for your work on this task. Reflect it in Current state (`bb work-board update PLUG-1 --progress ...`); comment only results or evidence, and ask the owner with `bb work-board question add PLUG-1` when you need a decision.",
              mentions: [],
            },
          ],
          mode: "steer-if-active",
        },
      ],
    ]);
  });

  it("uses resume-capable delivery for an idle latest responder", async () => {
    const { bb, harness, store, task } = setup((threadId) =>
      makeThreadResponse({ id: threadId, status: "idle" }),
    );
    store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Idle agent",
      threadId: "thr_idle",
      body: "Ready for more context",
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(1);
    expect(harness.sdk.callsTo("threads.send")).toEqual([
      [
        expect.objectContaining({
          threadId: "thr_idle",
          mode: "steer-if-active",
        }),
      ],
    ]);
  });

  it("does nothing when no agent has replied", async () => {
    const { bb, harness, store, task } = setup();

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.get")).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("does not fall back when the latest agent reply has no thread", async () => {
    const { bb, harness, store, task } = setup();
    store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Older linked agent",
      threadId: "thr_older",
      body: "Older reply",
    });
    store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Legacy agent",
      body: "Latest unlinked reply",
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.get")).toEqual([]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("preserves side-chat privacy and does not fall back", async () => {
    const { bb, harness, store, task } = setup((threadId) =>
      makeThreadResponse({
        id: threadId,
        status: "idle",
        originKind: "fork",
        originPluginId: "side-chat",
        visibility: "hidden",
      }),
    );
    store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Side chat",
      threadId: "thr_side_chat",
      body: "Private reply",
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.get")).toEqual([
      [{ threadId: "thr_side_chat" }],
    ]);
    expect(harness.sdk.callsTo("threads.send")).toEqual([]);
  });

  it("records delivery failure without trying another agent", async () => {
    const { bb, harness, store, task } = setup();
    store.createComment({
      taskId: task.id,
      kind: "agent",
      authorName: "Latest agent",
      threadId: "thr_latest",
      body: "Latest reply",
    });
    harness.sdk.stub("threads.send", async () => {
      throw Object.assign(new Error("thread awaiting interaction"), {
        status: 409,
      });
    });

    await expect(
      deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
    ).resolves.toBe(0);
    expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    expect(harness.logEntries).toContainEqual({
      level: "warn",
      message:
        "failed to deliver comment 01J00000000000000000000000 to thread thr_latest: thread awaiting interaction",
    });
  });

  describe("queued notice merging", () => {
    const row = (overrides: Record<string, unknown> = {}) => ({
      id: "q1",
      content: [{ type: "text", text: "Earlier notice", mentions: [] }],
      originPluginId: "work-board",
      state: "queued",
      editable: true,
      updatedAt: 42,
      ...overrides,
    });
    function withLatest() {
      const f = setup();
      f.store.createComment({
        taskId: f.task.id,
        kind: "agent",
        authorName: "Latest agent",
        threadId: "thr_latest",
        body: "Latest reply",
      });
      return f;
    }

    it("extends the last queued Work Board notice instead of sending another", async () => {
      const { bb, harness, store, task } = withLatest();
      harness.sdk.stub("threads.queuedMessages.list", async () => [row()] as never);
      harness.sdk.stub("threads.queuedMessages.update", async () => row() as never);

      await expect(
        deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
      ).resolves.toBe(1);
      expect(harness.sdk.callsTo("threads.send")).toEqual([]);
      const [update] = harness.sdk.callsTo("threads.queuedMessages.update") as [
        { input: { text: string }[]; expectedUpdatedAt: number; queuedMessageId: string },
      ][];
      expect(update[0]).toMatchObject({
        threadId: "thr_latest",
        queuedMessageId: "q1",
        expectedUpdatedAt: 42,
      });
      expect(update[0].input[0].text).toMatch(
        new RegExp(`^Earlier notice${QUEUED_NOTICE_SEPARATOR}\\*\\*Work Board\\*\\*`),
      );
      expect(update[0].input[0].text).toContain(input.body);
    });

    it.each([
      ["someone else's message is last", { originPluginId: null }],
      ["the row is already being sent", { state: "claimed" }],
      ["the row is held for editing", { editable: false }],
    ])("sends a new message when %s", async (_label, overrides) => {
      const { bb, harness, store, task } = withLatest();
      harness.sdk.stub("threads.queuedMessages.list", async () => [row(overrides)] as never);

      await deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input });
      expect(harness.sdk.callsTo("threads.queuedMessages.update")).toEqual([]);
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    });

    it("sends a new message when the queued row changed before the update", async () => {
      const { bb, harness, store, task } = withLatest();
      harness.sdk.stub("threads.queuedMessages.list", async () => [row()] as never);
      harness.sdk.stub("threads.queuedMessages.update", async () => {
        throw Object.assign(new Error("stale"), { status: 409 });
      });

      await expect(
        deliverCommentToLatestAgent(bb, store, { taskId: task.id, ...input }),
      ).resolves.toBe(1);
      expect(harness.sdk.callsTo("threads.send")).toHaveLength(1);
    });
  });
});
