import { randomUUID } from "node:crypto";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { touchAttention } from "./ledger";
import { registerAttention } from "./rpc";
import { attentionService } from "./service";

export const SWEEP = { kind: "plugin", pluginId: "sweep" } as const;
export const BB_PROJECT = "proj_example";
export const MANAGER = "thr_manager";

interface Row { id: string; threadId: string; state: string; editable: boolean; originPluginId: string; updatedAt: string; content: { type: "text"; text: string; mentions: [] }[]; payload: { kind: string } }
type Fault = Error & { status?: number };
const fault = (message: string, status?: number): Fault => Object.assign(new Error(message), status ? { status } : {});

/** An in-memory stand-in for the thread SDK area Work Board delivers through. */
export function createFakeThreads() {
  const state = {
    rows: [] as Row[],
    sends: 0,
    updates: 0,
    requests: [] as { threadId: string; seq: number; requestId: string; text: string; at: number; extra?: Record<string, unknown>; grouped?: boolean }[],
    listCalls: 0,
    acceptedCalls: 0,
    queueCalls: 0,
    /** Queue reads reject, as in a queue-only outage. */
    queueFail: false,
    /** Queue reads never answer until their signal aborts. */
    queueHang: false,
    /** Only the nth queue read (1-based) hangs, so a test can stall a re-read after an update. */
    queueHangOnCall: 0,
    /** Decides per history read whether it fails; the first matching read of a pass is the failing page. */
    eventsFailWhen: undefined as ((args: { types: string[]; beforeSeq?: string }) => boolean) | undefined,
    /** The next history read waits for this, then rejects. */
    eventsGateOnce: undefined as Promise<void> | undefined,
    /** Every history read fails, as when the recipient's history is inaccessible. */
    eventsFail: false,
    accepted: [] as { threadId: string; seq: number; clientRequestId: string; at: number }[],
    /** The thread id of every history read, so a test can see whose history was searched. */
    eventReads: [] as string[],
    /** queue: a queued row; inline: dispatched at once; throw: the send fails with `sendError`. */
    sendMode: "queue" as "queue" | "inline" | "throw",
    /** Whether an inline send also records its accepted-input event. */
    acceptInline: true,
    sendError: undefined as Fault | undefined,
    /** A lost update response: the write lands, the caller sees an error. */
    updateLost: false,
    /** An explicit rejection: the write never happens. */
    updateRejection: undefined as Fault | undefined,
    /** With a lost update: the row dispatches (and leaves the queue) before the caller re-reads it. */
    dispatchAfterUpdate: false,
    /** The row left the queue without our text and the update failed with no status. */
    dropRowOnUpdate: false,
    /** The send reaches the thread but its response is lost. */
    sendLandsThenThrows: false,
    lastBody: "",
    /** Holds every send until released, so a test can interleave a transition. */
    sendGate: undefined as Promise<void> | undefined,
    threads: new Map<string, { archived?: boolean; deleted?: boolean; parent?: string; status?: string; sideChat?: boolean }>(),
    /** The next queue read waits for this and then sees an empty queue: a search that was slow and stale. */
    listGateOnce: undefined as Promise<void> | undefined,
    /** Sweep's own manager setting, so a test can prove Work Board never asks for it. */
    sweepManager: "thr_sweep" as string | null,
    sweepCalls: 0,
    /** Every thread read throws this, as in a transient outage; `{ code: "thread_not_found" }` is the platform's authoritative answer. */
    getError: undefined as (Error & { code?: string }) | undefined,
    /** The next thread read waits for this before answering. */
    getGateOnce: undefined as Promise<void> | undefined,
  };
  let seq = 0;
  const text = (row: Row) => row.content.map((part) => part.text).join("\n");
  const sdk = {
    threads: {
      get: async ({ threadId }: { threadId: string }) => {
        const info = state.threads.get(threadId) ?? {};
        if (state.getGateOnce) { const gate = state.getGateOnce; state.getGateOnce = undefined; await gate; }
        if (state.getError) throw state.getError;
        return makeThreadResponse({ id: threadId, status: (info.status ?? "idle") as never, ...(info.archived ? { archivedAt: 1 } : {}), ...(info.deleted ? { deletedAt: 1 } : {}), ...(info.sideChat ? { originKind: "fork", originPluginId: "side-chat", visibility: "hidden" } : {}), ...(info.parent ? { parentThreadId: info.parent } : {}) } as never);
      },
      queuedMessages: {
        list: async ({ threadId, signal }: { threadId: string; signal?: AbortSignal }) => {
          state.queueCalls++;
          if (state.queueFail) throw fault("queue unavailable");
          if (state.queueHang || state.queueCalls === state.queueHangOnCall) await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(fault("queue timed out"))));
          if (state.listGateOnce) { const gate = state.listGateOnce; state.listGateOnce = undefined; await gate; return []; }
          return state.rows.filter((row) => row.threadId === threadId);
        },
        update: async ({ queuedMessageId, input, expectedUpdatedAt }: { queuedMessageId: string; input: { text: string }[]; expectedUpdatedAt: string }) => {
          state.updates++;
          if (state.updateRejection) throw state.updateRejection;
          const row = state.rows.find((candidate) => candidate.id === queuedMessageId);
          if (state.dropRowOnUpdate && row) { state.rows.splice(state.rows.indexOf(row), 1); throw fault("socket closed"); }
          if (!row || row.updatedAt !== expectedUpdatedAt) throw fault("changed", 409);
          row.content = [{ type: "text", text: input[0]!.text, mentions: [] }];
          row.updatedAt = `${Date.now()}-${++seq}`;
          if (state.updateLost) { if (state.dispatchAfterUpdate) dispatchRow(row); throw fault("socket closed"); }
          return row;
        },
      },
      send: async ({ threadId, input }: { threadId: string; input: { text: string }[] }) => {
        state.sends++;
        if (state.sendGate) await state.sendGate;
        if (state.sendMode === "throw") throw state.sendError ?? fault("socket closed");
        const body = input[0]!.text;
        state.lastBody = body;
        if (state.sendLandsThenThrows) { addRow(threadId, body); throw fault("socket closed"); }
        if (state.sendMode === "queue") {
          const row = addRow(threadId, body);
          return { ok: true, delivery: "queued", queuedMessage: row };
        }
        if (state.acceptInline) dispatch(body, threadId);
        return { ok: true, delivery: "sent" };
      },
      events: {
        // Honors the paging the real list has: type filter, order, limit and the seq bounds. Both arrays grow in seq order.
        list: async ({ threadId, types, order = "desc", limit = "50", beforeSeq, afterSeq }: { threadId: string; types: string[]; order?: string; limit?: string; beforeSeq?: string; afterSeq?: string }) => {
          state.listCalls++;
          state.eventReads.push(threadId);
          if (types.includes("turn/input/accepted")) state.acceptedCalls++;
          if (state.eventsGateOnce) { const gate = state.eventsGateOnce; state.eventsGateOnce = undefined; await gate; throw fault("history unavailable"); }
          if (state.eventsFail || state.eventsFailWhen?.({ types, beforeSeq })) throw fault("history unavailable");
          const requests = types.includes("client/turn/requested");
          // Evidence belongs to the thread it was recorded in: another thread's history never shows it.
          const source = (requests ? state.requests : state.accepted).filter((event) => event.threadId === threadId);
          const wanted = Number(limit);
          const out: unknown[] = [];
          const indices = order === "asc" ? source.map((_, index) => index) : source.map((_, index) => source.length - 1 - index);
          for (const index of indices) {
            const event = source[index]!;
            if ((beforeSeq !== undefined && event.seq >= Number(beforeSeq)) || (afterSeq !== undefined && event.seq <= Number(afterSeq))) continue;
            out.push(requests
              ? { seq: event.seq, type: "client/turn/requested", createdAt: event.at, data: { requestId: (event as { requestId: string }).requestId, ...((event as { grouped?: boolean }).grouped ? { inputGroups: [[{ type: "text", text: (event as { text: string }).text }]] } : { input: [{ type: "text", text: (event as { text: string }).text }] }), ...((event as { extra?: Record<string, unknown> }).extra ?? {}) } }
              : { seq: event.seq, type: "turn/input/accepted", createdAt: event.at, data: { clientRequestId: (event as { clientRequestId: string }).clientRequestId } });
            if (out.length >= wanted) break;
          }
          return out;
        },
      },
    },
    plugins: {
      callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
        if (pluginId === "sweep" && method === "config.get") { state.sweepCalls++; return { manager: state.sweepManager }; }
        throw new Error(`unexpected ${pluginId}.${method}`);
      },
    },
  };
  function addRow(threadId: string, body: string, originPluginId = "work-board"): Row {
    const row: Row = { id: `qm_${++seq}`, threadId, state: "queued", editable: true, originPluginId, updatedAt: `u${++seq}`, content: [{ type: "text", text: body, mentions: [] }], payload: { kind: "message" } };
    state.rows.push(row);
    return row;
  }
  /** Record an accepted-input pair for `body`, as an idle thread does for an inline message. */
  function dispatch(body: string, threadId = MANAGER) {
    const requestId = `req_${++seq}`;
    state.requests.push({ threadId, seq: ++seq, requestId, text: body, at: Date.now() });
    state.accepted.push({ threadId, seq: ++seq, clientRequestId: requestId, at: Date.now() });
  }
  /** A queued row leaves the queue and dispatches with its text. */
  function dispatchRow(row: Row) {
    state.rows.splice(state.rows.indexOf(row), 1);
    dispatch(text(row), row.threadId);
  }
  /** A request whose acceptance is recorded separately, later. */
  function requestOnly(body: string, options: { extra?: Record<string, unknown>; grouped?: boolean } = {}): string {
    const requestId = `req_${++seq}`;
    state.requests.push({ threadId: MANAGER, seq: ++seq, requestId, text: body, at: Date.now(), ...options });
    return requestId;
  }
  function acceptRequest(requestId: string) {
    state.accepted.push({ threadId: state.requests.find((request) => request.requestId === requestId)?.threadId ?? MANAGER, seq: ++seq, clientRequestId: requestId, at: Date.now() });
  }
  return Object.assign(state, { sdk, text, dispatch, dispatchRow, addRow, requestOnly, acceptRequest });
}

export function setup(threads = createFakeThreads()) {
  const host = createFakePluginHost({ pluginId: "work-board", sdk: threads.sdk as never });
  const { bb, harness } = host;
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerAttention(bb, store);
  const db = bb.storage.database();
  const tracker = store.tasks.createProject({ name: "Attention", prefix: "ATT", color: "blue", linkedBbProjectId: BB_PROJECT });
  store.tasks.updateProject(tracker.id, { statuses: [{ id: "backlog", name: "Backlog" }, { id: "todo", name: "Todo" }, { id: "in_progress", name: "In Progress" }, { id: "in_review", name: "In Review" }, { id: "in_testing", name: "In Testing" }, { id: "done", name: "Done" }, { id: "canceled", name: "Canceled" }] });
  const service = attentionService(bb);
  db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, ?, ?, NULL)").run(tracker.id, MANAGER, new Date().toISOString());
  const call = (method: string, input?: unknown, caller?: { kind: "plugin"; pluginId: string }) =>
    harness.callRpc(method, input, caller ? { experimental_caller: caller } : undefined) as Promise<any>;
  const sweep = (method: string, input?: unknown) => call(method, input, SWEEP);
  const setMode = (mode: "off" | "shadow" | "live", parityReviewed?: boolean) => call("updateAttentionMode", { projectId: tracker.id, mode, parityReviewed });
  /** Pretend the shadow observation started `hours` ago. */
  const ageShadow = (hours: number) => db.prepare("UPDATE attention_modes SET shadow_started_at=? WHERE tracker_id=?").run(new Date(Date.now() - hours * 3_600_000).toISOString(), tracker.id);
  const card = (title: string, status: "in_progress" | "in_review" | "in_testing" | "done" | "todo" = "in_progress", extra: Record<string, unknown> = {}) =>
    store.tasks.createTask({ projectId: tracker.id, title, status, ...extra });
  const occurrences = (all = false) => db.prepare<[string], any>(`SELECT * FROM manager_attention WHERE tracker_id=? ${all ? "" : "AND cleared_at IS NULL"} ORDER BY created_rev`).all(tracker.id);
  const attempts = () => db.prepare<[string], any>("SELECT * FROM attention_attempts WHERE tracker_id=? ORDER BY started_at, rev").all(tracker.id);
  /** Make every open occurrence past its grace period. */
  const makeEligible = () => db.prepare("UPDATE manager_attention SET eligible_at='2000-01-01T00:00:00.000Z'").run();
  const linkPr = (taskId: string, number: number, state: "open" | "merged" | "closed" | "failed" | "missing") => {
    const identity = `owner/repo#${number}`;
    db.prepare("INSERT OR REPLACE INTO task_pr_links(task_id, identity, payload) VALUES (?, ?, ?)").run(taskId, identity, JSON.stringify({ taskId }));
    db.prepare("DELETE FROM git_pr_snapshots WHERE project_id=? AND identity=?").run(tracker.id, identity);
    if (state !== "missing") db.prepare("INSERT INTO git_pr_snapshots(project_id, identity, payload, error) VALUES (?, ?, ?, ?)").run(tracker.id, identity, state === "failed" ? null : JSON.stringify({ state }), state === "failed" ? "refresh failed" : null);
    touchAttention(db, [taskId]);
  };
  return { ...host, bb, store, db, tracker, threads, service, call, sweep, setMode, ageShadow, card, occurrences, attempts, makeEligible, linkPr, dispose: () => harness.dispose() };
}

/** Switch to shadow, age the observation past the gate, then promote and let Sweep acknowledge, so live is effective. */
export async function goLive(f: ReturnType<typeof setup>, accepted: string[] = []) {
  await f.setMode("shadow");
  f.ageShadow(49);
  const state = await f.setMode("live", true);
  const transition = state.transition;
  const ack = await f.sweep("attention.ack", { projectId: BB_PROJECT, trackerId: f.tracker.id, kind: "stale-status", token: transition.token, generation: transition.generation, direction: "to_live", fenceId: "fence-live", acceptedOccurrenceIds: accepted });
  return { transition, ack };
}

/** Record an accepted attempt for an occurrence, as a delivered batch would. */
export function accept(f: ReturnType<typeof setup>, occurrenceId: string, outcome: "appended" | "queued" | "inline" = "queued", queuedMessageId = "qm_1") {
  const attempt = randomUUID();
  const rev = (f.db.prepare("UPDATE attention_rev SET rev = rev + 1 WHERE tracker_id=? RETURNING rev").get(f.tracker.id) as { rev: number }).rev;
  f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, transport_started_at, outcome, queued_message_id, accepted_at, rev) VALUES (?, ?, 'stale-status', 1, ?, 'thr_manager', 'manager', ?, ?, ?, ?, ?, ?)")
    .run(attempt, f.tracker.id, randomUUID(), new Date().toISOString(), new Date().toISOString(), outcome, queuedMessageId, new Date().toISOString(), rev);
  f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES (?, ?)").run(attempt, occurrenceId);
  return attempt;
}
