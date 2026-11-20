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
  /** Question answers carry their own next step, so they skip the reply hint. */
  replyHint?: boolean;
}

function steerPrompt(
  taskKey: string,
  authorName: string,
  body: string,
  replyHint = true,
): string {
  return (
    "`New comment`\n" +
    `- Task: [${taskKey}](/plugins/work-board/work-board/task/${taskKey})\n` +
    `- From: ${authorName}\n\n${body}` +
    (replyHint
      ? "\n\nTreat this as updated context for your work on this task. Reflect it in Current state " +
        `(\`bb work-board update ${taskKey} --progress ...\`); comment only results or evidence, and ask the owner ` +
        `on the task, not in chat, with \`bb work-board question add ${taskKey}\` when you need a decision.`
      : "")
  );
}

/**
 * The thread a message about a task goes to when nothing names one: the first linked session, else the thread of the
 * latest agent comment (other than `excludeCommentId`). Question answers and plan reviews use the same rule.
 */
export function defaultTaskThreadId(store: TasksStore, taskId: string, excludeCommentId = ""): string | undefined {
  return store.listTaskThreads(taskId)[0]?.threadId ?? store.getLatestAgentComment(taskId, excludeCommentId)?.threadId;
}

export const QUEUED_NOTICE_SEPARATOR = "\n\n---\n\n";

/** bb's origin line, so the receiving agent reads a Work Board message as the plugin's, not the owner's words. */
export const withPluginHeader = (pluginId: string, text: string) => `[bb message from plugin:${pluginId}]\n\n${text}`;

// Extend our own notice when it is still the last queued row, so a busy thread
// gets one message instead of a stack of them; that message already starts with the header. Any doubt falls back to send.
async function appendToQueuedNotice(
  bb: BbPluginApi,
  threadId: string,
  text: string,
): Promise<boolean> {
  // A conflict means the row changed under us, so list once more before giving up.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const last = (await bb.sdk.threads.queuedMessages.list({ threadId })).at(-1);
      const part = last?.content.length === 1 ? last.content[0] : undefined;
      if (
        !last ||
        !part ||
        part.type !== "text" ||
        last.originPluginId !== bb.pluginId ||
        // bb marks a row held for a busy thread `waiting`; both states are still unsent.
        (last.state !== "queued" && last.state !== "waiting") ||
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
      // Retry once, then fall back to a normal send.
    }
  }
  return false;
}

// Concurrent deliveries to one thread would both see the same last row, so each thread's append-or-send runs in turn.
const threadChains = new Map<string, Promise<unknown>>();
function serialPerThread<T>(threadId: string, job: () => Promise<T>): Promise<T> {
  const run = (threadChains.get(threadId) ?? Promise.resolve()).then(job);
  const tail = run.then(() => undefined, () => undefined);
  threadChains.set(threadId, tail);
  void tail.then(() => {
    if (threadChains.get(threadId) === tail) threadChains.delete(threadId);
  });
  return run;
}

/** Merge into the thread's queued notice, else send a new message; throws when the send fails. */
function appendOrSend(
  bb: BbPluginApi,
  threadId: string,
  text: string,
  mode: "steer-if-active" | "queue-if-active",
): Promise<void> {
  return serialPerThread(threadId, async () => {
    if (await appendToQueuedNotice(bb, threadId, text)) return;
    await bb.sdk.threads.send({
      threadId,
      originPluginId: bb.pluginId,
      input: [{ type: "text", text: withPluginHeader(bb.pluginId, text), mentions: [] }],
      mode,
    });
  });
}

/** Wake one known thread, merged into its queued Work Board notice when there is one. Throws on failure. */
export function notifyThread(
  bb: BbPluginApi,
  threadId: string,
  text: string,
): Promise<void> {
  return appendOrSend(bb, threadId, text, "queue-if-active");
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
  const prompt = steerPrompt(task.key, input.authorName, input.body, input.replyHint);
  for (const threadId of candidates) {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (isSideChatShapedThread(thread)) continue;
      if (thread.archivedAt != null || thread.deletedAt != null) {
        // An archived asker's work moved up to its parent, so the message follows it there.
        if (thread.parentThreadId && !candidates.includes(thread.parentThreadId)) candidates.push(thread.parentThreadId);
        continue;
      }
      if (thread.status === "stopping") continue;
      await appendOrSend(bb, threadId, prompt, input.mode ?? "steer-if-active");
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
