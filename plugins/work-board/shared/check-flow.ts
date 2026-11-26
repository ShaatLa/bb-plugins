import type { TaskQuestion } from "./contract";

/**
 * The order, numbers, rounds and holds of one card's owner checks. This is the single source of truth: the UI, the CLI, the
 * API and the `task_question_holds` table all read it, so none of them re-implements the rules.
 */
export type CheckVerdict = "open" | "confirmed" | "problem" | "answered" | "withdrawn";
export type CheckState = CheckVerdict | "held" | "superseded";

/** The part of a question a verdict reads; history snapshots have it too. */
type AnswerState = Pick<TaskQuestion, "options" | "selectedOptionIds" | "answerText">;

/**
 * Confirmed is exactly one selected option labelled Confirmed (the rule the readiness check uses, a comment may come with it).
 * A selected Problem found, or text with no option, is a problem. Any other answer is just answered.
 */
export function verdictOf(state: AnswerState, withdrawn = false): CheckVerdict {
  if (withdrawn) return "withdrawn";
  const labels = state.options.filter((option) => state.selectedOptionIds.includes(option.id)).map((option) => option.label);
  if (!labels.length && !state.answerText) return "open";
  if (labels.includes("Problem found")) return "problem";
  if (labels.length === 1 && labels[0] === "Confirmed") return "confirmed";
  return labels.length ? "answered" : "problem";
}

export interface CheckChain {
  /** Question ids from the root to the head. */
  ids: string[];
  rootId: string;
  headId: string;
  round: number;
  /** 1, 2, 3 … within the round, over chains that are not withdrawn; null for a withdrawn chain. */
  number: number | null;
  verdict: CheckVerdict;
  state: CheckState;
  /** The failed chain that holds this one, when state is `held`. */
  heldBy: { id: string; number: number } | null;
}

export interface CheckRound {
  round: number;
  chains: CheckChain[];
  /** Every check of the round is confirmed, answered or withdrawn. */
  finished: boolean;
  /** Shown in the card's list: not finished, or the last round. */
  visible: boolean;
}

export interface CheckFlow {
  chains: CheckChain[];
  rounds: CheckRound[];
  /** Held open heads: question id → the id of the failed head that holds it. */
  held: Map<string, string>;
  chainOf: Map<string, CheckChain>;
}

const FINISHED: readonly CheckVerdict[] = ["confirmed", "answered", "withdrawn"];

/** The answer a question had at `at`: the newest state older than `at`, the current one included; unanswered before its oldest snapshot. */
function answerAt(question: TaskQuestion, at: string): { state: AnswerState; withdrawn: boolean } {
  // The current state is the only record of the latest answer: answering appends only the previous state to history.
  const states: (AnswerState & { updatedAt: string })[] = [...question.history, question];
  let found: AnswerState = { options: question.options, selectedOptionIds: [], answerText: null };
  let foundAt = "";
  for (const state of states) if (state.updatedAt < at && state.updatedAt >= foundAt) { found = state; foundAt = state.updatedAt; }
  return { state: found, withdrawn: Boolean(question.withdrawnAt && question.withdrawnAt < at) };
}

/** Was the chain finished at `at`? A chain with no member created before `at` is not (equal creation times share a round). */
function finishedAt(members: readonly TaskQuestion[], at: string): boolean {
  let head: TaskQuestion | undefined;
  for (const member of members)
    if (member.createdAt < at && !(member.supersededAt && member.supersededAt < at)) head = member;
  if (!head) return false;
  const { state, withdrawn } = answerAt(head, at);
  return FINISHED.includes(verdictOf(state, withdrawn));
}

export function checkFlow(questions: readonly TaskQuestion[]): CheckFlow {
  const checks = questions.filter((question) => question.kind === "check");
  const byId = new Map(checks.map((question) => [question.id, question]));
  const members: TaskQuestion[][] = [];
  for (const root of checks) {
    if (root.supersedes && byId.has(root.supersedes)) continue;
    const chain = [root];
    const seen = new Set([root.id]);
    for (let next = root.supersededBy ? byId.get(root.supersededBy) : undefined; next && !seen.has(next.id); next = next.supersededBy ? byId.get(next.supersededBy) : undefined) {
      chain.push(next);
      seen.add(next.id);
    }
    members.push(chain);
  }
  members.sort((a, b) => a[0]!.createdAt.localeCompare(b[0]!.createdAt) || a[0]!.id.localeCompare(b[0]!.id));

  // A round is decided once from the past: chain C joins the previous chain's round unless, as of C's creation, all of it was finished.
  const roundOf: number[] = [];
  members.forEach((chain, index) => {
    if (!index) return roundOf.push(1);
    const previous = roundOf[index - 1]!;
    const at = chain[0]!.createdAt;
    const finished = members.slice(0, index).every((other, k) => roundOf[k] !== previous || finishedAt(other, at));
    roundOf.push(finished ? previous + 1 : previous);
  });

  const chains: CheckChain[] = members.map((chain, index) => {
    const head = chain.at(-1)!;
    const verdict = verdictOf(head, Boolean(head.withdrawnAt));
    return { ids: chain.map((question) => question.id), rootId: chain[0]!.id, headId: head.id, round: roundOf[index]!, number: null, verdict, state: verdict, heldBy: null };
  });

  // Round numbers stay as decided: a round whose checks were all withdrawn keeps its number, so later rounds never renumber.
  const counters = new Map<number, number>();
  const rounds: CheckRound[] = [];
  const held = new Map<string, string>();
  for (const chain of chains) {
    if (chain.verdict !== "withdrawn") {
      chain.number = (counters.get(chain.round) ?? 0) + 1;
      counters.set(chain.round, chain.number);
    }
    let round = rounds.find((entry) => entry.round === chain.round);
    if (!round) rounds.push((round = { round: chain.round, chains: [], finished: true, visible: false }));
    // The first failed check before this one in the same round holds it; replacing or reopening that check lifts the hold.
    const failed = round.chains.find((other) => other.verdict === "problem");
    if (chain.verdict === "open" && failed) {
      chain.state = "held";
      chain.heldBy = { id: failed.headId, number: failed.number! };
      held.set(chain.headId, failed.headId);
    }
    round.chains.push(chain);
    if (!FINISHED.includes(chain.verdict)) round.finished = false;
  }
  const last = [...rounds].reverse().find((round) => round.chains.some((chain) => chain.verdict !== "withdrawn"));
  for (const round of rounds) round.visible = !round.finished || round === last;

  const chainOf = new Map<string, CheckChain>();
  for (const chain of chains) for (const id of chain.ids) chainOf.set(id, chain);
  return { chains, rounds, held, chainOf };
}

/** State of one question in a computed flow: superseded members read `superseded`, a head reads its chain's state. */
export function stateOfQuestion(flow: CheckFlow, id: string): CheckState | undefined {
  const chain = flow.chainOf.get(id);
  return chain ? (chain.headId === id ? chain.state : "superseded") : undefined;
}

export interface CheckPlace {
  /** Position in the card's flow; the same for every question of one chain. */
  number: number | null;
  state: CheckState;
  round: number;
  heldBy?: { id: string; number: number };
}

/** The card's questions as agents read them: decisions first, then each chain's checks in flow order, each with its place. */
export function placeChecks<Q extends TaskQuestion>(questions: readonly Q[]): (Q & Partial<CheckPlace>)[] {
  const flow = checkFlow(questions);
  const byId = new Map(questions.map((question) => [question.id, question]));
  const checks = flow.chains.flatMap((chain) => chain.ids.map((id) => ({
    ...byId.get(id)!,
    number: chain.number, state: stateOfQuestion(flow, id)!, round: chain.round,
    ...(chain.headId === id && chain.heldBy ? { heldBy: chain.heldBy } : {}),
  })));
  return [...questions.filter((question) => question.kind !== "check"), ...checks] as (Q & Partial<CheckPlace>)[];
}

/** One line for a held check, as the CLI prints it. */
export const heldLine = (question: { id: string; heldBy?: { id: string; number: number } }): string =>
  `On hold: waiting for the fix of check ${question.heldBy?.number} (${question.heldBy?.id}); question ${question.id} can still be answered.`;
