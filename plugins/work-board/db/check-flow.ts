import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { checkFlow } from "../shared/check-flow";
import type { TaskQuestion } from "../shared/contract";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

/**
 * Held checks as rows, so SQL readers ask the same `checkFlow` the UI and the CLI do instead of copying its rules.
 * Derived data: never exported, rebuilt on import and by the migration that creates it.
 */
export const CREATE_HOLDS_TABLE = `
  CREATE TABLE task_question_holds (
    question_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    held_by TEXT NOT NULL
  );
  CREATE INDEX idx_task_question_holds_task ON task_question_holds(task_id);
`;

/** Rewrites one card's rows from its questions. Call it in the same transaction as every question write. */
export function refreshCheckFlow(db: PluginDatabase, taskId: string): void {
  const rows = db.prepare<[string], { payload: string }>("SELECT payload FROM task_questions WHERE task_id = ? ORDER BY id").all(taskId);
  const held = checkFlow(rows.map((row) => JSON.parse(row.payload) as TaskQuestion)).held;
  db.prepare<[string]>("DELETE FROM task_question_holds WHERE task_id = ?").run(taskId);
  const insert = db.prepare<[string, string, string]>("INSERT INTO task_question_holds (question_id, task_id, held_by) VALUES (?, ?, ?)");
  for (const [questionId, heldBy] of held) insert.run(questionId, taskId, heldBy);
}

/** Every card that has a check. */
export function rebuildCheckFlow(db: PluginDatabase): void {
  for (const { task_id } of db.prepare<[], { task_id: string }>("SELECT DISTINCT task_id FROM task_questions WHERE json_extract(payload, '$.kind') = 'check'").all())
    refreshCheckFlow(db, task_id);
}
