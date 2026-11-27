import { expect, it } from "vitest";
import { evaluateTaskActivity } from "./task-activity";
import type { TaskActivitySession } from "./task-activity";

const session = (state: TaskActivitySession["state"]): TaskActivitySession => ({ threadId: `thr_${state}`, title: state, role: "worker", state });
const evaluate = (sessions: TaskActivitySession[], hasWorked = false, terminal = false, complete = true) => evaluateTaskActivity({ sessions, hasLostSession: true, hasWorked, terminal, complete });

it("keeps working primary alongside failure and reports terminal work", () => {
  expect(evaluate([session("working"), session("error"), session("attached")], true, true)).toMatchObject({ state: "working", workingCount: 1, attachedCount: 3, hasFailure: true, terminalWarning: true });
});

it("requires confirmed history and a complete read before abandonment", () => {
  expect(evaluate([]).state).toBeNull();
  expect(evaluate([], true, false, false).state).toBeNull();
  expect(evaluate([], true, true).state).toBeNull();
  expect(evaluate([], true).state).toBe("abandoned");
  expect(evaluate([session("attached")], true).state).toBe("attached");
});

it("prioritizes explicit waiting and queued signals ahead of attachment", () => {
  expect(evaluate([session("attached"), session("queued")]).state).toBe("queued");
  expect(evaluate([session("queued"), session("waiting-owner")]).state).toBe("waiting-owner");
});

it("marks lost assignments abandoned while preserving live session activity", () => {
  const input = { hasLostSession: true, hasWorked: true, terminal: false, complete: true };
  expect(evaluateTaskActivity({ ...input, sessions: [] })).toMatchObject({ state: "abandoned", diagnostics: { hasWorked: true } });
  for (const state of ["working", "attached", "waiting-owner", "queued", "error"] as const) {
    expect(evaluateTaskActivity({ ...input, sessions: [session(state)] }).state).toBe(state);
  }
});

it("does not mistake agent comments without any lost assignment for abandonment", () => {
  expect(evaluateTaskActivity({ sessions: [], hasWorked: true, hasLostSession: false, terminal: false, complete: true }).state).toBeNull();
});

it("reads Paused over every idle state, and Working, waiting and failure win over it", () => {
  const run = (sessions: TaskActivitySession[], terminal = false, paused = true) => evaluateTaskActivity({ sessions, hasLostSession: true, hasWorked: true, terminal, complete: true, paused, pauseReason: "waiting on EXA-2" });
  for (const state of ["attached", "queued"] as const) expect(run([session(state)]).state).toBe("paused");
  expect(run([]).state).toBe("paused");
  expect(run([]).diagnostics?.explanation).toBe("The card is paused: waiting on EXA-2.");
  for (const state of ["working", "waiting-owner", "error"] as const) expect(run([session(state)]).state).toBe(state);
  expect(run([session("queued"), session("error")]).state).toBe("error");
  expect(run([], true).state).toBeNull();
  expect(run([], false, false).state).toBe("abandoned");
  expect(run([session("queued")], false, false).state).toBe("queued");
});

it("reads Working from tasks in work instead of Abandoned, attached or none, and leaves the card's own busier states", () => {
  const run = (sessions: TaskActivitySession[], extra: Partial<Parameters<typeof evaluateTaskActivity>[0]> = {}) => evaluateTaskActivity({ sessions, hasLostSession: true, hasWorked: true, terminal: false, complete: true, tasksInWork: ["EXA-2", "EXA-3"], ...extra });
  expect(run([])).toMatchObject({ state: "working", workingCount: 0, attachedCount: 0, diagnostics: { explanation: "Its tasks are in work: EXA-2, EXA-3." } });
  expect(run([], { hasWorked: false, hasLostSession: false }).state).toBe("working");
  expect(run([session("attached")]).state).toBe("working");
  expect(run([], { tasksInWork: ["A-1", "A-2", "A-3", "A-4", "A-5", "A-6", "A-7"] }).diagnostics?.explanation).toBe("Its tasks are in work: A-1, A-2, A-3, A-4, A-5 and 2 more.");
  expect(run([], { tasksInWork: [] }).state).toBe("abandoned");
  expect(run([], { terminal: true }).state).toBeNull();
  expect(run([session("waiting-owner")]).state).toBe("waiting-owner");
  expect(run([session("queued")]).state).toBe("queued");
  expect(run([session("error")]).state).toBe("error");
  expect(run([], { paused: true }).state).toBe("paused");
});
