import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BADGE_CRITERIA, BADGE_CRITERION_LABELS, DEFAULT_BADGE_CRITERIA, type BadgeCriterion } from "./shared/badge";
import { BOARD_PREFERENCES_KEY, DEFAULT_BOARD_PREFERENCES, boardPreferencesSchema, type BoardPreferences } from "./shared/project-settings";

// Global preferences are native plugin settings, so `bb plugin config work-board set KEY VALUE` changes one field.
const BADGE_FIELDS: Record<BadgeCriterion, string> = {
  open: "badgeOpen",
  waiting_on_owner: "badgeWaitingOnOwner",
  in_review: "badgeInReview",
  needs_answer: "badgeNeedsAnswer",
  failed_thread: "badgeFailedThread",
  stale_idle: "badgeStaleIdle",
};
const descriptors = {
  // Not "defaultScreen": that native key holds the stale pre-0.20 value.
  startScreen: { type: "select", label: "Start screen", options: [...boardPreferencesSchema.shape.defaultScreen.options], default: DEFAULT_BOARD_PREFERENCES.defaultScreen },
  // Read by the app (components/open-thread.ts): "agent-hub" opens Agent Hub (or Answers, its former id) and falls
  // back to bb chat when neither is installed. "answers" is still accepted and moved to "agent-hub" at load.
  openThreadsIn: { type: "select", label: "Open thread links in", options: ["bb", "agent-hub", "answers"], default: "bb" },
  ...Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], {
    type: "boolean", label: `Navigation badge counts: ${BADGE_CRITERION_LABELS[criterion]}`, default: DEFAULT_BADGE_CRITERIA.includes(criterion),
  }])),
} as const;

type Values = Record<string, string | number | boolean | null | undefined>;
type Handle = { get(): Promise<Values>; experimental_set(values: Values): Promise<Values>; onChange(listener: (next: Values, prev: Values) => void): void };
const handles = new WeakMap<BbPluginApi, Handle>();

function handle(bb: BbPluginApi): Handle {
  let settings = handles.get(bb);
  if (!settings) {
    settings = bb.settings.define(descriptors as never) as unknown as Handle;
    handles.set(bb, settings);
  }
  return settings;
}

export async function getBoardPreferences(bb: BbPluginApi): Promise<BoardPreferences> {
  return boardPreferencesSchema.parse({ defaultScreen: (await handle(bb).get()).startScreen ?? DEFAULT_BOARD_PREFERENCES.defaultScreen });
}
export async function setBoardPreferences(bb: BbPluginApi, preferences: BoardPreferences) {
  await handle(bb).experimental_set({ startScreen: preferences.defaultScreen });
  return preferences;
}
export async function getBadgeCriteria(bb: BbPluginApi): Promise<BadgeCriterion[]> {
  const values = await handle(bb).get();
  return BADGE_CRITERIA.filter((criterion) => values[BADGE_FIELDS[criterion]] ?? DEFAULT_BADGE_CRITERIA.includes(criterion));
}
export async function setBadgeCriteria(bb: BbPluginApi, criteria: readonly BadgeCriterion[]) {
  await handle(bb).experimental_set(Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], criteria.includes(criterion)])));
  return getBadgeCriteria(bb);
}

const LEGACY_BADGE_KEY = "navigation-badge:criteria";
/** Defines the native fields at load, moves the former stored values into them once, and refreshes views on any change. */
export async function registerGlobalSettings(bb: BbPluginApi, onChange: () => void) {
  const settings = handle(bb);
  if (!(await bb.storage.kv.get("global-settings:native"))) {
    const preferences = boardPreferencesSchema.safeParse(await bb.storage.kv.get(BOARD_PREFERENCES_KEY));
    if (preferences.success) await setBoardPreferences(bb, preferences.data);
    const stored = await bb.storage.kv.get<unknown>(LEGACY_BADGE_KEY);
    if (Array.isArray(stored)) {
      // Stores from before "waiting on you" existed still get it, as the former reader did.
      const upgraded = await bb.storage.kv.get<boolean>("navigation-badge:waiting-on-owner-upgraded");
      await setBadgeCriteria(bb, BADGE_CRITERIA.filter((criterion) => stored.includes(criterion) || (!upgraded && criterion === "waiting_on_owner")));
    }
    await bb.storage.kv.set("global-settings:native", true);
  }
  if ((await settings.get()).openThreadsIn === "answers") await settings.experimental_set({ openThreadsIn: "agent-hub" });
  settings.onChange(onChange);
}
