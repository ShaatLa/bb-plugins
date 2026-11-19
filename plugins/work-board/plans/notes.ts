import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import { createUlid } from "../db/store";
import type { CreatePlanNoteInput, PlanAuthor, PlanNote, PlanNoteCounts, TaskPlanHead } from "../shared/contract";
import type { PlanNoteKind, PlanNoteState } from "../shared/plan-notes";
import { noteLabel } from "../shared/plan-notes";
import { assertNoSecrets } from "../shared/secret-guard.js";
import { PlanError } from "./store";

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
  created_at: string;
  updated_at: string;
}
interface PlanRow {
  version: number;
  body: string;
  state: string;
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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});
const capturedOf = ({ taskId: _taskId, ...note }: PlanNote): CapturedPlanNote => note;

const COMMENT_NOTE_CAP = 300;
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** The owner's notes on task plans: draft → sent → addressed → resolved, and the two review decisions. */
export function createPlanNoteStore(db: Database, tasks: TasksStore, head: (taskId: string) => TaskPlanHead | null) {
  function requireEditable(taskId: string) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    if (task.archivedAt) throw new PlanError("plan_archived", `${task.key} is archived; restore the task before changing its plan`);
    return task;
  }
  const planRow = (taskId: string) => db.prepare<[string], PlanRow>("SELECT version, body, state FROM task_plans WHERE task_id = ?").get(taskId);
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
  const draftRows = (taskId: string) =>
    db.prepare<[string], NoteRow>("SELECT * FROM task_plan_notes WHERE task_id = ? AND state = 'draft' ORDER BY number").all(taskId);

  function list(taskId: string): PlanNote[] {
    if (!tasks.getTask(taskId)) throw new Error(`Task not found: ${taskId}`);
    return db.prepare<[string], NoteRow>("SELECT * FROM task_plan_notes WHERE task_id = ? ORDER BY number").all(taskId).map(noteOf);
  }

  function counts(taskId: string): PlanNoteCounts {
    const result: PlanNoteCounts = { draft: 0, open: 0, addressed: 0, resolved: 0 };
    for (const row of db.prepare<[string], { state: PlanNoteState; count: number }>("SELECT state, COUNT(*) AS count FROM task_plan_notes WHERE task_id = ? GROUP BY state").all(taskId))
      result[row.state === "sent" ? "open" : row.state] = row.count;
    return result;
  }

  function guardText(body: string, kind: PlanNoteKind) {
    if (kind !== "remove" && body.trim() === "") throw new PlanError("plan_invalid", "A note needs text");
    assertNoSecrets(body, "plan note");
  }

  const create = db.transaction((input: CreatePlanNoteInput & { body: string; authorName: string }): PlanNote => {
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
      `INSERT INTO task_plan_notes (id, task_id, number, kind, exact, prefix, suffix, heading_path, made_on_version, body, state, author_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(id, input.taskId, number, input.kind, general ? null : quote, general ? null : (input.prefix ?? ""), general ? null : (input.suffix ?? ""), general ? null : (input.headingPath ?? null), version, input.body.trim(), input.authorName, now, now);
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

  /** All draft notes become sent, the plan goes to "changes requested" and the task log says so, in one transaction. */
  const sendFeedback = db.transaction((taskId: string, by: PlanAuthor) => {
    const { task, plan } = requirePlan(taskId);
    const drafts = draftRows(taskId);
    if (drafts.length === 0) throw new PlanError("plan_state", `${task.key} has no draft notes to send`);
    const now = new Date().toISOString();
    db.prepare("UPDATE task_plan_notes SET state = 'sent', sent_in_version = ?, sent_at = ?, updated_at = ? WHERE task_id = ? AND state = 'draft'").run(plan.version, now, now, taskId);
    db.prepare("UPDATE task_plans SET state = 'changes_requested', updated_at = ? WHERE task_id = ?").run(now, taskId);
    tasks.createComment({ taskId, kind: "system", authorName: by.name, body: `Plan v${plan.version}: changes requested by ${by.name} · ${plural(drafts.length, "note")}` });
    return { plan: head(taskId)!, version: plan.version, body: plan.body, taskKey: task.key, notes: drafts.map((row) => fresh(row.id)) };
  });

  /** Approval is refused while drafts exist: they would never reach the agent. */
  const approve = db.transaction((taskId: string, by: PlanAuthor, note?: string) => {
    const { task, plan } = requirePlan(taskId);
    if (plan.state === "approved") throw new PlanError("plan_state", `Plan v${plan.version} is already approved`);
    const drafts = draftRows(taskId).length;
    if (drafts > 0) throw new PlanError("plan_state", `${task.key} has ${plural(drafts, "draft note")} not sent yet; send them as feedback or delete them before approving`);
    const text = note?.trim() || undefined;
    assertNoSecrets(text, "plan approval note");
    const now = new Date().toISOString();
    db.prepare("UPDATE task_plans SET state = 'approved', updated_at = ? WHERE task_id = ?").run(now, taskId);
    const shown = text && (text.length > COMMENT_NOTE_CAP ? `${text.slice(0, COMMENT_NOTE_CAP)}…` : text);
    tasks.createComment({ taskId, kind: "system", authorName: by.name, body: `Plan v${plan.version}: approved by ${by.name}${shown ? ` · note: ${shown}` : ""}` });
    return { plan: head(taskId)!, version: plan.version, taskKey: task.key, note: text ?? null };
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
  const capture = (taskId: string): CapturedPlanNote[] => list(taskId).map(capturedOf);

  /** Replaces a task's notes with imported ones. */
  function restore(taskId: string, notes: readonly CapturedPlanNote[]): void {
    db.prepare("DELETE FROM task_plan_notes WHERE task_id = ?").run(taskId);
    const insert = db.prepare(
      `INSERT INTO task_plan_notes (id, task_id, number, kind, exact, prefix, suffix, heading_path, made_on_version, body, state, sent_in_version, sent_at, reply, reply_by, replied_at, addressed_in_version, author_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const n of notes)
      insert.run(n.id, taskId, n.number, n.kind, n.exact, n.prefix, n.suffix, n.headingPath, n.madeOnVersion, n.body, n.state, n.sentInVersion, n.sentAt, n.reply, n.replyBy, n.repliedAt, n.addressedInVersion, n.authorName, n.createdAt, n.updatedAt);
  }

  return { list, counts, create, update, remove, setState, reply, sendFeedback, approve, capture, captureProject, restore };
}

export type PlanNoteStore = ReturnType<typeof createPlanNoteStore>;
