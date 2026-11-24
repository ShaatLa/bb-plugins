import { z } from "zod";
import { BADGE_CRITERIA, BADGE_CRITERION_LABELS, DEFAULT_BADGE_CRITERIA, type BadgeCriterion } from "./badge";
import { DEFAULT_BOARD_PREFERENCES, boardPreferencesSchema } from "./project-settings";

// The native global fields Work Board owns, shared by the server descriptors and the settings page.
export const BADGE_FIELDS = {
  open: "badgeOpen",
  waiting_on_owner: "badgeWaitingOnOwner",
  in_review: "badgeInReview",
  needs_answer: "badgeNeedsAnswer",
  failed_thread: "badgeFailedThread",
  stale_idle: "badgeStaleIdle",
} as const satisfies Record<BadgeCriterion, string>;
type BadgeField = (typeof BADGE_FIELDS)[BadgeCriterion];

export const START_SCREENS = boardPreferencesSchema.shape.defaultScreen.options;
export const OPEN_THREADS_IN = ["bb", "agent-hub"] as const;
export const OPEN_THREADS_IN_LABELS: Record<(typeof OPEN_THREADS_IN)[number], string> = { bb: "bb chat", "agent-hub": "Agent Hub" };

export const GLOBAL_SETTING_LABELS = {
  startScreen: "Start screen",
  openThreadsIn: "Open thread links in",
  checksBbCli: "Repository checks: BB CLI absolute path (empty: use the server environment)",
  checksRuntimePath: "Repository checks: script PATH (empty: inherit the server PATH)",
  ...(Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], `Navigation badge counts: ${BADGE_CRITERION_LABELS[criterion]}`])) as Record<BadgeField, string>),
};
export type GlobalSettingKey = keyof typeof GLOBAL_SETTING_LABELS;

export const GLOBAL_SETTING_DEFAULTS: Record<GlobalSettingKey, string | boolean> = {
  startScreen: DEFAULT_BOARD_PREFERENCES.defaultScreen,
  openThreadsIn: "bb",
  checksBbCli: "",
  checksRuntimePath: "",
  ...(Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], DEFAULT_BADGE_CRITERIA.includes(criterion)])) as Record<BadgeField, boolean>),
};

/** A patch of the native fields; each key is validated by its descriptor on the server. */
export const globalSettingsPatchSchema = z.object({
  startScreen: z.string(),
  openThreadsIn: z.string(),
  checksBbCli: z.string(),
  checksRuntimePath: z.string(),
  ...(Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], z.boolean()])) as Record<BadgeField, z.ZodBoolean>),
}).partial().strict();
export type GlobalSettingsPatch = z.infer<typeof globalSettingsPatchSchema>;
/** The refusal of a write whose `expected` values no longer match the stored ones. */
export const STALE_GLOBAL_SETTING = "Settings changed elsewhere; reload them before writing";
