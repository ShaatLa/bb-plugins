import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db";
import type { PlanAuthor, PlanReview, PlanVersion, SaveTaskPlanInput, TaskPlanHead } from "../shared/contract";
import { assertNoSecrets } from "../shared/secret-guard.js";
import { planningStatusOf } from "../shared/workflow-policy";
import { statusLabel } from "../shared/statuses.js";
import { planningOffMessage, planningOn, planningRequired } from "../shared/project-settings";
import { isPaused, submitRefusal } from "./pause";
import { countPlanChanges, diffPlanBodies, type PlanDiff } from "../shared/plan-diff";
import {
  assertPlanText,
  PlanEditError,
  planAdvisory,
  replaceFragment,
  replaceSection,
  type PlanOp,
  type PlanState,
} from "../shared/plan";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export type PlanErrorCode = "planning_off" | "plan_conflict" | "plan_no_change" | "plan_invalid" | "plan_archived" | "plan_state" | "secret_detected";

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
  reviewer_kind: "owner" | "thread" | null;
  reviewer_thread: string | null;
  review_version: number | null;
}
interface ReviewRow {
  task_id: string;
  version: number;
  reviewer_kind: "owner" | "thread";
  reviewer_thread: string | null;
  submitted_by_thread: string | null;
  submitted_at: string;
  outcome: PlanReview["outcome"];
  decided_at: string | null;
  decided_by: string | null;
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

/** Ends the open review attempt of a task, if there is one. Callers run it inside the transaction that changes the plan. */
export function closePendingReview(db: Database, taskId: string, outcome: Exclude<PlanReview["outcome"], "pending">, decidedBy: string): void {
  db.prepare("UPDATE task_plan_reviews SET outcome = ?, decided_at = ?, decided_by = ? WHERE task_id = ? AND outcome = 'pending'").run(outcome, new Date().toISOString(), decidedBy, taskId);
}

/** Plans are a per-project setting; with planning off every plan operation is refused and the data stays untouched. */
export function assertPlanning(tasks: TasksStore, task: { projectId: string }): void {
  const project = tasks.getProject(task.projectId);
  if (project && !planningOn(project)) throw new PlanError("planning_off", planningOffMessage(project.prefix));
}

const author = (row: AuthorColumns): PlanAuthor => ({ kind: row.author_kind, threadId: row.author_thread, name: row.author_name });
const headOf = (row: PlanRow): TaskPlanHead => ({
  taskId: row.task_id,
  format: row.format,
  version: row.version,
  state: row.state,
  updatedAt: row.updated_at,
  updatedBy: author(row),
  // A plan stored before reviewers existed has no reviewer, which means the owner.
  reviewer: { kind: row.reviewer_kind ?? "owner", threadId: row.reviewer_thread },
  reviewVersion: row.review_version,
});
const reviewOf = (row: ReviewRow): PlanReview => ({
  version: row.version,
  reviewer: { kind: row.reviewer_kind, threadId: row.reviewer_thread },
  submittedByThread: row.submitted_by_thread,
  submittedAt: row.submitted_at,
  outcome: row.outcome,
  decidedAt: row.decided_at,
  decidedBy: row.decided_by,
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
  reviewer: { kind: row.reviewer_kind ?? "owner", threadId: row.reviewer_thread },
  reviewVersion: row.review_version,
  versions: versions.map((version) => ({ ...versionOf(version), body: version.body })),
});

export function createPlanStore(db: Database, tasks: TasksStore) {
  function requireTask(taskId: string) {
    const task = tasks.getTask(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    assertPlanning(tasks, task);
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
    return { ...headOf(row), paused: isPaused(db, taskId), requested: { ...versionOf(source), body: source.body } };
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
    // Every state but draft goes back to draft: a review, a request for changes or an approval belongs to one version only.
    const resetState = current && current.state !== "draft";
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

    closePendingReview(db, input.taskId, "superseded", by.name);
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
    // The first version of a plan moves a Backlog or Todo card into the planning status, in this same write. A card that is
    // further along, closed or archived stays; so does one whose target is not valid now or is gated.
    let movedTo: { status: string; label: string } | null = null;
    const project = !current && !task.archivedAt && task.scheduledRole !== "template" ? tasks.getProject(task.projectId) : undefined;
    const planning = project && planningOn(project) ? planningStatusOf(project) : null;
    if (planning && (task.status === "backlog" || task.status === "todo") && !tasks.planGate(task, planning)) {
      tasks.updateTask(task.id, { status: planning });
      movedTo = { status: planning, label: statusLabel(planning, project!.statuses) };
    }
    return { plan: headOf(planRow(input.taskId)!), version: versionOf(versionRow(input.taskId, version)!), movedTo };
  });

  function changeState(taskId: string, state: PlanState, by: PlanAuthor, text: string) {
    const row = planRow(taskId)!;
    const updatedAt = new Date().toISOString();
    db.prepare("UPDATE task_plans SET state = ?, updated_at = ? WHERE task_id = ?").run(state, updatedAt, taskId);
    comment(taskId, by, `Plan v${row.version} ${text} by ${by.name}`);
    return { plan: headOf(planRow(taskId)!), version: null };
  }

  /** Opens a review attempt: the head names the reviewer and the version under review, and the history gets a row. */
  function startReview(taskId: string, version: number, reviewerThread: string | null, by: PlanAuthor, dedicated = false) {
    const now = new Date().toISOString();
    db.prepare("UPDATE task_plans SET state = 'in_review', updated_at = ?, reviewer_kind = ?, reviewer_thread = ?, review_version = ? WHERE task_id = ?").run(
      now,
      reviewerThread ? "thread" : "owner",
      reviewerThread,
      version,
      taskId,
    );
    db.prepare(
      "INSERT INTO task_plan_reviews (task_id, version, reviewer_kind, reviewer_thread, submitted_by_thread, submitted_at, outcome, dedicated_reviewer) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
    ).run(taskId, version, reviewerThread ? "thread" : "owner", reviewerThread, by.threadId, now, reviewerThread && dedicated ? 1 : 0);
  }

  /**
   * The author submits the plan to a reviewer: a reviewer thread, or null for the owner. A repeat to the same reviewer
   * changes nothing (`resent`: the caller only wakes the reviewer again); another reviewer takes the review over.
   * `unusable` says why the reviewer thread cannot be used (archived, deleted); it refuses a new or reassigned review.
   */
  const submit = db.transaction((taskId: string, by: PlanAuthor, reviewerThread: string | null, unusable: string | null = null, defaultedFrom: { kind: "owner" | "thread"; threadId: string | null } | null = null, dedicated = false) => {
    const task = requireEditable(taskId);
    const row = planRow(taskId);
    // A bare resubmit chose the latest attempt's reviewer before an asynchronous lookup; that choice must still hold now.
    if (defaultedFrom) {
      const now = db.prepare<[string], ReviewRow>("SELECT * FROM task_plan_reviews WHERE task_id = ? ORDER BY id DESC LIMIT 1").get(taskId);
      if (now?.reviewer_kind !== defaultedFrom.kind || (now?.reviewer_thread ?? null) !== defaultedFrom.threadId)
        throw new PlanError("plan_conflict", `The reviewer of ${task.key} changed while you resubmitted; run \`plan submit\` again to send it to the current reviewer`);
    }
    if (!row) throw new PlanError("plan_invalid", `${task.key} has no plan to submit; create it with \`bb work-board plan set ${task.key} --base-version 0\``);
    const refused = submitRefusal(db, task.key, taskId);
    if (refused) throw new PlanError("plan_state", refused);
    if (row.state === "approved") throw new PlanError("plan_state", `Plan v${row.version} is already approved; a new version returns it to draft`);
    if (row.state === "changes_requested")
      throw new PlanError("plan_state", `Plan v${row.version} has changes requested; revise it and save a new version (\`bb work-board plan edit ${task.key} … --base-version ${row.version}\`), then submit again`);
    if (reviewerThread) {
      const wrote = db.prepare("SELECT 1 AS found FROM task_plan_versions WHERE task_id = ? AND author_thread = ? LIMIT 1").get(taskId, reviewerThread);
      if (wrote || reviewerThread === by.threadId) throw new PlanError("plan_invalid", `${reviewerThread} wrote or submitted this plan; the reviewer must be another thread (or the owner, when the user asked to approve it)`);
    }
    const kind = reviewerThread ? "thread" : "owner";
    if (row.state === "in_review" && (row.reviewer_kind ?? "owner") === kind && row.reviewer_thread === reviewerThread)
      return { plan: headOf(row), version: null, outcome: "resent" as const };
    if (unusable) throw new PlanError("plan_invalid", unusable);
    const label = reviewerThread ?? "the owner";
    const reassigned = row.state === "in_review";
    if (reassigned) closePendingReview(db, taskId, "reassigned", by.name);
    startReview(taskId, row.version, reviewerThread, by, dedicated);
    comment(taskId, by, reassigned ? `Plan: review of v${row.version} reassigned to ${label}` : `Plan v${row.version} submitted for review by ${label}`);
    return { plan: headOf(planRow(taskId)!), version: null, outcome: reassigned ? ("reassigned" as const) : ("submitted" as const) };
  });

  /** Owner decisions on the plan; a repeated state is a no-op. */
  const setState = db.transaction((taskId: string, state: "in_review" | "approved" | "changes_requested", by: PlanAuthor) => {
    const task = requireEditable(taskId);
    const row = planRow(taskId);
    if (!row) throw new PlanError("plan_invalid", `${task.key} has no plan`);
    if (row.state === state) return { plan: headOf(row), version: null, changed: false };
    // The same rules as `submit` and `approvePlan`, checked before any history write or delivery: a review is bound to a
    // version, so a plan that was decided needs a new version before it goes back to review, and unsent drafts block an approval.
    if (state === "in_review" && row.state !== "draft")
      throw new PlanError("plan_state", `Plan v${row.version} is ${row.state.replace("_", " ")}; save a new version before it goes back to review`);
    if (state === "approved") {
      const drafts = db.prepare<[string], { count: number }>("SELECT COUNT(*) AS count FROM task_plan_notes WHERE task_id = ? AND state = 'draft' AND author_kind = 'person'").get(taskId)!.count;
      if (drafts > 0) throw new PlanError("plan_state", `${task.key} has ${drafts} draft note${drafts === 1 ? "" : "s"} not sent yet; send them as feedback or delete them before approving`);
    }
    if (state === "in_review") {
      const refused = submitRefusal(db, task.key, taskId);
      if (refused) throw new PlanError("plan_state", refused);
    }
    const text = { in_review: "submitted for review", approved: "approved", changes_requested: "changes requested" }[state];
    if (state === "in_review") startReview(taskId, row.version, null, by);
    else closePendingReview(db, taskId, state, by.name);
    return { ...changeState(taskId, state, by, text), changed: true };
  });

  /** Review attempts without the planning check, for export and import. */
  const captureReviews = (taskId: string): PlanReview[] => db.prepare<[string], ReviewRow>("SELECT * FROM task_plan_reviews WHERE task_id = ? ORDER BY id").all(taskId).map(reviewOf);
  const listReviews = (taskId: string): PlanReview[] => {
    requireTask(taskId);
    return captureReviews(taskId);
  };

  /** The non-blocking plan line for executors of a card; null when planning is off or the plan is approved. */
  function advisoryFor(task: { id: string; projectId: string; type: string }): string | null {
    const project = tasks.getProject(task.projectId);
    if (!project || !planningOn(project)) return null;
    return planAdvisory(head(task.id), planningRequired(project) && task.type !== "epic");
  }

  /** The thread of the newest agent-written version: the session that is expected to react to a review. */
  function latestAgentThread(taskId: string): string | null {
    return (
      db
        .prepare<[string], { author_thread: string }>(
          "SELECT author_thread FROM task_plan_versions WHERE task_id = ? AND author_kind = 'agent' AND author_thread IS NOT NULL ORDER BY version DESC LIMIT 1",
        )
        .get(taskId)?.author_thread ?? null
    );
  }

  /**
   * The threads a review result of `version` goes to. The actor is the session that submitted that version's latest attempt, or the
   * agent that wrote the version when there is no attempt or it was submitted without a thread; the copy is the other
   * one, for information. Never the task's worker thread.
   */
  function resultRecipients(taskId: string, version: number): { actor: string | null; copy: string | null } {
    const written = versionRow(taskId, version);
    const author = written?.author_kind === "agent" ? written.author_thread : null;
    // The attempt of the decided version only: a later draft that was never submitted has no submitter yet.
    const latest = db.prepare<[string, number], { submitted_by_thread: string | null }>("SELECT submitted_by_thread FROM task_plan_reviews WHERE task_id = ? AND version = ? ORDER BY id DESC LIMIT 1").get(taskId, version);
    const submitter = latest?.submitted_by_thread ?? null;
    return submitter ? { actor: submitter, copy: author !== submitter ? author : null } : { actor: author, copy: null };
  }

  /** The newest version this reviewer thread itself decided on (asked for changes or approved), for the wake of a resubmission. */
  function lastDecidedVersion(taskId: string, reviewerThread: string): number | null {
    return (
      db
        .prepare<[string, string, string], { version: number | null }>(
          "SELECT MAX(version) AS version FROM task_plan_reviews WHERE task_id = ? AND reviewer_thread = ? AND decided_by = ? AND outcome IN ('changes_requested', 'approved')",
        )
        .get(taskId, reviewerThread, reviewerThread)?.version ?? null
    );
  }

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
      `INSERT INTO task_plans (task_id, format, version, body, state, updated_at, author_kind, author_thread, author_name, reviewer_kind, reviewer_thread, review_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(taskId, plan.format, plan.version, plan.body, plan.state, plan.updatedAt, plan.updatedBy.kind, plan.updatedBy.threadId, plan.updatedBy.name, plan.reviewer.kind, plan.reviewer.threadId, plan.reviewVersion);
  }

  /** Every review attempt of a project in one statement, for export. */
  function captureReviewsProject(projectId: string): Map<string, PlanReview[]> {
    const result = new Map<string, PlanReview[]>();
    for (const row of db
      .prepare<[string], ReviewRow>("SELECT r.* FROM task_plan_reviews r JOIN tasks t ON t.id = r.task_id WHERE t.project_id = ? ORDER BY r.task_id, r.id")
      .all(projectId)) {
      const list = result.get(row.task_id) ?? [];
      list.push(reviewOf(row));
      result.set(row.task_id, list);
    }
    return result;
  }

  /** Replaces a task's review history with an imported one. */
  function restoreReviews(taskId: string, reviews: readonly PlanReview[]): void {
    db.prepare("DELETE FROM task_plan_reviews WHERE task_id = ?").run(taskId);
    const insert = db.prepare(
      "INSERT INTO task_plan_reviews (task_id, version, reviewer_kind, reviewer_thread, submitted_by_thread, submitted_at, outcome, decided_at, decided_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of reviews) insert.run(taskId, r.version, r.reviewer.kind, r.reviewer.threadId, r.submittedByThread, r.submittedAt, r.outcome, r.decidedAt, r.decidedBy);
  }

  /** Whether the plan's review is paused on an open owner decision; derived from the live decisions. */
  const paused = (taskId: string): boolean => isPaused(db, taskId);

  return { head, get, paused, listVersions, save, submit, setState, listReviews, captureReviews, advisoryFor, resultRecipients, lastDecidedVersion, diff, latestAgentThread, capture, captureProject, restore, captureReviewsProject, restoreReviews };
}

export type PlanStore = ReturnType<typeof createPlanStore>;
