import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { TasksApiStore } from "../api";
import { planGatedStatuses } from "../shared/workflow-policy";
import { publishProjectsChanged } from "../api";
import { gitSyncService } from "../git-sync/service";
import { createGitSyncStore } from "../git-sync/store";
import { gitSyncConfigSchema } from "../shared/git-sync";
import { archiveSettingSchema, autoArchiveAfterDaysSchema, PLANNING_OWNER_ONLY, planningSchema, staleIdleThresholdSchema, statusNotificationsSchema } from "../shared/project-settings";

// Per-project settings addressable one key at a time; Git settings carry a "git." prefix.
const PROJECT_KEYS = {
  autoArchiveAfterDays: autoArchiveAfterDaysSchema,
  staleIdleMinutes: staleIdleThresholdSchema,
  statusNotifications: statusNotificationsSchema,
  archiveThreadsOnClose: archiveSettingSchema,
  archiveReviewerOnApproval: archiveSettingSchema,
  planning: planningSchema,
} as const;
type ProjectKey = keyof typeof PROJECT_KEYS;
const GIT_KEYS = Object.keys(gitSyncConfigSchema.shape) as (keyof z.infer<typeof gitSyncConfigSchema>)[];
export const PROJECT_CONFIG_KEYS = [...Object.keys(PROJECT_KEYS), ...GIT_KEYS.map((key) => `git.${key}`)];

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
    async "config.set"({ projectId, key, value }: { projectId: string; key: string; value?: unknown }) {
      requireKey(key);
      // The owner changes planning in the project settings (updateProject from the app); no setting call proves the caller is the owner.
      if (key === "planning") throw new Error(PLANNING_OWNER_ONLY);
      requireProject(projectId);
      if (key.startsWith("git.")) {
        const field = key.slice(4);
        const current = createGitSyncStore(bb.storage.database()).config(projectId);
        const next = (candidate: unknown) => gitSyncConfigSchema.safeParse({ ...current, [field]: candidate });
        let parsed = next(value);
        // A list setting also takes "a, b" so a shell caller needs no JSON.
        if (!parsed.success && typeof value === "string") parsed = next(value.split(",").map((item) => item.trim()).filter(Boolean));
        if (!parsed.success) throw new Error(`Invalid value for ${key}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
        const { config } = await gitSyncService(bb, store).handlers.setGitSyncConfig({ projectId, config: parsed.data });
        return { projectId, key, value: (config as Record<string, unknown>)[field] ?? null };
      }
      // Project settings are string enums; "45" parsed as JSON arrives as a number.
      const parsed = PROJECT_KEYS[key as ProjectKey].parse(typeof value === "number" ? String(value) : value);
      const project = store.transaction(() => store.tasks.updateProject(projectId, { [key]: parsed }));
      publishProjectsChanged(bb, projectId);
      return { projectId, key, value: project[key as ProjectKey] };
    },
  };
}
