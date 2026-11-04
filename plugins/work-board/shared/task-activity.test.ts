import { expect, it } from "vitest";
import { evaluateTaskActivity } from "./task-activity";
import type { TaskActivitySession } from "./task-activity";

const session = (state: TaskActivitySession["state"]): TaskActivitySession => ({ threadId: `thr_${state}`, title: state, role: "worker", state });
const evaluate = (sessions: TaskActivitySession[], hasWorked = false, terminal = false, complete = true) => evaluateTaskActivity({ sessions, hasWorked, terminal, complete });

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
