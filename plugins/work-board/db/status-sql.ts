import { ROLE_DEFAULTS } from "../shared/status-roles";

/**
 * SQL twins of `shared/status-roles.ts`: small fragments that read a project's `workflow_policy` and `statuses` JSON and
 * fall back to the same defaults, so a query never names a status id. `task` is the alias of a `tasks` row and `proj` the
 * alias of its `projects` row; `inProject` adds that join as a subquery for a query that has none (negate the whole `isXIn` fragment, so a missing project counts as not done). Every fragment is a
 * 0/1 value, never NULL, so `NOT` over it is safe. A test runs both sides over the same projects.
 */
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** The status id is listed by the project; a project without a list filters nothing. */
function listed(proj: string, id: string): string {
  return `(${proj}.statuses IS NULL OR json_array_length(${proj}.statuses)=0 OR EXISTS (SELECT 1 FROM json_each(${proj}.statuses) rs WHERE json_extract(rs.value,'$.id') = ${id}))`;
}

/** A single role's status id (NULL for none): explicit null is none, omitted is the default, an unlisted id is none. */
function single(proj: string, key: string, fallback: string): string {
  const path = `'$.${key}'`;
  const value = `json_extract(${proj}.workflow_policy,${path})`;
  return `(CASE WHEN json_type(${proj}.workflow_policy,${path})='null' THEN NULL
    WHEN json_type(${proj}.workflow_policy,${path})='text' THEN (CASE WHEN ${listed(proj, value)} THEN ${value} END)
    ELSE (CASE WHEN ${listed(proj, quote(fallback))} THEN ${quote(fallback)} END) END)`;
}

/** Whether the task's status is in an array role: the stored array (or the default) minus ids the project does not list. */
function member(task: string, proj: string, key: string, fallback: readonly string[]): string {
  const path = `'$.${key}'`;
  const array = `(CASE WHEN json_type(${proj}.workflow_policy,${path})='array' THEN json_extract(${proj}.workflow_policy,${path}) ELSE ${quote(JSON.stringify(fallback))} END)`;
  return `(${task}.status IN (SELECT value FROM json_each(${array})) AND ${listed(proj, `${task}.status`)})`;
}

/** The task is in the project's done status (what satisfies a dependency). */
export const doneSql = (task: string, proj: string) => `COALESCE(${task}.status = ${single(proj, "doneStatus", ROLE_DEFAULTS.doneStatus)}, 0)`;

/** The task is closed: in `closedStatuses`, the done status or the canceled status. */
export const closedSql = (task: string, proj: string) => `(${member(task, proj, "closedStatuses", ROLE_DEFAULTS.closedStatuses)}
  OR COALESCE(${task}.status = ${single(proj, "doneStatus", ROLE_DEFAULTS.doneStatus)}, 0)
  OR COALESCE(${task}.status = ${single(proj, "canceledStatus", ROLE_DEFAULTS.canceledStatus)}, 0))`;

/** The task has not started: in `notStartedStatuses`. */
export const notStartedSql = (task: string, proj: string) => member(task, proj, "notStartedStatuses", ROLE_DEFAULTS.notStartedStatuses);

/** `build` over the project of `task`, for a query that does not join `projects` itself. */
export function inProject(task: string, build: (proj: string) => string): string {
  const proj = `sp_${task}`;
  return `EXISTS (SELECT 1 FROM projects ${proj} WHERE ${proj}.id = ${task}.project_id AND ${build(proj)})`;
}
export const isClosedIn = (task: string) => inProject(task, (proj) => closedSql(task, proj));
export const isDoneIn = (task: string) => inProject(task, (proj) => doneSql(task, proj));
export const isNotStartedIn = (task: string) => inProject(task, (proj) => notStartedSql(task, proj));
/** The review status id of the task's project (NULL for none), for the review badge. */
export const reviewSql = (proj: string) => single(proj, "reviewStatus", ROLE_DEFAULTS.reviewStatus);
