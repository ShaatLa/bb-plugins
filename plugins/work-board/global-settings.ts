import { isAbsolute } from "node:path";
import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BADGE_CRITERIA, DEFAULT_BADGE_CRITERIA, type BadgeCriterion } from "./shared/badge";
import { BOARD_PREFERENCES_KEY, DEFAULT_BOARD_PREFERENCES, boardPreferencesSchema, type BoardPreferences } from "./shared/project-settings";
import { BADGE_FIELDS, GLOBAL_SETTING_DEFAULTS, GLOBAL_SETTING_LABELS, OPEN_THREADS_IN, OPEN_THREADS_IN_LABELS, START_SCREENS, STALE_GLOBAL_SETTING, type GlobalSettingKey, type GlobalSettingsPatch } from "./shared/global-settings";

// Global preferences are native plugin settings, so `bb plugin config work-board set KEY VALUE` changes one field.
const descriptors = {
  // Not "defaultScreen": that native key holds the stale pre-0.20 value.
  startScreen: { type: "select", label: GLOBAL_SETTING_LABELS.startScreen, options: [...START_SCREENS], default: DEFAULT_BOARD_PREFERENCES.defaultScreen },
  // Read by the app (components/open-thread.ts): "agent-hub" opens Agent Hub and falls back to bb chat when it is not
  // installed.
  openThreadsIn: { type: "select", label: GLOBAL_SETTING_LABELS.openThreadsIn, options: [...OPEN_THREADS_IN], experimental_optionLabels: OPEN_THREADS_IN_LABELS, default: "bb" },
  // Repository-check runner: how the script is launched. Empty values inherit the server environment.
  checksBbCli: { type: "string", label: GLOBAL_SETTING_LABELS.checksBbCli, default: "", experimental_schema: z.string().refine((path) => path === "" || isAbsolute(path), "Enter the absolute path to bb (for example /opt/bin/bb), or clear it to use the server environment.") },
  checksRuntimePath: { type: "string", label: GLOBAL_SETTING_LABELS.checksRuntimePath, default: "" },
  ...Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], {
    type: "boolean", label: GLOBAL_SETTING_LABELS[BADGE_FIELDS[criterion]], default: DEFAULT_BADGE_CRITERIA.includes(criterion),
  }])),
} as const;
type Descriptor = { type: string; options?: readonly string[]; experimental_schema?: z.ZodType };

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
/** The launch environment of the repository-check scripts. */
export async function getChecksEnvironment(bb: BbPluginApi): Promise<{ bbCli: string; runtimePath: string }> {
  const values = await handle(bb).get();
  return { bbCli: String(values.checksBbCli ?? ""), runtimePath: String(values.checksRuntimePath ?? "") };
}
export async function getBadgeCriteria(bb: BbPluginApi): Promise<BadgeCriterion[]> {
  const values = await handle(bb).get();
  return BADGE_CRITERIA.filter((criterion) => values[BADGE_FIELDS[criterion]] ?? DEFAULT_BADGE_CRITERIA.includes(criterion));
}
export async function setBadgeCriteria(bb: BbPluginApi, criteria: readonly BadgeCriterion[]) {
  await handle(bb).experimental_set(Object.fromEntries(BADGE_CRITERIA.map((criterion) => [BADGE_FIELDS[criterion], criteria.includes(criterion)])));
  return getBadgeCriteria(bb);
}

// One chain per plugin instance: an `expected` check and its write run with no other RPC write between them.
const writeChains = new WeakMap<BbPluginApi, Promise<unknown>>();
function serialized<T>(bb: BbPluginApi, run: () => Promise<T>): Promise<T> {
  const next = (writeChains.get(bb) ?? Promise.resolve()).then(run, run);
  writeChains.set(bb, next.catch(() => undefined));
  return next;
}
/** Every native field Work Board owns, with its default when unset. */
export async function getGlobalSettings(bb: BbPluginApi): Promise<GlobalSettingsPatch> {
  const values = await handle(bb).get();
  return Object.fromEntries((Object.keys(GLOBAL_SETTING_DEFAULTS) as GlobalSettingKey[]).map((key) => [key, values[key] ?? GLOBAL_SETTING_DEFAULTS[key]])) as GlobalSettingsPatch;
}
/**
 * Writes only the given native fields. Every value is checked against its descriptor first, so one invalid value
 * rejects the whole patch and nothing is written; with `expected`, so does a stored value that differs from it.
 */
export async function setGlobalSettings(bb: BbPluginApi, patch: GlobalSettingsPatch, expected?: GlobalSettingsPatch): Promise<GlobalSettingsPatch> {
  const keys = Object.keys(patch) as GlobalSettingKey[];
  const problems = keys.flatMap((key) => {
    const descriptor = (descriptors as Record<string, Descriptor>)[key];
    const value = patch[key];
    if (!descriptor) return [`Unknown setting ${key}`];
    if (descriptor.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string") return [`Invalid value for ${key}`];
    if (descriptor.options && !descriptor.options.includes(value as string)) return [`Invalid value for ${key}: use ${descriptor.options.join(", ")}`];
    const parsed = descriptor.experimental_schema?.safeParse(value);
    return parsed && !parsed.success ? parsed.error.issues.map((issue) => issue.message) : [];
  });
  if (problems.length) throw new Error(problems.join("; "));
  if (!keys.length) return {};
  // Every RPC write runs alone, so two callers holding the same `expected` cannot both pass the check. One chain for
  // all keys: writes are rare, and it serializes each key as well. Writes from the settings page cannot overwrite each
  // other or a change made in another window; a `bb plugin config set` made at the same instant may be overwritten.
  // shortcut: a native `bb plugin config set` writes around this chain, so it can land between the check and the write;
  // upgrade if the host gains a conditional set.
  return serialized(bb, async () => {
    if (expected) {
      const stored = await getGlobalSettings(bb);
      if ((Object.keys(expected) as GlobalSettingKey[]).some((key) => stored[key] !== expected[key])) throw new Error(STALE_GLOBAL_SETTING);
    }
    await handle(bb).experimental_set(patch);
    const values = await handle(bb).get();
    return Object.fromEntries(keys.map((key) => [key, values[key] ?? GLOBAL_SETTING_DEFAULTS[key]])) as GlobalSettingsPatch;
  });
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
  settings.onChange(onChange);
}
