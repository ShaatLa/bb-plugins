import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { TasksApiStore } from "../api";
import { publishCommentsChanged, publishTasksChanged } from "../api";
import { DelegationError, agentTarget, dispatchToTarget, handlers as delegationHandlers, presetSpawnEnvironment, presetTarget, publishThreadsChanged, type DispatchTarget } from "../delegate";
import { cardComment, createOnceNotices, type NoticeRow, type Why } from "../notices/once";
import { managerOf } from "../queue/store";
import type { tasksRpcContract, ScheduledStartInfo, StartAgent } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import { taskMarkdownLink } from "../shared/task-link";
import { firstReachable, searchAttentionMarker } from "../steer";
import { StartRefusal, checkAgent } from "./agent";
import { PolicyReadError, callStart, isDefiniteRefusal, reasonCodeOf, resolveMode } from "./policy";
import {
  activeStart, assertMayEdit, cancelStart, cardFacts, changeStart, claimDue, currentStart, insertStart, listLog, markAttached, markerOf, pruneLog, recordOutcome,
  releaseClaim, resolveStart, setLaunchParent, toStart, type Launch, type ScheduledStart,
} from "./store";
import { parseStartTime, splitArgs, withoutFinalPeriod } from "./when";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type Names = "scheduleStart" | "changeScheduledStart" | "cancelScheduledStart" | "resolveScheduledStart" | "getScheduledStart" | "scheduleOptions" | "checkScheduledStart" | "listScheduledStartLog";

/** The builder arguments of the bb-plugins convention; a project with another builder sets `scheduledStartArgs`. */
export const DEFAULT_START_ARGS = "--card {key} --role impl";
/** A policy that stays unreadable this long after the start time ends the attempt. */
export const POLICY_GIVE_UP_MS = 30 * 60_000;

export function startArgsSetting(db: Database, projectId: string): string {
  return db.prepare<[string], { args: string }>("SELECT args FROM scheduled_start_settings WHERE project_id=?").get(projectId)?.args ?? DEFAULT_START_ARGS;
}
const fillKey = (args: string[], key: string) => args.map((arg) => arg.replaceAll("{key}", key));

// --- The notice a refused or unknown start owes its setter ---

type StartNoticeRow = NoticeRow & { notice_id: string; start_id: string; kind: string; detail: string; created_at: string };
function noticeText(_db: Database, row: StartNoticeRow, why: Why): string {
  const link = taskMarkdownLink(row.task_key);
  return [
    row.kind === "refused" ? `The scheduled start of ${link} was refused and nothing was started: ${withoutFinalPeriod(row.detail)}.` : `The scheduled start of ${link} has an unknown outcome: ${withoutFinalPeriod(row.detail)}. A session may exist; the start is not retried. Check the project's threads, then run: bb work-board schedule resolve ${row.task_key} --launched <thread> | --not-launched.`,
    `Scheduled by ${row.setter}.`,
    why === "archived" ? `You get this because ${row.setter} is archived or gone.` : why === "none" ? `You get this because ${row.setter} is archived or gone and no live parent was found.` : why === "owner" ? "You get this because the start was scheduled by the owner, not by a thread." : "",
  ].filter(Boolean).join(" ");
}
export const drainStartNotices = createOnceNotices<StartNoticeRow>({ table: "scheduled_start_notices", key: "notice_id", order: "created_at", label: "Scheduled start notice", marker: (row) => `<!-- work-board-scheduled-start-notice:${row.notice_id} -->`, text: noticeText });

// --- Resolving what a start needs ---

/** The thread that owns the launched session: the setter, else its nearest live ancestor, else the project's manager. Throws when a read fails. */
async function resolveParent(bb: BbPluginApi, db: Database, setter: string, projectId: string): Promise<string | undefined> {
  if (setter !== "owner") {
    const found = await firstReachable(bb, [setter], {}, true);
    if (found) return found;
  }
  const manager = managerOf(db, projectId);
  return manager ? firstReachable(bb, [manager], {}, true) : undefined;
}

export function toInfo(db: Database, start: ScheduledStart): ScheduledStartInfo {
  const name = start.presetId ? db.prepare<[string], { name: string }>("SELECT name FROM presets WHERE id=?").get(start.presetId)?.name : undefined;
  return {
    id: start.id, taskId: start.taskId, at: start.startAt, mode: start.mode, state: start.state, setter: start.setter,
    ...(start.builderArgs ? { builderArgs: start.builderArgs } : {}), ...(start.presetId ? { presetId: start.presetId } : {}), ...(name ? { presetName: name } : {}), ...(start.agent ? { agent: start.agent } : {}),
    ...(start.extraInstructions ? { brief: start.extraInstructions } : {}), ...(start.threadId ? { threadId: start.threadId } : {}), ...(start.parentThreadId ? { parentThreadId: start.parentThreadId } : {}),
    ...(start.error ? { error: start.error } : {}), ...(start.reasonCode ? { reasonCode: start.reasonCode } : {}), ...(start.policyError ? { policyError: start.policyError } : {}),
  };
}

type LaunchInput = { kind: "gate"; args?: string[] | undefined } | { kind: "preset"; presetId: string; brief?: string | undefined } | ({ kind: "agent"; brief?: string | undefined } & StartAgent);

export function scheduleHandlers(bb: BbPluginApi, store: TasksApiStore): Pick<PluginRpcHandlers<typeof tasksRpcContract>, Names> {
  const db = bb.storage.database();
  const publish = (taskId: string, projectId: string) => {
    publishTasksChanged(bb, taskId, projectId);
    publishCommentsChanged(bb, taskId);
  };

  /** The card, its bb project and how it launches; throws what a caller must hear. */
  async function context(taskId: string) {
    const card = cardFacts(db, taskId);
    if (!card) throw new Error("Task not found");
    const bbProjectId = store.tasks.getProject(card.projectId)?.linkedBbProjectId;
    if (!bbProjectId) throw new Error("The card's project is not linked to a bb project, so no session can be launched for it");
    return { card, bbProjectId, mode: await resolveMode(bb, bbProjectId) };
  }
  /** Checks a launch against the mode and returns it ready to store; with `dryRun`, Spawn Gate's builder has run on it. */
  async function prepare(input: LaunchInput, ctx: Awaited<ReturnType<typeof context>>, parentThreadId: string, dryRun: boolean): Promise<Launch> {
    const { card, bbProjectId, mode } = ctx;
    if (input.kind === "gate") {
      if (mode !== "spawn_gate") throw new Error("This project does not launch through Spawn Gate's Script mode: schedule with a preset instead");
      const args = fillKey(input.args?.length ? input.args : splitArgs(startArgsSetting(db, card.projectId)), card.key);
      if (dryRun) await callStart(bb, { projectId: bbProjectId, parentThreadId, args, dryRun: true }).catch((error: unknown) => {
        const message = errorMessage(error), code = reasonCodeOf(message);
        throw new Error(`The builder refuses these arguments${code ? ` (${code})` : ""}: ${message}`);
      });
      return { mode: "spawn_gate", args };
    }
    if (mode !== "preset") throw new Error("Spawn Gate launches this project's sessions: schedule with the gate launch, not a preset or an agent");
    if (input.kind === "agent") {
      const { kind: _kind, brief, ...picked } = input;
      return { mode: "preset", agent: await checkAgent(bb, bbProjectId, picked), ...(brief?.trim() ? { brief: brief.trim() } : {}) };
    }
    const preset = store.tasks.getPreset(input.presetId);
    if (!preset) throw new Error(`Preset not found: ${input.presetId}`);
    await presetSpawnEnvironment(bb, preset);
    return { mode: "preset", presetId: preset.id, ...(input.brief?.trim() ? { brief: input.brief.trim() } : {}) };
  }
  async function parentFor(setter: string, projectId: string) {
    const parent = await resolveParent(bb, db, setter, projectId);
    if (!parent) throw new Error(setter === "owner" ? "This project has no manager thread to own a scheduled start" : `Neither ${setter}, its parents nor the project's manager is live, so nothing could own the launched session`);
    return parent;
  }
  const launchOf = (start: ScheduledStart): LaunchInput => (start.mode === "spawn_gate" ? { kind: "gate", args: start.builderArgs ?? [] } : start.agent ? { kind: "agent", ...start.agent, ...(start.extraInstructions ? { brief: start.extraInstructions } : {}) } : { kind: "preset", presetId: start.presetId!, ...(start.extraInstructions ? { brief: start.extraInstructions } : {}) });

  return {
    async scheduleStart({ taskId, at, launch: input, actor }) {
      const startAt = parseStartTime(at);
      const ctx = await context(taskId);
      if (ctx.card.archived || ctx.card.closed) throw new Error(`${ctx.card.key} is closed or archived; a closed card cannot be scheduled`);
      const existing = activeStart(db, taskId);
      if (existing) throw new Error(existing.state === "unknown" ? `${ctx.card.key} has a start whose outcome is unknown: resolve the previous start first (schedule resolve)` : `${ctx.card.key} already has a scheduled start: use schedule change or schedule cancel`);
      const parentThreadId = await parentFor(actor, ctx.card.projectId);
      const launch = await prepare(input, ctx, parentThreadId, true);
      const start = insertStart(db, { taskId, startAt, launch, setter: actor, parentThreadId });
      publish(taskId, start.projectId);
      return { scheduledStart: toInfo(db, start) };
    },
    async changeScheduledStart({ taskId, at, launch: input, actor }) {
      const before = activeStart(db, taskId);
      if (!before) throw new Error("The card has no scheduled start to change");
      assertMayEdit(db, before, actor);
      if (before.state !== "scheduled") throw new Error(before.state === "launching" ? "The launch is already in progress; change is no longer possible" : `The start is ${before.state}; change is no longer possible`);
      const startAt = at ? parseStartTime(at) : undefined;
      const ctx = await context(taskId);
      const parentThreadId = await parentFor(before.setter, ctx.card.projectId);
      const launch = await prepare(input ?? launchOf(before), ctx, parentThreadId, true);
      const start = changeStart(db, before.id, actor, { ...(startAt ? { startAt } : {}), launch, parentThreadId });
      publish(taskId, start.projectId);
      return { scheduledStart: toInfo(db, start) };
    },
    cancelScheduledStart({ taskId, reason, actor }) {
      const before = activeStart(db, taskId);
      if (!before) throw new Error("The card has no scheduled start to cancel");
      const start = cancelStart(db, before.id, actor, reason);
      publish(taskId, start.projectId);
      return { scheduledStart: toInfo(db, start) };
    },
    async resolveScheduledStart({ taskId, launchedThreadId, notLaunched, actor }) {
      const before = activeStart(db, taskId);
      if (!before) throw new Error("The card has no start to resolve");
      const start = resolveStart(db, before.id, actor, notLaunched ? { notLaunched: true } : { launched: launchedThreadId! });
      await attachLaunched(bb, store, db).catch((error: unknown) => bb.log.warn(`Attaching the resolved start of ${taskId} failed: ${errorMessage(error)}`));
      publish(taskId, start.projectId);
      return { scheduledStart: toInfo(db, start) };
    },
    getScheduledStart({ taskId }) {
      const start = currentStart(db, taskId);
      return { scheduledStart: start && start.state !== "canceled" ? toInfo(db, start) : null };
    },
    async scheduleOptions({ projectId }) {
      const project = store.tasks.getProject(projectId);
      if (!project) throw new Error("Project not found");
      const presets = store.tasks.listPresets().map((preset) => ({ id: preset.id, name: preset.name }));
      const defaultArgs = startArgsSetting(db, projectId);
      if (!project.linkedBbProjectId) return { mode: null, error: "The project is not linked to a bb project", defaultArgs, presets };
      try { return { mode: await resolveMode(bb, project.linkedBbProjectId), defaultArgs, presets }; } catch (error) {
        return { mode: null, error: errorMessage(error), defaultArgs, presets };
      }
    },
    async checkScheduledStart({ taskId, launch: input, actor }) {
      try {
        const ctx = await context(taskId);
        await prepare(input, ctx, await parentFor(actor, ctx.card.projectId), true);
        return { ok: true, mode: ctx.mode };
      } catch (error) {
        const message = errorMessage(error), code = error instanceof StartRefusal ? error.code : reasonCodeOf(message);
        return { ok: false, error: message, ...(code ? { reasonCode: code } : {}) };
      }
    },
    listScheduledStartLog: ({ taskId, projectId, limit }) => ({ events: listLog(db, { ...(taskId ? { taskId } : {}), ...(projectId ? { projectId } : {}), ...(limit ? { limit } : {}) }) }),
  };
}

// --- The sweep ---

/** A start left `launching` by a restart lost its outcome: it is `unknown` and never launched again by itself. */
export function recoverScheduledStarts(db: Database): number {
  let count = 0;
  for (const row of db.prepare<[], { id: string }>("SELECT id FROM scheduled_starts WHERE state='launching'").all())
    if (recordOutcome(db, row.id, "launching", { state: "unknown", error: "the launch was interrupted by a restart, so it is not known whether a session was started" })) count++;
  return count;
}

const READ_FAILED = (start: ScheduledStart, error: unknown, what: string) => {
  const waited = Date.now() - Date.parse(start.startAt);
  return waited >= POLICY_GIVE_UP_MS ? { give: true as const, error: `${what} was unreadable ${Math.round(waited / 60_000)} minutes after the start time (${errorMessage(error)})` } : { give: false as const, error: errorMessage(error) };
};

async function launch(bb: BbPluginApi, store: TasksApiStore, db: Database, start: ScheduledStart): Promise<void> {
  const refuse = (error: string, reasonCode?: string) => recordOutcome(db, start.id, "launching", { state: "refused", error, ...(reasonCode ? { reasonCode } : {}) });
  const card = cardFacts(db, start.taskId);
  if (!card || card.archived || card.closed) { recordOutcome(db, start.id, "launching", { state: "canceled", error: "the card was closed or archived before the start time" }); return; }
  const bbProjectId = store.tasks.getProject(start.projectId)?.linkedBbProjectId;
  if (!bbProjectId) { refuse("the card's project is no longer linked to a bb project"); return; }

  let parent: string | undefined;
  try {
    const mode = await resolveMode(bb, bbProjectId);
    if (mode !== start.mode) { refuse("the project's launch policy changed; reschedule the start"); return; }
    parent = await resolveParent(bb, db, start.setter, start.projectId);
  } catch (error) {
    // Nothing was launched, so a read failure is only waited out: the next sweep tries again.
    const failed = READ_FAILED(start, error, error instanceof PolicyReadError ? "the Spawn Gate policy" : "the parent thread");
    if (failed.give) refuse(failed.error); else releaseClaim(db, start.id, failed.error);
    return;
  }
  if (!parent) { refuse("no live parent thread or project manager could own the session"); return; }
  // The parent may differ from the one stored when the start was set (the setter was archived since): reconcile and the log read this one.
  setLaunchParent(db, start.id, parent);

  if (start.mode === "spawn_gate") {
    try {
      const result = await callStart(bb, { projectId: bbProjectId, parentThreadId: parent, args: start.builderArgs ?? [], dryRun: false });
      if (result.threadId) recordOutcome(db, start.id, "launching", { state: "launched", threadId: result.threadId });
      else recordOutcome(db, start.id, "launching", { state: "unknown", error: "Spawn Gate answered without a thread id" });
    } catch (error) {
      const message = errorMessage(error);
      recordOutcome(db, start.id, "launching", isDefiniteRefusal(error) ? { state: "refused", error: message, reasonCode: reasonCodeOf(message) } : { state: "unknown", error: message });
    }
    return;
  }

  let target: DispatchTarget;
  if (start.agent) target = agentTarget(start.agent);
  else {
    const preset = start.presetId ? store.tasks.getPreset(start.presetId) : undefined;
    if (!preset) { refuse("the preset no longer exists"); return; }
    try { await presetSpawnEnvironment(bb, preset); target = presetTarget(bb, preset); } catch (error) { refuse(errorMessage(error)); return; }
  }
  try {
    const result = await dispatchToTarget(bb, store, {
      taskId: start.taskId, parentThreadId: parent,
      extraInstructions: [start.extraInstructions, markerOf(start.launchId!)].filter(Boolean).join("\n\n"),
    }, target);
    recordOutcome(db, start.id, "launching", { state: "launched", threadId: result.threadId });
    markAttached(db, start.id);
  } catch (error) {
    // Delegation validates before it spawns; anything else (a failed spawn, a failure after it) may have started a session.
    recordOutcome(db, start.id, "launching", error instanceof DelegationError ? { state: "refused", error: errorMessage(error) } : { state: "unknown", error: errorMessage(error) });
  }
}

/** An unknown preset start is found by the marker in its session's first prompt: exactly one such child proves it, nothing else is guessed. */
async function reconcile(bb: BbPluginApi, db: Database, start: ScheduledStart): Promise<void> {
  if (start.mode !== "preset" || !start.launchId || !start.attemptedAt || !start.parentThreadId) return;
  const since = Date.parse(start.attemptedAt);
  const children = (await bb.sdk.threads.list({ parentThreadId: start.parentThreadId, includeHidden: true, limit: 200 })).filter((thread) => thread.createdAt >= since - 1000);
  const found: string[] = [];
  for (const thread of children) {
    const { receipt } = await searchAttentionMarker(bb, thread.id, markerOf(start.launchId), start.attemptedAt);
    if (receipt && (receipt.outcome === "appended" || receipt.outcome === "queued" || receipt.outcome === "inline")) found.push(thread.id);
  }
  if (found.length === 1) recordOutcome(db, start.id, "unknown", { state: "launched", threadId: found[0]!, event: "reconciled" });
  else if (found.length > 1 && !start.error?.includes("Several sessions")) {
    const text = `Several sessions carry this start's marker (${found.join(", ")}); none is attached. Resolve the start by hand: bb work-board schedule resolve --launched <thread> | --not-launched`;
    db.transaction(() => {
      db.prepare<[string, string]>("UPDATE scheduled_starts SET error=? WHERE id=?").run(text, start.id);
      cardComment(db, start.taskId, text, new Date().toISOString());
    })();
  }
}

/** A launched session joins the card (a Spawn Gate one is not attached by the launch itself); retried on every sweep until it does. */
async function attachLaunched(bb: BbPluginApi, store: TasksApiStore, db: Database): Promise<void> {
  const delegation = delegationHandlers(bb, store);
  for (const row of db.prepare<[], Parameters<typeof toStart>[0]>("SELECT * FROM scheduled_starts WHERE state='launched' AND attached=0 AND thread_id IS NOT NULL").all()) {
    const start = toStart(row);
    try {
      await delegation.taskThreadsAttach({ taskId: start.taskId, threadId: start.threadId! });
      markAttached(db, start.id);
      publishThreadsChanged(bb, start.taskId);
      publishTasksChanged(bb, start.taskId, start.projectId);
      publishCommentsChanged(bb, start.taskId);
    } catch (error) {
      bb.log.warn(`Attaching ${start.threadId} to its card failed, will retry: ${errorMessage(error)}`);
    }
  }
}

const chains = new WeakMap<BbPluginApi, Promise<unknown>>();
/** Launches what is due, then looks for what a restart left unknown, attaches launched sessions and sends the notices owed. One pass at a time. */
export function sweepScheduledStarts(bb: BbPluginApi, store: TasksApiStore): Promise<void> {
  const db = bb.storage.database();
  const run = (chains.get(bb) ?? Promise.resolve()).then(async () => {
    // A start released after a read failure is due again at once: each is claimed at most once per pass.
    const seen = new Set<string>();
    for (let start = claimDue(db, new Date().toISOString(), seen); start; start = claimDue(db, new Date().toISOString(), seen)) {
      seen.add(start.id);
      try { await launch(bb, store, db, start); } catch (error) {
        // `launch` records its own outcomes; a throw here is a bug after the claim, so the start must not stay `launching`.
        bb.log.warn(`Scheduled start ${start.id} failed unexpectedly: ${errorMessage(error)}`);
        recordOutcome(db, start.id, "launching", { state: "unknown", error: `unexpected failure: ${errorMessage(error)}` });
      }
      publishTasksChanged(bb, start.taskId, start.projectId);
      publishCommentsChanged(bb, start.taskId);
    }
    for (const row of db.prepare<[], Parameters<typeof toStart>[0]>("SELECT * FROM scheduled_starts WHERE state='unknown'").all()) {
      try { await reconcile(bb, db, toStart(row)); publishTasksChanged(bb, row.task_id, row.project_id); } catch (error) { bb.log.warn(`Scheduled start ${row.id} could not be reconciled: ${errorMessage(error)}`); }
    }
    await attachLaunched(bb, store, db);
    pruneLog(db);
    await drainStartNotices(bb);
  }).catch((error: unknown) => bb.log.warn(`Scheduled start sweep failed: ${errorMessage(error)}`));
  chains.set(bb, run);
  return run as Promise<void>;
}
