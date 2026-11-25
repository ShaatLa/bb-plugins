import { z } from "zod";

export const autoArchiveAfterDaysSchema = z.enum(["off", "3", "7", "14", "30"]);
export const staleIdleThresholdSchema = z.enum(["off", "30", "45", "60", "120"]);
export const statusNotificationsSchema = z.enum(["off", "all", "done"]);
/**
 * How plans apply to a project; off is the default for new projects. `optional` is plans and review without any
 * refusal; `required` also keeps a card out of In progress until its plan is approved. Only the owner changes it.
 */
export const planningSchema = z.enum(["off", "optional", "required"]);
export const planningOn = (project: { planning?: string | null }) => project.planning === "optional" || project.planning === "required";
export const planningRequired = (project: { planning?: string | null }) => project.planning === "required";
export const planningOffMessage = (prefix: string) => `planning is off for project ${prefix}; the owner can enable it in the project settings`;
export const READINESS_OWNER_ONLY = "check readiness is changed by the owner in the project settings";
export const DONE_REVIEW_OWNER_ONLY = "done after review is changed by the owner in the project settings";
export const READINESS_HINT = "This project checks readiness before owner checks: smoke-test what you send and list anything beyond the approved plan and design";
export const PLANNING_OWNER_ONLY = "planning is changed by the owner in the project settings";
/** Automation switches of the closed-card thread handling; both default to on. */
export const archiveSettingSchema = z.enum(["on", "off"]);
export const boardPreferencesSchema = z.object({
  defaultScreen: z.enum(["last-project-board", "last-project-list", "all", "active"]),
}).strict();

export type BoardPreferences = z.infer<typeof boardPreferencesSchema>;
export const DEFAULT_BOARD_PREFERENCES = boardPreferencesSchema.parse({ defaultScreen: "last-project-board" });
export const BOARD_PREFERENCES_KEY = "board:preferences";

export function idleThreshold(project: { staleIdleMinutes?: string }): number | null {
  return project.staleIdleMinutes === "off" ? null : Number(project.staleIdleMinutes ?? "45");
}
