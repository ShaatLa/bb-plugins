// Idle Compact: compact a Claude Code thread that has sat idle for 50 minutes with a large context.
//
// Claude's prompt cache lives one hour. A thread woken after that rewrites its whole context to the
// cache; compacting it while the cache is still warm costs a cache read plus the summary, and the
// wake then rewrites only the summary. Past the hour the compaction itself pays the full rewrite,
// so a thread found idle longer than WARM_MS is left alone.
//
// It also compacts, as the former auto-compact plugin did, any thread that goes idle or fails with its context at or past
// a share of the model's window: right away, while the cache is warm, instead of mid-turn at the provider's own limit.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const IDLE_MS = 50 * 60_000;
export const WARM_MS = 57 * 60_000;
// OWN marks a compaction this plugin dispatched: the idle (or failure) that ends that compaction turn starts no checks, so
// a thread still over the threshold afterwards is not compacted again until a real turn. shortcut: a marker whose end
// event was missed (a reload mid-turn) makes the next real stop skip its checks once.
const IDLE = "idle:", KEEP = "keep:", COMPACTED = "compacted:", OWN = "own:";
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
    // The attempt is recorded first, so a failed compaction is not retried on the same usage.
    await bb.storage.kv.set(COMPACTED + threadId, used);
    await bb.storage.kv.set(OWN + threadId, true);
    // shortcut: neither the SDK nor the server has a conditional compact, so a turn starting between this check and the
    // server's dispatch is not seen; only a bb change (a conditional dispatch) closes it.
    if (stale() || inflight.has(threadId)) { const reason = stale() ?? "skipped: an earlier compaction has not finished"; if (stale()) { await bb.storage.kv.delete(COMPACTED + threadId); await bb.storage.kv.delete(OWN + threadId); } return reason; }
    inflight.add(threadId);
    try { await bb.sdk.threads.compact({ threadId }); }
    catch (error) { await bb.storage.kv.delete(OWN + threadId); if (NOT_IDLE.test(message(error))) return "skipped: the server found the thread no longer idle"; if (UNSUPPORTED.test(message(error))) return `skipped: provider ${thread.providerId} cannot compact`; throw error; }
    finally { inflight.delete(threadId); }
    return full ? `compacted ${used} tokens at ${percent}% of the window` : `compacted ${used} tokens after ${Math.round((now() - since) / 60_000)} min idle`;
  }
  const atOnce = (threadId: string, period: number) => {
    if (config.thresholdPercent === "off") return;
    void attempt(threadId, now(), () => periods.get(threadId) === period, true).then(result => bb.log.info(`Compact ${threadId}: ${result}`), error => bb.log.warn(`Compact ${threadId} failed: ${message(error)}`));
  };

  // The stop that ends this plugin's own compaction turn: consume the marker and start nothing.
  const ownTurnEnded = async (threadId: string, period: number) => {
    if (!await bb.storage.kv.get(OWN + threadId)) return false;
    await bb.storage.kv.delete(OWN + threadId);
    if (periods.get(threadId) === period) periods.delete(threadId);
    bb.log.info(`Compact ${threadId}: its compaction turn ended; no check until the next turn`);
    return true;
  };
  bb.events.on("thread.idle", async ({ thread }) => {
    const since = now(), period = ++generation;
    periods.set(thread.id, period);
    if (await ownTurnEnded(thread.id, period)) return;
    atOnce(thread.id, period);
    await bb.storage.kv.set(IDLE + thread.id, since);
    schedule(thread.id, since, period);
  });
  for (const event of ["thread.active", "thread.archived"] as const) bb.events.on(event, ({ thread }) => cancel(thread.id));
  // A failed thread gets no idle timer, only the check by share of the window, under its own generation.
  bb.events.on("thread.failed", async ({ thread }) => {
    const done = cancel(thread.id), period = ++generation;
    periods.set(thread.id, period); await done;
    if (!await ownTurnEnded(thread.id, period)) atOnce(thread.id, period);
  });

  // Timers die with the server; threads that went idle before a restart are picked up again while still warm.
  for (const key of await bb.storage.kv.list(IDLE)) {
    const since = await bb.storage.kv.get<number>(key);
    const threadId = key.slice(IDLE.length), period = ++generation;
    if (typeof since === "number" && !periods.has(threadId)) { periods.set(threadId, period); schedule(threadId, since, period); }
  }
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
