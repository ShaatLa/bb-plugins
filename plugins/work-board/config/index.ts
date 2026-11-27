import { agentReceiptRefusal, checkReceiptSchema } from "../shared/check-receipt";
import { registeredValidator } from "../checks/receipt-registry";
import { logReceiptChange } from "../checks/receipt-log";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { TasksApiStore } from "../api";
import { planGatedStatuses } from "../shared/workflow-policy";
import { publishProjectsChanged } from "../api";
import { gitSyncService } from "../git-sync/service";
import { createGitSyncStore } from "../git-sync/store";
import { STALE_GIT_CONFIG, gitSyncConfigSchema, overlapEnabled } from "../shared/git-sync";
import { ATTENTION_OWNER_ONLY } from "../shared/attention";
import { setPauseMode } from "../pause/store";
import { queueMode } from "../queue/store";
import { startArgsSetting, DEFAULT_START_ARGS } from "../schedule/service";
import { splitArgs } from "../schedule/when";
import { kindState } from "../attention/modes";
import { CHECK_FIELDS, CHECKS_CONFIG_KEYS, CHECKS_ENABLED_OWNER_ONLY, CHECKS_PREFIX, type CheckField } from "../checks/config";
import { checksService } from "../checks/service";
import { PR_EVENT_KEYS, prEventSettings, setPrEventSetting } from "../git-sync/events";
import { archiveSettingSchema, autoArchiveAfterDaysSchema, READINESS_OWNER_ONLY, DONE_REVIEW_OWNER_ONLY, PLANNING_OWNER_ONLY, planningSchema, staleIdleThresholdSchema, statusNotificationsSchema } from "../shared/project-settings";

// Per-project settings addressable one key at a time; Git settings carry a "git." prefix.
const PROJECT_KEYS = {
  autoArchiveAfterDays: autoArchiveAfterDaysSchema,
  staleIdleMinutes: staleIdleThresholdSchema,
  statusNotifications: statusNotificationsSchema,
  archiveThreadsOnClose: archiveSettingSchema,
  archiveReviewerOnApproval: archiveSettingSchema,
  checkReceipt: checkReceiptSchema,
  checkReadiness: archiveSettingSchema,
  doneRequiresReview: archiveSettingSchema,
  planning: planningSchema,
} as const;
type ProjectKey = keyof typeof PROJECT_KEYS;
const GIT_KEYS = Object.keys(gitSyncConfigSchema.shape) as (keyof z.infer<typeof gitSyncConfigSchema>)[];
// Stale-status notices (`attentionMode`: off or live) and the manager are the owner's to change in the project settings; the keys are readable here and refused by `config.set`.
const ATTENTION_KEYS = ["attentionMode", "manager", "autoPause", "queueMode"];
// The builder arguments a scheduled start launches Spawn Gate with, `{key}` replaced by the card key.
const START_ARGS_KEY = "scheduledStartArgs";
export const PROJECT_CONFIG_KEYS = [...Object.keys(PROJECT_KEYS), ...ATTENTION_KEYS, START_ARGS_KEY, ...Object.keys(PR_EVENT_KEYS), ...GIT_KEYS.map((key) => `git.${key}`), ...CHECKS_CONFIG_KEYS];

/** JSON with object keys sorted, so two values compare equal regardless of key order; array order is kept. */
const structural = (value: unknown) => JSON.stringify(value, (_key, entry: unknown) =>
  entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : 1))) : entry);

function requireKey(key: string) {
  if (!PROJECT_CONFIG_KEYS.includes(key)) throw new Error(`Unknown setting ${key}; known: ${PROJECT_CONFIG_KEYS.join(", ")}`);
}

export function projectConfigHandlers(bb: BbPluginApi, store: TasksApiStore) {
  const requireProject = (projectId: string) => {
    const project = store.tasks.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  };
  const values = (projectId: string): Record<string, unknown> => {
    const project = requireProject(projectId);
    const git = createGitSyncStore(bb.storage.database()).config(projectId);
    return {
      ...Object.fromEntries((Object.keys(PROJECT_KEYS) as ProjectKey[]).map((key) => [key, project[key]])),
      ...Object.fromEntries(GIT_KEYS.map((key) => [`git.${key}`, git[key] ?? null])),
      "git.overlapEnabled": overlapEnabled(git),
      ...checksService(bb).configValues(projectId),
      attentionMode: kindState(bb.storage.database(), projectId).effective.mode,
      autoPause: bb.storage.database().prepare<[string], { mode: string }>("SELECT mode FROM pause_modes WHERE project_id=?").get(projectId)?.mode ?? "off",
      queueMode: queueMode(bb.storage.database(), projectId),
      [START_ARGS_KEY]: startArgsSetting(bb.storage.database(), projectId),
      prEvents: prEventSettings(bb.storage.database(), projectId).events,
      prEventsManager: prEventSettings(bb.storage.database(), projectId).manager,
      manager: bb.storage.database().prepare<[string], { manager: string | null }>("SELECT manager FROM attention_manager WHERE tracker_id=?").get(projectId)?.manager ?? null,
    };
  };
  return {
    "config.get"({ projectId, key }: { projectId: string; key?: string }) {
      const all = values(projectId);
      const project = requireProject(projectId);
      // Planning shows when it last changed and what it was before.
      const planningHistory = { planningChangedAt: project.planningChangedAt ?? null, planningPrevious: project.planningPrevious ?? null, planGatedStatuses: planGatedStatuses(project) };
      if (key === undefined) return { projectId, values: { ...all, ...planningHistory } };
      requireKey(key);
      return { projectId, values: { [key]: all[key] ?? null, ...(key === "planning" ? planningHistory : {}) } };
    },
    async "config.set"({ projectId, key, value, expected }: { projectId: string; key: string; value?: unknown; expected?: unknown }) {
      requireKey(key);
      if (expected !== undefined && !key.startsWith("git.")) throw new Error(`expected applies to git.* keys only, not ${key}`);
      if (key === "checkReceipt") {
        const next = checkReceiptSchema.parse(value);
        const change = store.transaction(() => {
          const project = requireProject(projectId);
          const before = project.checkReceipt ?? null;
          if (JSON.stringify(before) === JSON.stringify(next)) return null;
          const refusal = agentReceiptRefusal(before, next);
          if (refusal) throw new Error(`${refusal}. Change it in the ${project.prefix} project settings.`);
          const registration = next && registeredValidator(next.validatorId);
          const updated = store.tasks.updateProject(projectId, { checkReceipt: next });
          return { before, after: updated.checkReceipt ?? null, prefix: updated.prefix, registration };
        });
        if (change) {
          logReceiptChange(bb, change.prefix, change.before, change.after, change.registration);
          publishProjectsChanged(bb, projectId);
        }
        return { projectId, key, value: next };
      }
      // The owner changes planning in the project settings (updateProject from the app); no setting call proves the caller is the owner.
      if (key === "checkReadiness") throw new Error(READINESS_OWNER_ONLY);
      if (key === "doneRequiresReview") throw new Error(DONE_REVIEW_OWNER_ONLY);
      if (key === "planning") throw new Error(PLANNING_OWNER_ONLY);
      if (key === "autoPause" && value === "off") {
        requireProject(projectId);
        setPauseMode(bb.storage.database(), projectId, "off");
        publishProjectsChanged(bb, projectId);
        return { projectId, key, value: "off" };
      }
      if (key === "queueMode") throw new Error("the work queue mode (off, trial, on) is changed by the owner in the project settings");
      if (ATTENTION_KEYS.includes(key)) throw new Error(ATTENTION_OWNER_ONLY);
      requireProject(projectId);
      if (key === START_ARGS_KEY) {
        if (value !== null && value !== "" && typeof value !== "string") throw new Error(`${key} is the builder arguments as one text, e.g. ${DEFAULT_START_ARGS}`);
        const text = typeof value === "string" ? value.trim() : "";
        if (text.length > 500) throw new Error(`${key} is at most 500 characters`);
        if (text) splitArgs(text);
        const db = bb.storage.database();
        if (text) db.prepare<[string, string]>("INSERT INTO scheduled_start_settings(project_id,args) VALUES (?,?) ON CONFLICT(project_id) DO UPDATE SET args=excluded.args").run(projectId, text);
        else db.prepare<[string]>("DELETE FROM scheduled_start_settings WHERE project_id=?").run(projectId);
        publishProjectsChanged(bb, projectId);
        return { projectId, key, value: startArgsSetting(db, projectId) };
      }
      if (key in PR_EVENT_KEYS)
        return { projectId, key, value: setPrEventSetting(bb.storage.database(), projectId, key as keyof typeof PR_EVENT_KEYS, value) };
      if (key.startsWith(CHECKS_PREFIX)) {
        // `enabled` is the owner's, changed only from the project settings UI; every other field is validated and written alone.
        if (key === `${CHECKS_PREFIX}enabled`) throw new Error(CHECKS_ENABLED_OWNER_ONLY);
        const field = key.slice(CHECKS_PREFIX.length) as CheckField;
        if (!CHECK_FIELDS.includes(field)) throw new Error(`Unknown setting ${key}`);
        checksService(bb).setField(projectId, field, value);
        return { projectId, key, value: checksService(bb).configValues(projectId)[key] ?? null };
      }
      if (key.startsWith("git.")) {
        const field = key.slice(4);
        const current = createGitSyncStore(bb.storage.database()).config(projectId);
        // Compared with the value `config.get` returns (an absent overlapEnabled is its effective boolean), structurally.
        const stored = field === "overlapEnabled" ? overlapEnabled(current) : (current as Record<string, unknown>)[field] ?? null;
        if (expected !== undefined && structural(stored) !== structural(expected)) throw new Error(STALE_GIT_CONFIG);
        const next = (candidate: unknown) => gitSyncConfigSchema.safeParse({ ...current, [field]: candidate });
        let parsed = next(value);
        // A list setting also takes "a, b" so a shell caller needs no JSON.
        if (!parsed.success && typeof value === "string") parsed = next(value.split(",").map((item) => item.trim()).filter(Boolean));
        if (!parsed.success) throw new Error(`Invalid value for ${key}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        // The write is refused inside its transaction when the configuration changed since `current` was read.
        const { config } = await gitSyncService(bb, store).handlers.setGitSyncConfig({ projectId, config: parsed.data, ...(expected !== undefined ? { baseConfig: current } : {}) });
        return { projectId, key, value: field === "overlapEnabled" ? overlapEnabled(config) : (config as Record<string, unknown>)[field] ?? null };
      }
      // Project settings are string enums; "45" parsed as JSON arrives as a number.
      const parsed = PROJECT_KEYS[key as ProjectKey].parse(typeof value === "number" ? String(value) : value);
      const project = store.transaction(() => store.tasks.updateProject(projectId, { [key]: parsed }));
      publishProjectsChanged(bb, projectId);
      return { projectId, key, value: project[key as ProjectKey] };
    },
  };
}
