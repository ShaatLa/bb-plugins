import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeThreadResponse, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { checkOutbox, forgetDrainForTests, HELD_ANSWER_MINUTES, retryDelaySeconds } from "./check-outbox";
import { createStructuredStore } from "./store";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Held answers", prefix: "HLD", color: "purple" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Checks" });
  const structured = createStructuredStore(bb, store);
  const outbox = checkOutbox(bb, store);
  harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async () => {});
  const ask = async (prompt: string, thread: string | null = "thr_example", taskId = task.id) =>
    (await structured.handlers.createQuestion({ taskId, kind: "check", askedByThread: thread, prompt, mode: "single", options: [] })).question;
  const answer = (question: { id: string; revision: number; options: { id: string; label: string }[] }, label: string | null, text?: string) =>
    structured.handlers.answerQuestion({
      questionId: question.id, revision: question.revision, authorName: "Owner", answerText: text ?? null,
      selectedOptionIds: label ? [question.options.find((option) => option.label === label)!.id] : [],
    });
  const sent = () => harness.sdk.callsTo("threads.send").map((call) => JSON.stringify(call));
  const rows = () => bb.storage.database().prepare("SELECT question_id, state FROM check_answer_outbox").all() as { question_id: string; state: string }[];
  return { bb, harness, store, task, project, structured, outbox, ask, answer, sent, rows };
}

describe("check answers batched for the agent", () => {
  it("holds an Approve while another check is open and sends one message when the last one closes", async () => {
    const { ask, answer, sent, outbox, task, structured } = setup();
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    expect((await answer(one, "Approve")).notification).toBe("held");
    expect(sent()).toEqual([]);
    const result = await answer(two, "Approve");
    expect(result.notification).toBe("sent");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain(`${task.key}: 2 of 2 checks approved.`);
    expect(sent()[0]).toContain("Does reload work?");
    expect(sent()[0]).toContain("Does save work?");
    expect(sent()[0].match(/Read the current saved decision/g)).toHaveLength(1);
    await outbox.drain();
    expect(sent()).toHaveLength(1);
    expect(structured.listQuestions(task.id)).toHaveLength(2);
  });

  it("sends a Reject at once with the held approvals", async () => {
    const { ask, answer, sent, rows } = setup();
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    await answer(one, "Approve");
    expect((await answer(two, "Reject")).notification).toBe("sent");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("1 of 2 checks approved, 1 rejected.");
    expect(rows()).toEqual([]);
  });

  it("answers a withdrawn held Approve as never delivered, and a delivered one with today's undo text", async () => {
    const { ask, answer, sent, task } = setup();
    const [one] = [await ask("Does reload work?"), await ask("Does save work?")];
    const held = (await answer(one, "Approve")).question;
    const result = await answer(held, null);
    expect(result.notification).toBe("sent");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("before it was delivered; nothing to undo");
    expect(sent()[0]).not.toContain("undo or report anything");
    expect(sent()[0]).toContain(`${task.key}: 1 answer withdrawn.`);
    expect(sent()[0]).not.toContain("1 of");
    // A delivered answer: Approve the only open check, then withdraw it.
    const solo = setup();
    const check = await solo.ask("Does reload work?");
    const approved = (await solo.answer(check, "Approve")).question;
    await solo.answer(approved, null);
    expect(solo.sent()[1]).toContain("undo or report anything you already did");
  });

  it("drops a held Approve when its check is reopened or superseded, and sends nothing if it was alone", async () => {
    const { ask, answer, sent, structured, task, rows, outbox } = setup();
    const [one, two, three] = [await ask("Does reload work?"), await ask("Does save work?"), await ask("Does print work?")];
    const first = (await answer(one, "Approve")).question;
    await answer(two, "Approve");
    await structured.handlers.updateQuestion({ questionId: first.id, revision: first.revision, prompt: first.prompt, mode: "single", options: first.options, reopen: true, authorName: "Owner" });
    await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: "thr_example", prompt: "Does print twice work?", mode: "single", options: [], supersedes: { questionId: three.id, revision: 1 } });
    expect(rows()).toHaveLength(1);
    expect(sent()).toEqual([]);
    await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: first.id, revision: first.revision + 1, reason: "no longer needed", authorName: "Owner" });
    const open = structured.listQuestions(task.id).find((question) => question.prompt === "Does print twice work?")!;
    await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: open.id, revision: 1, reason: "no longer needed", authorName: "Owner" });
    await outbox.drain();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("1 of 1 check approved.");
    expect(sent()[0]).toContain("Does save work?");
    expect(sent()[0]).not.toContain("Does reload work?");
  });

  it("sends a held batch only once the safety timer has run out", async () => {
    const { ask, answer, sent, outbox } = setup();
    await ask("Does reload work?");
    const second = await ask("Does save work?");
    await answer(second, "Approve");
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    outbox.sweep(at(HELD_ANSWER_MINUTES - 1));
    await outbox.drain();
    expect(sent()).toEqual([]);
    outbox.sweep(at(HELD_ANSWER_MINUTES + 1));
    await outbox.drain();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("1 of 1 check approved.");
  });

  it("sends rows left sending at a restart exactly once more, with the stored text", async () => {
    const { ask, answer, sent, outbox, harness, rows, bb } = setup();
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    await answer(one, "Approve");
    // The process dies after the Reject committed and was claimed, before its send: the claim and its rows stay.
    harness.sdk.stub("threads.get", () => new Promise(() => {}));
    void answer(two, "Reject");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(rows().map((row) => row.state)).toEqual(["sending", "sending"]);
    const claimed = (bb.storage.database().prepare("SELECT body FROM check_answer_claims").get() as { body: string }).body;
    forgetDrainForTests(bb);
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await outbox.drain();
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain(JSON.stringify(claimed).slice(1, -1));
    expect(sent()[0]).toContain("1 of 2 checks approved, 1 rejected.");
    expect(rows()).toEqual([]);
    await outbox.drain();
    expect(sent()).toHaveLength(1);
  });

  it("never changes a claimed answer: a newer write follows in its own message", async () => {
    const { ask, answer, sent, outbox, harness, rows, structured, task } = setup();
    const one = await ask("Does reload work?");
    // The only check: Approve claims at once; the send is held open.
    let release!: () => void;
    harness.sdk.stub("threads.send", () => new Promise<void>((resolve) => { release = resolve; }));
    const pending = answer(one, "Approve");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rows().map((row) => row.state)).toEqual(["sending"]);
    const approved = structured.listQuestions(task.id)[0]!;
    const withdrawn = answer(approved, null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    harness.sdk.stub("threads.send", async () => {});
    await pending;
    await withdrawn;
    await outbox.drain();
    expect(sent().length).toBe(2);
    expect(sent()[0]).toContain("Answer:** Approve");
    expect(sent()[1]).toContain("Answer withdrawn");
    expect(sent()[1]).toContain("undo or report anything");
    expect(rows()).toEqual([]);
  });

  it("sends one message per recipient when the last check closes, and a Reject only releases its own thread", async () => {
    const { ask, answer, sent, rows } = setup();
    const a1 = await ask("Does A reload?", "thr_a");
    const a2 = await ask("Does A save?", "thr_a");
    const b1 = await ask("Does B reload?", "thr_b");
    const b2 = await ask("Does B save?", "thr_b");
    await answer(a1, "Approve");
    await answer(b1, "Approve");
    await answer(a2, "Reject");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("thr_a");
    expect(rows()).toHaveLength(1);
    await answer(b2, "Approve");
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toContain("2 of 2 checks approved.");
  });

  it("sends a decision answer alone while approvals stay held, and holds nothing without a recipient", async () => {
    const { ask, answer, sent, rows, structured, task } = setup();
    const [one] = [await ask("Does reload work?"), await ask("Does save work?")];
    await answer(one, "Approve");
    const decision = (await structured.handlers.createQuestion({ taskId: task.id, kind: "decision", askedByThread: "thr_example", prompt: "Proceed?", mode: "single", options: ["Yes"] })).question;
    await structured.handlers.answerQuestion({ questionId: decision.id, revision: 1, selectedOptionIds: [decision.options[0]!.id], authorName: "Owner" });
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("Proceed?");
    expect(rows().map((row) => row.state)).toEqual(["held"]);
    const bare = setup();
    const lone = await bare.ask("Does reload work?", null);
    await bare.ask("Does save work?", null);
    expect((await bare.answer(lone, "Approve")).notification).toBe("none");
    expect(bare.rows()).toEqual([]);
  });

  it("still flushes the batch of an archived card when its last check closes", async () => {
    const { store, ask, answer, sent, rows, task } = setup();
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    await answer(one, "Approve");
    // Only a done or canceled card is archived.
    store.tasks.updateTask(task.id, { status: "canceled" });
    store.tasks.setTaskArchived(task.id, true);
    expect(rows().map((row) => row.state)).toEqual(["held"]);
    expect((await answer(two, "Approve")).notification).toBe("sent");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("2 of 2 checks approved.");
    expect(rows()).toEqual([]);
  });

  it("removes the held rows and the open claim of a deleted card, and sends nothing", async () => {
    const { ask, answer, sent, outbox, harness, rows, bb, store, task } = setup();
    const [one, two, three] = [await ask("Does reload work?"), await ask("Does save work?"), await ask("Does print work?")];
    await ask("Does export work?");
    await answer(one, "Approve");
    // The Reject is claimed with the first approval and its send never ends: an open claim with `sending` rows.
    harness.sdk.stub("threads.get", () => new Promise(() => {}));
    void answer(two, "Reject");
    await new Promise((resolve) => setTimeout(resolve, 30));
    // A further Approve, held because the last check is still open.
    await answer(three, "Approve");
    expect(rows().map((row) => row.state).sort()).toEqual(["held", "sending", "sending"]);
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS n FROM check_answer_claims").get()).toEqual({ n: 1 });
    store.tasks.deleteTask(task.id);
    expect(rows()).toEqual([]);
    expect(bb.storage.database().prepare("SELECT COUNT(*) AS n FROM check_answer_claims").get()).toEqual({ n: 0 });
    forgetDrainForTests(bb);
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await outbox.drain();
    expect(sent()).toEqual([]);
  });

  it("still flushes the batch of a card moved to another project, under its new key", async () => {
    const { ask, answer, sent, store, task } = setup();
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    await answer(one, "Approve");
    const other = store.tasks.createProject({ name: "Elsewhere", prefix: "ELS", color: "blue" });
    store.tasks.moveTaskToProject(task.id, other.id);
    await answer(two, "Approve");
    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toContain("ELS-");
    expect(sent()[0]).not.toContain("HLD-");
  });

  it("sends a row that joins a running drain without the timer, and names a successor committed before its claim", async () => {
    const { ask, answer, sent, harness, structured } = setup();
    const one = await ask("Does reload work?");
    // The first claim's send is held open, so the drain is running.
    let open!: () => void;
    harness.sdk.stub("threads.get", async ({ threadId }) => {
      await new Promise<void>((resolve) => { open = resolve; });
      return makeThreadResponse({ id: threadId, status: "idle" });
    });
    const first = answer(one, "Approve");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const approved = structured.listQuestions(one.taskId)[0]!;
    const withdrawing = answer(approved, null);
    const { question: next } = await structured.handlers.createQuestion({ taskId: one.taskId, kind: "check", askedByThread: "thr_example", prompt: "Does reload twice work?", mode: "single", options: [], supersedes: { questionId: one.id, revision: approved.revision + 1 } });
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    open();
    await Promise.all([first, withdrawing]);
    expect(sent()).toHaveLength(2);
    expect(sent()[0]).toContain("Answer:** Approve");
    expect(sent()[1]).toContain("Answer withdrawn");
    expect(sent()[1]).toContain(`This check is superseded by ${next.id}`);
  });

  it("adds the last-open-check hint once, when the newest answer confirms a check with a design line", async () => {
    const { ask, answer, sent, task, structured } = setup();
    const withDesign = async (prompt: string) =>
      (await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: "thr_example", prompt, mode: "single", options: [], beyondDesign: "none" })).question;
    const [one, two] = [await withDesign("Does reload work?"), await withDesign("Does save work?")];
    await answer(one, "Approve");
    await answer(two, "Approve");
    expect(sent()).toHaveLength(1);
    expect(sent()[0].match(/confirmed the last open check/g)).toHaveLength(1);
    // A newest answer without a design line owes no hint, even when an earlier one had it.
    const [three, four] = [await withDesign("Does print work?"), await ask("Does export work?")];
    await answer(three, "Approve");
    await answer(four, "Approve");
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).not.toContain("confirmed the last open check");
  });

  it("sends nothing for a held Approve whose check was replaced when it was alone", async () => {
    const { ask, answer, sent, structured, task, rows, outbox } = setup();
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    const first = (await answer(one, "Approve")).question;
    const { question: replacement } = await structured.handlers.createQuestion({ taskId: task.id, kind: "check", askedByThread: "thr_example", prompt: "Does reload twice work?", mode: "single", options: [], supersedes: { questionId: one.id, revision: first.revision } });
    expect(rows()).toEqual([]);
    await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: two.id, revision: 1, reason: "not needed", authorName: "Owner" });
    await structured.handlers.withdrawQuestion({ taskId: task.id, questionId: replacement.id, revision: 1, reason: "not needed", authorName: "Owner" });
    await outbox.drain();
    expect(sent()).toEqual([]);
  });

  it("recovers a due Reject that was never claimed, together with the held approvals and an interrupted claim", async () => {
    const { ask, answer, sent, outbox, harness, rows, bb, store, project } = setup();
    // Another card's claim is on its way when the process dies, so the drain never reaches the Reject.
    const other = store.tasks.createTask({ projectId: project.id, title: "Other" });
    const lone = await ask("Does other work?", "thr_example", other.id);
    const [one, two] = [await ask("Does reload work?"), await ask("Does save work?")];
    harness.sdk.stub("threads.get", () => new Promise(() => {}));
    void answer(lone, "Approve");
    await new Promise((resolve) => setTimeout(resolve, 30));
    void answer(one, "Approve");
    void answer(two, "Reject");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rows().map((row) => row.state).sort()).toEqual(["due", "due", "sending"]);
    forgetDrainForTests(bb);
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await outbox.drain();
    expect(sent()).toHaveLength(2);
    expect(sent()[0]).toContain("Does other work?");
    expect(sent()[1]).toContain("1 of 2 checks approved, 1 rejected.");
    expect(rows()).toEqual([]);
  });

  it("resends an interrupted claim byte for byte, then sends the newer answers in a second message", async () => {
    const { ask, answer, sent, outbox, harness, rows, bb, structured, task } = setup();
    const [one, two, three] = [await ask("Does reload work?"), await ask("Does save work?"), await ask("Does print work?")];
    await answer(one, "Approve");
    harness.sdk.stub("threads.get", () => new Promise(() => {}));
    void answer(two, "Reject");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const claimed = (bb.storage.database().prepare("SELECT body FROM check_answer_claims").get() as { body: string }).body;
    // While it is interrupted the owner changes check one and approves check three.
    const current = structured.listQuestions(task.id).find((question) => question.id === one.id)!;
    void answer(current, "Reject");
    void answer(three, "Approve");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(rows().filter((row) => row.state === "sending")).toHaveLength(2);
    forgetDrainForTests(bb);
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await outbox.drain();
    expect(sent()).toHaveLength(2);
    expect(sent()[0]).toContain(JSON.stringify(claimed).slice(1, -1));
    expect(sent()[1]).toContain("Does reload work?");
    expect(sent()[1]).toContain("Does print work?");
    expect(sent()[1]).not.toContain("Does save work?");
    expect(rows()).toEqual([]);
  });

  it("says undo for a withdrawn held answer when an earlier answer to the check already reached the agent", async () => {
    const { ask, answer, sent, rows } = setup();
    const one = await ask("Does reload work?");
    const delivered = (await answer(one, "Approve")).question;
    expect(sent()).toHaveLength(1);
    await ask("Does save work?");
    // A changed answer is held again because a check is open; withdrawing it must not say "nothing to undo".
    const held = (await answer(delivered, "Approve", "same, with a remark")).question;
    expect(rows().map((row) => row.state)).toEqual(["held"]);
    await answer(held, null);
    expect(sent()).toHaveLength(2);
    expect(sent()[1]).toContain("undo or report anything");
    expect(sent()[1]).not.toContain("before it was delivered");
  });

  it("reads the card key when the batch is claimed and keeps it in the stored message across a move and a restart", async () => {
    const { ask, answer, sent, outbox, harness, bb, store, task } = setup();
    const one = await ask("Does reload work?");
    harness.sdk.stub("threads.get", () => new Promise(() => {}));
    void answer(one, "Approve");
    await new Promise((resolve) => setTimeout(resolve, 30));
    const other = store.tasks.createProject({ name: "Elsewhere", prefix: "ELS", color: "blue" });
    store.tasks.moveTaskToProject(task.id, other.id);
    forgetDrainForTests(bb);
    harness.sdk.stub("threads.get", async ({ threadId }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await outbox.drain();
    expect(sent()).toHaveLength(1);
    // The whole message the host received, header included, still names the key it was claimed under.
    expect(sent()[0]).toContain("- Task: [HLD-1](/plugins/work-board/work-board/task/HLD-1)");
    expect(sent()[0]).not.toContain("ELS-");
    expect(sent()[0]).toContain("HLD-1: 1 of 1 check approved.");
    expect(sent()[0]).toContain("question list HLD-1 --json");
  });

  /** A send that fails for the threads in `down` and records what reached the others. */
  const flaky = (harness: FakePluginHarness, down: Set<string>) => {
    const delivered: { threadId: string; text: string }[] = [];
    let attempts = 0;
    harness.sdk.stub("threads.send", async (...args: unknown[]) => {
      const input = args[0] as { threadId: string };
      attempts++;
      if (down.has(input.threadId)) throw new Error("down");
      delivered.push({ threadId: input.threadId, text: JSON.stringify(input) });
    });
    return { delivered, attempts: () => attempts };
  };
  /** A later moment, past the retry wait. */
  const later = () => new Date(Date.now() + 60_000);
  const claims = (bb: { storage: { database(): { prepare(sql: string): { all(): unknown[] } } } }) => bb.storage.database().prepare("SELECT claim_id, body, attempts FROM check_answer_claims").all() as { claim_id: string; body: string; attempts: number }[];

  it("keeps the claim when a send fails and sends the same body once on the next drain", async () => {
    const { ask, answer, outbox, harness, rows, bb } = setup();
    const down = new Set(["thr_example"]);
    const { delivered } = flaky(harness, down);
    const one = await ask("Does reload work?");
    expect((await answer(one, "Approve")).notification).toBe("failed");
    expect(delivered).toEqual([]);
    const [claim] = claims(bb);
    expect(claim).toMatchObject({ attempts: 1 });
    expect(rows().map((row) => row.state)).toEqual(["sending"]);
    down.clear();
    // Too soon: a drain before the retry wait leaves the claim alone.
    await outbox.drain();
    expect(delivered).toEqual([]);
    expect(claims(bb)).toHaveLength(1);
    await outbox.drain(later());
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain(JSON.stringify(claim!.body).slice(1, -1).split("\\n\\n").slice(1).join("\\n\\n"));
    expect(claims(bb)).toEqual([]);
    expect(rows()).toEqual([]);
    await outbox.drain(later());
    expect(delivered).toHaveLength(1);
  });

  it("never drops a claim for failing: after 5 failures it is still there and the next allowed drain sends the stored body once", async () => {
    const { ask, answer, outbox, harness, rows, bb } = setup();
    const down = new Set(["thr_example"]);
    const { delivered, attempts } = flaky(harness, down);
    const one = await ask("Does reload work?");
    expect((await answer(one, "Approve")).notification).toBe("failed");
    const [claim] = claims(bb);
    // Each drain is far enough past the last attempt to be allowed.
    for (let failed = 1; failed < 5; failed++) await outbox.drain(new Date(Date.now() + 11 * 60_000));
    expect(attempts()).toBe(5);
    expect(claims(bb)).toEqual([expect.objectContaining({ claim_id: claim!.claim_id, attempts: 5 })]);
    expect(rows().map((row) => row.state)).toEqual(["sending"]);
    expect(harness.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("could not be delivered"))).toHaveLength(1);
    down.clear();
    await outbox.drain(new Date(Date.now() + 11 * 60_000));
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain(JSON.stringify(claim!.body).slice(1, -1).split("\\n\\n").slice(1).join("\\n\\n"));
    expect(claims(bb)).toEqual([]);
    expect(rows()).toEqual([]);
  });

  it("backs off between attempts: 30 s, 60 s, 120 s, doubling up to 10 minutes", async () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(retryDelaySeconds)).toEqual([30, 60, 120, 240, 480, 600, 600, 600]);
    const { ask, answer, outbox, harness, bb } = setup();
    const { attempts } = flaky(harness, new Set(["thr_example"]));
    await answer(await ask("Does reload work?"), "Approve");
    for (const [index, wait] of [30, 60, 120, 240, 480, 600, 600].entries()) {
      const [{ attempts: made, claim_id }] = claims(bb) as { attempts: number; claim_id: string }[] as [{ attempts: number; claim_id: string }];
      expect(made).toBe(index + 1);
      const at = (bb.storage.database().prepare("SELECT attempted_at FROM check_answer_claims WHERE claim_id = ?").get(claim_id) as { attempted_at: string }).attempted_at;
      await outbox.drain(new Date(Date.parse(at) + wait * 1000 - 1000));
      expect(attempts()).toBe(index + 1);
      await outbox.drain(new Date(Date.parse(at) + wait * 1000));
      expect(attempts()).toBe(index + 2);
    }
  });

  it("holds back newer answers for a thread behind its failed older claim, but not other threads", async () => {
    const { ask, answer, outbox, harness, store, project, rows, bb } = setup();
    const down = new Set(["thr_a"]);
    const { delivered } = flaky(harness, down);
    const second = store.tasks.createTask({ projectId: project.id, title: "Second" });
    const third = store.tasks.createTask({ projectId: project.id, title: "Third" });
    const [a1, a2, b1] = [await ask("Does A reload?", "thr_a"), await ask("Does A save?", "thr_a", second.id), await ask("Does B reload?", "thr_b", third.id)];
    await answer(a1, "Approve");
    const [claim] = claims(bb);
    expect(claim).toBeDefined();
    // Newer batch for the same thread: saved and due, but neither claimed nor sent.
    expect((await answer(a2, "Approve")).notification).toBe("failed");
    expect(claims(bb)).toHaveLength(1);
    expect(rows().map((row) => row.state).sort()).toEqual(["due", "sending"]);
    // Another thread is not blocked.
    await answer(b1, "Approve");
    expect(delivered.map((item) => item.threadId)).toEqual(["thr_b"]);
    // After the retry, the older claim goes first with its stored body, then the newer batch.
    down.clear();
    await outbox.drain(later());
    expect(delivered.map((item) => item.threadId)).toEqual(["thr_b", "thr_a", "thr_a"]);
    expect(delivered[1]!.text).toContain("Does A reload?");
    expect(delivered[2]!.text).toContain("Does A save?");
    expect(rows()).toEqual([]);
    expect(claims(bb)).toEqual([]);
  });
});
