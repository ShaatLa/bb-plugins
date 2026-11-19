import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import type { PlanAuthor, PlanVersion, SaveTaskPlanInput, TaskPlanHead } from "../shared/contract";
import { assertNoSecrets } from "../shared/secret-guard.js";
import { countPlanChanges, diffPlanBodies, type PlanDiff } from "../shared/plan-diff";
import {
  assertPlanText,
  PlanEditError,
  replaceFragment,
  replaceSection,
  type PlanOp,
  type PlanState,
} from "../shared/plan";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type PlanErrorCode = "plan_conflict" | "plan_no_change" | "plan_invalid" | "plan_archived" | "plan_state" | "secret_detected";

/** A refused plan write; the message is written for the agent that has to react to it. */
export class PlanError extends Error {
  constructor(
    readonly code: PlanErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

interface AuthorColumns {
  author_kind: "agent" | "person";
  author_thread: string | null;
  author_name: string;
}
interface PlanRow extends AuthorColumns {
  task_id: string;
  format: "markdown";
  version: number;
  body: string;
  state: PlanState;
  updated_at: string;
}
interface VersionRow extends AuthorColumns {
  task_id: string;
  version: number;
  body: string;
  base_version: number;
  op: PlanOp;
  target: string | null;
  summary: string;
  added: number;
  removed: number;
  created_at: string;
}

/** One task's plan as stored in an export: the current plan plus every version with its body. */
export interface CapturedPlan extends Omit<TaskPlanHead, "taskId"> {
  body: string;
  versions: Array<PlanVersion & { body: string }>;
}

const author = (row: AuthorColumns): PlanAuthor => ({ kind: row.author_kind, threadId: row.author_thread, name: row.author_name });
const headOf = (row: PlanRow): TaskPlanHead => ({
  taskId: row.task_id,
  format: row.format,
  version: row.version,
  state: row.state,
  updatedAt: row.updated_at,
  updatedBy: author(row),
});
const versionOf = (row: VersionRow): PlanVersion => ({
  version: row.version,
  baseVersion: row.base_version,
  op: row.op,
  target: row.target,
  summary: row.summary,
  author: author(row),
  createdAt: row.created_at,
  added: row.added,
  removed: row.removed,
});
const capturedOf = (row: PlanRow, versions: VersionRow[]): CapturedPlan => ({
  format: row.format,
  version: row.version,
  body: row.body,
  state: row.state,
  updatedAt: row.updated_at,
  updatedBy: author(row),
  versions: versions.map((version) => ({ ...versionOf(version), body: version.body })),
});

export function createPlanStore(db: Database, tasks: TasksStore) {
  function requireTask(taskId: string) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    return task;
  }
  function requireEditable(taskId: string) {
    const task = requireTask(taskId);
    if (task.archivedAt) throw new PlanError("plan_archived", `${task.key} is archived; restore the task before changing its plan`);
    return task;
  }
  const planRow = (taskId: string) => db.prepare<[string], PlanRow>("SELECT * FROM task_plans WHERE task_id = ?").get(taskId);
  const versionRow = (taskId: string, version: number) =>
    db.prepare<[string, number], VersionRow>("SELECT * FROM task_plan_versions WHERE task_id = ? AND version = ?").get(taskId, version);

  function comment(taskId: string, by: PlanAuthor, body: string) {
    tasks.createComment({ taskId, kind: "system", authorName: by.name, body });
  }

  /** The plan head, or null when the task has no plan. */
  function head(taskId: string): TaskPlanHead | null {
    const row = planRow(taskId);
    return row ? headOf(row) : null;
  }

  function get(taskId: string, version?: number) {
    requireTask(taskId);
    const row = planRow(taskId);
    if (!row) return null;
    const requested = version === undefined || version === row.version ? undefined : versionRow(taskId, version);
    if (version !== undefined && version !== row.version && !requested)
      throw new Error(`Plan version ${version} does not exist; the current version is ${row.version}`);
    const source = requested ?? versionRow(taskId, row.version)!;
    return { ...headOf(row), requested: { ...versionOf(source), body: source.body } };
  }

  function listVersions(taskId: string) {
    requireTask(taskId);
    const rows = db
      .prepare<[string], VersionRow>("SELECT * FROM task_plan_versions WHERE task_id = ? ORDER BY version")
      .all(taskId);
    return { plan: head(taskId), versions: rows.map(versionOf) };
  }

  const save = db.transaction((input: SaveTaskPlanInput) => {
    const task = requireEditable(input.taskId);
    const current = planRow(input.taskId);
    const by = input.author;
    if (!current) {
      if (input.baseVersion !== 0)
        throw new PlanError("plan_conflict", `${task.key} has no plan yet, so the base version must be 0 (you passed ${input.baseVersion})`);
      if (input.op !== "replace")
        throw new PlanError("plan_invalid", `${task.key} has no plan to edit; create it first with \`bb work-board plan set ${task.key} --base-version 0\``);
    } else if (input.baseVersion !== current.version) {
      throw new PlanError(
        "plan_conflict",
        `The plan changed: current version is v${current.version}, but you edited from v${input.baseVersion}. Re-read it with \`bb work-board plan show ${task.key}\`, reapply your change and pass --base-version ${current.version}.`,
      );
    }

    let body: string;
    let op: PlanOp = input.op;
    let target: string | null = null;
    try {
      if (input.op === "replace") {
        body = input.body;
        if (!current) op = "create";
      } else if (input.op === "section") {
        body = replaceSection(current!.body, input.section, input.body);
        target = input.section.trim();
      } else if (input.op === "fragment") {
        body = replaceFragment(current!.body, input.find, input.replace);
        target = input.find.length > 200 ? `${input.find.slice(0, 200)}…` : input.find;
      } else {
        const source = versionRow(input.taskId, input.restoreVersion);
        if (!source) throw new PlanEditError(`Plan version ${input.restoreVersion} does not exist; the current version is v${current!.version}`);
        body = source.body;
        target = `v${input.restoreVersion}`;
      }
      assertPlanText(body, input.summary);
    } catch (error) {
      if (error instanceof PlanEditError) throw new PlanError("plan_invalid", error.message);
      throw error;
    }
    assertNoSecrets(body, "plan");
    assertNoSecrets(input.summary, "plan summary");
    assertNoSecrets(target ?? undefined, "plan target");
    if (current && body === current.body) throw new PlanError("plan_no_change", "No change: the plan already has exactly this content");

    const summary = input.summary.trim();
    const { added, removed } = countPlanChanges(current?.body ?? "", body);
    const version = (current?.version ?? 0) + 1;
    const resetState = current && (current.state === "approved" || current.state === "changes_requested");
    const state: PlanState = resetState ? "draft" : (current?.state ?? "draft");
    const createdAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO task_plan_versions (task_id, version, body, base_version, op, target, summary, author_kind, author_thread, author_name, added, removed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.taskId, version, body, input.baseVersion, op, target, summary, by.kind, by.threadId, by.name, added, removed, createdAt);
    db.prepare(
      `INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name)
       VALUES (?, 'markdown', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (task_id) DO UPDATE SET version = excluded.version, body = excluded.body, state = excluded.state,
         updated_at = excluded.updated_at, author_kind = excluded.author_kind, author_thread = excluded.author_thread, author_name = excluded.author_name`,
    ).run(input.taskId, version, body, state, createdAt, by.kind, by.threadId, by.name);

    const kind = {
      create: "new plan",
      replace: "full rewrite",
      section: `section "${target}"`,
      fragment: "fragment",
      restore: `restored from ${target}`,
    }[op];
    comment(
      input.taskId,
      by,
      [`Plan v${version} by ${by.name}: ${summary}`, kind, `+${added} −${removed} lines`, ...(resetState ? [`state ${current!.state} → draft`] : [])].join(" · "),
    );
    return { plan: headOf(planRow(input.taskId)!), version: versionOf(versionRow(input.taskId, version)!) };
  });

  function changeState(taskId: string, state: PlanState, by: PlanAuthor, text: string) {
    const row = planRow(taskId)!;
    const updatedAt = new Date().toISOString();
    db.prepare("UPDATE task_plans SET state = ?, updated_at = ? WHERE task_id = ?").run(state, updatedAt, taskId);
    comment(taskId, by, `Plan v${row.version} ${text} by ${by.name}`);
    return { plan: headOf(planRow(taskId)!), version: null };
  }

  const submit = db.transaction((taskId: string, by: PlanAuthor) => {
    const task = requireEditable(taskId);
    const row = planRow(taskId);
    if (!row) throw new PlanError("plan_invalid", `${task.key} has no plan to submit; create it with \`bb work-board plan set ${task.key} --base-version 0\``);
    if (row.state === "in_review") throw new PlanError("plan_state", `Plan v${row.version} is already in review`);
    if (row.state === "approved") throw new PlanError("plan_state", `Plan v${row.version} is already approved; a new version returns it to draft`);
    return changeState(taskId, "in_review", by, "submitted for review");
  });

  /** Owner decisions on the plan; a repeated state is a no-op. */
  const setState = db.transaction((taskId: string, state: "in_review" | "approved" | "changes_requested", by: PlanAuthor) => {
    const task = requireEditable(taskId);
    const row = planRow(taskId);
    if (!row) throw new PlanError("plan_invalid", `${task.key} has no plan`);
    if (row.state === state) return { plan: headOf(row), version: null, changed: false };
    const text = { in_review: "submitted for review", approved: "approved", changes_requested: "changes requested" }[state];
    return { ...changeState(taskId, state, by, text), changed: true };
  });

  /** Line diff between two versions; version 0 is the empty plan. Defaults: previous version → current. */
  function diff(taskId: string, from?: number, to?: number): PlanDiff & { from: number; to: number } {
    const task = requireTask(taskId);
    const row = planRow(taskId);
    if (!row) throw new Error(`${task.key} has no plan`);
    const target = to ?? row.version;
    const source = from ?? Math.max(0, target - 1);
    const body = (version: number) => {
      if (version === 0) return "";
      const found = versionRow(taskId, version);
      if (!found) throw new Error(`Plan version ${version} does not exist; the current version is ${row.version}`);
      return found.body;
    };
    return { from: source, to: target, ...diffPlanBodies(body(source), body(target), { from: `${task.key} plan v${source}`, to: `${task.key} plan v${target}` }) };
  }

  /** Every plan of a project in two statements, for export. */
  function captureProject(projectId: string): Map<string, CapturedPlan> {
    const plans = db
      .prepare<[string], PlanRow>("SELECT p.* FROM task_plans p JOIN tasks t ON t.id = p.task_id WHERE t.project_id = ?")
      .all(projectId);
    const versions = new Map<string, VersionRow[]>();
    for (const row of db
      .prepare<[string], VersionRow>("SELECT v.* FROM task_plan_versions v JOIN tasks t ON t.id = v.task_id WHERE t.project_id = ? ORDER BY v.task_id, v.version")
      .all(projectId)) {
      const list = versions.get(row.task_id) ?? [];
      list.push(row);
      versions.set(row.task_id, list);
    }
    return new Map(plans.map((row) => [row.task_id, capturedOf(row, versions.get(row.task_id) ?? [])]));
  }

  function capture(taskId: string): CapturedPlan | null {
    const row = planRow(taskId);
    if (!row) return null;
    return capturedOf(row, db.prepare<[string], VersionRow>("SELECT * FROM task_plan_versions WHERE task_id = ? ORDER BY version").all(taskId));
  }

  /** Replaces a task's plan and history with an imported one (or removes it). */
  function restore(taskId: string, plan: CapturedPlan | null): void {
    db.prepare("DELETE FROM task_plan_versions WHERE task_id = ?").run(taskId);
    db.prepare("DELETE FROM task_plans WHERE task_id = ?").run(taskId);
    if (!plan) return;
    const insertVersion = db.prepare(
      `INSERT INTO task_plan_versions (task_id, version, body, base_version, op, target, summary, author_kind, author_thread, author_name, added, removed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const v of plan.versions)
      insertVersion.run(taskId, v.version, v.body, v.baseVersion, v.op, v.target, v.summary, v.author.kind, v.author.threadId, v.author.name, v.added, v.removed, v.createdAt);
    db.prepare(
      `INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskId, plan.format, plan.version, plan.body, plan.state, plan.updatedAt, plan.updatedBy.kind, plan.updatedBy.threadId, plan.updatedBy.name);
  }

  return { head, get, listVersions, save, submit, setState, diff, capture, captureProject, restore };
}

export type PlanStore = ReturnType<typeof createPlanStore>;
