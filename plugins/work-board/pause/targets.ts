import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { UNANSWERED_QUESTION } from "../db/waiting-on-owner";
import { isDoneIn } from "../db/status-sql";
import { placeChecks } from "../shared/check-flow";
import type { TaskQuestion } from "../shared/contract";
import type { PauseTarget } from "../shared/pause";

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

const decisionLabel = (prompt: string) => {
  const text = prompt.trim().replace(/\s+/g, " ");
  return `decision «${text.length > 40 ? `${text.slice(0, 40)}…` : text}»`;
};

/**
 * What each card's held and owner_question pauses wait on right now, by the predicates `pause/signals.ts` uses to keep them.
 * The row stays until the next scan, so the stored reason can name an item that is already resolved; targets never do.
 * `held`: unfinished predecessors, in key order. `owner_question`: the open, not held questions, decisions first, then checks in flow order.
 */
export function pauseTargets(db: PluginDatabase, held: readonly string[], asked: readonly string[]): { held: Map<string, PauseTarget[]>; owner_question: Map<string, PauseTarget[]> } {
  const out = { held: new Map<string, PauseTarget[]>(), owner_question: new Map<string, PauseTarget[]>() };
  if (held.length) {
    const rows = db.prepare<[string], { task_id: string; key: string }>(
      `SELECT d.task_id, p.prefix || '-' || b.number AS key FROM task_dependencies d JOIN tasks b ON b.id=d.blocking_task_id JOIN projects p ON p.id=b.project_id
       WHERE d.task_id IN (SELECT value FROM json_each(?)) AND NOT ${isDoneIn("b")} ORDER BY p.prefix, b.number`).all(JSON.stringify(held));
    for (const row of rows) out.held.set(row.task_id, [...(out.held.get(row.task_id) ?? []), { kind: "task", taskKey: row.key }]);
  }
  if (asked.length) {
    const ids = JSON.stringify(asked);
    const waiting = new Set(db.prepare<[string], { id: string }>(
      `SELECT q.id FROM task_questions q WHERE q.task_id IN (SELECT value FROM json_each(?)) AND ${UNANSWERED_QUESTION}`).all(ids).map((row) => row.id));
    const all = db.prepare<[string], { task_id: string; payload: string }>(
      "SELECT task_id, payload FROM task_questions WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY id").all(ids);
    const byTask = new Map<string, TaskQuestion[]>();
    for (const row of all) byTask.set(row.task_id, [...(byTask.get(row.task_id) ?? []), JSON.parse(row.payload) as TaskQuestion]);
    for (const [taskId, questions] of byTask) {
      const targets = placeChecks(questions).filter((question) => waiting.has(question.id)).map((question): PauseTarget => ({
        kind: "question", questionId: question.id,
        label: question.kind === "check" ? `check ${question.number}` : decisionLabel(question.prompt),
      }));
      if (targets.length) out.owner_question.set(taskId, targets);
    }
  }
  return out;
}
