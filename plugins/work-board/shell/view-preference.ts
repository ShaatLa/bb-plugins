import { migrateBrowserPreferences } from "./migrate-preferences.js";
import type { TaskViewMode } from "./routes.js";
import { mergeKanbanChoice, type KanbanChoice, type KanbanOpen, type KanbanPatch } from "./kanban-project.js";

export const VIEW_PREFERENCE_STORAGE_KEY = "bb-work-board:view-preferences";
// 2: the board became the default view, and choices saved while the toggle drove the side panel (before 0.54.0) are dropped.
export const VIEW_PREFERENCE_VERSION = 2 as const;
const LAST_PROJECT_STORAGE_KEY = "bb-work-board:last-project";

export function loadLastProjectId(): string | null {
  migrateBrowserPreferences();
  try {
    return window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeLastProjectId(projectId: string): void {
  migrateBrowserPreferences();
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, projectId);
  } catch {}
}

const LAST_ROUTE_STORAGE_KEY = "bb-work-board:last-route";

/** The panel location last shown in this app session, so reopening Work Board resumes it. */
export function loadLastRoute(): string | null {
  try {
    return window.sessionStorage.getItem(LAST_ROUTE_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeLastRoute(subPath: string): void {
  try {
    window.sessionStorage.setItem(LAST_ROUTE_STORAGE_KEY, subPath);
  } catch {}
}

const KANBAN_PROJECT_STORAGE_KEY = "bb-work-board:kanban-project";

const idOrNull = (value: unknown) => value === null || typeof value === "string";
const TASK_KEY = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;

/** A malformed `open` reads as nothing open; the rest of the value stays. */
function readOpen(value: unknown): KanbanOpen | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const { kind, taskKey } = value as Record<string, unknown>;
  return (kind === "task" || kind === "plan") && typeof taskKey === "string" && TASK_KEY.test(taskKey) ? { kind, taskKey } : undefined;
}

/** The right Kanban panel's choice for this app session; unreadable or malformed storage reads as nothing stored. */
export function loadKanbanChoice(): KanbanChoice | null {
  try {
    const raw = window.sessionStorage.getItem(KANBAN_PROJECT_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { projectId, followed, open } = parsed as Record<string, unknown>;
    if (!idOrNull(projectId) || !idOrNull(followed)) return null;
    const read = readOpen(open);
    return { projectId: projectId as string | null, followed: followed as string | null, ...(read ? { open: read } : {}) };
  } catch {
    return null;
  }
}

/** Merges the patch into what is stored, so no writer erases another's part. */
export function storeKanbanChoice(patch: KanbanPatch): void {
  try {
    window.sessionStorage.setItem(KANBAN_PROJECT_STORAGE_KEY, JSON.stringify(mergeKanbanChoice(loadKanbanChoice(), patch)));
  } catch {}
}

const DEFAULT_VIEW_MODE: TaskViewMode = "board";

interface StoredDocument {
  version: typeof VIEW_PREFERENCE_VERSION;
  lastUsed: TaskViewMode;
  projects: Record<string, TaskViewMode>;
}

function asViewMode(value: unknown): TaskViewMode | null {
  return value === "list" || value === "board" ? value : null;
}

interface ParsedStorage {
  lastUsed: TaskViewMode | null;
  projects: Record<string, unknown>;
  isFutureVersion: boolean;
}

function readStorage(): ParsedStorage | null {
  migrateBrowserPreferences();
  try {
    const raw = window.localStorage.getItem(VIEW_PREFERENCE_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const version =
      typeof record.version === "number" && Number.isFinite(record.version)
        ? record.version
        : null;
    if (version !== null && version < VIEW_PREFERENCE_VERSION) return null;
    const projects =
      record.projects !== null &&
      typeof record.projects === "object" &&
      !Array.isArray(record.projects)
        ? (record.projects as Record<string, unknown>)
        : {};
    return {
      lastUsed: asViewMode(record.lastUsed),
      projects,
      isFutureVersion: version !== null && version > VIEW_PREFERENCE_VERSION,
    };
  } catch {
    return null;
  }
}

export function loadViewMode(projectId: string): TaskViewMode {
  const document = readStorage();
  if (document === null) return DEFAULT_VIEW_MODE;
  return (
    asViewMode(document.projects[projectId]) ??
    document.lastUsed ??
    DEFAULT_VIEW_MODE
  );
}

export function storeViewMode(projectId: string, view: TaskViewMode): void {
  migrateBrowserPreferences();
  try {
    const existing = readStorage();
    if (existing?.isFutureVersion) return;
    const projects: Record<string, TaskViewMode> = {};
    for (const [id, value] of Object.entries(existing?.projects ?? {})) {
      const mode = asViewMode(value);
      if (mode !== null) projects[id] = mode;
    }
    projects[projectId] = view;
    const document: StoredDocument = {
      version: VIEW_PREFERENCE_VERSION,
      lastUsed: view,
      projects,
    };
    window.localStorage.setItem(
      VIEW_PREFERENCE_STORAGE_KEY,
      JSON.stringify(document),
    );
  } catch {}
}
