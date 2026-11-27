import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { createUlid } from "../db/store";
import { verdictOf, type CheckVerdict } from "../shared/check-flow";
import { questionSchema, type TaskQuestion } from "../shared/contract";
import { isQuestionOpen } from "../shared/questions";
import { defaultTaskThreadId, deliverCommentToLatestAgent } from "../steer";
import { errorMessage } from "../shared/errors";

/** A held batch is sent this long after its newest held answer, when no other trigger came first. */
export const HELD_ANSWER_MINUTES = 15;
/** One warning is logged when a claim has failed this many times; it is never dropped for failing. */
export const WARN_AFTER_ATTEMPTS = 3;
/**
 * How long a claim that failed `attempts` times waits for its next attempt: 30 s, then doubling, at most 10 minutes. The wait
 * also keeps a burst of answers from retrying it back to back.
 */
export const retryDelaySeconds = (attempts: number) => Math.min(30 * 2 ** Math.max(attempts - 1, 0), 600);

const LAST_CHECK_HINT = "The owner confirmed the last open check. If this card's work goes to a PR, run the full review and the tests once now, then open it.";

/**
 * What one saved check answer owes the agent, fixed when it was saved. `answer` and `withdrawal-undelivered` rows are dropped when a
 * later write makes them stale before they are claimed; a `withdrawal-undo` row never is, or the agent could keep acting on the
 * answer it already received.
 */
interface Payload {
  kind: "answer" | "withdrawal-undo" | "withdrawal-undelivered";
  /** The Markdown block of this answer, in today's format, and its attachment lines. */
  block: string;
  attachments: string[];
  verdict: CheckVerdict;
  /** A confirmed first answer to a check that has `beyondDesign`: the batch may owe the "last open check" hint. */
  hintable: boolean;
  /** The answer a withdrawal took back. */
  previousAnswer: string;
  questionId: string;
  authorName: string;
}

interface Row { question_id: string; revision: number; task_id: string; thread_id: string; comment_id: string | null; payload: string }
interface Claim { claim_id: string; task_id: string; thread_id: string; body: string; task_key: string }

export interface AnswerToRecord {
  question: TaskQuestion;
  previous: TaskQuestion;
  commentId: string;
  authorName: string;
  /** The saved block (Question / Answer / ID lines) and the attachment lines, built from the saved state. */
  block: string;
  attachmentLines: string[];
}

export type Outbox = ReturnType<typeof checkOutbox>;

const draining = new WeakMap<BbPluginApi, Promise<void>>();
/** Comment ids whose caller waits for the delivery result; set by the drain once their claim was sent. */
const watched = new WeakMap<BbPluginApi, Map<string, number | undefined>>();

const answerOf = (state: Pick<TaskQuestion, "options" | "selectedOptionIds" | "answerText">) => [
  ...state.options.filter((option) => state.selectedOptionIds.includes(option.id)).map((option) => option.label),
  ...(state.answerText ? [state.answerText] : []),
].join("; ");

/** Models a restart in tests: the drain that was running when the process died is forgotten. */
export const forgetDrainForTests = (bb: BbPluginApi) => { draining.delete(bb); };

export function checkOutbox(bb: BbPluginApi, store: TasksApiStore) {
  const db = bb.storage.database();
  const listQuestions = (taskId: string): TaskQuestion[] =>
    db.prepare<[string], { payload: string }>("SELECT payload FROM task_questions WHERE task_id = ? ORDER BY id").all(taskId)
      .map((row) => questionSchema.parse(JSON.parse(row.payload)));
  const openCheck = (taskId: string) => listQuestions(taskId).some((question) => question.kind === "check" && isQuestionOpen(question));
  const successorOf = (questionId: string) => {
    const row = db.prepare<[string], { payload: string }>("SELECT payload FROM task_questions WHERE id = ?").get(questionId);
    return row ? (JSON.parse(row.payload) as { supersededBy?: string }).supersededBy : undefined;
  };

  /** In the writing transaction: with no open check left on the card, every held answer of it is due. */
  const release = (taskId: string) => {
    if (!openCheck(taskId)) db.prepare<[string]>("UPDATE check_answer_outbox SET state = 'due' WHERE task_id = ? AND state = 'held'").run(taskId);
  };
  /** In the writing transaction: unsent answers of a question the agent never saw; an undo withdrawal stays. */
  const dropUnsent = (questionId: string) =>
    db.prepare<[string]>("DELETE FROM check_answer_outbox WHERE question_id = ? AND state IN ('held','due') AND json_extract(payload, '$.kind') <> 'withdrawal-undo'").run(questionId);

  /**
   * In the answer's transaction, after the answer is saved. Returns `held` when the answer waits for a trigger, `due` when
   * it is to be sent now, `none` when no thread is known (nothing is written).
   */
  function record(input: AnswerToRecord): "held" | "due" | "none" {
    const { question, previous } = input;
    const threadId = question.askedByThread ?? defaultTaskThreadId(store.tasks, question.taskId, input.commentId);
    if (!threadId) return "none";
    const answer = answerOf(question);
    const withdrawal = !answer;
    const unsent = db.prepare<[string], { revision: number }>(
      "SELECT revision FROM check_answer_outbox WHERE question_id = ? AND state IN ('held','due') AND json_extract(payload, '$.kind') = 'answer'").all(question.id);
    dropUnsent(question.id);
    // An earlier answer to this question that is claimed or was sent still stands with the agent, so its withdrawal must say undo.
    const reached = db.prepare<[string], { found: number }>("SELECT 1 AS found FROM check_answer_outbox WHERE question_id = ? AND state = 'sending'").get(question.id) !== undefined ||
      db.prepare<[string, string], { found: number }>("SELECT 1 AS found FROM comments WHERE task_id = ? AND kind = 'system' AND notified_count > 0 AND body LIKE ?")
        .get(question.taskId, `%\nQuestion ID: ${question.id}; revision: %`) !== undefined;
    const kind: Payload["kind"] = !withdrawal ? "answer" : unsent.length && !reached ? "withdrawal-undelivered" : "withdrawal-undo";
    const verdict = withdrawal ? "withdrawn" : verdictOf(question);
    const payload: Payload = {
      kind, verdict, block: input.block, attachments: input.attachmentLines, questionId: question.id, authorName: input.authorName,
      previousAnswer: answerOf(previous),
      // Confirmed alone, as the first answer of a check that has `beyondDesign`.
      hintable: Boolean(question.kind === "check" && question.beyondDesign && verdict === "confirmed" && isQuestionOpen(previous)),
    };
    const hold = verdict === "confirmed" && openCheck(question.taskId);
    const now = new Date().toISOString();
    db.prepare<[string, number, string, string, string, string, string, string | null]>(
      "INSERT INTO check_answer_outbox (question_id, revision, task_id, thread_id, comment_id, state, payload, held_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(question.id, question.revision, question.taskId, threadId, input.commentId, hold ? "held" : "due", JSON.stringify(payload), hold ? now : null);
    if (!hold && verdict !== "confirmed") {
      // A reject, another answer or a withdrawal goes out at once, with this thread's held approvals.
      db.prepare<[string, string]>("UPDATE check_answer_outbox SET state = 'due' WHERE task_id = ? AND thread_id = ? AND state = 'held'").run(question.taskId, threadId);
    }
    release(question.taskId);
    return hold ? "held" : "due";
  }

  /** The held batches whose newest held answer is old enough are due. */
  const sweep = (now = new Date()) => {
    const cutoff = new Date(now.getTime() - HELD_ANSWER_MINUTES * 60_000).toISOString();
    db.transaction(() => db.prepare<[string]>(
      `UPDATE check_answer_outbox SET state = 'due' WHERE state = 'held' AND EXISTS (
         SELECT 1 FROM check_answer_outbox o WHERE o.task_id = check_answer_outbox.task_id AND o.thread_id = check_answer_outbox.thread_id
         GROUP BY o.task_id, o.thread_id HAVING max(CASE WHEN o.state = 'held' THEN o.held_at END) <= ?)`,
    ).run(cutoff))();
  };

  /** The message of one batch: a summary line, each answer in save order, one closing line and at most one hint. */
  function messageOf(key: string, taskId: string, payloads: Payload[]) {
    const count = (verdict: CheckVerdict) => payloads.filter((item) => item.verdict === verdict).length;
    const withdrawn = count("withdrawn"), total = payloads.length - withdrawn;
    const approved = count("confirmed"), rejected = count("problem"), other = total - approved - rejected;
    const summary = total
      ? `${key}: ${approved} of ${total} ${total === 1 ? "check" : "checks"} approved${rejected ? `, ${rejected} rejected` : ""}${other ? `, ${other} answered` : ""}${withdrawn ? `, ${withdrawn} withdrawn` : ""}.`
      : `${key}: ${withdrawn} ${withdrawn === 1 ? "answer" : "answers"} withdrawn.`;
    const blocks = payloads.map((item) => {
      const successor = successorOf(item.questionId);
      return [
        item.block,
        ...(item.kind === "withdrawal-undelivered" ? [`The owner withdrew the answer \`${item.previousAnswer}\` before it was delivered; nothing to undo.`] : []),
        ...(item.kind === "withdrawal-undo" ? [`The owner withdrew this answer. Do not act on the earlier answer, and undo or report anything you already did because of it (for example, move the task back if you changed its status).${successor ? ` This check is superseded by ${successor}: act on that question.` : ""} Before you act further, read this question's id, revision and \`supersededBy\` with \`bb work-board question list ${key}\`; when \`supersededBy\` is set, act on that successor instead.`] : []),
        ...item.attachments,
      ].join("\n\n");
    });
    const newest = payloads.at(-1)!;
    return [
      summary,
      ...blocks,
      ...(newest.hintable && !openCheck(taskId) ? [LAST_CHECK_HINT] : []),
      `Read the current saved decision with \`bb work-board question list ${key} --json\` before continuing.`,
    ].join("\n\n");
  }

  /**
   * One transaction: the oldest batch with a due row is marked `sending` with its full message stored. A thread with an open
   * claim that is not sent yet takes no new claim, so its answers reach it in the order they were claimed.
   */
  function claimNext(): Claim | undefined {
    return store.transaction(() => {
      const first = db.prepare<[], { task_id: string; thread_id: string }>(
        "SELECT task_id, thread_id FROM check_answer_outbox WHERE state = 'due' AND NOT EXISTS (SELECT 1 FROM check_answer_claims c WHERE c.thread_id = check_answer_outbox.thread_id) ORDER BY rowid LIMIT 1").get();
      if (!first) return undefined;
      const rows = db.prepare<[string, string], Row>(
        "SELECT * FROM check_answer_outbox WHERE task_id = ? AND thread_id = ? AND state IN ('held','due') ORDER BY rowid").all(first.task_id, first.thread_id);
      // The key is read here, with the rest of the message, and kept: a resend after a move or a restart is the same message.
      const taskKey = store.tasks.getTask(first.task_id)!.key;
      const claim: Claim = {
        claim_id: createUlid(), task_id: first.task_id, thread_id: first.thread_id, task_key: taskKey,
        body: messageOf(taskKey, first.task_id, rows.map((row) => JSON.parse(row.payload) as Payload)),
      };
      db.prepare<[string, string, string, string, string, string]>(
        "INSERT INTO check_answer_claims (claim_id, task_id, thread_id, body, task_key, claimed_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run(claim.claim_id, claim.task_id, claim.thread_id, claim.body, claim.task_key, new Date().toISOString());
      db.prepare<[string, string, string]>("UPDATE check_answer_outbox SET state = 'sending', claim_id = ? WHERE task_id = ? AND thread_id = ? AND state IN ('held','due')")
        .run(claim.claim_id, first.task_id, first.thread_id);
      return claim;
    });
  }
  const openClaim = (seen: Set<string>, now: Date): Claim | undefined => {
    return db.prepare<[], Claim & { attempts: number; attempted_at: string | null }>("SELECT claim_id, task_id, thread_id, body, task_key, attempts, attempted_at FROM check_answer_claims ORDER BY claimed_at, claim_id").all()
      .find((claim) => !seen.has(claim.claim_id) && (!claim.attempts || !claim.attempted_at ||
        Date.parse(claim.attempted_at) + retryDelaySeconds(claim.attempts) * 1000 <= now.getTime()));
  };

  /** Sends one claim's stored message. A failed delivery keeps the claim and its rows for a later drain, with a growing wait. */
  async function send(claim: Claim) {
    const rows = db.prepare<[string], Row>("SELECT * FROM check_answer_outbox WHERE claim_id = ? ORDER BY rowid").all(claim.claim_id);
    const last = rows.at(-1);
    const author = last ? (JSON.parse(last.payload) as Payload).authorName : "You";
    let sent = 0;
    try {
      sent = last?.comment_id ? await deliverCommentToLatestAgent(bb, store.tasks, {
        taskId: claim.task_id, commentId: last.comment_id, body: claim.body, authorName: author,
        threadId: claim.thread_id, mode: "queue-if-active", replyHint: false, taskKey: claim.task_key,
      }) : 0;
    } catch (error) {
      bb.log.warn(`held check answers failed to send: ${errorMessage(error)}`);
    }
    const waiting = watched.get(bb);
    // A waiting answer call reports the failure as it is now, whether or not a retry follows.
    if (!sent) for (const row of rows) if (row.comment_id && waiting?.has(row.comment_id)) waiting.set(row.comment_id, 0);
    if (!sent) {
      db.prepare<[string, string]>("UPDATE check_answer_claims SET attempts = attempts + 1, attempted_at = ? WHERE claim_id = ?").run(new Date().toISOString(), claim.claim_id);
      const { attempts } = db.prepare<[string], { attempts: number }>("SELECT attempts FROM check_answer_claims WHERE claim_id = ?").get(claim.claim_id)!;
      // Kept until it is delivered or the card is deleted; the sweep retries it, and its thread waits behind it.
      if (attempts === WARN_AFTER_ATTEMPTS) bb.log.warn(`check answers for ${claim.task_id} could not be delivered to ${claim.thread_id} after ${attempts} attempts; still retrying`);
      return false;
    }
    store.transaction(() => {
      for (const row of rows) if (row.comment_id) store.tasks.updateComment(row.comment_id, { notifiedCount: sent });
      db.prepare<[string]>("DELETE FROM check_answer_outbox WHERE claim_id = ?").run(claim.claim_id);
      db.prepare<[string]>("DELETE FROM check_answer_claims WHERE claim_id = ?").run(claim.claim_id);
    });
    if (sent) for (const row of rows) if (row.comment_id && waiting?.has(row.comment_id)) waiting.set(row.comment_id, sent);
    bb.realtime.publish("comments:changed", { taskId: claim.task_id });
    return true;
  }

  /** Interrupted claims first, then every batch with a due row. One drain per plugin instance, so nothing is sent twice at once. */
  function drain(now = new Date()): Promise<void> {
    const running = draining.get(bb);
    if (running) return running;
    // eslint-disable-next-line prefer-const -- the body's `finally` reads the promise it runs in
    let run: Promise<void> | undefined;
    run = (async () => {
      // Deferred, so the map holds `run` before the body can reach its end.
      await Promise.resolve();
      const seen = new Set<string>();
      try {
        for (;;) {
          // The empty claim and leaving the map are one synchronous step: a row committed after it starts a new drain.
          const claim = openClaim(seen, now) ?? claimNext();
          if (!claim) { draining.delete(bb); return; }
          seen.add(claim.claim_id);
          try { await send(claim); } catch (error) { bb.log.warn(`held check answers failed to send: ${errorMessage(error)}`); }
        }
      } finally {
        if (draining.get(bb) === run) draining.delete(bb);
      }
    })();
    draining.set(bb, run);
    return run;
  }
  const kick = () => { void drain().catch((error: unknown) => bb.log.warn(`held check answers failed: ${errorMessage(error)}`)); };

  /** Starts the safety timer and the recovery drain; the answer path calls `drain` itself. */
  function register() {
    const tick = () => { sweep(); return drain(); };
    bb.background.schedule("held-check-answers", "* * * * *", tick);
    void tick().catch((error: unknown) => bb.log.warn(`held check answers failed: ${errorMessage(error)}`));
  }

  /** Registered right after the answer's commit; the returned reader, called after `drain`, gives its delivery count, or undefined when it was dropped before sending. */
  function watch(commentId: string): () => number | undefined {
    const waiting = watched.get(bb) ?? new Map<string, number | undefined>();
    watched.set(bb, waiting);
    waiting.set(commentId, undefined);
    return () => {
      // An answer still queued behind a failed older claim is not delivered yet, which a caller reports as failed.
      const result = waiting.get(commentId) ?? (db.prepare<[string], { found: number }>("SELECT 1 AS found FROM check_answer_outbox WHERE comment_id = ?").get(commentId) ? 0 : undefined);
      waiting.delete(commentId);
      return result;
    };
  }

  return { record, release, dropUnsent, sweep, drain, kick, register, watch };
}
