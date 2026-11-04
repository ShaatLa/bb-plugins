import { z } from "zod";

export const ACTIVITY_LABELS = { working: "Working", attached: "Attached", abandoned: "Abandoned", error: "Error", "waiting-owner": "Waiting for owner", queued: "Queued" } as const;

const inactiveSessionSchema = z.object({
  threadId: z.string().startsWith("thr_"),
  title: z.string(),
  reason: z.enum(["archived", "deleted", "missing"]),
}).strict();

export const taskActivitySessionSchema = z.object({
  threadId: z.string().startsWith("thr_"),
  title: z.string(),
  role: z.enum(["worker", "parent"]),
  state: z.enum(["working", "waiting-owner", "queued", "attached", "error"]),
  diagnostics: z.object({
    explanation: z.string(),
    threadStatus: z.string().nullable(),
    runtimeStatus: z.string().nullable(),
    turnId: z.string().nullable(),
    requestId: z.string().nullable(),
    focusedTaskId: z.string().nullable(),
    focusedTaskKey: z.string().nullable(),
    queueIds: z.array(z.string()),
    interactionIds: z.array(z.string()),
  }).strict().optional(),
}).strict();

export const taskActivitySchema = z.object({
  state: z.enum(["working", "waiting-owner", "queued", "attached", "abandoned", "error"]).nullable(),
  workingCount: z.number().int().nonnegative(),
  attachedCount: z.number().int().nonnegative(),
  sessions: z.array(taskActivitySessionSchema),
  terminalWarning: z.boolean(),
  hasFailure: z.boolean(),
  diagnostics: z.object({
    explanation: z.string(),
    hasWorked: z.boolean(),
    complete: z.boolean(),
    checkedAt: z.string().datetime(),
    inactiveSessions: z.array(inactiveSessionSchema),
  }).strict().optional(),
}).strict();

export type TaskActivitySession = z.infer<typeof taskActivitySessionSchema>;
export type TaskActivity = z.infer<typeof taskActivitySchema>;

/** Evaluate only verified, card-scoped signals; attachment alone is not work history. */
export function evaluateTaskActivity(input: {
  sessions: TaskActivitySession[];
  hasWorked: boolean;
  terminal: boolean;
  complete: boolean;
  inactiveSessions?: z.infer<typeof inactiveSessionSchema>[];
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
  const explanation = state === "working" ? "A session is executing a current accepted input scoped to this task."
    : state === "waiting-owner" ? "A session has a pending owner interaction in a turn scoped to this task."
    : state === "queued" ? "A dispatched request for this task is still in a session's queue."
    : state === "error" ? "An attached session has failed."
    : state === "attached" ? "Sessions are attached, but none is verified as executing work on this task."
    : state === "abandoned" ? "Previous work is recorded, no live sessions remain attached, and the task is neither done nor canceled."
    : !complete ? "Activity could not be verified because session data is unavailable."
    : terminal ? "No current activity; done and canceled tasks are not marked Abandoned."
    : "No live sessions or recorded previous work.";
  return { state, workingCount, attachedCount: sessions.length, sessions, terminalWarning: terminal && workingCount > 0, hasFailure,
    diagnostics: { explanation, hasWorked, complete, checkedAt: new Date().toISOString(), inactiveSessions: input.inactiveSessions ?? [] } };

}
