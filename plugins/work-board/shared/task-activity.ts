import { z } from "zod";

export const taskActivitySessionSchema = z.object({
  threadId: z.string().startsWith("thr_"),
  title: z.string(),
  role: z.enum(["worker", "parent"]),
  state: z.enum(["working", "waiting-owner", "queued", "attached", "error"]),
}).strict();

export const taskActivitySchema = z.object({
  state: z.enum(["working", "waiting-owner", "queued", "attached", "abandoned", "error"]).nullable(),
  workingCount: z.number().int().nonnegative(),
  attachedCount: z.number().int().nonnegative(),
  sessions: z.array(taskActivitySessionSchema),
  terminalWarning: z.boolean(),
  hasFailure: z.boolean(),
}).strict();

export type TaskActivitySession = z.infer<typeof taskActivitySessionSchema>;
export type TaskActivity = z.infer<typeof taskActivitySchema>;

/** Evaluate only verified, card-scoped signals; attachment alone is not work history. */
export function evaluateTaskActivity(input: {
  sessions: TaskActivitySession[];
  hasWorked: boolean;
  terminal: boolean;
  complete: boolean;
}): TaskActivity {
  const { sessions, hasWorked, terminal, complete } = input;
  const workingCount = sessions.filter((session) => session.state === "working").length;
  const hasFailure = sessions.some((session) => session.state === "error");
  const state = workingCount ? "working"
    : sessions.some((session) => session.state === "waiting-owner") ? "waiting-owner"
    : sessions.some((session) => session.state === "queued") ? "queued"
    : hasFailure ? "error"
    : sessions.length ? "attached"
    : complete && hasWorked && !terminal ? "abandoned" : null;
  return { state, workingCount, attachedCount: sessions.length, sessions, terminalWarning: terminal && workingCount > 0, hasFailure };
}
