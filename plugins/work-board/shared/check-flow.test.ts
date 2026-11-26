import { describe, expect, it } from "vitest";
import { checkFlow, placeChecks, stateOfQuestion, verdictOf } from "./check-flow";
import type { TaskQuestion } from "./contract";

const OPTIONS = [{ id: "ok", label: "Confirmed" }, { id: "bad", label: "Problem found" }, { id: "meh", label: "Needs a look" }];
const at = (n: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

/** A check created at second `created`; `answer` is its current answer, `answeredAt` when it was saved. */
function check(id: string, created: number, extra: Partial<TaskQuestion> = {}): TaskQuestion {
  return {
    id, taskId: "task_example", kind: "check", askedByThread: null, prompt: id, steps: [], mode: "single", options: OPTIONS, allowOther: true,
    selectedOptionIds: [], answerText: null, answeredBy: null, revision: 1, createdAt: at(created), updatedAt: at(created), history: [], ...extra,
  } as TaskQuestion;
}
/** Answers a check at second `time`, pushing its earlier state into history like `answerQuestion` does. */
function answered(question: TaskQuestion, time: number, selected: string[], text: string | null = null): TaskQuestion {
  return { ...question, selectedOptionIds: selected, answerText: text, answeredBy: "owner", revision: question.revision + 1, updatedAt: at(time), history: [...question.history, { ...question, history: undefined } as never] };
}
/** `next` replaces `previous`: both are linked, as `createQuestion` does. */
function replace(previous: TaskQuestion, next: TaskQuestion, time: number): [TaskQuestion, TaskQuestion] {
  return [{ ...previous, supersededBy: next.id, supersededAt: at(time) }, { ...next, supersedes: previous.id }];
}
const summary = (questions: TaskQuestion[]) => checkFlow(questions).chains.map((chain) => `${chain.number}:${chain.headId}:${chain.state}:r${chain.round}`);

describe("verdictOf", () => {
  const state = (selectedOptionIds: string[], answerText: string | null = null) => ({ options: OPTIONS, selectedOptionIds, answerText });
  it("reads Confirmed, Problem found, text alone, a comment and a custom option", () => {
    expect(verdictOf(state([]))).toBe("open");
    expect(verdictOf(state(["ok"]))).toBe("confirmed");
    expect(verdictOf(state(["ok"], "looks fine"))).toBe("confirmed");
    expect(verdictOf(state(["bad"], "button is cut off"))).toBe("problem");
    expect(verdictOf(state([], "button is cut off"))).toBe("problem");
    expect(verdictOf(state(["meh"]))).toBe("answered");
    expect(verdictOf(state(["ok", "meh"]))).toBe("answered");
    expect(verdictOf(state([]), true)).toBe("withdrawn");
  });
});

describe("checkFlow order and numbers", () => {
  it("numbers checks in the order they were asked", () => {
    expect(summary([check("c3", 3), check("c1", 1), check("c2", 2)])).toEqual(["1:c1:open:r1", "2:c2:open:r1", "3:c3:open:r1"]);
  });
  it("a replacement takes its predecessor's place", () => {
    const [first, replacement] = replace(answered(check("c1", 1), 5, [], "wrong"), check("c4", 6), 6);
    expect(summary([first, check("c2", 2), check("c3", 3), replacement])).toEqual(["1:c4:open:r1", "2:c2:open:r1", "3:c3:open:r1"]);
  });
  it("a withdrawn check keeps its number, so later checks keep theirs", () => {
    const withdrawn = check("c2", 2, { withdrawnAt: at(4), withdrawnBy: "agent", withdrawReason: "obsolete" });
    expect(summary([check("c1", 1), withdrawn, check("c3", 3)])).toEqual(["1:c1:open:r1", "2:c2:withdrawn:r1", "3:c3:open:r1"]);
    const held = checkFlow([answered(check("c1", 1), 5, [], "broken"), withdrawn, check("c3", 3)]);
    expect(held.chains[2]!.heldBy).toEqual({ id: "c1", number: 1 });
    expect(placeChecks([check("c1", 1), withdrawn, check("c3", 3)]).map((question) => question.number)).toEqual([1, 2, 3]);
  });
  it("breaks equal creation times by id", () => {
    expect(summary([check("b", 1), check("a", 1)])).toEqual(["1:a:open:r1", "2:b:open:r1"]);
  });
  it("ignores decisions", () => {
    expect(summary([check("c1", 1), check("d1", 2, { kind: "decision" })])).toEqual(["1:c1:open:r1"]);
  });
});

describe("checkFlow hold", () => {
  const three = (first: TaskQuestion) => [first, check("c2", 2), check("c3", 3)];
  it("a problem holds the later open checks, and an answered one still counts", () => {
    const flow = checkFlow([...three(answered(check("c1", 1), 10, [], "broken"))]);
    expect(flow.chains.map((chain) => chain.state)).toEqual(["problem", "held", "held"]);
    expect(flow.chains[1]!.heldBy).toEqual({ id: "c1", number: 1 });
    expect([...flow.held.keys()]).toEqual(["c2", "c3"]);
    const answeredLater = checkFlow([answered(check("c1", 1), 10, ["bad"]), answered(check("c2", 2), 11, ["ok"], "fine"), check("c3", 3)]);
    expect(answeredLater.chains.map((chain) => chain.state)).toEqual(["problem", "confirmed", "held"]);
  });
  it("several failed checks: the first one holds", () => {
    const flow = checkFlow([answered(check("c1", 1), 10, ["bad"]), answered(check("c2", 2), 11, ["bad"]), check("c3", 3)]);
    expect(flow.chains[2]!.heldBy).toEqual({ id: "c1", number: 1 });
  });
  it("lifts when the failed check is replaced", () => {
    const [first, replacement] = replace(answered(check("c1", 1), 10, [], "broken"), check("c4", 12), 12);
    const flow = checkFlow([first, check("c2", 2), check("c3", 3), replacement]);
    expect(flow.chains.map((chain) => `${chain.number}:${chain.state}`)).toEqual(["1:open", "2:open", "3:open"]);
    expect(flow.held.size).toBe(0);
    expect(stateOfQuestion(flow, "c1")).toBe("superseded");
  });
  it("lifts when the failed check is reopened", () => {
    const reopened = { ...answered(check("c1", 1), 10, [], "broken"), selectedOptionIds: [], answerText: null, answeredBy: null, updatedAt: at(12) };
    expect(checkFlow(three(reopened)).held.size).toBe(0);
  });
  it("a held check can be answered, and then is not held", () => {
    const flow = checkFlow([answered(check("c1", 1), 10, [], "broken"), answered(check("c2", 2), 11, ["ok"]), check("c3", 3)]);
    expect(flow.chains.map((chain) => chain.state)).toEqual(["problem", "confirmed", "held"]);
  });
});

describe("checkFlow rounds", () => {
  it("a check asked after the last round finished starts a new one", () => {
    // c1 confirmed at 5; c2 asked at 10 with no later edit of c1.
    const flow = checkFlow([answered(check("c1", 1), 5, ["ok"]), check("c2", 10)]);
    expect(flow.chains.map((chain) => `${chain.number}:r${chain.round}`)).toEqual(["1:r1", "1:r2"]);
    expect(flow.rounds.map((round) => `${round.round}:${round.finished}:${round.visible}`)).toEqual(["1:true:false", "2:false:true"]);
  });
  it("a check asked after a problem stays in the round", () => {
    const flow = checkFlow([answered(check("c1", 1), 5, [], "broken"), check("c2", 10)]);
    expect(flow.chains.map((chain) => chain.round)).toEqual([1, 1]);
    expect(flow.chains[1]!.state).toBe("held");
  });
  it("checks created at the same instant share a round", () => {
    expect(checkFlow([answered(check("a", 5), 5, ["ok"]), check("b", 5)]).chains.map((chain) => chain.round)).toEqual([1, 1]);
  });
  it("a later edit of an earlier check does not move a later round", () => {
    const base = [answered(check("c1", 1), 5, ["ok"]), check("c2", 10)];
    const edits: TaskQuestion[][] = [
      // c1 answered Problem found at 20, with the confirmed answer in history
      [answered(base[0]!, 20, ["bad"]), base[1]!],
      // c1 reopened at 20
      [{ ...base[0]!, selectedOptionIds: [], answeredBy: null, revision: 3, updatedAt: at(20), history: [...base[0]!.history, { ...base[0]!, history: undefined } as never] }, base[1]!],
      // c1 replaced at 20
      [...replace(base[0]!, check("c3", 20), 20).slice(0, 1), base[1]!, ...replace(base[0]!, check("c3", 20), 20).slice(1)],
    ];
    for (const questions of edits) {
      const flow = checkFlow(questions);
      expect(flow.chainOf.get("c2")!.round).toBe(2);
      expect(flow.chainOf.get("c2")!.state).toBe("open");
      expect(flow.chainOf.get("c2")!.number).toBe(1);
      // round 1 is unfinished again and shows above round 2
      expect(flow.rounds[0]!.finished).toBe(false);
      expect(flow.rounds[0]!.visible).toBe(true);
    }
  });
  it("keeps round numbers when every check of an earlier round is withdrawn", () => {
    const withdrawnFirst = check("c1", 1, { withdrawnAt: at(2), withdrawnBy: "agent", withdrawReason: "obsolete" });
    expect(summary([withdrawnFirst, check("c2", 3)])).toEqual(["1:c1:withdrawn:r1", "1:c2:open:r2"]);
    // Withdrawing the last live check of round one later does not renumber round two.
    const confirmed = answered(check("c1", 1), 2, ["ok"]);
    const before = summary([confirmed, check("c2", 3)]);
    const after = summary([{ ...confirmed, withdrawnAt: at(4), withdrawnBy: "agent", withdrawReason: "obsolete" } as TaskQuestion, check("c2", 3)]);
    expect(before).toEqual(["1:c1:confirmed:r1", "1:c2:open:r2"]);
    expect(after).toEqual(["1:c1:withdrawn:r1", "1:c2:open:r2"]);
  });
  it("a problem in round one never holds round two", () => {
    const flow = checkFlow([answered(check("c1", 1), 5, ["ok"]), check("c2", 10), answered(check("c1", 1), 5, ["ok"])].slice(0, 2).map((question, index) => (index ? question : answered(question, 20, ["bad"]))));
    expect(flow.chainOf.get("c2")!.state).toBe("open");
    expect(flow.held.size).toBe(0);
  });
  it("reads a legacy check without history as unanswered until its oldest snapshot", () => {
    // c1 was answered at 5 but carries no history: before 5 it counts as unanswered, so c2 (asked at 3) joins round 1.
    expect(checkFlow([{ ...check("c1", 1), selectedOptionIds: ["ok"], answeredBy: "owner", updatedAt: at(5) }, check("c2", 3)]).chains.map((chain) => chain.round)).toEqual([1, 1]);
  });
  it("shows an unfinished earlier round and the last round only", () => {
    const flow = checkFlow([answered(check("a", 1), 3, ["ok"]), answered(check("b", 4), 6, ["ok"]), check("c", 8), check("d", 9)]);
    expect(flow.rounds.map((round) => [round.round, round.visible])).toEqual([[1, false], [2, false], [3, true]]);
  });
});
