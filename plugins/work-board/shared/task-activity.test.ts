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
