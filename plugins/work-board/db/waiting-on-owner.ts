
// What the owner is waited on for: open, minus the checks held back by an earlier failed check.
export { WAITING_ON_OWNER_SQL as UNANSWERED_QUESTION } from "../shared/questions";
import { WAITING_ON_OWNER_SQL as UNANSWERED_QUESTION } from "../shared/questions";
export const NEWEST_UNANSWERED = `(SELECT MAX(json_extract(q.payload, '$.createdAt')) FROM task_questions q WHERE q.task_id = t.id AND ${UNANSWERED_QUESTION})`;
export const WAITING_ON_OWNER = `t.archived_at IS NULL
  AND t.status NOT IN ('done', 'canceled') AND (EXISTS (SELECT 1 FROM task_questions q WHERE q.task_id = t.id AND ${UNANSWERED_QUESTION}))`;
