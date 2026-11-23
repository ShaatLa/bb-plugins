import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

// Field validators of the repository-check runner. Each is checked on its own when one field is set.
export const FIELD_SCHEMAS = {
  branch: z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/),
  script: z.string().min(1).max(1000).refine((s) => !s.startsWith("/") && !s.split("/").includes(".."), "script must be repository-relative, with no .. segment"),
  args: z.array(z.string().max(10000)).max(100),
  intervalMinutes: z.number().int().min(1).max(1440),
  timeoutSeconds: z.number().int().min(1).max(300),
  snapshots: z.boolean(),
} as const;
export type CheckField = keyof typeof FIELD_SCHEMAS;
export const CHECK_FIELDS = Object.keys(FIELD_SCHEMAS) as CheckField[];
export const CHECKS_PREFIX = "checks.";
export const CHECKS_CONFIG_KEYS = ["enabled", ...CHECK_FIELDS].map((field) => `${CHECKS_PREFIX}${field}`);
export const DEFAULT_INTERVAL_MINUTES = 10;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const CHECKS_ENABLED_OWNER_ONLY = "checks.enabled is changed by the owner in the project settings; this is an owner-only convention, and no command or setting call proves the caller is the owner.";

/** The settings a runner needs to execute: branch and script are required, the rest have defaults. */
export const completeSchema = z.object({
  branch: FIELD_SCHEMAS.branch,
  script: FIELD_SCHEMAS.script,
  args: FIELD_SCHEMAS.args.default([]),
  intervalMinutes: FIELD_SCHEMAS.intervalMinutes.default(DEFAULT_INTERVAL_MINUTES),
  timeoutSeconds: FIELD_SCHEMAS.timeoutSeconds.default(DEFAULT_TIMEOUT_SECONDS),
  snapshots: FIELD_SCHEMAS.snapshots.default(false),
});
export type ChecksConfig = z.infer<typeof completeSchema>;

/** The stored state of one tracker; a null field was never set. */
export interface ChecksDraft {
  enabled: boolean;
  enabledChangedAt: string | null;
  enabledPrevious: boolean | null;
  branch: string | null;
  script: string | null;
  args: string[] | null;
  intervalMinutes: number | null;
  timeoutSeconds: number | null;
  snapshots: boolean | null;
}

const COLUMNS: Record<CheckField, string> = { branch: "branch", script: "script", args: "args", intervalMinutes: "interval_minutes", timeoutSeconds: "timeout_seconds", snapshots: "snapshots" };

interface ConfigRow {
  enabled: number; enabled_changed_at: string | null; enabled_previous: number | null; branch: string | null; script: string | null;
  args: string | null; interval_minutes: number | null; timeout_seconds: number | null; snapshots: number | null;
}

export function readDraft(db: Database, trackerId: string): ChecksDraft {
  const row = db.prepare<[string], ConfigRow>("SELECT * FROM checks_config WHERE tracker_id=?").get(trackerId);
  return {
    enabled: row?.enabled === 1,
    enabledChangedAt: row?.enabled_changed_at ?? null,
    enabledPrevious: row?.enabled_previous == null ? null : row.enabled_previous === 1,
    branch: row?.branch ?? null,
    script: row?.script ?? null,
    args: row?.args == null ? null : (JSON.parse(row.args) as string[]),
    intervalMinutes: row?.interval_minutes ?? null,
    timeoutSeconds: row?.timeout_seconds ?? null,
    snapshots: row?.snapshots == null ? null : row.snapshots === 1,
  };
}

/** The values as they apply, defaults filled in; branch and script stay null until set. */
export const effectiveConfig = (draft: ChecksDraft) => ({
  enabled: draft.enabled,
  branch: draft.branch,
  script: draft.script,
  args: draft.args ?? [],
  intervalMinutes: draft.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES,
  timeoutSeconds: draft.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  snapshots: draft.snapshots ?? false,
});

/** Full validation: run when enabling and again before every execution. */
export function completeConfig(draft: ChecksDraft): { ok: true; config: ChecksConfig } | { ok: false; error: string } {
  const parsed = completeSchema.safeParse({
    branch: draft.branch ?? undefined, script: draft.script ?? undefined, args: draft.args ?? undefined,
    intervalMinutes: draft.intervalMinutes ?? undefined, timeoutSeconds: draft.timeoutSeconds ?? undefined, snapshots: draft.snapshots ?? undefined,
  });
  if (parsed.success) return { ok: true, config: parsed.data };
  const missing = ["branch", "script"].filter((field) => draft[field as "branch" | "script"] === null);
  return { ok: false, error: missing.length ? `Set ${missing.join(" and ")} (for example branch main, script checks/run.py) first.` : `Invalid settings: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}` };
}

/**
 * Writes one field. The UPDATE touches only that column, so concurrent edits of different fields merge in the database and a
 * stale save of one field can never restore another (or `enabled`).
 */
export function writeField(db: Database, trackerId: string, field: CheckField, value: unknown): void {
  const stored = field === "args" ? JSON.stringify(value) : field === "snapshots" ? (value ? 1 : 0) : value;
  db.prepare<[string]>("INSERT OR IGNORE INTO checks_config(tracker_id) VALUES (?)").run(trackerId);
  db.prepare(`UPDATE checks_config SET ${COLUMNS[field]}=? WHERE tracker_id=?`).run(stored, trackerId);
}

/** Records the change of `enabled` with its time and previous value. */
export function writeEnabled(db: Database, trackerId: string, enabled: boolean): void {
  const previous = readDraft(db, trackerId).enabled;
  db.prepare<[string]>("INSERT OR IGNORE INTO checks_config(tracker_id) VALUES (?)").run(trackerId);
  db.prepare<[number, string, number, string]>("UPDATE checks_config SET enabled=?, enabled_changed_at=?, enabled_previous=? WHERE tracker_id=?").run(enabled ? 1 : 0, new Date().toISOString(), previous ? 1 : 0, trackerId);
}

/** Fields whose CLI value is literal text, never JSON: `1e3` is a legal branch name. */
export const LITERAL_TEXT_FIELDS: readonly CheckField[] = ["branch", "script"];

/** Validates one supplied value strictly: a typed caller's number is not a branch. */
export function parseField(field: CheckField, value: unknown): unknown {
  const parsed = FIELD_SCHEMAS[field].safeParse(value);
  if (!parsed.success) throw new Error(`Invalid value for checks.${field}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  return parsed.data;
}
