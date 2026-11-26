import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { refreshCheckFlow, rebuildCheckFlow } from "../db/check-flow";
import { initializeTasksSchema, MIGRATIONS } from "../db/schema";
import { checkFlow } from "../shared/check-flow";
import { questionSchema, type TaskQuestion } from "../shared/contract";
import { createStructuredStore } from "./store";
import { openDecisionIds } from "../plans/pause";
import { staleRows } from "../attention/observe";
import { navigationBadgeCounts } from "../api/badge";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  const project = store.tasks.createProject({ name: "Flow", prefix: "FLW", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Checks", status: "in_progress" });
  const structured = createStructuredStore(bb, store);
  const db = bb.storage.database();
  /** Asks a check; its creation time is set explicitly so the order never depends on the clock. */
  const ask = async (prompt: string, second: number, extra: Record<string, unknown> = {}) => {
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: null, prompt, mode: "single", options: [], ...extra });
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    db.prepare("UPDATE task_questions SET payload = json_set(payload, '$.createdAt', ?) WHERE id = ?").run(at, question.id);
    refreshCheckFlow(db, task.id);
    return question;
  };
  const answer = (question: { id: string; options: { id: string }[] }, selected: number[], text?: string) =>
    structured.handlers.answerQuestion({
      questionId: question.id, revision: structured.listQuestions(task.id).find((q) => q.id === question.id)!.revision,
      selectedOptionIds: selected.map((index) => question.options[index]!.id), answerText: text, authorName: "You",
    });
  const held = () => db.prepare<[], { question_id: string; held_by: string }>("SELECT question_id, held_by FROM task_question_holds ORDER BY question_id").all();
  return { bb, harness, store, project, task, structured, db, ask, answer, held };
}

describe("a check answer is a verdict plus a comment", () => {
  it("accepts an option with text for a check and refuses it for a single-choice decision", async () => {
    const { structured, task } = setup();
    const check = (await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: null, prompt: "Works?", mode: "single", options: [] })).question;
    const decision = (await structured.handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: null, prompt: "Which?", mode: "single", options: ["A", "B"] })).question;
    const answered = (question: typeof check) => ({ ...question, selectedOptionIds: [question.options[0]!.id], answerText: "with a note", answeredBy: "You" });
    expect(questionSchema.safeParse(answered(check)).success).toBe(true);
    expect(questionSchema.safeParse(answered(decision)).success).toBe(false);
    expect(questionSchema.safeParse({ ...answered(check), selectedOptionIds: check.options.map((option) => option.id) }).success).toBe(false);
  });

  it("stores both on answerQuestion and keeps both through a later edit", async () => {
    const { structured, task, ask, answer } = setup();
    const check = await ask("Does it work?", 1);
    const { question } = await answer(check, [0], "Looks fine");
    expect(question).toMatchObject({ selectedOptionIds: [check.options[0]!.id], answerText: "Looks fine", answeredBy: "You" });
    expect(structured.listQuestions(task.id)[0]).toMatchObject({ selectedOptionIds: [check.options[0]!.id], answerText: "Looks fine" });
    await expect(structured.handlers.answerQuestion({ questionId: check.id, revision: question.revision, selectedOptionIds: [check.options[0]!.id], answerText: "Another note", authorName: "You" })).resolves.toBeTruthy();
  });

  it("still counts Confirmed with a comment as a confirmation for the readiness reminder", async () => {
    const { harness, structured, task } = setup();
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async () => {});
    const { question } = await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: "thr_example", prompt: "Does reload work?", mode: "single", options: [], smoke: "Opened the form and saved a draft.", beyondDesign: "none" });
    await structured.handlers.answerQuestion({ questionId: question.id, revision: 1, selectedOptionIds: [question.options[0]!.id], answerText: "Checked twice", authorName: "You" });
    expect(JSON.stringify(harness.sdk.callsTo("threads.send").at(-1))).toContain("confirmed the last open check");
  });
});

describe("holds after a failed check", () => {
  it("holds the later open checks after a text-only answer, and lifts on replacement", async () => {
    const { structured, task, ask, answer, held } = setup();
    const [one, two, three] = [await ask("One?", 1), await ask("Two?", 2), await ask("Three?", 3)];
    expect(held()).toEqual([]);
    await answer(one, [], "It is broken");
    expect(held()).toEqual([two, three].map((question) => ({ question_id: question.id, held_by: one.id })).sort((a, b) => a.question_id.localeCompare(b.question_id)));
    const current = structured.listQuestions(task.id).find((question) => question.id === one.id)!;
    const replacement = await ask("One again?", 4, { supersedes: { questionId: one.id, revision: current.revision } });
    expect(held()).toEqual([]);
    const flow = checkFlow(structured.listQuestions(task.id));
    expect(flow.chains.map((chain) => [chain.number, chain.headId, chain.state])).toEqual([[1, replacement.id, "open"], [2, two.id, "open"], [3, three.id, "open"]]);
  });

  it("lifts the hold when the failed check is reopened, and holds again on a Problem found option", async () => {
    const { structured, task, ask, answer, held } = setup();
    const [one, two] = [await ask("One?", 1), await ask("Two?", 2)];
    const { question } = await answer(one, [1]);
    expect(held()).toEqual([{ question_id: two.id, held_by: one.id }]);
    await structured.handlers.updateQuestion({ questionId: one.id, revision: question.revision, prompt: one.prompt, mode: "single", options: one.options, reopen: true, authorName: "Agent" });
    expect(held()).toEqual([]);
    expect(structured.listQuestions(task.id)).toHaveLength(2);
  });

  it("a held check can still be answered, and a withdrawn or deleted one leaves the table", async () => {
    const { structured, task, ask, answer, held } = setup();
    const [one, two, three] = [await ask("One?", 1), await ask("Two?", 2), await ask("Three?", 3)];
    await answer(one, [], "broken");
    await answer(two, [0]);
    expect(held().map((row) => row.question_id)).toEqual([three.id]);
    const current = structured.listQuestions(task.id).find((question) => question.id === three.id)!;
    await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: three.id, revision: current.revision, reason: "obsolete", authorName: "Agent" });
    expect(held()).toEqual([]);
  });

  it("keeps the table equal to checkFlow after every kind of write, on generated fixtures", async () => {
    let writes = 0, heldSeen = 0;
    for (const seed of [3, 11, 29]) {
      const { structured, task, db, ask, held } = setup();
      let state = seed;
      const random = (n: number) => ((state = (state * 1103515245 + 12345) % 2147483648) >> 8) % n;
      let second = 1;
      const parity = () => {
        const expected = [...checkFlow(structured.listQuestions(task.id)).held].map(([question_id, held_by]) => ({ question_id, held_by })).sort((a, b) => a.question_id.localeCompare(b.question_id));
        expect(held()).toEqual(expected);
      };
      for (let step = 0; step < 30; step++) {
        const all = structured.listQuestions(task.id);
        const heads = all.filter((question) => question.kind === "check" && !question.supersededBy && !question.withdrawnAt);
        const target = heads[random(heads.length)];
        try {
          const op = random(7);
          if (op === 0 || !target) await ask(`Check ${step}`, random(3) ? second++ : second);
          else if (op === 1 || op === 2) await structured.handlers.answerQuestion({ questionId: target.id, revision: target.revision, selectedOptionIds: random(2) ? [target.options[random(2)]!.id] : [], answerText: random(2) ? "note" : undefined, authorName: "You" });
          else if (op === 3) await structured.handlers.updateQuestion({ questionId: target.id, revision: target.revision, prompt: target.prompt, mode: "single", options: target.options, reopen: true, authorName: "Agent" });
          else if (op === 4) await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: target.id, revision: target.revision, reason: "obsolete", authorName: "Agent" });
          else if (op === 5) await ask(`Replacement ${step}`, random(3) ? second++ : second, { supersedes: { questionId: target.id, revision: target.revision } });
          else await structured.handlers.deleteQuestion({ questionId: target.id, revision: target.revision });
          writes++;
        } catch {
          // A refused write (for example a clear of an open question) changes nothing; the table must still match.
        }
        parity();
        heldSeen += held().length;
      }
      expect(db).toBeTruthy();
    }
    // The fixtures must exercise real writes and real holds, not only refusals.
    expect(writes).toBeGreaterThan(30);
    expect(heldSeen).toBeGreaterThan(5);
  });

  it("is rebuilt by the migration and by rebuildCheckFlow", async () => {
    const { structured, task, db, ask, answer, held } = setup();
    const [one, two] = [await ask("One?", 1), await ask("Two?", 2)];
    await answer(one, [], "broken");
    const expected = [{ question_id: two.id, held_by: one.id }];
    expect(held()).toEqual(expected);
    db.prepare("DELETE FROM task_question_holds").run();
    rebuildCheckFlow(db);
    expect(held()).toEqual(expected);
    db.exec("DROP TABLE task_question_holds");
    db.prepare("DELETE FROM schema_version WHERE version = ?").run(MIGRATIONS.findIndex((step) => typeof step === "function" && step.toString().includes("CREATE_HOLDS_TABLE")) + 1);
    initializeTasksSchema(db);
    expect(held()).toEqual(expected);
    expect(structured.listQuestions(task.id)).toHaveLength(2);
  });
});

describe("what waits on the owner", () => {
  it("does not count a held check, and counts it again once its predecessor is fixed", async () => {
    const { bb, store, project, task, structured, db, ask, answer } = setup();
    const [one, two] = [await ask("One?", 1), await ask("Two?", 2)];
    const waiting = async () => ({
      stale: Boolean(staleRows(db, [task.id])[0]!.waiting_owner),
      filter: store.tasks.listTasks({ waitingOnOwner: true }).some((item) => item.id === task.id),
      badge: navigationBadgeCounts(bb, store, ["waiting_on_owner", "needs_answer"], Date.now()).counts,
      counts: (await structured.handlers.questionCounts({ taskIds: [task.id] })).counts[0]!,
    });
    expect(await waiting()).toMatchObject({ stale: true, filter: true, badge: { waiting_on_owner: 1, needs_answer: 1 }, counts: { unanswered: 2, checks: 2, waitingOnOwner: true } });
    await answer(one, [], "broken");
    expect(await waiting()).toMatchObject({ stale: false, filter: false, badge: { waiting_on_owner: 0, needs_answer: 0 }, counts: { unanswered: 0, checks: 0, waitingOnOwner: false } });
    // The plan-review pause counts open decisions only, so held checks never touch it.
    expect(openDecisionIds(db, task.id)).toEqual([]);
    const current = structured.listQuestions(task.id).find((question) => question.id === one.id)!;
    await ask("One again?", 3, { supersedes: { questionId: one.id, revision: current.revision } });
    expect(await waiting()).toMatchObject({ stale: true, filter: true, counts: { unanswered: 2 } });
    expect(project.id).toBeTruthy();
    expect(two.id).toBeTruthy();
  });
});

describe("agents read the flow", () => {
  it("lists checks in flow order with number, state, heldBy and round, and says why one is held", async () => {
    const { harness, task, ask, answer, structured } = setup();
    const [one, two] = [await ask("One?", 1), await ask("Two?", 2)];
    await answer(one, [], "broken");
    const json = JSON.parse((await harness.runCli(["question", "list", task.key, "--json"])).stdout) as { questions: (TaskQuestion & { number: number; state: string; round: number; heldBy?: { id: string; number: number } })[] };
    expect(json.questions.map((question) => [question.id, question.number, question.state, question.round])).toEqual([[one.id, 1, "problem", 1], [two.id, 2, "held", 1]]);
    expect(json.questions[1]!.heldBy).toEqual({ id: one.id, number: 1 });
    const text = await harness.runCli(["question", "list", task.key]);
    expect(text.stderr).toContain(`On hold: waiting for the fix of check 1 (${one.id})`);
    const brief = JSON.parse((await harness.runCli(["show", task.key, "--brief", "--json"])).stdout) as { questions: { id: string; number: number; state: string }[]; task: { waitingOnOwner: boolean } };
    expect(brief.questions.map((question) => [question.id, question.number, question.state])).toEqual([[one.id, 1, "problem"], [two.id, 2, "held"]]);
    expect(brief.task.waitingOnOwner).toBe(false);
    expect((await harness.runCli(["show", task.key, "--brief"])).stdout).toContain("On hold: waiting for the fix of check 1");
    expect(structured.listQuestions(task.id)).toHaveLength(2);
  });
});
