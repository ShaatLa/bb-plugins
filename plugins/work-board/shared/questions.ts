import type { TaskQuestion } from "./contract";

export function isQuestionOpen(question: Pick<TaskQuestion, "selectedOptionIds"> & { answerText?: string | null }): boolean {
  return !question.selectedOptionIds.length && !question.answerText;
}

export const OPEN_QUESTION_SQL = `COALESCE(json_array_length(q.payload, '$.selectedOptionIds'), 0) = 0
  AND COALESCE(json_extract(q.payload, '$.answerText'), '') = ''`;

const MARKDOWN_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()\]]+/g;

/** Distinct link targets in a question's prompt and steps: Markdown link targets and bare web URLs. */
export function questionLinks(prompt: string, steps: readonly string[]): string[] {
  const links = new Set<string>();
  for (const text of [prompt, ...steps]) {
    for (const match of text.matchAll(MARKDOWN_LINK)) links.add(match[1]!);
    // Bare URLs outside Markdown links; a link's own target is already counted above.
    for (const match of text.replace(MARKDOWN_LINK, "]()").matchAll(BARE_URL)) links.add(match[0].replace(/[.,;:!?]+$/, ""));
  }
  return [...links];
}

export const QUESTION_SPLIT_HINT =
  'A multi-part acceptance is several --kind check questions, each asking one check with its own link, e.g. bb work-board question add EXA-1 --kind check --prompt "Does [the empty state](https://example.com/a) look right?" and a second question for the next state.';

/** One question asks one decision or one check with at most one link, across the prompt and every step. */
export function assertQuestionShape(prompt: string, steps: readonly string[]): void {
  const links = questionLinks(prompt, steps);
  if (links.length > 1)
    throw new Error(`A question may carry at most one link across its prompt and steps; this one has ${links.length}. ${QUESTION_SPLIT_HINT}`);
}

/** Reopening asks the same thing again; new steps or links mean a new state, which is a new question. */
export function assertReopenKeepsScope(previous: { prompt: string; steps: readonly string[] }, next: { prompt: string; steps: readonly string[] }): void {
  const before = new Set(questionLinks(previous.prompt, previous.steps));
  const added = questionLinks(next.prompt, next.steps).filter((link) => !before.has(link));
  if (next.steps.length > previous.steps.length || added.length)
    throw new Error(`Reopening an answered question asks the same check again; it cannot add ${added.length ? "links" : "steps"} the answered revision did not have. Ask the new state as a new question instead. ${QUESTION_SPLIT_HINT}`);
}
