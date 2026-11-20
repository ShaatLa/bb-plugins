import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { createUlid } from "../db/store";
import type { CreatePlanNoteInput, PlanAuthor, PlanNote, PlanNoteCounts, TaskPlanHead } from "../shared/contract";
import type { PlanNoteKind, PlanNoteState } from "../shared/plan-notes";
import { noteLabel, PLAN_NOTE_BODY_MAX, PLAN_NOTE_QUOTE_MAX } from "../shared/plan-notes";
import { buildAnchor, fold, markdownPlainText, resolveAnchor } from "../shared/plan-anchor";
import { findSection, getSection } from "../shared/plan";
import { assertNoSecrets } from "../shared/secret-guard.js";
import { assertPlanning, closePendingReview, PlanError } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

interface NoteRow {
  id: string;
  task_id: string;
  number: number;
  kind: PlanNoteKind;
  exact: string | null;
  prefix: string | null;
  suffix: string | null;
  heading_path: string | null;
  made_on_version: number;
  body: string;
  state: PlanNoteState;
  sent_in_version: number | null;
  sent_at: string | null;
  reply: string | null;
  reply_by: string | null;
  replied_at: string | null;
  addressed_in_version: number | null;
  author_name: string;
  author_kind: "person" | "thread";
  author_thread: string | null;
  created_at: string;
  updated_at: string;
}
interface PlanRow {
  version: number;
  body: string;
  state: string;
  reviewer_kind: "owner" | "thread" | null;
  reviewer_thread: string | null;
  review_version: number | null;
}

/** A note as it is stored in an export: the task is the record that holds it. */
export type CapturedPlanNote = Omit<PlanNote, "taskId">;

const noteOf = (row: NoteRow): PlanNote => ({
  id: row.id,
  taskId: row.task_id,
  number: row.number,
  kind: row.kind,
  exact: row.exact,
  prefix: row.prefix,
  suffix: row.suffix,
  headingPath: row.heading_path,
  madeOnVersion: row.made_on_version,
  body: row.body,
  state: row.state,
  sentInVersion: row.sent_in_version,
  sentAt: row.sent_at,
  reply: row.reply,
  replyBy: row.reply_by,
  repliedAt: row.replied_at,
  addressedInVersion: row.addressed_in_version,
  authorName: row.author_name,
  authorKind: row.author_kind,
  authorThread: row.author_thread,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const capturedOf = ({ taskId: _taskId, ...note }: PlanNote): CapturedPlanNote => note;

const COMMENT_NOTE_CAP = 300;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The notes on task plans: draft → sent → addressed → resolved, and the two review decisions. The owner writes notes
 * through the app; a reviewer thread writes them through the CLI-only functions below, which check who is calling.
 */
export function createPlanNoteStore(db: Database, tasks: TasksStore, head: (taskId: string) => TaskPlanHead | null) {
  function requireEditable(taskId: string) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    assertPlanning(tasks, task);
    if (task.archivedAt) throw new PlanError("plan_archived", `${task.key} is archived; restore the task before changing its plan`);
    return task;
  }
  const planRow = (taskId: string) => db.prepare<[string], PlanRow>("SELECT version, body, state, reviewer_kind, reviewer_thread, review_version FROM task_plans WHERE task_id = ?").get(taskId);
  function requirePlan(taskId: string) {
    const task = requireEditable(taskId);
    const row = planRow(taskId);
    if (!row) throw new PlanError("plan_invalid", `${task.key} has no plan, so there is nothing to review`);
    return { task, plan: row };
  }
  const noteRow = (noteId: string) => db.prepare<[string], NoteRow>("SELECT * FROM task_plan_notes WHERE id = ?").get(noteId);
  function requireNote(noteId: string) {
    const row = noteRow(noteId);
    if (!row) throw new PlanError("plan_invalid", `Note not found: ${noteId}`);
    requireEditable(row.task_id);
    return row;
  }
  const fresh = (noteId: string) => noteOf(noteRow(noteId)!);
  /** Drafts are scoped per author: the owner's feedback sends the owner's drafts, a reviewer's sends the reviewer threads'. */
  const draftRows = (taskId: string, author: "person" | "thread") =>
    db.prepare<[string, string], NoteRow>("SELECT * FROM task_plan_notes WHERE task_id = ? AND state = 'draft' AND author_kind = ? ORDER BY number").all(taskId, author);

  /** Every note of a task without the planning check, for export and import. */
  const capturedNotes = (taskId: string): PlanNote[] => db.prepare<[string], NoteRow>("SELECT * FROM task_plan_notes WHERE task_id = ? ORDER BY number").all(taskId).map(noteOf);

  function list(taskId: string): PlanNote[] {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    assertPlanning(tasks, task);
    return capturedNotes(taskId);
  }

  function counts(taskId: string): PlanNoteCounts {
    const result: PlanNoteCounts = { draft: 0, open: 0, addressed: 0, resolved: 0 };
    for (const row of db.prepare<[string], { state: PlanNoteState; count: number }>("SELECT state, COUNT(*) AS count FROM task_plan_notes WHERE task_id = ? AND NOT (state = 'draft' AND author_kind = 'thread') GROUP BY state").all(taskId))
      result[row.state === "sent" ? "open" : row.state] = row.count;
    return result;
  }

  /** Notes that block a reviewer's approval: drafts and unresolved notes of reviewer threads, inherited ones included. */
  const blockingCount = (taskId: string): number =>
    db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM task_plan_notes WHERE task_id = ? AND author_kind = 'thread' AND state != 'resolved'").get(taskId)!.count;

  function guardText(body: string, kind: PlanNoteKind) {
    if (kind !== "remove" && body.trim() === "") throw new PlanError("plan_invalid", "A note needs text");
    assertNoSecrets(body, "plan note");
  }

  const create = db.transaction((input: CreatePlanNoteInput & { body: string; authorName: string; authorThread?: string }): PlanNote => {
    const { task, plan } = requirePlan(input.taskId);
    const quote = input.exact ?? null;
    if (input.kind === "general") {
      if (quote !== null || input.prefix || input.suffix || input.headingPath) throw new PlanError("plan_invalid", "A general note is not tied to a passage");
    } else if (quote === null || quote.trim() === "") throw new PlanError("plan_invalid", "A note on a passage needs the selected text");
    guardText(input.body, input.kind);
    assertNoSecrets(quote ?? undefined, "plan note quote");
    const version = input.madeOnVersion ?? plan.version;
    if (version > plan.version) throw new PlanError("plan_invalid", `${task.key} plan is at v${plan.version}, not v${version}`);
    const number = (db.prepare<[string], { next: number }>("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM task_plan_notes WHERE task_id = ?").get(input.taskId)!).next;
    const id = createUlid();
    const now = new Date().toISOString();
    const general = input.kind === "general";
    db.prepare(
      `INSERT INTO task_plan_notes (id, task_id, number, kind, exact, prefix, suffix, heading_path, made_on_version, body, state, author_name, author_kind, author_thread, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
    ).run(id, input.taskId, number, input.kind, general ? null : quote, general ? null : (input.prefix ?? ""), general ? null : (input.suffix ?? ""), general ? null : (input.headingPath ?? null), version, input.body.trim(), input.authorName, input.authorThread ? "thread" : "person", input.authorThread ?? null, now, now);
    return fresh(id);
  });

  const update = db.transaction((noteId: string, body: string): PlanNote => {
    const row = requireNote(noteId);
    if (row.state !== "draft") throw new PlanError("plan_state", `${noteLabel(row.number)} was already sent to the agent and can no longer be edited`);
    guardText(body, row.kind);
    db.prepare("UPDATE task_plan_notes SET body = ?, updated_at = ? WHERE id = ?").run(body.trim(), new Date().toISOString(), noteId);
    return fresh(noteId);
  });

  const remove = db.transaction((noteId: string): string => {
    const row = requireNote(noteId);
    if (row.state !== "draft") throw new PlanError("plan_state", `${noteLabel(row.number)} was already sent to the agent and can no longer be deleted`);
    db.prepare("DELETE FROM task_plan_notes WHERE id = ?").run(noteId);
    return row.task_id;
  });

  /** The owner resolves an answered note, or reopens one so that it goes out again with the next feedback. */
  const setState = db.transaction((noteId: string, state: "resolved" | "draft"): PlanNote => {
    const row = requireNote(noteId);
    const label = noteLabel(row.number);
    if (row.state === state) return noteOf(row);
    const now = new Date().toISOString();
    if (state === "resolved") {
      if (row.state === "draft") throw new PlanError("plan_state", `${label} is a draft; send it, or delete it`);
      db.prepare("UPDATE task_plan_notes SET state = 'resolved', updated_at = ? WHERE id = ?").run(now, noteId);
    } else {
      if (row.state === "sent") throw new PlanError("plan_state", `${label} is waiting for the agent's answer`);
      db.prepare("UPDATE task_plan_notes SET state = 'draft', sent_in_version = NULL, sent_at = NULL, addressed_in_version = NULL, updated_at = ? WHERE id = ?").run(now, noteId);
    }
    return fresh(noteId);
  });

  /** The agent answers a sent note; `addressed` records that the current plan version answers it. */
  const reply = db.transaction((input: { taskId: string; number: number; body: string; addressed: boolean; author: PlanAuthor }): PlanNote => {
    const { task, plan } = requirePlan(input.taskId);
    const row = db.prepare<[string, number], NoteRow>("SELECT * FROM task_plan_notes WHERE task_id = ? AND number = ?").get(input.taskId, input.number);
    const label = noteLabel(input.number);
    if (!row) {
      const known = list(input.taskId).filter((note) => note.state !== "draft").map((note) => noteLabel(note.number));
      throw new PlanError("plan_invalid", `${task.key} has no note ${label}${known.length ? `; sent notes: ${known.join(", ")}` : ""}`);
    }
    if (row.state === "draft") throw new PlanError("plan_state", `${label} has not been sent to you yet`);
    if (row.state === "resolved") throw new PlanError("plan_state", `${label} was resolved by the owner`);
    if (input.body.trim() === "") throw new PlanError("plan_invalid", "A reply needs text");
    assertNoSecrets(input.body, "plan note reply");
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE task_plan_notes SET reply = ?, reply_by = ?, replied_at = ?, updated_at = ?,
         state = CASE WHEN ? THEN 'addressed' ELSE state END,
         addressed_in_version = CASE WHEN ? THEN ? ELSE addressed_in_version END
       WHERE id = ?`,
    ).run(input.body.trim(), input.author.name, now, now, input.addressed ? 1 : 0, input.addressed ? 1 : 0, plan.version, row.id);
    return fresh(row.id);
  });

  /** Who the revised plan goes back to: the assigned reviewer thread, else the owner. */
  const reviewerOf = (plan: PlanRow) => (plan.reviewer_kind === "thread" && plan.reviewer_thread ? plan.reviewer_thread : "owner");

  /**
   * The checks every reviewer command makes in its own transaction: the caller is the assigned reviewer, the plan is in
   * review, and `version` is the version that was submitted and is still current. A decision on text the reviewer did
   * not read, or after the owner decided, is refused here.
   */
  function requireReviewer(taskId: string, caller: string | null, version: number) {
    const { task, plan } = requirePlan(taskId);
    if (!caller) throw new PlanError("plan_state", "Reviewer commands run from the reviewer's own thread; this call has no thread id");
    if (plan.reviewer_kind !== "thread" || plan.reviewer_thread !== caller)
      throw new PlanError("plan_state", `${caller} is not the reviewer of ${task.key} plan${plan.reviewer_kind === "thread" ? ` (that is ${plan.reviewer_thread})` : " (the owner reviews it)"}`);
    if (plan.state !== "in_review") throw new PlanError("plan_state", `${task.key} plan v${plan.version} is ${plan.state.replace("_", " ")}, not in review; a decision on it is no longer yours to make`);
    if (version !== plan.version || version !== plan.review_version)
      throw new PlanError("plan_conflict", `You reviewed v${version}, but the plan under review is v${plan.review_version ?? plan.version} (current v${plan.version}); read it again and pass --version ${plan.version}`);
    return { task, plan };
  }

  /** Reviewer-thread notes by number; the owner's notes are never reachable from a reviewer command. */
  function reviewerNotes(taskId: string, numbers: readonly number[]): NoteRow[] {
    return numbers.map((number) => {
      const row = db.prepare<[string, number], NoteRow>("SELECT * FROM task_plan_notes WHERE task_id = ? AND number = ?").get(taskId, number);
      if (!row) throw new PlanError("plan_invalid", `The plan has no note ${noteLabel(number)}`);
      if (row.author_kind !== "thread") throw new PlanError("plan_state", `${noteLabel(number)} is the owner's note; only the owner changes it`);
      return row;
    });
  }

  /**
   * All draft notes of one author kind become sent, the plan goes to "changes requested" and the task log says so, in one
   * transaction. The owner's call (no `reviewerVersion`) sends the owner's drafts; a reviewer's call sends the drafts of
   * every reviewer thread, each keeping its author.
   */
  const sendFeedback = db.transaction((taskId: string, by: PlanAuthor, reviewerVersion?: number) => {
    const { task, plan } = reviewerVersion === undefined ? requirePlan(taskId) : requireReviewer(taskId, by.threadId, reviewerVersion);
    const drafts = draftRows(taskId, reviewerVersion === undefined ? "person" : "thread");
    if (drafts.length === 0) throw new PlanError("plan_state", `${task.key} has no draft notes to send`);
    const now = new Date().toISOString();
    const ids = drafts.map((row) => row.id);
    db.prepare(`UPDATE task_plan_notes SET state = 'sent', sent_in_version = ?, sent_at = ?, updated_at = ? WHERE id IN (${ids.map(() => "?").join(", ")})`).run(plan.version, now, now, ...ids);
    db.prepare("UPDATE task_plans SET state = 'changes_requested', updated_at = ? WHERE task_id = ?").run(now, taskId);
    closePendingReview(db, taskId, "changes_requested", reviewerVersion === undefined ? by.name : by.threadId!);
    tasks.createComment({ taskId, kind: "system", authorName: by.name, body: `Plan v${plan.version}: changes requested by ${by.name} · ${plural(drafts.length, "note")}` });
    return { plan: head(taskId)!, version: plan.version, body: plan.body, taskKey: task.key, notes: drafts.map((row) => fresh(row.id)), reviewer: reviewerOf(plan) };
  });

  /**
   * Approval is refused while unsent drafts of the approver exist: they would never reach the agent. A reviewer also
   * needs every note of a reviewer thread resolved (the convergence rule); the owner can always override.
   */
  const approve = db.transaction((taskId: string, by: PlanAuthor, note?: string, reviewerVersion?: number) => {
    const { task, plan } = reviewerVersion === undefined ? requirePlan(taskId) : requireReviewer(taskId, by.threadId, reviewerVersion);
    if (plan.state === "approved") throw new PlanError("plan_state", `Plan v${plan.version} is already approved`);
    if (reviewerVersion === undefined) {
      const drafts = draftRows(taskId, "person").length;
      if (drafts > 0) throw new PlanError("plan_state", `${task.key} has ${plural(drafts, "draft note")} not sent yet; send them as feedback or delete them before approving`);
    } else {
      const open = db.prepare<[string], { number: number; state: string }>("SELECT number, state FROM task_plan_notes WHERE task_id = ? AND author_kind = 'thread' AND state != 'resolved' ORDER BY number").all(taskId);
      if (open.length)
        throw new PlanError(
          "plan_state",
          `${task.key} has ${plural(open.length, "reviewer note")} still open: ${open.map((row) => `${noteLabel(row.number)} (${row.state})`).join(", ")}. Dismiss or send drafts, resolve answered notes, then approve`,
        );
    }
    const text = note?.trim() || undefined;
    assertNoSecrets(text, "plan approval note");
    const now = new Date().toISOString();
    db.prepare("UPDATE task_plans SET state = 'approved', updated_at = ? WHERE task_id = ?").run(now, taskId);
    closePendingReview(db, taskId, "approved", reviewerVersion === undefined ? by.name : by.threadId!);
    const shown = text && (text.length > COMMENT_NOTE_CAP ? `${text.slice(0, COMMENT_NOTE_CAP)}…` : text);
    tasks.createComment({ taskId, kind: "system", authorName: by.name, body: `Plan v${plan.version}: approved by ${by.name}${shown ? ` · note: ${shown}` : ""}` });
    return { plan: head(taskId)!, version: plan.version, taskKey: task.key, note: text ?? null };
  });

  /** The reviewer's note on a passage: the quote must occur exactly once in the section (or the whole plan); the anchor is the UI's own. */
  const createByReviewer = db.transaction(
    (input: { taskId: string; by: PlanAuthor; version: number; kind?: PlanNoteKind; body: string; quote?: string; section?: string }): PlanNote => {
      const { task, plan } = requireReviewer(input.taskId, input.by.threadId, input.version);
      if (input.body.length > PLAN_NOTE_BODY_MAX) throw new PlanError("plan_invalid", `A note is at most ${PLAN_NOTE_BODY_MAX} characters`);
      const kind = input.kind ?? (input.quote === undefined ? "general" : "comment");
      let anchor: { exact: string; prefix: string; suffix: string; headingPath: string | null } | null = null;
      if (input.quote !== undefined) {
        const plain = markdownPlainText(plan.body);
        let scope = plain;
        let base = 0;
        let where = "the plan";
        let headingPath: string | null = null;
        if (input.section !== undefined) {
          let found;
          try {
            found = findSection(plan.body, input.section);
            getSection(plan.body, input.section);
          } catch (error) {
            throw new PlanError("plan_invalid", error instanceof Error ? error.message : String(error));
          }
          const lines = plan.body.split("\n");
          scope = markdownPlainText(lines.slice(found.start, found.end).join("\n"));
          base = markdownPlainText(lines.slice(0, found.end).join("\n")).length - scope.length;
          headingPath = found.heading.path.join(" > ");
          where = `section "${headingPath}"`;
        }
        const wanted = fold(input.quote).folded;
        if (!wanted) throw new PlanError("plan_invalid", "The quote has no letters or digits to find");
        const text = fold(scope);
        let count = 0;
        for (let at = text.folded.indexOf(wanted); at !== -1; at = text.folded.indexOf(wanted, at + 1)) count++;
        if (count === 0) throw new PlanError("plan_invalid", `The quote was not found in ${where} of ${task.key} v${plan.version} (0 matches); copy it from \`plan show\``);
        if (count > 1)
          throw new PlanError("plan_invalid", `The quote occurs ${count} times in ${where}; ${input.section === undefined ? "name its section with --section, or " : ""}quote a longer passage so it occurs once`);
        const span = resolveAnchor(text, { exact: input.quote, prefix: "", suffix: "" })!;
        const built = buildAnchor(plain, base + span.start, base + span.end);
        if (!built || built.exact.length > PLAN_NOTE_QUOTE_MAX) throw new PlanError("plan_invalid", `The quote must be 1–${PLAN_NOTE_QUOTE_MAX} characters`);
        anchor = { ...built, headingPath };
      }
      return create({
        taskId: input.taskId,
        kind,
        exact: anchor?.exact ?? null,
        prefix: anchor?.prefix ?? null,
        suffix: anchor?.suffix ?? null,
        headingPath: anchor?.headingPath ?? null,
        madeOnVersion: input.version,
        body: input.body,
        authorName: input.by.name,
        authorThread: input.by.threadId!,
      });
    },
  );

  /** A reviewer withdraws unsent drafts of reviewer threads. Like a deleted draft, this leaves no log entry: numbers of unsent drafts can be reused. */
  const dismissByReviewer = db.transaction((taskId: string, by: PlanAuthor, version: number, numbers: readonly number[]) => {
    requireReviewer(taskId, by.threadId, version);
    const rows = reviewerNotes(taskId, numbers);
    for (const row of rows) if (row.state !== "draft") throw new PlanError("plan_state", `${noteLabel(row.number)} was already sent; resolve it instead of dismissing it`);
    for (const row of rows) db.prepare("DELETE FROM task_plan_notes WHERE id = ?").run(row.id);
    return { taskId, removed: [...numbers] };
  });

  /** A reviewer resolves or reopens notes of reviewer threads, including a previous reviewer's. */
  const setStateByReviewer = db.transaction((taskId: string, by: PlanAuthor, version: number, numbers: readonly number[], state: "resolved" | "draft") => {
    requireReviewer(taskId, by.threadId, version);
    return reviewerNotes(taskId, numbers).map((row) => setState(row.id, state));
  });

  /** Every note of a project in one statement, for export. */
  function captureProject(projectId: string): Map<string, CapturedPlanNote[]> {
    const result = new Map<string, CapturedPlanNote[]>();
    for (const row of db
      .prepare<[string], NoteRow>("SELECT n.* FROM task_plan_notes n JOIN tasks t ON t.id = n.task_id WHERE t.project_id = ? ORDER BY n.task_id, n.number")
      .all(projectId)) {
      const notes = result.get(row.task_id) ?? [];
      notes.push(capturedOf(noteOf(row)));
      result.set(row.task_id, notes);
    }
    return result;
  }
  const capture = (taskId: string): CapturedPlanNote[] => capturedNotes(taskId).map(capturedOf);

  /** Replaces a task's notes with imported ones. */
  function restore(taskId: string, notes: readonly CapturedPlanNote[]): void {
    db.prepare("DELETE FROM task_plan_notes WHERE task_id = ?").run(taskId);
    const insert = db.prepare(
      `INSERT INTO task_plan_notes (id, task_id, number, kind, exact, prefix, suffix, heading_path, made_on_version, body, state, sent_in_version, sent_at, reply, reply_by, replied_at, addressed_in_version, author_name, author_kind, author_thread, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of notes)
      insert.run(n.id, taskId, n.number, n.kind, n.exact, n.prefix, n.suffix, n.headingPath, n.madeOnVersion, n.body, n.state, n.sentInVersion, n.sentAt, n.reply, n.replyBy, n.repliedAt, n.addressedInVersion, n.authorName, n.authorKind, n.authorThread, n.createdAt, n.updatedAt);
  }

  return { list, counts, create, update, remove, setState, reply, blockingCount, sendFeedback, approve, createByReviewer, dismissByReviewer, setStateByReviewer, capture, captureProject, restore };
}

export type PlanNoteStore = ReturnType<typeof createPlanNoteStore>;
