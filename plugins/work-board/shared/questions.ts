import type { TaskQuestion } from "./contract";

/** A superseded check is closed whatever its answer: its successor is the one the owner answers. */
export function isQuestionOpen(question: Pick<TaskQuestion, "selectedOptionIds"> & { answerText?: string | null; supersededBy?: string }): boolean {
  return !question.selectedOptionIds.length && !question.answerText && !question.supersededBy;
}

export const OPEN_QUESTION_SQL = `COALESCE(json_array_length(q.payload, '$.selectedOptionIds'), 0) = 0
  AND COALESCE(json_extract(q.payload, '$.answerText'), '') = ''
  AND json_extract(q.payload, '$.supersededBy') IS NULL`;

/** Refusal for any change to a superseded check; stale requests get the same redirect. */
export function supersededRefusal(question: Pick<TaskQuestion, "id" | "supersededBy">, taskKey: string): string {
  return `Question ${question.id} is superseded by ${question.supersededBy}; act on that question (\`bb work-board question list ${taskKey}\` shows its revision).`;
}

/** Trimmed, case-folded, whitespace collapsed: the only equality the duplicate-check warning uses. */
export const normalizedPrompt = (prompt: string) => prompt.trim().replace(/\s+/g, " ").toLocaleLowerCase();

const supersedeCommand = (taskKey: string, question: Pick<TaskQuestion, "id" | "revision">) =>
  `bb work-board question add ${taskKey} --kind check --supersedes ${question.id} --supersedes-revision ${question.revision} --prompt ...`;

/**
 * What to do with an existing check instead of asking a parallel one: an open check is edited, an answered one with the same
 * prompt and steps is reopened, and any changed prompt link or step is a new state that supersedes it.
 */
export function checkGuidance(taskKey: string, existing: TaskQuestion, asked: { prompt: string; steps: readonly string[] }): string {
  const at = `--question ${existing.id} --revision ${existing.revision}`;
  if (isQuestionOpen(existing)) return `It is still open: edit it with \`bb work-board question update ${taskKey} ${at}\`.`;
  const same = existing.prompt.trim() === asked.prompt.trim() && JSON.stringify(existing.steps) === JSON.stringify(asked.steps.map((step) => step.trim()));
  return same
    ? `Its prompt and steps are unchanged: reopen it with \`bb work-board question update ${taskKey} ${at} --reopen\`.`
    : `A link or step changed, so this is a new state: replace it with \`${supersedeCommand(taskKey, existing)}\`.`;
}

/**
 * Supersession links on one card must be reciprocal, between checks and acyclic. Imports check the state they leave
 * behind, because a merge can keep a local link whose other end the archive replaced.
 */
export function assertSupersessionLinks(questions: readonly TaskQuestion[]): void {
  const byId = new Map(questions.map((question) => [question.id, question]));
  for (const question of questions) {
    const previous = question.supersedes && byId.get(question.supersedes);
    const next = question.supersededBy && byId.get(question.supersededBy);
    if ((question.supersedes && (!previous || previous.supersededBy !== question.id)) || (question.supersededBy && (!next || next.supersedes !== question.id)))
      throw new Error(`Question ${question.id} has a supersede link without its other end on the same card`);
    if ((question.supersedes || question.supersededBy) && question.kind !== "check")
      throw new Error(`Question ${question.id} is linked by a supersede but is not a check`);
    const seen = new Set<string>();
    for (let at: TaskQuestion | undefined = question; at?.supersededBy; at = byId.get(at.supersededBy)) {
      if (seen.has(at.id)) throw new Error(`Question ${question.id} is in a supersede cycle`);
      seen.add(at.id);
    }
  }
}

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

/**
 * Reopening asks the same thing again. For an answered check the ordered steps and the prompt's links must stay exactly the
 * same: any change is a new state, which supersedes the check. A decision may not gain steps or links; a changed decision is
 * a fresh decision question, since only checks can be superseded.
 */
export function assertReopenKeepsScope(previous: TaskQuestion, next: { prompt: string; steps: readonly string[] }, taskKey: string): void {
  if (previous.kind === "check") {
    const trimmed = (steps: readonly string[]) => JSON.stringify(steps.map((step) => step.trim()));
    const stepsChanged = trimmed(previous.steps) !== trimmed(next.steps);
    if (stepsChanged || JSON.stringify(questionLinks(previous.prompt, [])) !== JSON.stringify(questionLinks(next.prompt, [])))
      throw new Error(`Reopening an answered check asks the same check again, with the same steps and prompt link; its ${stepsChanged ? "steps" : "prompt link"} changed, so this is a new state. Replace it: \`${supersedeCommand(taskKey, previous)}\` with the new prompt and steps. ${QUESTION_SPLIT_HINT}`);
    return;
  }
  const before = new Set(questionLinks(previous.prompt, previous.steps));
  const added = questionLinks(next.prompt, next.steps).filter((link) => !before.has(link));
  if (next.steps.length > previous.steps.length || added.length)
    throw new Error(`Reopening an answered decision asks the same thing again; it cannot add ${added.length ? "links" : "steps"} the answered revision did not have. Ask the changed decision as a fresh decision question: \`bb work-board question add ${taskKey} --kind decision --prompt ... --option ...\`.`);
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

/** A step that matches an unused kept step is untouched; each kept entry covers one occurrence, so a duplicate of a legacy step is new. */
function keptMatcher(kept: readonly string[]): (step: string) => boolean {
  const unused = [...kept];
  return (step) => {
    const at = unused.indexOf(step);
    if (at < 0) return false;
    unused.splice(at, 1);
    return true;
  };
}

/** Each "How to check" step is a single sentence; several sentences are several steps. Steps in `kept` are not checked, once each. */
export function assertStepsAtomic(steps: readonly string[], kept: readonly string[] = []): void {
  const isKept = keptMatcher(kept);
  steps.forEach((step, index) => {
    if (isKept(step)) return;
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

/** Each new or changed step is one action: a step that chains actions ("then", or a comma or "and" before another verb) is refused. Steps in `kept` are not checked, once each. */
export function assertStepsSingleAction(steps: readonly string[], kept: readonly string[] = []): void {
  const isKept = keptMatcher(kept);
  const numbers = steps.flatMap((step, index) => (!isKept(step) && CHAINED.test(step) ? [index + 1] : []));
  if (numbers.length)
    throw new Error(`Step${numbers.length > 1 ? "s" : ""} ${numbers.join(", ")} may join several actions ("then", or a comma or "and" before another action). Nothing was saved. ${STEP_SPLIT_HINT}`);
}
