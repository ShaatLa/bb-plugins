import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, mkdir, writeFile, rename, appendFile, readdir, unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { loadavg, platform } from "node:os";
import { createServer } from "node:net";
import type { AuditEvent, State } from "./contract.js";

export function parseMemoryPressure(text: string): number {
  const match = text.match(/System-wide memory free percentage:\s*(\d+(?:\.\d+)?)%/);
  if (!match || +match[1] > 100) throw new Error("Missing memory_pressure reading");
  return +match[1];
}
export function parseMeminfo(text: string): number {
  const total = text.match(/^MemTotal:\s*(\d+) kB$/m);
  const available = text.match(/^MemAvailable:\s*(\d+) kB$/m);
  if (!total || !available || +total[1] <= 0 || +available[1] > +total[1]) throw new Error("Invalid meminfo");
  return +available[1] / +total[1] * 100;
}
export async function metrics(): Promise<{ memFreePct: number; load1: number }> {
  let memFreePct: number;
  if (platform() === "darwin") {
    const { stdout } = await promisify(execFile)("/usr/bin/memory_pressure", [], { timeout: 2000, maxBuffer: 65536 });
    memFreePct = parseMemoryPressure(stdout);
  } else if (platform() === "linux") memFreePct = parseMeminfo(await readFile("/proc/meminfo", "utf8"));
  else throw new Error("Unsupported metrics platform");
  return { memFreePct, load1: loadavg()[0] };
}
export async function probePort(port: number): Promise<boolean> {
  const servers: ReturnType<typeof createServer>[] = [];
  try {
    for (const host of ["127.0.0.1", "::1"]) {
      const server = createServer(); servers.push(server);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen({ host, port, ipv6Only: true, exclusive: true }, resolve);
        });
      } catch (error) {
        if (host === "::1" && ["EAFNOSUPPORT", "EADDRNOTAVAIL"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
        return false;
      }
    }
    return true;
  } finally {
    await Promise.all(servers.filter(s => s.listening).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  }
}
export function parseSince(value: string, now: number): number {
  const duration = value.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/);
  const at = duration ? now - +duration[1] * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[duration[2]]!) :
    /^\d{4}-\d\d-\d\dT/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(at) || at < 0) throw new Error("since must be a duration (2h) or ISO timestamp");
  return at;
}
export class DiskStore {
  constructor(readonly dir: string) {}
  async load(): Promise<unknown | undefined> {
    try { return JSON.parse(await readFile(join(this.dir, "state.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async save(state: State) {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, "state.json.tmp"), JSON.stringify(state), { mode: 0o600 });
    await rename(join(this.dir, "state.json.tmp"), join(this.dir, "state.json"));
  }
  async audit(event: AuditEvent) {
    await mkdir(this.dir, { recursive: true });
    await appendFile(join(this.dir, `${new Date(event.at).toISOString().slice(0, 10)}.jsonl`), JSON.stringify(event) + "\n", { mode: 0o600 });
  }
  async prune(now: number): Promise<string[]> {
    await mkdir(this.dir, { recursive: true });
    const files: string[] = [];
    for (const name of (await readdir(this.dir)).filter(n => /^\d{4}-\d\d-\d\d\.jsonl$/.test(n)).sort()) {
      if (Date.parse(name.slice(0, 10)) + 86400000 < now - 14 * 86400000) await unlink(join(this.dir, name));
      else files.push(name);
    }
    return files;
  }
  async logs(since: number, limit: number, now: number, hostId?: string): Promise<AuditEvent[]> {
    const result: AuditEvent[] = [];
    for (const name of await this.prune(now)) {
      const lines = createInterface({ input: createReadStream(join(this.dir, name)), crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line) as AuditEvent;
        if (event.at >= since && (!hostId || event.hostId === hostId)) {
          result.push(event); if (result.length > limit) result.shift();
        }
      }
    }
    return result;
  }
}
