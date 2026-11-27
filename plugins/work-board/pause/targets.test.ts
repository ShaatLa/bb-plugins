import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { setPauseMode, startManualPause } from "./store";
import { sweepPauseSignals } from "./signals";
import { pauseTargets } from "./targets";

async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const card = store.tasks.createTask({ projectId: project.id, title: "Card", status: "in_progress" });
  const db = bb.storage.database();
  const ask = async (kind: "check" | "decision", prompt: string) => ((await harness.callRpc("createQuestion", { taskId: card.id, kind, prompt, ...(kind === "decision" ? { options: [{ label: "First" }, { label: "Second" }] } : {}) })) as { question: { id: string } }).question;
  const blocker = (title: string) => {
    const task = store.tasks.createTask({ projectId: project.id, title, status: "todo" });
    db.prepare("INSERT INTO task_dependencies(task_id,blocking_task_id) VALUES (?,?)").run(card.id, task.id);
    return task;
  };
  return { bb, harness, store, project, card, db, ask, blocker };
}

it("names only the predecessors that still hold the card, and keeps the stored reason", async () => {
  const { bb, harness, store, project, card, db, blocker } = await setup();
  const first = blocker("First");
  const second = blocker("Second");
  setPauseMode(db, project.id, "on");
  await sweepPauseSignals(bb);
  const reason = () => (db.prepare("SELECT reason FROM task_pauses WHERE task_id=? AND signal='held'").get(card.id) as { reason: string }).reason;
  const stored = reason();
  expect(pauseTargets(db, [card.id], []).held.get(card.id)).toEqual([{ kind: "task", taskKey: "EXA-2" }, { kind: "task", taskKey: "EXA-3" }]);
  store.tasks.updateTask(first.id, { status: "done" });
  expect(pauseTargets(db, [card.id], []).held.get(card.id)).toEqual([{ kind: "task", taskKey: "EXA-3" }]);
  db.prepare("DELETE FROM task_dependencies WHERE blocking_task_id=?").run(second.id);
  expect(pauseTargets(db, [card.id], []).held.has(card.id)).toBe(false);
  expect(reason()).toBe(stored);
  await harness.dispose();
});

it("names the open questions: checks by number, decisions by prompt, never a held check or an answered one", async () => {
  const { bb, harness, project, card, db, ask } = await setup();
  const decision = await ask("decision", "Which of the two example approaches should the card take, given the long prompt?");
  const first = await ask("check", "First?");
  await ask("check", "Second?");
  setPauseMode(db, project.id, "on");
  await sweepPauseSignals(bb);
  const stored = (db.prepare("SELECT reason FROM task_pauses WHERE task_id=?").get(card.id) as { reason: string }).reason;
  const targets = () => pauseTargets(db, [], [card.id]).owner_question.get(card.id);
  expect(targets()).toEqual([
    { kind: "question", questionId: decision.id, label: "decision «Which of the two example approaches shou…»" },
    { kind: "question", questionId: first.id, label: "check 1" },
    { kind: "question", questionId: expect.any(String), label: "check 2" },
  ]);
  await harness.callRpc("answerQuestion", { questionId: decision.id, revision: 1, selectedOptionIds: [], answerText: "the first", authorName: "Owner" });
  const labels = () => targets()?.map((target) => (target as { label: string }).label);
  expect(labels()).toEqual(["check 1", "check 2"]);
  const third = await ask("check", "Third?");
  db.prepare("DELETE FROM task_questions WHERE id=?").run(third.id);
  expect(labels()).toEqual(["check 1", "check 2"]);
  // The first check fails: the later one is held and nobody waits on the owner for it.
  await harness.callRpc("answerQuestion", { questionId: first.id, revision: 1, selectedOptionIds: [], answerText: "broken", authorName: "Owner" });
  // No question waits on the owner any more, so the answer's own write ends the owner-question pause.
  expect(targets()).toBeUndefined();
  expect(db.prepare("SELECT reason FROM task_pauses WHERE task_id=?").get(card.id)).toBeUndefined();
  expect(db.prepare("SELECT end_reason FROM pause_log WHERE task_id=? AND event='end' AND signal='owner_question'").get(card.id)).toEqual({ end_reason: "signal_cleared" });
  await harness.dispose();
});

it("lists targets on the card meta, none on a manual pause, and reads Paused until the pause ends", async () => {
  const { bb, harness, card, db, blocker, project } = await setup();
  blocker("First");
  const other = await harness.callRpc("createTask", { projectId: project.id, title: "Other", status: "in_progress" }) as { ok: true; task: { id: string } };
  startManualPause(db, other.task.id, "Waiting for a reply from [the docs](https://example.com/docs)", 60_000, "owner");
  setPauseMode(db, project.id, "on");
  await sweepPauseSignals(bb);
  const read = async () => ((await harness.callRpc("listTaskCardMeta", { taskIds: [card.id, other.task.id] })) as { metadata: { taskId: string; pauses?: unknown[]; activity?: { state: string | null } }[] }).metadata;
  const meta = await read();
  // A wait on a predecessor keeps its targets in the metadata, but Blocked is its own state: the card is not Paused.
  const held = meta.find((entry) => entry.taskId === card.id)!;
  expect(held).toMatchObject({ pauses: [{ signal: "held", targets: [{ kind: "task", taskKey: "EXA-2" }] }] });
  expect(held.activity?.state ?? null).not.toBe("paused");
  // A blocked card with a manual pause is not Paused either; once the block lifts it is.
  startManualPause(db, card.id, "Waiting on the owner", 60_000, "owner");
  expect((await read()).find((entry) => entry.taskId === card.id)?.activity?.state ?? null).not.toBe("paused");
  db.prepare("DELETE FROM task_dependencies WHERE task_id=?").run(card.id);
  expect((await read()).find((entry) => entry.taskId === card.id)?.activity?.state).toBe("paused");
  const manual = meta.find((entry) => entry.taskId === other.task.id)!;
  expect(manual.pauses).toEqual([{ signal: "manual", reason: "Waiting for a reply from [the docs](https://example.com/docs)", until: expect.any(String) }]);
  expect(manual.activity?.state).toBe("paused");
  db.prepare("DELETE FROM task_pauses WHERE task_id=?").run(other.task.id);
  expect((await read()).find((entry) => entry.taskId === other.task.id)?.activity?.state ?? null).toBeNull();
  await harness.dispose();
});
