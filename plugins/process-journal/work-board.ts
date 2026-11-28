import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { proposalPath } from "./paths";
import { isOpen, type BoardLink, type Config, type Input, type Proposal } from "./contract";
import { assertNoSecretsInValue } from "./secret-guard";
import { JournalError, requireCondition, stableId, type Store } from "./store";
import type { ReviewIdentity } from "./reviews";
import { dateIn, minute, timeOn } from "./time";

const task = z.object({
  id: z.string(), key: z.string(), projectId: z.string(), status: z.string(), dueDate: z.iso.date().nullable(),
  archivedAt: z.string().nullable().optional(),
});
type Task = z.infer<typeof task>;
const read = z.object({ task: task.nullable() });
const mutation = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), task }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), currentDueDate: z.iso.date().nullable().optional() }) }),
]);
const projectList = z.object({ projects: z.array(z.object({
  id: z.string(), linkedBbProjectId: z.string().nullable().optional(),
  workflowPolicy: z.object({ doneStatus: z.string().nullable().optional() }).optional(),
})) });
const pullRequests = z.object({
  pullRequests: z.array(z.object({ state: z.string(), url: z.url() })),
  unavailableThreadIds: z.array(z.string()),
});

export function workBoardApi(bb: BbPluginApi) {
  const call = async <T extends z.ZodType>(method: string, input: Record<string, string | boolean | null>, outputSchema: T): Promise<z.output<T>> =>
    outputSchema.parse(await bb.sdk.plugins.callRpc({ pluginId: "work-board", method, input, outputSchema, signal: AbortSignal.timeout(10_000) }));
  return {
    projects: () => call("listProjects", {}, projectList),
    task: (id: string) => call("getTask", { taskId: id }, read),
    byKey: (key: string) => call("getTaskByKey", { taskKey: key }, read),
    executors: (id: string) => call("listTaskThreads", { taskId: id, reconcile: false },
      z.object({ taskThreads: z.array(z.object({ threadId: z.string() })) })),
    pullRequests: (id: string) => call("listTaskPullRequests", { taskId: id }, pullRequests),
    create: (input: { projectId: string; idempotencyKey: string; title: string; description: string; dueDate: string | null }) =>
      call("createTask", input, mutation),
    updateDue: (id: string, expectedDueDate: string | null, dueDate: string | null) =>
      call("updateTask", { taskId: id, expectedDueDate, dueDate }, mutation),
  };
}
type Api = ReturnType<typeof workBoardApi>;
type FixRequest = Input<"fix.link"> | Input<"fix.create">;

export function createWorkBoard(
  store: Store, api: Omit<Api, "executors">, verifyHypothesis: (p: Proposal) => Promise<ReviewIdentity | undefined>,
) {
  function boardProject(cfg: Config) {
    requireCondition(cfg.boardProject, "board_unconfigured", "Configure a Work Board project first");
    return cfg.boardProject;
  }
  function canAttach(p: Proposal, deadlineSource: boolean, existingTaskId?: string) {
    requireCondition(store.links(p.projectId, p.id).length < 20 || existingTaskId,
      "link_limit", "At most twenty fix cards can be linked");
    if (deadlineSource) requireCondition(
      !store.links(p.projectId, p.id).some(link => link.deadlineSource && link.taskId !== existingTaskId),
      "multiple_deadline_links", "This proposal already has a deadline-source card",
    );
  }
  const inProgress = new Set<string>();
  async function serialized<T>(project: string, proposal: string, fn: () => Promise<T>) {
    const key = stableId(project, proposal);
    requireCondition(!inProgress.has(key), "fix_busy", "Another fix-card operation is running. Retry with the original request key");
    inProgress.add(key);
    try { return await fn(); } finally { inProgress.delete(key); }
  }
  const attach = store.db.transaction((p: Proposal, card: Task, i: FixRequest, actor: string) => {
    const current = store.proposal(p.projectId, p.id);
    requireCondition(store.config(p.projectId).boardProject === card.projectId,
      "board_scope", "Work Board project changed. Reconcile the same operation within its original project");
    const prior = store.links(p.projectId, p.id).find(link => link.taskId === card.id);
    if (prior && prior.deadlineSource === i.deadlineSource) return prior;
    requireCondition(isOpen(current.state) || "key" in i, "closed", "The proposal closed while linking the fix card");
    canAttach(current, i.deadlineSource, prior?.taskId);
    const link = store.saveLink(current, {
      taskId: card.id, key: card.key, status: card.archivedAt ? `${card.status} (archived)` : card.status,
      dueDate: card.dueDate, deadlineSource: i.deadlineSource,
      syncedCheckAt: null, syncedDueDate: card.dueDate, conflict: false,
    });
    store.event(p.projectId, p.id, { kind: "work-board", actor, message: `Linked fix card ${card.key}` });
    return link;
  });

  async function create(i: Input<"fix.create">, actor: string) {
    const p = store.proposal(i.projectId, i.proposalId, i.revision);
    requireCondition(isOpen(p.state), "closed", "Cannot add a fix card to a closed proposal");
    assertNoSecretsInValue(i, "fix request");
    const cfg = store.config(p.projectId);
    const projectId = boardProject(cfg);
    store.db.prepare("INSERT OR IGNORE INTO fix_requests VALUES (?,?,?,?,?,NULL)").run(p.projectId, p.id, i.key, projectId, Number(i.deadlineSource));
    const previous = store.db.prepare("SELECT board,deadline,task FROM fix_requests WHERE project=? AND proposal=? AND request=?")
      .get(p.projectId, p.id, i.key) as { board: string; deadline: number; task: string | null };
    requireCondition(previous.board === projectId, "board_scope", "This create request belongs to the previous Work Board project");
    requireCondition(previous.deadline === Number(i.deadlineSource), "request_changed", "Reuse the original fix request with the same deadline role");
    canAttach(p, i.deadlineSource, previous.task ?? undefined);
    const result = await api.create({
      projectId, idempotencyKey: stableId("process-journal", p.projectId, p.id, i.key), title: i.title ?? p.title,
      description: `[Process Journal proposal](${proposalPath(p.projectId, p.id)})\n\n${p.hypothesis}`,
      dueDate: i.deadlineSource && p.checkAt !== null ? dateIn(p.checkAt, cfg.timeZone) : null,
    });
    if (!result.ok) throw new JournalError(result.error.code, "Work Board could not create or recover the fix card");
    requireCondition(result.task.projectId === projectId, "board_scope", "Fix card is outside the mapped Work Board project");
    return store.db.transaction(() => {
      const linked = attach(p, result.task, i, actor);
      store.db.prepare("UPDATE fix_requests SET task=? WHERE project=? AND proposal=? AND request=?")
        .run(result.task.id, p.projectId, p.id, i.key);
      return linked;
    })();
  }
  async function linkExisting(i: Input<"fix.link">, actor: string) {
    const p = store.proposal(i.projectId, i.proposalId, i.revision);
    requireCondition(isOpen(p.state), "closed", "Cannot link a fix card to a closed proposal");
    const project = boardProject(store.config(p.projectId));
    const { task: card } = await api.byKey(i.taskKey);
    requireCondition(card?.projectId === project, "board_scope", "Fix card is outside the mapped Work Board project");
    return attach(p, card, i, actor);
  }
  function observed(p: Proposal, before: BoardLink, next: BoardLink, message?: string) {
    if (JSON.stringify(before) === JSON.stringify(next)) return before;
    store.saveLink(p, next);
    store.event(p.projectId, p.id, {
      kind: "work-board", actor: "Work Board", message: message ?? `${next.key}: ${next.status}`,
    });
    return next;
  }
  function fresh(p: Proposal, cfg: Config, link: BoardLink) {
    const current = store.findProposal(p.projectId, p.id);
    const settings = store.config(p.projectId);
    return current?.obligation === p.obligation && settings.boardProject === cfg.boardProject
      && settings.timeZone === cfg.timeZone && settings.checkTime === cfg.checkTime &&
      JSON.stringify(store.links(p.projectId, p.id).find(row => row.taskId === link.taskId)) === JSON.stringify(link);
  }
  async function due(p: Proposal, link: BoardLink, card: Task, cfg: Config, prefer?: "card" | "journal") {
    if (!fresh(p, cfg, link)) return link;
    const next = { ...link, dueDate: card.dueDate, key: card.key };
    if (!link.deadlineSource || p.state !== "measuring" || p.checkAt === null) return observed(p, link, next);
    const journalDate = dateIn(p.checkAt, cfg.timeZone);
    if (card.dueDate === journalDate) {
      return observed(p, link, { ...next, conflict: false, syncedCheckAt: p.checkAt, syncedDueDate: card.dueDate });
    }
    const cardChanged = link.syncedDueDate !== card.dueDate;
    const journalChanged = link.syncedCheckAt !== p.checkAt;
    const conflict = (message: string, currentDueDate = card.dueDate) =>
      fresh(p, cfg, link) ? observed(p, link, { ...next, dueDate: currentDueDate, conflict: true }, message) : link;
    if (!prefer && (link.conflict || cardChanged && journalChanged && link.syncedCheckAt !== null)) {
      return conflict(`Deadline conflict on ${card.key}; resolve in favor of the journal or card`);
    }
    if (prefer === "card" || (!prefer && cardChanged)) {
      const at = card.dueDate === null ? null : timeOn(card.dueDate, cfg.checkTime, cfg.timeZone);
      if (at === null || at >= p.deadlineAt) return conflict(`${card.key} needs a check date before the decision deadline`);
      return store.db.transaction(() => {
        const updated = store.adjustCheck(p, at, "Work Board");
        return observed(updated, link, { ...next, conflict: false, syncedCheckAt: at, syncedDueDate: card.dueDate });
      })();
    }
    const result = await api.updateDue(card.id, card.dueDate, journalDate);
    if (!result.ok) {
      if (result.error.code === "due_date_conflict") return conflict(`Deadline on ${card.key} changed during the write`, result.error.currentDueDate);
      throw new JournalError(result.error.code, "Work Board rejected the due date");
    }
    requireCondition(result.task.projectId === cfg.boardProject, "board_scope", "The card moved out of the mapped Work Board project");
    if (!fresh(p, cfg, link)) return link;
    return observed(p, link, { ...next, dueDate: result.task.dueDate, conflict: false,
      syncedCheckAt: p.checkAt, syncedDueDate: result.task.dueDate }, `Synchronized check date on ${card.key}`);
  }
  async function resolve(i: Input<"fix.resolveDeadline">) {
    const p = store.proposal(i.projectId, i.proposalId, i.revision);
    const cfg = store.config(p.projectId);
    const link = store.links(p.projectId, p.id).find(row => row.taskId === i.taskId && row.deadlineSource);
    requireCondition(link && p.state === "measuring", "missing_link", "Select a deadline-source card for a measuring proposal");
    const { task: card } = await api.task(link.taskId);
    requireCondition(card?.projectId === boardProject(cfg), "board_scope", "Fix card is outside the mapped Work Board project");
    store.proposal(p.projectId, p.id, i.revision);
    return due(p, link, card, cfg, i.prefer);
  }
  async function reconcile(projectId: string, cfg: Config) {
    if (!cfg.boardProject) return;
    const candidates = store.linkedProposals(projectId);
    if (!candidates.length) return;
    const { projects } = await api.projects();
    const mapped = projects.find(row => row.id === cfg.boardProject);
    if (!mapped || mapped.linkedBbProjectId && mapped.linkedBbProjectId !== projectId) return;
    const done = (card: Task) => card.status === "done" || card.status === mapped.workflowPolicy?.doneStatus;
    for (const p of candidates) {
      const links = store.links(projectId, p.id);
      const completed: string[] = [];
      for (const link of links) {
        const { task: card } = await api.task(link.taskId);
        if (!fresh(p, cfg, link)) break;
        if (card?.projectId !== mapped.id) {
          observed(p, link, { ...link, status: "Unavailable in project" });
          continue;
        }
        const prs = done(card) ? null : await api.pullRequests(card.id);
        if (!fresh(p, cfg, link)) break;
        const merged = prs?.pullRequests.find(pr => pr.state === "merged");
        if (done(card) || merged) completed.push(merged ? `${card.key} merged (${merged.url})` : `${card.key} is Done`);
        const status = done(card) ? "Done" : merged ? `${card.status} · PR merged`
          : prs?.unavailableThreadIds.length ? `${card.status} · PR status unavailable` : card.status;
        const updated = observed(p, link, { ...link, status, key: card.key });
        await due(p, updated, card, cfg);
      }
      if (p.state !== "proposed" || completed.length !== links.length) continue;
      try {
        const identity = await verifyHypothesis(p);
        store.db.transaction(() => {
          const current = store.proposal(projectId, p.id);
          if (current.state !== "proposed" || current.revision !== p.revision
            || store.config(projectId).boardProject !== cfg.boardProject
            || store.links(projectId, p.id).map(l => l.taskId).join() !== links.map(l => l.taskId).join()) return;
          if (store.waitingForHypothesis(current)) {
            store.queue(projectId, p.id, current.obligation, "manager", store.now(), "review");
            return;
          }
          if (!identity) return;
          store.changeState(current, { state: "applied", deadlineAt: store.now() + cfg.appliedMinutes * minute,
            reason: completed.join("\n") }, "Work Board", identity);
        })();
      } catch (error) {
        if (!(error instanceof JournalError) || !["review_required", "reviewer_unverified", "reviewer_conflict", "stale_review"].includes(error.code)) throw error;
      }
    }
  }
  return {
    create: (i: Input<"fix.create">, actor: string) => serialized(i.projectId, i.proposalId, () => create(i, actor)),
    linkExisting: (i: Input<"fix.link">, actor: string) => serialized(i.projectId, i.proposalId, () => linkExisting(i, actor)),
    resolve: (i: Input<"fix.resolveDeadline">) => serialized(i.projectId, i.proposalId, () => resolve(i)),
    reconcile,
  };
}
