import type { TaskQuestion } from "./contract";

export function isQuestionOpen(question: Pick<TaskQuestion, "selectedOptionIds"> & { answerText?: string | null }): boolean {
  return !question.selectedOptionIds.length && !question.answerText;
}

export const OPEN_QUESTION_SQL = `COALESCE(json_array_length(q.payload, '$.selectedOptionIds'), 0) = 0
  AND COALESCE(json_extract(q.payload, '$.answerText'), '') = ''`;
