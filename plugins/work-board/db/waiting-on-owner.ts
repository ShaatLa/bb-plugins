import { ordinaryTaskVisibilitySql } from "../scheduled/visibility";

export const UNANSWERED_QUESTION = `json_array_length(q.payload, '$.selectedOptionIds') = 0
  AND COALESCE(json_extract(q.payload, '$.answerText'), '') = ''`;
export const NEWEST_UNANSWERED = `(SELECT MAX(json_extract(q.payload, '$.createdAt')) FROM task_questions q WHERE q.task_id = t.id AND ${UNANSWERED_QUESTION})`;
export const WAITING_ON_OWNER = `t.archived_at IS NULL AND ${ordinaryTaskVisibilitySql()}
  AND t.status NOT IN ('done', 'canceled') AND (t.execution_target = 'owner'
  OR EXISTS (SELECT 1 FROM task_questions q WHERE q.task_id = t.id AND ${UNANSWERED_QUESTION}))`;
