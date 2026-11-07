import { execFile } from "node:child_process";
import { readlink as readlinkFile } from "node:fs/promises";
import { promisify } from "node:util";

export type ProcessReading = { pid: number; start: string; startedAt: number; cpu: number };
export type Snapshot = { at: number; processes: ProcessReading[] };
const identity = (p: ProcessReading) => `${p.pid}:${p.start}`;

export function parsePs(text: string): ProcessReading[] {
  return text.split("\n").filter(line => line.trim()).map(line => {
    const match = line.trim().match(/^(\d+)\s+(\w+\s+\w+\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(?:(\d+)-)?(\d+):(\d\d)(?::(\d\d))?(?:\.(\d+))?$/);
    if (!match) throw new Error("Invalid ps output");
    const startedAt = Date.parse(match[2]);
    if (!Number.isFinite(startedAt)) throw new Error("Invalid process start time");
    const cpu = +(match[3] || 0) * 86400 + (match[6] === undefined ? +match[4] * 60 + +match[5] : +match[4] * 3600 + +match[5] * 60 + +match[6]) + (match[7] ? Number(`0.${match[7]}`) : 0);
    return { pid: +match[1], start: match[2].replace(/\s+/g, " "), startedAt, cpu };
  });
}

export function parseLsofCwd(text: string): Map<number, string> {
  const result = new Map<number, string>();
  let pid = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1));
    else if (line.startsWith("n") && pid && line.length > 1) result.set(pid, line.slice(1));
  }
  return result;
}

export function cpuDeltas(previous: Snapshot, next: Snapshot): (ProcessReading & { cores: number })[] {
  const old = new Map(previous.processes.map(p => [identity(p), p]));
  const seconds = (next.at - previous.at) / 1000;
  if (seconds <= 0) return [];
  return next.processes.flatMap(p => {
    const before = old.get(identity(p));
    const delta = before ? p.cpu - before.cpu : p.startedAt >= previous.at ? p.cpu : 0;
    return delta > 0 ? [{ ...p, cores: delta / seconds }] : [];
  }).sort((a, b) => b.cores - a.cores);
}

type ExecOptions = { timeout: number; maxBuffer: number; signal: AbortSignal; env: NodeJS.ProcessEnv };
type Exec = (file: string, args: string[], options: ExecOptions) => Promise<{ stdout: string }>;
type CollectorOptions = { exec?: Exec; readlink?: (path: string) => Promise<string>; now?: () => number; platform?: NodeJS.Platform };

// Processes born and gone between snapshots cannot be observed; cwd changes can take five minutes to appear.
export function createCollector(options: CollectorOptions = {}) {
  const exec = options.exec ?? (promisify(execFile) as Exec);
  const readlink = options.readlink ?? readlinkFile;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  let previous: Snapshot | undefined;
  const cache = new Map<string, { cwd: string; at: number }>();

  return { async sample(signal: AbortSignal) {
    const begin = now();
    let endAt = begin, psMs = 0, lsofMs = 0, lsofCalls = 0, valid = false, unknownCores = 0;
    const startAt = previous?.at ?? begin;
    const perPid: { cores: number; cwd: string }[] = [];
    const cwdChanged: { from: string; to: string }[] = [];
    const execOptions: ExecOptions = { timeout: 3000, maxBuffer: 4 * 1024 * 1024, signal, env: { ...process.env, LC_ALL: "C" } };
    try {
      if (platform !== "darwin" && platform !== "linux") throw new Error("Unsupported platform");
      const ps = await exec("ps", [platform === "darwin" ? "-axo" : "-eo", "pid=,lstart=,time="], execOptions);
      endAt = now(); psMs = endAt - begin;
      const next = { at: endAt, processes: parsePs(ps.stdout) };
      const busy = previous ? cpuDeltas(previous, next) : [];
      valid = !!previous && endAt > startAt && busy.length <= 500;
      previous = next;
      const present = new Set(next.processes.map(identity));
      for (const id of cache.keys()) if (!present.has(id)) cache.delete(id);
      const capped = busy.slice(0, 500);
      unknownCores = busy.slice(500).reduce((sum, p) => sum + p.cores, 0);
      const unresolved = capped.filter(p => { const entry = cache.get(identity(p)); return !entry || endAt - entry.at >= 300000; });
      let remainder = unresolved.reduce((sum, p) => sum + p.cores, 0);
      const selected: typeof unresolved = [];
      for (const p of unresolved) { if (remainder < 0.5 - 1e-9) break; selected.push(p); remainder -= p.cores; }
      const resolved = new Map<number, string>();
      if (selected.length) {
        const lookupStart = now();
        if (platform === "darwin") {
          lsofCalls++;
          try {
            const result = await exec("lsof", ["-n", "-P", "-b", "-w", "-a", "-d", "cwd", "-Fpn", "-p", selected.map(p => p.pid).join(",")], execOptions);
            for (const [pid, cwd] of parseLsofCwd(result.stdout)) resolved.set(pid, cwd);
          } catch (error) {
            const failure = error as { stdout?: unknown; killed?: boolean; signal?: string | null; code?: string };
            if (failure?.killed || failure?.signal || signal.aborted || failure?.code === "ENOENT" || typeof failure?.stdout !== "string") valid = false;
            else for (const [pid, cwd] of parseLsofCwd(failure.stdout)) resolved.set(pid, cwd);
          }
        } else {
          const deadline = AbortSignal.any([signal, AbortSignal.timeout(3000)]);
          const abort = new Promise<never>((_, reject) => {
            if (deadline.aborted) reject(deadline.reason);
            else deadline.addEventListener("abort", () => reject(deadline.reason), { once: true });
          });
          await Promise.all(selected.map(async p => {
            try { resolved.set(p.pid, await Promise.race([readlink(`/proc/${p.pid}/cwd`), abort])); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") valid = false; }
          }));
        }
        lsofMs = now() - lookupStart;
      }
      for (const p of capped) {
        const id = identity(p), old = cache.get(id), fresh = old && endAt - old.at < 300000;
        const cwd = fresh ? old.cwd : resolved.get(p.pid);
        if (!cwd) { unknownCores += p.cores; continue; }
        if (!fresh) {
          if (old && old.cwd !== cwd) cwdChanged.push({ from: old.cwd, to: cwd });
          cache.set(id, { cwd, at: endAt });
        }
        perPid.push({ cores: p.cores, cwd });
      }
      if (unknownCores >= 0.5 - 1e-9 || signal.aborted) valid = false;
    } catch { previous = undefined; endAt = now(); }
    return { startAt, endAt, valid, perPid, unknownCores, cwdChanged, stats: { psMs, lsofCalls, lsofMs, cacheSize: cache.size } };
  } };
}
