import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  autoArchiveAfterDaysSchema,
  staleIdleThresholdSchema,
  boardPreferencesSchema,
  BOARD_PREFERENCES_KEY,
} from "./shared/project-settings";

export async function migrateSettings(bb: BbPluginApi) {
  if (await bb.storage.kv.get("project-settings:migrated")) return;
  // shortcut: legacy controls stay visible for the migration load; reload once to remove them.
  const legacy = bb.settings.define({
    autoArchiveAfterDays: { type: "select", label: "Legacy auto-archive interval (migrated)", options: autoArchiveAfterDaysSchema.options, default: "off" },
    staleIdleMinutes: { type: "select", label: "Legacy idle threshold (migrated)", options: staleIdleThresholdSchema.options, default: "45" },
    defaultScreen: { type: "select", label: "Legacy default screen (migrated)", options: boardPreferencesSchema.shape.defaultScreen.options, default: "last-project-board" },
  });
  const values = await legacy.get();
  const days = autoArchiveAfterDaysSchema.parse(values.autoArchiveAfterDays ?? "off");
  const idle = staleIdleThresholdSchema.parse(values.staleIdleMinutes ?? "45");
  // Null marks pre-project settings; retries never replace an explicit project choice.
  bb.storage.database().prepare<[string, string]>(
    `UPDATE projects SET auto_archive_after_days = COALESCE(auto_archive_after_days, ?),
     stale_idle_minutes = COALESCE(stale_idle_minutes, ?)`,
  ).run(days, idle);
  if (!(await bb.storage.kv.get(BOARD_PREFERENCES_KEY))) {
    await bb.storage.kv.set(BOARD_PREFERENCES_KEY, boardPreferencesSchema.parse({
      defaultScreen: values.defaultScreen ?? "last-project-board",
    }));
  }
  await bb.storage.kv.set("project-settings:migrated", true);
}
