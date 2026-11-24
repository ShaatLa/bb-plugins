import { z } from "zod";

export const ATTENTION_OWNER_ONLY = "Stale-status notices and the manager thread are changed by the owner in the project settings; this is an owner-only convention, and no command or setting call proves the caller is the owner.";

/** Why a manager session cannot receive notices; each cause has its own text and none is ever reported as another. */
export const MANAGER_CAUSES = ["none", "deleted", "archived", "stopping", "side_chat", "not_found"] as const;
export type ManagerCause = (typeof MANAGER_CAUSES)[number];
export type ManagerLookup =
  | { status: "usable"; threadId: string }
  | { status: "unusable"; cause: ManagerCause; detectedAt: string }
  | { status: "unavailable"; error: string };

const MANAGER_PROBLEM: Record<ManagerCause | "unavailable", string> = {
  none: "No manager chosen",
  deleted: "The manager session was deleted",
  archived: "The manager session is archived",
  stopping: "The manager session is stopping",
  side_chat: "The manager is a side chat",
  not_found: "The manager session no longer exists",
  unavailable: "Could not verify the manager session",
};
/**
 * The line shown in the settings, and the refusal text of a request to turn notices on: one wording for both. While notices are on
 * the line says they are not being sent; otherwise it says what to do before turning them on.
 */
export function managerProblemText(lookup: ManagerLookup, mode: "off" | "live" = "off"): string | null {
  if (lookup.status === "usable") return null;
  const cause = lookup.status === "unusable" ? lookup.cause : "unavailable";
  const suffix = mode === "live" ? "; notices are not being sent" : cause === "unavailable" ? "" : cause === "none" ? "; choose one before turning notices on" : "; choose another before turning notices on";
  return `${MANAGER_PROBLEM[cause]}${suffix}`;
}

const trackerProjectId = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);

export const attentionKindStateSchema = z.object({
  effective: z.object({ mode: z.enum(["off", "live"]), generation: z.number().int() }).strict(),
  /** Turned off while a notice is still being sent: no new notice starts, and the switch completes once it settles. */
  switchingOff: z.boolean(),
}).strict();

const attemptSchema = z.object({
  attemptId: z.string(), occurrenceIds: z.array(z.string()), recipientThreadId: z.string(), startedAt: z.string(), error: z.string().nullable(),
  /** Send again is offered: notices are on and at least one of the attempt's cards can still be sent. */
  canRetry: z.boolean(),
}).strict();

const settingsSchema = z.object({
  trackerId: trackerProjectId,
  linkedBbProjectId: z.string().nullable(),
  state: attentionKindStateSchema,
  changedAt: z.string().nullable(),
  previousMode: z.string().nullable(),
  manager: z.string().nullable(),
  managerChangedAt: z.string().nullable(),
  managerPrevious: z.string().nullable(),
  /** What a lookup of the saved manager returned just now. */
  managerLookup: z.union([
    z.object({ status: z.literal("usable") }).strict(),
    z.object({ status: z.literal("unusable"), cause: z.enum(MANAGER_CAUSES), detectedAt: z.string() }).strict(),
    z.object({ status: z.literal("unavailable") }).strict(),
  ]),
  managerWarning: z.string().nullable(),
  unresolvedAttempts: z.array(attemptSchema),
}).strict();

/** The owner's settings calls; they join the app's tasks contract, since the settings UI cannot carry a plugin caller. */
export const attentionUiMethods = {
  getAttentionSettings: {
    input: z.object({ projectId: trackerProjectId }).strict(),
    output: settingsSchema,
  },
  updateAttentionMode: {
    // `shadow` is accepted only to be refused with a clear message: older callers may still send it.
    input: z.object({ projectId: trackerProjectId, mode: z.enum(["off", "live", "shadow"]) }).strict(),
    output: attentionKindStateSchema,
  },
  updateAttentionManager: {
    input: z.object({ projectId: trackerProjectId, manager: z.string().regex(/^thr_[A-Za-z0-9_-]+$/).nullable() }).strict(),
    output: z.object({ manager: z.string().nullable() }).strict(),
  },
  resolveAttentionAttempt: {
    input: z.object({ attemptId: z.string(), disposition: z.enum(["waived_loss", "retry"]) }).strict(),
    output: z.object({ ok: z.literal(true) }).strict(),
  },
};
export type AttentionSettings = z.infer<typeof settingsSchema>;
