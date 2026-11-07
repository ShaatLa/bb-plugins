import { experimental_isHostPathWithin, type BbPluginApi } from "@get-bb/plugin-sdk";
import { realpath } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createCollector } from "./watch-collector.js";
import type { Effect, Input, UsageSubject, WatchDiagnostics, WatchRunStats } from "./contract.js";

type Usage = Extract<Input, { type: "usage" }>;
type Thread = { environmentId: string | null };
export interface WatcherOptions {
  sdk: BbPluginApi["sdk"]; hostId: () => string; enabled: () => boolean;
  preview: (usage: Usage) => Promise<Effect[]>;
  commit: (usage: Usage, verified: Set<string>, signal: AbortSignal) => Promise<unknown>;
  now?: () => number; realpath?: typeof realpath; collector?: ReturnType<typeof createCollector>;
  warn: (error: unknown) => void;
}
export function createWatcher(options: WatcherOptions) {
  const now = options.now ?? Date.now, canonical = options.realpath ?? realpath;
  const collector = options.collector ?? createCollector({ now });
  let groups: UsageSubject[] = [], refreshedAt = -Infinity, unmatchedAt = -Infinity, dirty = true, running = false;
  let controller: AbortController | undefined;
  let lastEndAt = now();
  const environments = new Map<string, { at: number; path: string | null; hostId: string }>();
  const resetKeys = new Set<string>(), history: WatchRunStats[] = [];
  const within = (rootPath: string, candidatePath: string) => experimental_isHostPathWithin({ rootPath, candidatePath });
  const match = (cwd: string) => groups.find(g => within(g.key, cwd));
  function bounded<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      if (signal.aborted) { abort(); return; }
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  async function pathFor(thread: Thread, signal: AbortSignal, fresh = false) {
    if (!thread.environmentId) throw new Error("Live thread has no environment");
    let env = environments.get(thread.environmentId);
    if (fresh || !env || now() - env.at >= 300000) {
      const result = await bounded(options.sdk.environments.get({ environmentId: thread.environmentId }), signal);
      env = { at: now(), hostId: result.hostId, path: result.hostId !== options.hostId() || result.path === null ? null : await bounded(canonical(result.path), signal) };
      if (!fresh) environments.set(thread.environmentId, env);
    }
    return env.hostId === options.hostId() ? env.path : null;
  }
  async function refresh(signal: AbortSignal) {
    const paths = new Map<string, string[]>();
    for (let offset = 0;; offset += 100) {
      const threads = await bounded(options.sdk.threads.list({ hostId: options.hostId(), archived: false, includeHidden: true, limit: 100, offset, signal }), signal);
      for (const thread of threads) {
        if (thread.archivedAt || thread.deletedAt) continue;
        // Thread routing refreshes every two minutes; physical environment paths cache for five.
        const path = await pathFor(thread, signal);
        if (path) paths.set(path, [...(paths.get(path) ?? []), thread.id]);
      }
      if (threads.length < 100) break;
    }
    const next = [...paths].map(([key, threadIds]) => ({ key, threadIds: threadIds.sort(), cores: 0 })).sort((a,b) => b.key.length - a.key.length);
    for (const key of new Set([...groups.map(g => g.key), ...next.map(g => g.key)])) {
      if (JSON.stringify(groups.find(g => g.key === key)?.threadIds) !== JSON.stringify(next.find(g => g.key === key)?.threadIds)) resetKeys.add(key);
    }
    groups = next; refreshedAt = now(); dirty = false;
    for (const [id, env] of environments) if (now() - env.at >= 300000) environments.delete(id);
  }
  async function verify(subject: UsageSubject, signal: AbortSignal) {
    for (const threadId of subject.threadIds) {
      const thread = await bounded(options.sdk.threads.get({ threadId }), signal);
      if (thread.archivedAt || thread.deletedAt || await pathFor(thread, signal, true) !== subject.key) return false;
    }
    return true;
  }
  async function run(parentSignal?: AbortSignal) {
    if (running || !options.enabled() || parentSignal?.aborted) return;
    running = true; controller = new AbortController();
    const active = controller;
    const abort = () => active.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", abort, { once: true });
    const deadline = setTimeout(() => active.abort(new Error("Watcher deadline exceeded")), 20000);
    const begin = now(), cpu = process.cpuUsage();
    let stats = { psMs: 0, lsofMs: 0, lsofCalls: 0 };
    let usage: Usage = { type: "usage", hostId: options.hostId(), startAt: lastEndAt, endAt: now(), valid: false, unknownCores: 0, subjects: [] };
    try {
      const sample = await bounded(collector.sample(active.signal), active.signal); stats = sample.stats;
      usage = { ...usage, startAt: sample.startAt, endAt: sample.endAt, valid: sample.valid, unknownCores: sample.unknownCores };
      if (dirty || now() - refreshedAt >= 120000) await refresh(active.signal);
      if (sample.perPid.some(p => !match(p.cwd)) && now() - refreshedAt >= 60000 && now() - unmatchedAt >= 60000) { unmatchedAt = now(); await refresh(active.signal); }
      for (const change of sample.cwdChanged) for (const cwd of [change.from, change.to]) { const g = match(cwd); if (g) resetKeys.add(g.key); }
      const subjects = groups.map(g => ({ ...g, threadIds: [...g.threadIds], cores: 0 }));
      for (const p of sample.perPid) { const g = match(p.cwd); if (g) subjects.find(s => s.key === g.key)!.cores += p.cores; }
      usage.subjects = subjects; usage.resetKeys = [...resetKeys];
      const effects = await options.preview(usage), verified = new Set<string>();
      for (const effect of effects) if (effect.type === "notify" && effect.watch && !verified.has(effect.watch.subject.key)) {
        if (await verify(effect.watch.subject, active.signal)) verified.add(effect.watch.subject.key);
        else { resetKeys.add(effect.watch.subject.key); dirty = true; }
      }
      if (active.signal.aborted) throw active.signal.reason;
      usage.resetKeys = [...resetKeys];
      if (options.enabled()) await bounded(options.commit(usage, verified, active.signal), active.signal);
      resetKeys.clear();
    } catch (error) {
      options.warn(error);
      usage = { ...usage, endAt: Math.max(usage.endAt, now()), valid: false, subjects: groups.map(g => ({ ...g, cores: 0 })) };
      if (options.enabled()) await options.commit(usage, new Set(), active.signal).catch(options.warn);
    } finally {
      lastEndAt = usage.endAt;
      const delta = process.cpuUsage(cpu);
      history.push({ at: now(), durationMs: now() - begin, cpuMs: (delta.user + delta.system) / 1000, ...stats });
      while (history.length && history[0].at < now() - 600000) history.shift();
      clearTimeout(deadline); parentSignal?.removeEventListener("abort", abort); controller = undefined; running = false;
    }
  }
  return {
    run, invalidate() { dirty = true; }, dispose() { controller?.abort(new Error("Watcher disposed")); },
    diagnostics(): WatchDiagnostics {
      const recent = history.filter(r => r.at >= now() - 600000);
      const average = { durationMs: 0, cpuMs: 0, psMs: 0, lsofMs: 0, lsofCalls: 0 };
      for (const r of recent) for (const key of Object.keys(average) as (keyof typeof average)[]) average[key] += r[key] / recent.length;
      return { last: history.at(-1) ?? null, average10m: { ...average, runs: recent.length } };
    },
    async start(signal: AbortSignal) {
      while (!signal.aborted) {
        const begin = now();
        await run(signal).catch(options.warn);
        await sleep(Math.max(1, 30000 - (now() - begin)), undefined, { signal }).catch(error => { if (!signal.aborted) options.warn(error); });
      }
    },
  };
}
