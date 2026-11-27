/**
 * What a status means for a project comes from its workflow roles, never from a fixed status id. This module is the one
 * place that names the former system ids, as the defaults of roles a project leaves out. A default is computed here, at
 * read time, from the project's own status list; nothing is written back to the stored policy.
 *
 * Omitted, explicit null and explicit empty are different: an omitted role takes its default (when that status is
 * listed), an explicit null means "no such status", and an explicit array is used as stored minus the ids the project no
 * longer lists. A project without a status list (callers that hold only a policy) is not filtered at all.
 */
export const ROLE_DEFAULTS = {
  doneStatus: "done",
  canceledStatus: "canceled",
  closedStatuses: ["done", "canceled"],
  notStartedStatuses: ["backlog", "todo"],
  newCardStatus: "backlog",
  readyStatus: "todo",
  inProgressStatus: "in_progress",
  reviewStatus: "in_review",
  testingStatus: "in_testing",
  bugfixStatus: "bugfix",
  earlyStatuses: ["todo", "in_progress"],
  /** Unfiltered by the status list and independent of the other roles: exactly the pilot scope of a project that sets none. */
  pilotStatuses: ["in_progress", "in_review", "in_testing", "bugfix"],
} as const;

/** The single roles, as policy keys; each is nullable except `newCardStatus`. */
export const SINGLE_ROLES = ["doneStatus", "canceledStatus", "inProgressStatus", "reviewStatus", "testingStatus", "bugfixStatus", "planningStatus", "newCardStatus", "readyStatus"] as const;
/** The array roles, as policy keys. */
export const ARRAY_ROLES = ["earlyStatuses", "closedStatuses", "notStartedStatuses", "pilotStatuses"] as const;
export type SingleRole = (typeof SINGLE_ROLES)[number];
export type ArrayRole = (typeof ARRAY_ROLES)[number];

export type RoleProject = { workflowPolicy?: object | null; statuses?: ReadonlyArray<{ id: string }> | null };

export interface StatusRoles {
  done: string | null;
  canceled: string | null;
  /** Every closed status: `closedStatuses` plus the done and canceled roles. */
  closed: string[];
  notStarted: string[];
  newCard: string;
  ready: string;
  inProgress: string | null;
  review: string | null;
  testing: string | null;
  bugfix: string | null;
  early: string[];
  pilot: string[];
}

const raw = (project: RoleProject, key: string): unknown => (project.workflowPolicy as Record<string, unknown> | null | undefined)?.[key];

/** The listed status ids, or null when the project carries no list (then nothing is filtered). */
export function listedIds(project: RoleProject): string[] | null {
  return project.statuses?.length ? project.statuses.map((status) => status.id) : null;
}

function single(listed: string[] | null, value: unknown, fallback: string): string | null {
  if (value === null) return null;
  const id = typeof value === "string" ? value : fallback;
  return listed === null || listed.includes(id) ? id : null;
}

function many(listed: string[] | null, value: unknown, fallback: readonly string[]): string[] {
  const ids = Array.isArray(value) ? (value as string[]) : fallback;
  return listed === null ? [...ids] : ids.filter((id) => listed.includes(id));
}

/** The resolved roles of a project. Pure and cheap: call it where a status is interpreted. */
export function resolveRoles(project: RoleProject): StatusRoles {
  const listed = listedIds(project);
  const done = single(listed, raw(project, "doneStatus"), ROLE_DEFAULTS.doneStatus);
  const canceled = single(listed, raw(project, "canceledStatus"), ROLE_DEFAULTS.canceledStatus);
  const closed = [...new Set([...many(listed, raw(project, "closedStatuses"), ROLE_DEFAULTS.closedStatuses), ...(done ? [done] : []), ...(canceled ? [canceled] : [])])];
  const first = listed?.[0] ?? ROLE_DEFAULTS.newCardStatus;
  const newCardRaw = raw(project, "newCardStatus");
  const newCard = typeof newCardRaw === "string" && (listed === null || listed.includes(newCardRaw))
    ? newCardRaw
    : listed === null || listed.includes(ROLE_DEFAULTS.newCardStatus) ? ROLE_DEFAULTS.newCardStatus : first;
  const readyRaw = raw(project, "readyStatus");
  const ready = typeof readyRaw === "string" && (listed === null || listed.includes(readyRaw))
    ? readyRaw
    : readyRaw === undefined && (listed === null || listed.includes(ROLE_DEFAULTS.readyStatus)) ? ROLE_DEFAULTS.readyStatus : newCard;
  // `inProgressStatus` keeps its older rule: an explicit id is returned as configured, even unlisted; only null falls back.
  const progressRaw = raw(project, "inProgressStatus");
  const configured = progressRaw === undefined ? ROLE_DEFAULTS.inProgressStatus : progressRaw;
  const inProgress = typeof configured === "string" ? configured : listed === null || listed.includes(ROLE_DEFAULTS.inProgressStatus) ? ROLE_DEFAULTS.inProgressStatus : null;
  const pilotRaw = raw(project, "pilotStatuses");
  return {
    done,
    canceled,
    closed,
    notStarted: many(listed, raw(project, "notStartedStatuses"), ROLE_DEFAULTS.notStartedStatuses),
    newCard,
    ready,
    inProgress,
    review: single(listed, raw(project, "reviewStatus"), ROLE_DEFAULTS.reviewStatus),
    testing: single(listed, raw(project, "testingStatus"), ROLE_DEFAULTS.testingStatus),
    bugfix: single(listed, raw(project, "bugfixStatus"), ROLE_DEFAULTS.bugfixStatus),
    early: many(listed, raw(project, "earlyStatuses"), ROLE_DEFAULTS.earlyStatuses),
    pilot: Array.isArray(pilotRaw) ? many(listed, pilotRaw, []) : [...ROLE_DEFAULTS.pilotStatuses],
  };
}

/** Closed as done or as canceled; the policy's own done status counts. */
export const isClosed = (project: RoleProject, status: string): boolean => resolveRoles(project).closed.includes(status);
/** Closed, and not as canceled: the state a dependency waits for and a "done" notification reports. */
export const isClosedAsDone = (project: RoleProject, status: string): boolean => {
  const roles = resolveRoles(project);
  return roles.closed.includes(status) && status !== roles.canceled;
};
export const isDoneStatus = (project: RoleProject, status: string): boolean => resolveRoles(project).done === status;
export const isCanceledStatus = (project: RoleProject, status: string): boolean => resolveRoles(project).canceled === status;
export const isNotStarted = (project: RoleProject, status: string): boolean => resolveRoles(project).notStarted.includes(status);
