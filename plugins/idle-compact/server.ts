// Idle Compact: compact a Claude Code thread that has sat idle for 50 minutes with a large context.
//
// Claude's prompt cache lives one hour. A thread woken after that rewrites its whole context to the
// cache; compacting it while the cache is still warm costs a cache read plus the summary, and the
// wake then rewrites only the summary. Past the hour the compaction itself pays the full rewrite,
// so a thread found idle longer than WARM_MS is left alone.
//
// It also compacts, as the former auto-compact plugin did, any thread that goes idle or fails with its context at or past
// a share of the model's window: right away, while the cache is warm, instead of mid-turn at the provider's own limit.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const IDLE_MS = 50 * 60_000;
export const WARM_MS = 57 * 60_000;
export const LOG_RETENTION_MS = 30 * 86_400_000;

// A read-only log of the compactions this plugin dispatched, for other plugins (Tokenomos) through bb.sdk.plugins.callRpc,
// including those the user started with the thread header's Compact button (`compact`, trigger "manual").
// An entry's id is its storage key without the prefix: <ordering key>:<at>:<thread>, both times zero-padded ms, so ids sort
// in log order and stay stable across reloads.
export type Compaction = { id: string; threadId: string; at: number; trigger: "idle" | "threshold" | "manual"; usedTokensBefore: number | null; contextWindow: number | null };
export const rpcContract = defineRpcContract({
  "compactions.list": {
    input: z.object({ since: z.number().int().nonnegative().optional(), after: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }).strict(),
    output: z.custom<{ items: Compaction[]; nextCursor?: string }>(),
  },
  // `queue`: a thread in a turn gets the compaction when it next stops, before bb dispatches its next message; see `queue()`.
  compact: {
    input: z.object({ threadId: z.string().min(1), queue: z.boolean().optional() }).strict(),
    output: z.custom<{ ok: true; queued?: true }>(),
  },
  cancelQueuedCompact: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.custom<{ ok: true }>(),
  },
  // `running`: a compaction this plugin dispatched has not finished its turn yet.
  compactState: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.custom<{ queued: boolean; running: boolean }>(),
  },
});
const LOG = "log:";
// OWN marks a compaction this plugin dispatched: the idle (or failure) that ends that compaction turn starts no checks, so
// a thread still over the threshold afterwards is not compacted again until a real turn. shortcut: a marker whose end
// event was missed (a reload mid-turn) makes the next real stop skip its checks once.
const IDLE = "idle:", KEEP = "keep:", COMPACTED = "compacted:", OWN = "own:";
// QUEUED: a compaction requested during a turn, not dispatched yet.
const QUEUED = "queued:";
// bb's server refuses to compact a thread that is not idle or errored (409), and runs the compaction as a turn. Its check
// reads a snapshot, though, and the dispatch that follows is not conditional: a turn (or a second compact) that starts in
// the few awaits between them still goes through. Same for `bb thread compact` and any plugin. bb is not changed for this.
const NOT_IDLE = /only be compacted while the thread is idle/, UNSUPPORTED = /does not support .*compaction/i;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

export default async function plugin(bb: BbPluginApi, now: () => number = Date.now) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Compact idle threads", description: "Compact a Claude Code thread after 50 minutes idle, while its prompt cache is still warm, and any thread that stops with a nearly full context.", default: true },
    minTokens: { type: "number", label: "Minimum context, tokens", description: "After 50 minutes idle, threads with a smaller context are left alone: compacting them saves less than it costs.", default: 100_000 },
    thresholdPercent: { type: "select", label: "Compact at once when context usage reaches", description: "Share of the model's context window at which a thread is compacted as soon as it goes idle or fails, on any provider.", options: ["off", "70", "75", "80", "85", "90", "95"], default: "80" },
  });
  let config = await settings.get();
  settings.onChange(next => { config = next; });
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  // Each idle period gets a generation, set and cleared synchronously by the events; a check re-reads it after every await,
  // so an active, failed or archived event (or keep) that lands mid-check stops it, and a stale check never touches a newer period.
  const periods = new Map<string, number>(), inflight = new Set<string>();
  // queued mirrors the QUEUED keys; running holds the threads whose compaction turn (dispatched by this plugin) has not
  // ended. While either holds a thread, the dispatch hook keeps its next turn waiting.
  const queued = new Set<string>(), running = new Set<string>();
  // retry: threads whose queued compaction found another call holding the in-flight guard; whoever releases it runs it.
  const retry = new Set<string>();
  const release = (threadId: string) => { inflight.delete(threadId); if (retry.delete(threadId)) void runQueued(threadId); };
  // taken: queued requests a pending dispatch took; a cancel removes them, so a refused call does not bring them back.
  const taken = new Set<string>();
  // Every compaction this plugin dispatches. running is set before the call, since the compaction's stop can arrive before
  // the call returns. A queued request runs at most once: bb has no acceptance a restart could read back, so its key goes
  // before the call and comes back only if the call is refused. A restart in between loses the request, never repeats it.
  async function dispatch(threadId: string) {
    running.add(threadId);
    const wasQueued = queued.delete(threadId);
    if (wasQueued) taken.add(threadId);
    try {
      if (wasQueued) await bb.storage.kv.delete(QUEUED + threadId);
      await bb.sdk.threads.compact({ threadId });
    } catch (error) {
      // State first, so a failing store cannot leave the hook holding the thread.
      if (taken.delete(threadId)) queued.add(threadId);
      stopped(threadId);
      // Also stores a request made while the call was pending, which queue() kept in memory only.
      if (queued.has(threadId)) await bb.storage.kv.set(QUEUED + threadId, true).catch(cause => bb.log.warn(`Compact ${threadId}: queued request not saved again: ${message(cause)}`));
      throw error;
    }
    taken.delete(threadId);
    // The accepted compaction also covers a request made while the call was pending. If its stop already came, the hook's
    // recheck then ran with a request in place, so it runs again.
    const covered = queued.delete(threadId);
    if (covered) await bb.storage.kv.delete(QUEUED + threadId);
    if ((wasQueued || covered) && !running.has(threadId)) void bb.experimental_hooks.recheck("message.dispatch");
  }
  let generation = 0;

  const cancel = async (threadId: string) => {
    periods.delete(threadId); clearTimeout(timers.get(threadId)); timers.delete(threadId);
    await bb.storage.kv.delete(IDLE + threadId);
  };
  const schedule = (threadId: string, since: number, period: number) => {
    if (periods.get(threadId) !== period) return;
    clearTimeout(timers.get(threadId));
    if (now() - since > WARM_MS) { periods.delete(threadId); void bb.storage.kv.delete(IDLE + threadId); return; }
    timers.set(threadId, setTimeout(() => {
      timers.delete(threadId);
      void check(threadId, since, period).then(result => bb.log.info(`Idle compact ${threadId}: ${result}`), error => bb.log.warn(`Idle compact ${threadId} failed: ${message(error)}`));
    }, Math.max(0, since + IDLE_MS - now())));
  };

  async function check(threadId: string, since: number, period: number): Promise<string> {
    const live = () => periods.get(threadId) === period;
    try { return await attempt(threadId, since, live); } finally { if (live()) { periods.delete(threadId); await bb.storage.kv.delete(IDLE + threadId); } }
  }

  // `full`: the check made the moment a thread stops, by share of the window; otherwise the one after 50 minutes idle.
  async function attempt(threadId: string, since: number, live: () => boolean, full = false): Promise<string> {
    // The window share once read; stale() re-evaluates it against the current setting, which may change mid-check.
    let share: number | null = null;
    const below = () => full && share != null && !(share >= Number(config.thresholdPercent));
    const stale = () => !live() ? "skipped: thread left idle during the check" : !config.enabled || (full && config.thresholdPercent === "off") ? "skipped: turned off" : below() ? `skipped: ${share!.toFixed(1)}% of the window, below ${config.thresholdPercent}%` : !full && now() - since > WARM_MS ? `skipped: idle ${Math.round((now() - since) / 60_000)} min, cache already cold` : null;
    if (!config.enabled) return "skipped: turned off";
    // A sleeping machine fires the timer late, after the cache has gone cold.
    if (stale()) return stale()!;
    if (inflight.has(threadId)) return "skipped: an earlier compaction has not finished";
    if (await bb.storage.kv.get(KEEP + threadId)) return "skipped: keeps its full context";
    const thread = await bb.sdk.threads.get({ threadId });
    if ((thread.status !== "idle" && !(full && thread.status === "error")) || thread.archivedAt) return `skipped: thread is ${thread.archivedAt ? "archived" : thread.status}`;
    if (!full && thread.providerId !== "claude-code") return `skipped: provider ${thread.providerId}`;
    const { usedTokens: used, modelContextWindow: window } = (await bb.sdk.threads.timeline({ threadId })).contextWindowUsage ?? {};
    if (used == null) return "skipped: context size unknown";
    share = window ? used / window * 100 : null;
    const percent = share == null ? "?" : share.toFixed(1);
    if (full && share == null) return "skipped: context window size unknown";
    if (below()) return stale()!;
    if (!full && used < config.minTokens) return `skipped: ${used} tokens, below ${config.minTokens}`;
    // The usage figure may still show the pre-compaction size until the next turn.
    if (await bb.storage.kv.get<number>(COMPACTED + threadId) === used) return "skipped: no turn since the last compaction";
    if (stale()) return stale()!;
    // The in-flight guard is taken before any marker is written and held until they are cleaned up, so this check never
    // touches the markers of a compaction (automatic or from the header) that another call is dispatching.
    if (inflight.has(threadId)) return "skipped: an earlier compaction has not finished";
    inflight.add(threadId);
    try {
      // The attempt is recorded first, so a failed compaction is not retried on the same usage.
      await bb.storage.kv.set(COMPACTED + threadId, used);
      await bb.storage.kv.set(OWN + threadId, true);
      // shortcut: neither the SDK nor the server has a conditional compact, so a turn starting between this check and the
      // server's dispatch is not seen; only a bb change (a conditional dispatch) closes it.
      const reason = stale();
      if (reason) { await bb.storage.kv.delete(COMPACTED + threadId); await bb.storage.kv.delete(OWN + threadId); return reason; }
      try { await dispatch(threadId); }
      catch (error) { await bb.storage.kv.delete(OWN + threadId); if (NOT_IDLE.test(message(error))) return "skipped: the server found the thread no longer idle"; if (UNSUPPORTED.test(message(error))) return `skipped: provider ${thread.providerId} cannot compact`; throw error; }
    } finally { release(threadId); }
    record({ threadId, trigger: full ? "threshold" : "idle", usedTokensBefore: used, contextWindow: window ?? null });
    return full ? `compacted ${used} tokens at ${percent}% of the window` : `compacted ${used} tokens after ${Math.round((now() - since) / 60_000)} min idle`;
  }

  // `at` is the real time the server accepted the compaction. The id starts with a separate ordering key: writes run one at
  // a time and the key strictly increases (max(at, previous + 1)), so ids are unique and every new id sorts after all
  // written ones; a reader's `after` cursor never passes an entry still to come. Reads wait for pending writes. `at` is
  // carried in the id too, so retention and `since` use the real time without reading values.
  // shortcut: an old instance whose compaction resolves after a reload can still write a lower id; per-instance only.
  // shortcut: each write and read lists every log key. One entry per accepted compaction for 30 days: 10 concurrent threads
  // compacting twice an hour around the clock is about 14,400 keys (~1 MB listed); index the log if that is ever reached.
  const ids = (keys: string[]) => keys.map(key => key.slice(LOG.length)).sort();
  const atOf = (id: string) => Number(id.slice(16, 31));
  let lastKey = 0, writes: Promise<unknown> = bb.storage.kv.list(LOG).then(keys => { const last = ids(keys).at(-1); lastKey = last ? Number(last.slice(0, 15)) : 0; }, error => bb.log.warn(`Compaction log: ${message(error)}`));
  const record = (entry: Omit<Compaction, "id" | "at">) => {
    const at = now();
    writes = writes.catch(() => {}).then(async () => {
      const key = lastKey = Math.max(at, lastKey + 1), id = `${String(key).padStart(15, "0")}:${String(at).padStart(15, "0")}:${entry.threadId}`;
      await bb.storage.kv.set(LOG + id, { ...entry, id, at });
      // At most 20 deletes per write, so a backlog after a quiet month is cleared over several writes.
      const oldest = now() - LOG_RETENTION_MS;
      for (const old of ids(await bb.storage.kv.list(LOG)).filter(id => atOf(id) < oldest).slice(0, 20)) await bb.storage.kv.delete(LOG + old);
    });
    // A failed log write must not report the compaction itself as failed.
    writes.catch(error => bb.log.warn(`Compaction log ${entry.threadId}: ${message(error)}`));
  };
  bb.rpc.register(rpcContract, {
    "compactions.list": async ({ since, after, limit = 100 }) => {
      await writes.catch(() => {});
      const oldest = now() - LOG_RETENTION_MS;
      const items: Compaction[] = [];
      let more = false;
      for (const id of ids(await bb.storage.kv.list(LOG))) {
        if ((after != null && id <= after) || (since != null && atOf(id) <= since) || atOf(id) < oldest) continue;
        // An entry pruned since the listing is skipped without counting.
        const entry = await bb.storage.kv.get<Compaction>(LOG + id);
        if (!entry) continue;
        if (items.length === limit) { more = true; break; }
        items.push(entry);
      }
      return more ? { items, nextCursor: items.at(-1)!.id } : { items };
    },
    compact: async ({ threadId, queue: later }) => {
      if (!later) { await manual(threadId); return { ok: true as const }; }
      // A repeat request, or one made while a compaction is already under way, adds nothing.
      if (queued.has(threadId)) return { ok: true as const, queued: true as const };
      // An accepted compaction covers the request; a check still in flight may skip, so the request is kept (see release).
      if (running.has(threadId) && !inflight.has(threadId)) return { ok: true as const };
      const thread = await bb.sdk.threads.get({ threadId });
      if (thread.archivedAt) throw new Error("The thread is archived");
      // While another call holds the in-flight guard the request is queued; release() runs it if that call compacts nothing.
      if (!inflight.has(threadId) && (thread.status === "idle" || thread.status === "error")) {
        try { await manual(threadId); return { ok: true as const }; } catch (error) { if (!NOT_IDLE.test(message(error))) throw error; }
      }
      await queue(threadId);
      return { ok: true as const, queued: true as const };
    },
    cancelQueuedCompact: async ({ threadId }) => { await unqueue(threadId); return { ok: true as const }; },
    compactState: async ({ threadId }) => ({ queued: queued.has(threadId), running: running.has(threadId) || inflight.has(threadId) }),
  });

  // A queued compaction runs at the thread's next stop (idle or failed). The `message.dispatch` hook keeps the thread's next
  // turn waiting until that compaction's own turn has ended, so a message queued in bb meanwhile runs on the compacted
  // context; recheck() then lets bb dispatch it. Compaction itself does not pass through the hook. A user's Send now on a
  // queued message bypasses the hook by design; the compaction then waits for the stop after that turn.
  async function queue(threadId: string) {
    queued.add(threadId);
    // A request made while a compact call is pending stays in memory: if that call is accepted it covers the request, and
    // a restart before then must not find a key and compact again. dispatch() stores it if the call is refused.
    if (!running.has(threadId)) await bb.storage.kv.set(QUEUED + threadId, true);
    bb.log.info(`Compact ${threadId}: queued until the thread stops`);
    // The thread may have stopped between the status read and the request; its stop event has then already passed.
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status === "idle" || thread.status === "error") void runQueued(threadId);
  }
  async function unqueue(threadId: string) {
    const had = [queued.delete(threadId), taken.delete(threadId)].some(Boolean);
    await bb.storage.kv.delete(QUEUED + threadId);
    if (had) { bb.log.info(`Compact ${threadId}: queued compaction cancelled`); await bb.experimental_hooks.recheck("message.dispatch"); }
  }
  async function runQueued(threadId: string) {
    if (!queued.has(threadId)) return;
    if (inflight.has(threadId)) { retry.add(threadId); return; }
    try { await manual(threadId); }
    catch (error) {
      // A thread that started a turn again (Send now) gets the compaction at its next stop; any other refusal drops the
      // request, since a thread left idle has no next stop to retry at and its waiting messages must go.
      if (NOT_IDLE.test(message(error))) return;
      bb.log.warn(`Compact ${threadId}: queued compaction failed: ${message(error)}`);
      await unqueue(threadId);
    }
  }
  bb.experimental_hooks.on("message.dispatch", ({ thread, attempt }) => {
    // Joining the running turn needs nothing new; only a turn that would start on the uncompacted context waits.
    if (attempt !== "start-turn" || (!queued.has(thread.id) && !running.has(thread.id))) return { action: "proceed" };
    // An idle thread whose compaction is still queued: the stop event came before the request was stored.
    if (queued.has(thread.id) && (thread.status === "idle" || thread.status === "error")) void runQueued(thread.id);
    return { action: "wait", reason: "Idle Compact is compacting the context first" };
  });

  // The header button: any provider, regardless of the settings, size and keep. The server still refuses a thread that is
  // not idle or errored. OWN makes the stop ending this compaction turn start no checks, as for the plugin's own.
  async function manual(threadId: string) {
    if (inflight.has(threadId)) throw new Error("An earlier compaction of this thread has not finished");
    inflight.add(threadId);
    try {
      // usedTokensBefore is null when bb does not know the context size.
      const { usedTokens: used, modelContextWindow: window } = (await bb.sdk.threads.timeline({ threadId })).contextWindowUsage ?? {};
      await bb.storage.kv.set(OWN + threadId, true);
      try { await dispatch(threadId); } catch (error) { await bb.storage.kv.delete(OWN + threadId); throw error; }
      record({ threadId, trigger: "manual", usedTokensBefore: used ?? null, contextWindow: window ?? null });
      // The usage figure may still show the pre-compaction size until the next turn.
      if (used != null) await bb.storage.kv.set(COMPACTED + threadId, used);
    } finally { release(threadId); }
    bb.log.info(`Compact ${threadId}: compacted from the thread header`);
  }

  const atOnce = (threadId: string, period: number) => {
    if (config.thresholdPercent === "off") return;
    void attempt(threadId, now(), () => periods.get(threadId) === period, true).then(result => bb.log.info(`Compact ${threadId}: ${result}`), error => bb.log.warn(`Compact ${threadId} failed: ${message(error)}`));
  };

  // The stop that ends this plugin's own compaction turn: consume the marker and start nothing.
  // A compaction turn's stop (or archive) releases the messages the dispatch hook kept waiting behind it.
  const stopped = (threadId: string) => { if (running.delete(threadId)) void bb.experimental_hooks.recheck("message.dispatch"); };
  const ownTurnEnded = async (threadId: string, period: number) => {
    stopped(threadId);
    if (!await bb.storage.kv.get(OWN + threadId)) return false;
    await bb.storage.kv.delete(OWN + threadId);
    if (periods.get(threadId) === period) periods.delete(threadId);
    bb.log.info(`Compact ${threadId}: its compaction turn ended; no check until the next turn`);
    return true;
  };
  bb.events.on("thread.idle", async ({ thread }) => {
    const since = now(), period = ++generation;
    periods.set(thread.id, period);
    // A request still queued after this plugin's own compaction turn (one that turn did not cover) runs now rather than
    // leaving the thread's next message waiting.
    if (await ownTurnEnded(thread.id, period) || queued.has(thread.id)) { periods.delete(thread.id); return void runQueued(thread.id); }
    atOnce(thread.id, period);
    await bb.storage.kv.set(IDLE + thread.id, since);
    schedule(thread.id, since, period);
  });
  bb.events.on("thread.active", ({ thread }) => cancel(thread.id));
  for (const event of ["thread.archived", "thread.deleted"] as const) bb.events.on(event, async ({ thread }) => { stopped(thread.id); await unqueue(thread.id); await cancel(thread.id); });
  // A failed thread gets no idle timer, only the check by share of the window, under its own generation.
  bb.events.on("thread.failed", async ({ thread }) => {
    const done = cancel(thread.id), period = ++generation;
    periods.set(thread.id, period); await done;
    // A request still queued after this plugin's own compaction turn (one that turn did not cover) runs now rather than
    // leaving the thread's next message waiting.
    if (await ownTurnEnded(thread.id, period) || queued.has(thread.id)) { periods.delete(thread.id); return void runQueued(thread.id); }
    atOnce(thread.id, period);
  });

  // Timers die with the server; threads that went idle before a restart are picked up again while still warm.
  for (const key of await bb.storage.kv.list(IDLE)) {
    const since = await bb.storage.kv.get<number>(key);
    const threadId = key.slice(IDLE.length), period = ++generation;
    if (typeof since === "number" && !periods.has(threadId)) { periods.set(threadId, period); schedule(threadId, since, period); }
  }
  // Queued requests survive a restart; one whose thread stopped meanwhile runs now. The recheck releases messages a previous
  // instance kept waiting behind a compaction whose end this one never sees.
  // A compaction a previous instance dispatched may still be running: its thread's next turn keeps waiting until its stop.
  for (const key of await bb.storage.kv.list(OWN)) {
    const thread = await bb.sdk.threads.get({ threadId: key.slice(OWN.length) }).catch(() => null);
    if (thread?.status === "active") running.add(thread.id);
  }
  for (const key of await bb.storage.kv.list(QUEUED)) queued.add(key.slice(QUEUED.length));
  for (const threadId of queued) {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    // A key still stored was never dispatched (dispatch deletes it first) or was refused.
    if (!thread || thread.archivedAt) await unqueue(threadId);
    else if (thread.status === "idle" || thread.status === "error") void runQueued(threadId);
  }
  await bb.experimental_hooks.recheck("message.dispatch");
  bb.onDispose(() => { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); });

  const usage = "Usage:\n  bb idle-compact status [--json]\n  bb idle-compact keep [thread-id]\n  bb idle-compact release [thread-id]";
  bb.cli.register({
    name: "idle-compact",
    summary: "Compact Claude Code threads idle for 50 minutes while their cache is warm",
    commands: [
      { name: "status", summary: "Show settings, pending compactions and threads that keep full context", usage: "bb idle-compact status [--json]" },
      { name: "keep", summary: "Never idle-compact this thread", usage: "bb idle-compact keep [thread-id]" },
      { name: "release", summary: "Let this thread be idle-compacted again", usage: "bb idle-compact release [thread-id]" },
    ],
    async run(argv, ctx) {
      const json = argv.includes("--json"), [command, ...rest] = argv.filter(arg => arg !== "--json");
      if (command === "status") {
        const pending: Record<string, string> = {};
        for (const key of await bb.storage.kv.list(IDLE)) { const since = await bb.storage.kv.get<number>(key); if (typeof since === "number") pending[key.slice(IDLE.length)] = new Date(since + IDLE_MS).toISOString(); }
        const kept = (await bb.storage.kv.list(KEEP)).map(key => key.slice(KEEP.length));
        const value = { enabled: config.enabled, idleMinutes: IDLE_MS / 60_000, minTokens: config.minTokens, thresholdPercent: config.thresholdPercent, pending, kept };
        return { exitCode: 0, stdout: json ? JSON.stringify(value) : [`enabled: ${value.enabled}`, `compacts after: ${value.idleMinutes} min idle, ${value.minTokens} tokens or more`, `compacts at once from: ${value.thresholdPercent === "off" ? "off" : `${value.thresholdPercent}% of the window`}`, `pending: ${Object.entries(pending).map(([id, at]) => `${id} at ${at}`).join(", ") || "none"}`, `keep full context: ${kept.join(", ") || "none"}`].join("\n") };
      }
      if (command === "keep" || command === "release") {
        const threadId = rest[0] ?? ctx.threadId;
        if (!threadId || rest.length > 1) return { exitCode: 1, stderr: usage };
        await bb.sdk.threads.get({ threadId });
        if (command === "keep") { periods.delete(threadId); clearTimeout(timers.get(threadId)); timers.delete(threadId); await bb.storage.kv.set(KEEP + threadId, true); } else await bb.storage.kv.delete(KEEP + threadId);
        return { exitCode: 0, stdout: json ? JSON.stringify({ threadId, keep: command === "keep" }) : `${threadId}: ${command === "keep" ? "keeps its full context" : "can be idle-compacted"}` };
      }
      if (command && command !== "help" && command !== "--help") return { exitCode: 1, stderr: usage };
      return { exitCode: 0, stdout: usage };
    },
  });
}
