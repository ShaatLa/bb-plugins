import { cliCommand, defineCli, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { methods, rpcContract, type Config, type Input, type Proposal, type ReviewStage } from "./contract";
import { SecretDetectedError } from "./secret-guard";
import { boardDisplayMigration, createStore, JournalError, requireCondition, versionOne } from "./store";
import { deliverReviews } from "./review-delivery";
import { reviewMigration, type ReviewIdentity } from "./reviews";
import { createSweep, measureCommand, type Transport } from "./sweep";
import { createWorkBoard, workBoardApi } from "./work-board";

type Caller = { kind: "cli"; threadId?: string } | { kind: "client" } | { kind: "plugin"; pluginId: string };

const changed = "journal:changed";
const instructions = "Record process failures in Process Journal in the same turn. Keep each proposal's manager, next deadline, and measurement evidence current. Load the process-journal skill for commands. Handle wake-ups for your proposals and acknowledge owner questions in the journal.";

export default function plugin(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, [versionOne, boardDisplayMigration, reviewMigration]);
  const store = createStore(db);
  const boardApi = workBoardApi(bb);
  const board = createWorkBoard(store, boardApi, p => verifyApproval(p, "hypothesis"));
  const publish = (projectId: string) => bb.realtime.publish(changed, { projectId });
  const settings = bb.settings.define({
    metricCommands: { type: "string", label: "Trusted metric commands JSON", default: "{}" },
  });
  const thread = (threadId: string) => bb.sdk.threads.get({ threadId });
  function reachable(t: Awaited<ReturnType<typeof thread>>, projectId: string) {
    return t.projectId === projectId && !t.archivedAt && !t.deletedAt;
  }
  async function managerReachable(projectId: string, managerId: string) {
    return thread(managerId).then(t => reachable(t, projectId), () => false);
  }
  const transport: Transport = {
    measure: async name => measureCommand((await settings.get()).metricCommands, name),
    send: async (project, manager, message, wanted) => {
      let target: Awaited<ReturnType<typeof thread>>;
      try { target = await thread(manager); }
      catch (error) {
        return typeof error === "object" && error !== null && "code" in error && error.code === "thread_not_found"
          ? "unreachable" : "retry";
      }
      if (!wanted()) return "obsolete";
      if (!reachable(target, project)) return "unreachable";
      try {
        await bb.sdk.threads.send({
          threadId: manager, originPluginId: bb.pluginId, mode: "queue-if-active",
          input: [{ type: "text", text: `[bb message from plugin:${bb.pluginId}]\n\n${message}`, mentions: [] }],
        });
        return "sent";
      } catch { return "uncertain"; }
    },
    notice: async input => {
      const result = await bb.sdk.plugins.callRpc({
        pluginId: "agent-hub", method: "notice", input,
        outputSchema: z.object({ id: z.string(), created: z.boolean() }), signal: AbortSignal.timeout(10_000),
      });
      return result.id;
    },
  };
  const worker = createSweep(store, transport);
  const rememberParent = ({ id, parentThreadId }: Awaited<ReturnType<typeof thread>>, former?: string | null) => {
    store.reviews.lineage(id, [parentThreadId, former].filter((value): value is string => !!value));
  };
  bb.events.on("thread.created", ({ thread }) => rememberParent(thread));
  bb.events.on("experimental_thread.parentChanged", ({ thread, previousParentThreadId }) => rememberParent(thread, previousParentThreadId));

  async function verifyLineage(projectId: string, reviewerId: string, active: boolean) {
    const target = await thread(reviewerId);
    requireCondition(target.projectId === projectId && (!active || reachable(target, projectId)),
      "reviewer_unverified", "Reviewer must be an eligible project thread");
    // A recorded verdict already has verified ancestry. Archiving may detach the thread.
    if (!active && target.archivedAt != null) return;
    const ancestry = await bb.sdk.threads.experimental_listAncestors({ threadIds: [reviewerId] });
    const lineage = ancestry.threads.find(candidate => candidate.threadId === reviewerId);
    requireCondition(lineage, "reviewer_unverified", "Reviewer ancestry is unavailable");
    store.reviews.lineage(reviewerId, lineage.ancestorIds);
  }
  async function verifyReviewer(p: Proposal, reviewerId: string, active: boolean): Promise<ReviewIdentity> {
    const links = store.links(p.projectId, p.id).map(link => link.taskId).sort();
    try {
      const [, ...attachments] = await Promise.all([
        verifyLineage(p.projectId, reviewerId, active),
        ...links.map(async id => {
          const { task } = await boardApi.task(id);
          requireCondition(task?.projectId === store.config(p.projectId).boardProject,
            "reviewer_unverified", "A linked fix card is unavailable to verify review independence");
          return boardApi.executors(id);
        }),
      ] as const);
      // The attachment RPC exposes preset names, which cannot establish executor roles.
      const executors = attachments.flatMap(({ taskThreads }) => taskThreads.map(row => row.threadId));
      store.reviews.recordLinkedExecutors(p, executors);
      return { reviewerId, links, executors };
    } catch (error) {
      if (error instanceof JournalError) throw error;
      throw new JournalError("reviewer_unverified", "Could not verify reviewer and linked-thread ancestry. Try again");
    }
  }
  async function verifyApproval(p: Proposal, stage: ReviewStage) {
    const approved = store.reviews.approval(p, stage);
    if (!approved) return;
    return { ...await verifyReviewer(p, approved.reviewerId, false), version: approved.version };
  }
  let busy = false;
  async function tick() {
    if (busy) return;
    busy = true;
    const before = db.prepare("SELECT total_changes() AS count");
    try {
      const count = (before.get() as { count: number }).count;
      try { await deliverReviews(store, transport, managerReachable); }
      catch { bb.log.warn("Process Journal review delivery failed; it will retry"); }
      try { await worker.sweep(); } catch { bb.log.warn("Process Journal sweep failed; it will retry"); }
      for (const { projectId, config } of store.configuredProjects()) {
        if (!config.enabled || !config.boardProject) continue;
        try { await board.reconcile(projectId, config); }
        catch { bb.log.warn("Process Journal Work Board reconciliation failed; it will retry"); }
      }
      if ((before.get() as { count: number }).count !== count) bb.realtime.publish(changed, {});
    } finally { busy = false; }
  }
  worker.recovery();
  store.reviews.recover();
  bb.background.schedule("process-journal", "* * * * *", tick);
  bb.background.service("process-journal-startup", { start: async () => { await tick(); } });
  bb.agents.contributeInstructions(({ projectId, threadId }) => {
    const c = store.config(projectId);
    return c.enabled && c.managers.includes(threadId) ? instructions + " Submit proposals and kept results for independent review." : null;
  });

  function verifyProject(projectId: string) {
    return bb.sdk.projects.get({ projectId });
  }
  async function actorFor(projectId: string, caller: Caller) {
    if (caller.kind === "client") return "BB client";
    if (caller.kind === "plugin") return `Plugin ${caller.pluginId}`;
    if (!caller.threadId) return "Local operator";
    const found = await thread(caller.threadId).catch(() => null);
    requireCondition(found && reachable(found, projectId), "invalid_actor", "Actor must be an active thread in this project");
    return caller.threadId;
  }
  function enabled(projectId: string) {
    requireCondition(store.config(projectId).enabled, "journal_disabled", "Enable Process Journal for this project first");
  }
  async function write<I extends { projectId: string }, O>(i: I, caller: Caller, fn: (actor: string) => O | Promise<O>) {
    const actor = await actorFor(i.projectId, caller);
    enabled(i.projectId);
    const result = await fn(actor);
    publish(i.projectId);
    return result;
  }
  async function validManager(projectId: string, id: string | null | undefined) {
    if (id) requireCondition(await managerReachable(projectId, id), "invalid_manager", "Manager must be an active thread in this project");
  }
  function commandConfigured(i: { command?: string } | undefined) {
    if (!i?.command) return;
    // The proposal refers to a name, never to executable text.
    return settings.get().then(({ metricCommands }) => {
      let catalog: Record<string, unknown> = {};
      try { catalog = z.record(z.string(), z.unknown()).parse(JSON.parse(metricCommands)); } catch { }
      requireCondition(Object.hasOwn(catalog, i.command!), "invalid_metric", "Metric command is not in the trusted catalog");
    });
  }
  const handlers = {
    projects: async (_: Input<"projects">) => {
      const projects = await bb.sdk.projects.list();
      const configured = store.configuredProjects().filter(row => row.config.enabled);
      return Promise.all(configured.map(async ({ projectId: id, config: c }) => ({
        id, name: projects.find(p => p.id === id)?.name ?? id, timeZone: c.timeZone,
        managers: await Promise.all(c.managers.map(async manager => {
          const t = await thread(manager).catch(() => null);
          return { id: manager, name: t?.title ?? manager, reachable: t ? Boolean(reachable(t, id)) : false };
        })),
      })));
    },
    "config.get": (i: Input<"config.get">) => {
      if (i.key === "boardDisplay") return store.boardDisplay(i.projectId);
      const config = store.config(i.projectId);
      return i.key ? config[i.key] : config;
    },
    "config.set": async (i: Input<"config.set">) => {
      await verifyProject(i.projectId);
      const next = methods["config.set"].input.parse(i);
      if (next.key === "boardDisplay") {
        const result = store.setBoardDisplay(next.projectId, next.value);
        if (result.ok) publish(next.projectId);
        return result;
      }
      if (next.key === "managers") {
        const ids = z.array(z.string()).max(50).parse(next.value);
        await Promise.all(ids.map(id => validManager(next.projectId, id)));
      }
      if ((next.key === "defaultManager" || next.key === "scheduleManager") && typeof next.value === "string") {
        await validManager(next.projectId, next.value);
      }
      if (next.key === "boardProject" && next.value !== null) {
        const { projects } = await boardApi.projects();
        const boardProject = projects.find(p => p.id === next.value);
        requireCondition(boardProject && (!boardProject.linkedBbProjectId || boardProject.linkedBbProjectId === next.projectId),
          "board_scope", "Choose a Work Board project mapped to this BB project or an unlinked board");
      }
      const result = store.setConfig(next.projectId, next.key, next.value);
      publish(next.projectId);
      return result;
    },
    "entry.add": (i: Input<"entry.add">, caller: Caller) => write(i, caller, async actor => {
      if (i.proposal) {
        await validManager(i.projectId, i.proposal.managerId ?? store.config(i.projectId).defaultManager);
        await commandConfigured(i.proposal.metric);
      }
      return store.addEntry(i, actor);
    }),
    "entry.list": (i: Input<"entry.list">) => store.listEntries(i),
    "proposal.add": (i: Input<"proposal.add">, caller: Caller) => write(i, caller, async actor => {
      await validManager(i.projectId, i.proposal.managerId ?? store.config(i.projectId).defaultManager);
      await commandConfigured(i.proposal.metric);
      return store.insertProposal(i, actor);
    }),
    "proposal.update": (i: Input<"proposal.update">, caller: Caller) => write(i, caller, async actor => {
      await validManager(i.projectId, i.patch.managerId);
      await commandConfigured(i.patch.metric);
      return store.update(i, actor);
    }),
    "proposal.measure": (i: Input<"proposal.measure">, caller: Caller) => write(i, caller, actor => store.measure(i, actor)),
    "proposal.transition": (i: Input<"proposal.transition">, caller: Caller) => write(i, caller, async actor => {
      const p = store.proposal(i.projectId, i.proposalId, i.revision);
      const stage = i.transition.state === "applied" ? "hypothesis" : i.transition.state === "kept" ? "result" : null;
      const identity = stage ? await verifyApproval(p, stage) : undefined;
      const hypothesis = stage === "result" && identity ? await verifyApproval(p, "hypothesis") : undefined;
      return store.transition(i, actor, identity, hypothesis);
    }),
    "review.assign": (i: Input<"review.assign">, caller: Caller) => write(i, caller, async actor => {
      const p = store.proposal(i.projectId, i.proposalId, i.revision);
      requireCondition(p.managerId === actor, "invalid_actor", "Assign the reviewer from the proposal manager thread");
      return store.reviews.assign(i, actor, await verifyReviewer(p, i.reviewerId, true));
    }),
    "review.submit": (i: Input<"review.submit">, caller: Caller) => write(i, caller, async actor => {
      const p = store.proposal(i.projectId, i.proposalId, i.revision);
      requireCondition(p.managerId === actor, "invalid_actor", "Submit a review from the proposal manager thread");
      const assigned = store.reviews.assignment(p);
      requireCondition(assigned?.generation === i.generation, "stale_review", "Assign a reviewer or reload the proposal");
      const identity = await verifyReviewer(p, assigned.reviewerId, true);
      const hypothesis = i.submission.stage === "result" ? await verifyApproval(p, "hypothesis") : undefined;
      return store.reviews.submit(i, actor, identity, hypothesis);
    }),
    "review.decide": (i: Input<"review.decide">, caller: Caller) => write(i, caller, async actor => {
      const p = store.proposal(i.projectId, i.proposalId);
      const assigned = store.reviews.assignment(p);
      requireCondition(assigned?.generation === i.generation, "stale_review", "Reviewer assignment changed");
      requireCondition(assigned.reviewerId === actor, "invalid_actor", "Only the assigned reviewer can record a verdict from their thread");
      const identity = await verifyReviewer(p, actor, true);
      const hypothesis = i.stage === "result" ? await verifyApproval(p, "hypothesis") : undefined;
      return store.reviews.decide(i, actor, identity, hypothesis);
    }),
    "proposal.comment": (i: Input<"proposal.comment">, caller: Caller) =>
      write(i, caller, actor => store.comment(i.projectId, i.proposalId, actor, "comment", i.body)),
    "proposal.rollback": (i: Input<"proposal.rollback">, caller: Caller) =>
      write(i, caller, actor => store.comment(i.projectId, i.proposalId, actor, "rollback", i.evidence)),
    "proposal.ack": (i: Input<"proposal.ack">, caller: Caller) => write(i, caller, actor => store.ack(i, actor)),
    "proposal.detail": async (i: Input<"proposal.detail">) => {
      const p = store.proposal(i.projectId, i.proposalId);
      return { proposal: p, entry: store.entry(i.projectId, p.entryId), ...store.events(i.projectId, p.id, i.before),
        links: store.links(i.projectId, p.id), managerReachable: await managerReachable(i.projectId, p.managerId),
        measured: store.measured(p.projectId, p.id), review: store.reviews.summary(p), reviewRounds: store.reviews.rounds(p) };
    },
    list: (i: Input<"list">) => store.list(i),
    digest: (i: Input<"digest">) => store.digest(i.projectId, i.managerId),
    "fix.create": (i: Input<"fix.create">, caller: Caller) => write(i, caller, actor => board.create(i, actor)),
    "fix.link": (i: Input<"fix.link">, caller: Caller) => write(i, caller, actor => board.linkExisting(i, actor)),
    "fix.resolveDeadline": (i: Input<"fix.resolveDeadline">, caller: Caller) => write(i, caller, () => board.resolve(i)),
    "run.list": (i: Input<"run.list">) => store.listRuns(i),
    "run.finish": (i: Input<"run.finish">, caller: Caller) => write(i, caller, actor => store.finishRun(i, actor)),
  };
  bb.rpc.register(rpcContract, Object.fromEntries(
    Object.entries(handlers).map(([key, fn]) => [
      key, async (input: never, context: { experimental_caller: Exclude<Caller, { kind: "cli" }> }) => {
        try { return await fn(input, context.experimental_caller); }
        catch (error) {
          if (error instanceof JournalError && (error.code === "review_required" || key.startsWith("review."))) {
            throw new experimental_PluginRpcRefusal({
              code: ["invalid_actor", "reviewer_conflict"].includes(error.code) ? "forbidden" : "conflict",
              message: error.message, issues: [{ message: error.code }],
            });
          }
          throw error;
        }
      },
    ]),
  ) as unknown as { [K in keyof typeof handlers]: (input: Input<K>, context: {
    experimental_caller: Exclude<Caller, { kind: "cli" }>;
  }) => ReturnType<typeof handlers[K]> });

  const project = { type: "string", description: "BB project ID; defaults to the current thread's project" } as const;
  const input = { type: "string", description: "JSON object with operation fields" } as const;
  const json = { type: "boolean", description: "Output JSON (the default)" } as const;
  function result(body: unknown) { return { exitCode: 0, stdout: JSON.stringify(body) }; }
  function failure(error: unknown) {
    const known = error instanceof JournalError || error instanceof SecretDetectedError || error instanceof z.ZodError || error instanceof SyntaxError;
    const code = error instanceof JournalError ? error.code : known ? "invalid_input" : "operation_failed";
    const message = error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ")
      : known ? (error as Error).message : "Operation failed. Check the configuration and try again.";
    return { exitCode: 1, stdout: JSON.stringify({ ok: false, error: { code, message } }) };
  }
  const commands = Object.fromEntries(Object.entries(methods).filter(([key]) => !key.startsWith("config.")).map(([key, method]) => [
    key.replaceAll(".", "-").replace(/[A-Z]/g, letter => "-" + letter.toLowerCase()),
    cliCommand({ summary: `Process Journal ${key}`, options: { project, input, json }, async run(i, ctx) {
      try {
        const args = z.record(z.string(), z.unknown()).parse(JSON.parse(i.options.input ?? "{}"));
        const parsed = method.input.parse(key === "projects" ? args : { ...args, projectId: i.options.project ?? ctx.projectId ?? args.projectId });
        const handler = handlers[key as keyof typeof handlers] as (value: typeof parsed, caller: Caller) => unknown;
        return result(await handler(parsed, { kind: "cli", threadId: ctx.threadId }));
      } catch (error) { return failure(error); }
    } }),
  ]));
  bb.cli.register(defineCli({ name: "process-journal", summary: "Record failures and measure process fixes", commands: {
    ...commands,
    config: cliCommand({ summary: "Read or change one project configuration field", options: { project, json }, positionals: [
      { name: "action", description: "get or set", required: true },
      { name: "key", description: "Configuration field", required: false },
      { name: "value", description: "JSON value, or a plain string", required: false },
    ], async run(i, ctx) {
      try {
        const { action, key, value } = i.positionals;
        const projectId = i.options.project ?? ctx.projectId;
        if (action === "get" && value === undefined) return result(handlers["config.get"](methods["config.get"].input.parse({ projectId, key })));
        requireCondition(action === "set" && key !== undefined && value !== undefined, "usage", "Use config get [key] or config set <key> <value>");
        let data: unknown = value;
        try { data = JSON.parse(value); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
        const saved = await handlers["config.set"](methods["config.set"].input.parse({ projectId, key, value: data }));
        if (key === "boardDisplay" && saved && typeof saved === "object" && "ok" in saved && !saved.ok) {
          return { exitCode: 1, stdout: JSON.stringify(saved) };
        }
        return result(saved);
      } catch (error) { return failure(error); }
    } }),
  } }));
}
