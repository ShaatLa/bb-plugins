// Idle Compact: compact a Claude Code thread that has sat idle for 50 minutes with a large context.
//
// Claude's prompt cache lives one hour. A thread woken after that rewrites its whole context to the
// cache; compacting it while the cache is still warm costs a cache read plus the summary, and the
// wake then rewrites only the summary. Past the hour the compaction itself pays the full rewrite,
// so a thread found idle longer than WARM_MS is left alone.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const IDLE_MS = 50 * 60_000;
export const WARM_MS = 57 * 60_000;
const IDLE = "idle:", KEEP = "keep:", COMPACTED = "compacted:";
// bb's server refuses to compact a thread that is not idle or errored (409), and runs the compaction as a turn. Its check
// reads a snapshot, though, and the dispatch that follows is not conditional: a turn (or a second compact) that starts in
// the few awaits between them still goes through. Same for `bb thread compact` and any plugin. bb is not changed for this.
const NOT_IDLE = /only be compacted while the thread is idle/;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").slice(0, 200);

export default async function plugin(bb: BbPluginApi, now: () => number = Date.now) {
  const settings = bb.settings.define({
    enabled: { type: "boolean", label: "Compact idle threads", description: "Compact a Claude Code thread after 50 minutes idle, while its prompt cache is still warm.", default: true },
    minTokens: { type: "number", label: "Minimum context, tokens", description: "Threads with a smaller context are left alone: compacting them saves less than it costs.", default: 100_000 },
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

  async function attempt(threadId: string, since: number, live: () => boolean): Promise<string> {
    const stale = () => !live() ? "skipped: thread left idle during the check" : now() - since > WARM_MS ? `skipped: idle ${Math.round((now() - since) / 60_000)} min, cache already cold` : null;
    if (!config.enabled) return "skipped: turned off";
    // A sleeping machine fires the timer late, after the cache has gone cold.
    if (stale()) return stale()!;
    if (inflight.has(threadId)) return "skipped: an earlier compaction has not finished";
    if (await bb.storage.kv.get(KEEP + threadId)) return "skipped: keeps its full context";
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.status !== "idle" || thread.archivedAt) return `skipped: thread is ${thread.archivedAt ? "archived" : thread.status}`;
    if (thread.providerId !== "claude-code") return `skipped: provider ${thread.providerId}`;
    const used = (await bb.sdk.threads.timeline({ threadId })).contextWindowUsage?.usedTokens;
    if (used == null) return "skipped: context size unknown";
    if (used < config.minTokens) return `skipped: ${used} tokens, below ${config.minTokens}`;
    // The usage figure may still show the pre-compaction size until the next turn.
    if (await bb.storage.kv.get<number>(COMPACTED + threadId) === used) return "skipped: no turn since the last compaction";
    if (stale()) return stale()!;
    // The attempt is recorded first, so a failed compaction is not retried on the same usage.
    await bb.storage.kv.set(COMPACTED + threadId, used);
    // shortcut: neither the SDK nor the server has a conditional compact, so a turn starting between this check and the
    // server's dispatch is not seen; only a bb change (a conditional dispatch) closes it.
    if (stale() || inflight.has(threadId)) { const reason = stale() ?? "skipped: an earlier compaction has not finished"; if (stale()) await bb.storage.kv.delete(COMPACTED + threadId); return reason; }
    inflight.add(threadId);
    try { await bb.sdk.threads.compact({ threadId }); }
    catch (error) { if (NOT_IDLE.test(message(error))) return "skipped: the server found the thread no longer idle"; throw error; }
    finally { inflight.delete(threadId); }
    return `compacted ${used} tokens after ${Math.round((now() - since) / 60_000)} min idle`;
  }

  bb.events.on("thread.idle", async ({ thread }) => {
    const since = now(), period = ++generation;
    periods.set(thread.id, period);
    await bb.storage.kv.set(IDLE + thread.id, since);
    schedule(thread.id, since, period);
  });
  for (const event of ["thread.active", "thread.failed", "thread.archived"] as const) bb.events.on(event, ({ thread }) => cancel(thread.id));

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
        const value = { enabled: config.enabled, idleMinutes: IDLE_MS / 60_000, minTokens: config.minTokens, pending, kept };
        return { exitCode: 0, stdout: json ? JSON.stringify(value) : [`enabled: ${value.enabled}`, `compacts after: ${value.idleMinutes} min idle, ${value.minTokens} tokens or more`, `pending: ${Object.entries(pending).map(([id, at]) => `${id} at ${at}`).join(", ") || "none"}`, `keep full context: ${kept.join(", ") || "none"}`].join("\n") };
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
