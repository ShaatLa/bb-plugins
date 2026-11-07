import { z } from "zod";

export const autoArchiveAfterDaysSchema = z.enum(["off", "7", "14", "30"]);
export const staleIdleThresholdSchema = z.enum(["off", "30", "45", "60", "120"]);
export const statusNotificationsSchema = z.enum(["off", "all", "done"]);
export const boardPreferencesSchema = z.object({
  defaultScreen: z.enum(["last-project-board", "last-project-list", "all", "active"]),
}).strict();

export const DEFAULT_BOARD_PREFERENCES = boardPreferencesSchema.parse({ defaultScreen: "last-project-board" });
export const BOARD_PREFERENCES_KEY = "board:preferences";

export function idleThreshold(project: { staleIdleMinutes?: string }): number | null {
  return project.staleIdleMinutes === "off" ? null : Number(project.staleIdleMinutes ?? "45");
}
