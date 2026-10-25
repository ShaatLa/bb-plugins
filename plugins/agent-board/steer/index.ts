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
    `New comment on task ${taskKey} from ${authorName}: ${body}\n\n` +
    "Treat this as updated context for your work on this task; " +
    `reply via bb agent-board comment ${taskKey} when relevant.`
  );
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
  const ownerRequester = task.executionTarget === "owner" && input.threadId;
  const canUsePreferred =
    ownerRequester ||
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
      await bb.sdk.threads.send({
        threadId,
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
