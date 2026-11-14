import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { reconcileTaskThreads } from "../lifecycle/thread-links";
import { errorMessage } from "../shared/errors";
import { isSideChatShapedThread } from "../shared/side-chat";

interface DeliverCommentInput {
  taskId: string;
  commentId: string;
  body: string;
  authorName: string;
  threadId?: string;
  mode?: "steer-if-active" | "queue-if-active";
}

function steerPrompt(
  taskKey: string,
  authorName: string,
  body: string,
): string {
  return (
    "**Work Board** · `New comment`\n" +
    `- Task: [${taskKey}](/plugins/work-board/work-board/task/${taskKey})\n` +
    `- From: ${authorName}\n\n${body}\n\n` +
    "Treat this as updated context for your work on this task; " +
    `reply via \`bb work-board comment ${taskKey}\` when relevant.`
  );
}

export const QUEUED_NOTICE_SEPARATOR = "\n\n---\n\n";

// Extend our own notice when it is still the last queued row, so a busy thread
// gets one message instead of a stack of them. Any doubt falls back to send.
async function appendToQueuedNotice(
  bb: BbPluginApi,
  threadId: string,
  text: string,
): Promise<boolean> {
  try {
    const last = (await bb.sdk.threads.queuedMessages.list({ threadId })).at(-1);
    const part = last?.content.length === 1 ? last.content[0] : undefined;
    if (
      !last ||
      !part ||
      part.type !== "text" ||
      last.originPluginId !== bb.pluginId ||
      last.state !== "queued" ||
      !last.editable
    )
      return false;
    await bb.sdk.threads.queuedMessages.update({
      threadId,
      queuedMessageId: last.id,
      expectedUpdatedAt: last.updatedAt,
      input: [{ ...part, text: part.text + QUEUED_NOTICE_SEPARATOR + text }],
    });
    return true;
  } catch {
    return false;
  }
}

export async function deliverCommentToLatestAgent(
  bb: BbPluginApi,
  store: TasksStore,
  input: DeliverCommentInput,
): Promise<number> {
  const task = store.getTask(input.taskId);
  if (!task) throw new Error(`Task not found: ${input.taskId}`);

  const previous = store.listTaskThreads(input.taskId);
  const links = await reconcileTaskThreads(bb, store, input.taskId);
  const preferred =
    input.threadId ??
    store.getLatestAgentComment(input.taskId, input.commentId)?.threadId;
  const detached = store
    .listComments(input.taskId)
    .filter(
      (comment) =>
        comment.kind === "system" && comment.body.startsWith("Thread detached"),
    );
  const canUsePreferred =
    input.threadId ||
    (!detached.some((comment) => comment.threadId === preferred) &&
      (links.length > 0 || (previous.length === 0 && detached.length === 0)));
  const candidates = [
    ...new Set([
      ...(preferred && canUsePreferred ? [preferred] : []),
      ...links.map((link) => link.threadId),
    ]),
  ];
  const prompt = steerPrompt(task.key, input.authorName, input.body);
  for (const threadId of candidates) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (
        isSideChatShapedThread(thread) ||
        thread.archivedAt != null ||
        thread.deletedAt != null ||
        thread.status === "stopping"
      )
        continue;
      if (await appendToQueuedNotice(bb, threadId, prompt)) return 1;
      await bb.sdk.threads.send({
        threadId,
        originPluginId: bb.pluginId,
        input: [{ type: "text", text: prompt, mentions: [] }],
        mode: input.mode ?? "steer-if-active",
      });
      return 1;
    } catch (error) {
      bb.log.warn(
        `failed to deliver comment ${input.commentId} to thread ${threadId}: ${errorMessage(error)}`,
      );
      return 0;
    }
  }
  return 0;
}
