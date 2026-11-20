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

const PLAN_LINK = /\/plugins\/work-board\/work-board\/task\/[^/\s)]+\/plan(?![\w-])/;
// "accept/approve … plan" either way round, English and Russian, within one sentence.
const PLAN_APPROVAL = [
  /\b(?:accept|approve|sign[ -]?off|confirm)\w*\b[^.?!\n]{0,60}\bplan\b/i,
  /\bplan\b[^.?!\n]{0,60}\b(?:accept|approve|sign[ -]?off|confirm)\w*/i,
  /(?:принима|приним|одобр|соглас|утвержд|подтвержд)[а-яё]*[^.?!\n]{0,60}план/i,
  /план[а-яё]*[^.?!\n]{0,60}(?:принима|одобр|соглас|утвержд|подтвержд)/i,
];

/**
 * The plan's own review replaces "do you accept the plan?" questions. A question that links a task plan is refused;
 * on a task that has a plan, so is one that asks to accept or approve a plan.
 */
export function assertNotPlanApproval(prompt: string, steps: readonly string[], taskKey: string, taskHasPlan: boolean): void {
  const text = [prompt, ...steps].join("\n");
  if (PLAN_LINK.test(text) || (taskHasPlan && PLAN_APPROVAL.some((pattern) => pattern.test(text))))
    throw new Error(`Plan approval is not an owner question: run \`bb work-board plan submit ${taskKey} --reviewer <reviewer thread, or owner only when the user asked to approve the plan>\` and wait. The reviewer approves the plan or sends notes, and you get a message either way. Ask questions only for decisions inside the work.`);
}

export const STEP_SPLIT_HINT =
  'One --step is one action or one observation: split it into separate --step values, in order, e.g. --step "Press Retry" --step "Close the message" --step "Check that the list reloads".';

// A new sentence starts after . ! ? or … and whitespace, with a capital letter, a quote or a digit.
const SENTENCE_BREAK = /[.!?…]["»”)]?\s+(?=["«“(]?[A-ZА-ЯЁ0-9])/u;
// Common abbreviations end in a dot without ending the sentence.
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|т\.е|т\.к|т\.д|т\.п|напр|см|стр)\.$/i;

/** Each "How to check" step is a single sentence; several sentences are several steps. Steps in `kept` are not checked. */
export function assertStepsAtomic(steps: readonly string[], kept: readonly string[] = []): void {
  steps.forEach((step, index) => {
    if (kept.includes(step)) return;
    const parts = step.trim().split(SENTENCE_BREAK);
    let sentences = 1;
    for (let i = 0; i < parts.length - 1; i++) if (!ABBREVIATION.test(parts[i]!.trim())) sentences++;
    if (sentences > 1)
      throw new Error(`Step ${index + 1} has ${sentences} sentences ("${step.slice(0, 80)}${step.length > 80 ? "…" : ""}"). ${STEP_SPLIT_HINT}`);
  });
}

const ACTION = String.raw`(?:press|click|tap|open|close|select|choose|type|enter|scroll|drag|wait|check|verify|confirm|go|switch|reload|нажм|нажи|закро|закры|откро|откры|выбер|выбра|введ|введ|прокру|перетащ|подожд|дожд|провер|убед|перейд|переключ|обнов)`;
// Actions chained inside one sentence: "then", or a comma or "and" followed by another action verb.
const CHAINED = new RegExp(String.raw`\b(?:then|after that|afterwards)\b|затем|потом|после чего|,\s*(?:and\s+|и\s+)?${ACTION}|\s(?:and|и)\s+${ACTION}`, "iu");

/** Steps that look like several actions joined into one; a warning, since wording alone cannot prove it. */
export function compoundStepWarnings(steps: readonly string[]): string[] {
  const numbers = steps.flatMap((step, index) => (CHAINED.test(step) ? [index + 1] : []));
  return numbers.length
    ? [`Step${numbers.length > 1 ? "s" : ""} ${numbers.join(", ")} may join several actions ("then", or a comma or "and" before another action). ${STEP_SPLIT_HINT}`]
    : [];
}
