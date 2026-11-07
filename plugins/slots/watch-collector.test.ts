import { describe, expect, it } from "vitest";
import { cpuDeltas, createCollector, parseLsofCwd, parsePs } from "./watch-collector.js";

const start = "Mon Jan  1 00:00:00 2024";
const row = (pid: number, time: string, when = start) => `${pid} ${when} ${time}\n`;
const at = Date.parse(start);
const signal = () => new AbortController().signal;

describe("collector parsers", () => {
  it("parses macOS and Linux CPU formats and lsof records", () => {
    expect(parsePs(row(1, "02:03.25") + row(2, "01:02:03") + row(3, "2-03:04:05" )).map(p => p.cpu)).toEqual([123.25, 3723, 183845]);
    expect([...parseLsofCwd("p1\nn/a path\np2\nn/tmp\n")]).toEqual([[1, "/a path"], [2, "/tmp"]]);
    expect(() => parsePs("bad line")).toThrow();
  });
  it("handles pid reuse and only counts new processes born since the snapshot", () => {
    const p = parsePs(row(1, "00:10") + row(2, "00:20"));
    const reused = parsePs(row(1, "00:30", "Mon Jan  1 00:00:02 2024") + row(2, "00:01", "Mon Jan  1 00:00:02 2024"));
    expect(cpuDeltas({ at: at + 1000, processes: p }, { at: at + 3000, processes: reused }).map(x => x.cores)).toEqual([15, 0.5]);
    expect(cpuDeltas({ at: at + 3000, processes: [] }, { at: at + 4000, processes: reused })).toEqual([]);
  });
});

describe("collector", () => {
  it.each(["darwin", "linux"] as const)("limits ps to the configured uid on %s", async platform => {
    let args: string[] = [];
    const collector = createCollector({ platform, uid: 1234, exec: async (_file, argv) => { args = argv; return { stdout: "" }; } });
    await collector.sample(signal());
    expect(args).toEqual(["-U", "1234", "-o", "pid=,lstart=,time="]);
  });
  it.each(["darwin", "linux"] as const)("resolves every uncached pid at 0.25 core on %s", async platform => {
    let clock = at + 1000, running = false;
    const batches: string[] = [];
    const collector = createCollector({ platform, now: () => clock, exec: async (file, args) => {
      if (file === "ps") return { stdout: row(1, running ? "00:00.20" : "00:00") + row(2, running ? "00:00.05" : "00:00") };
      batches.push(args.at(-1)!); return { stdout: "p1\nn/one\np2\nn/two\n" };
    }, readlink: async path => { batches.push(path); return path; } });
    await collector.sample(signal()); clock += 1000; running = true;
    const result = await collector.sample(signal());
    expect(result.valid).toBe(true);
    expect(result.perPid).toHaveLength(2);
    expect(result.unknownCores).toBe(0);
    expect(batches).toEqual(platform === "darwin" ? ["1,2"] : ["/proc/1/cwd", "/proc/2/cwd"]);
    expect(result.stats.lsofCalls).toBe(platform === "darwin" ? 1 : 0);
  });
  it("caches busy identities, refreshes stale cwd, and reports changes", async () => {
    let clock = at + 1000, cpu = 0, cwd = "/old", calls = 0;
    const collector = createCollector({ platform: "darwin", now: () => clock, exec: async (file) => {
      if (file === "ps") return { stdout: row(1, `00:${String(cpu).padStart(2, "0")}`) };
      calls++; return { stdout: `p1\nn${cwd}\n` };
    } });
    expect((await collector.sample(signal())).valid).toBe(false);
    clock += 1000; cpu = 1;
    expect((await collector.sample(signal())).perPid).toEqual([{ cores: 1, cwd: "/old" }]);
    clock += 1000; cpu = 2;
    expect((await collector.sample(signal())).stats.lsofCalls).toBe(0);
    clock += 300000; cwd = "/new"; await collector.sample(signal());
    clock += 1000; cpu = 3;
    const result = await collector.sample(signal());
    expect(result.cwdChanged).toEqual([{ from: "/old", to: "/new" }]);
    expect(calls).toBe(2);
  });
  it("leaves small unresolved load unknown and invalidates missing or failed lookups at the threshold", async () => {
    let clock = at + 1000, cpu = "00:00", fail = false, lsof = 0;
    const collector = createCollector({ platform: "darwin", now: () => clock, exec: async file => {
      if (file === "ps") return { stdout: row(1, cpu) };
      lsof++; if (fail) throw new Error("permission"); return { stdout: "" };
    } });
    await collector.sample(signal()); clock += 1000; cpu = "00:00.20";
    expect(await collector.sample(signal())).toMatchObject({ valid: true, unknownCores: 0.2, stats: { lsofCalls: 0 } });
    clock += 1000; cpu = "00:01.20";
    const missing = await collector.sample(signal());
    expect(missing.valid).toBe(false);
    expect(missing.unknownCores).toBeCloseTo(1);
    fail = true; clock += 1000; cpu = "00:02.20";
    expect((await collector.sample(signal())).valid).toBe(false);
    expect(lsof).toBe(2);
  });
  it.each([
    { name: "partial output", error: { code: 1, stdout: "p1\nn/work\n" }, valid: true, known: 1, unknown: 0.4 },
    { name: "timeout", error: { killed: true, stdout: "p1\nn/work\n" }, valid: false, known: 0, unknown: 1.4 },
    { name: "empty output", error: { code: 1, stdout: "" }, valid: false, known: 0, unknown: 1.4 },
  ])("handles lsof exit with $name", async ({ error, valid, known, unknown }) => {
    let clock = at + 1000, running = false;
    const collector = createCollector({ platform: "darwin", now: () => clock, exec: async file => {
      if (file === "ps") return { stdout: row(1, running ? "00:01" : "00:00") + row(2, running ? "00:00.40" : "00:00") };
      throw error;
    } });
    await collector.sample(signal()); clock += 1000; running = true;
    const result = await collector.sample(signal());
    expect(result.valid).toBe(valid);
    expect(result.perPid).toHaveLength(known);
    expect(result.unknownCores).toBeCloseTo(unknown);
  });
  it("invalidates the 500-process cap and bounds lookup size", async () => {
    let clock = at + 1000, cpu = "00:00", count = 0;
    const collector = createCollector({ platform: "darwin", now: () => clock, exec: async (file, args) => {
      if (file === "ps") return { stdout: Array.from({ length: 501 }, (_, i) => row(i + 1, cpu)).join("") };
      count = args.at(-1)!.split(",").length; return { stdout: "" };
    } });
    await collector.sample(signal()); clock += 1000; cpu = "00:01";
    expect((await collector.sample(signal())).valid).toBe(false);
    expect(count).toBe(500);
  });
  it("treats vanished Linux processes as unknown and permission failures as invalid", async () => {
    let clock = at + 1000, cpu = "00:00", code = "ENOENT";
    const collector = createCollector({ platform: "linux", now: () => clock, exec: async () => ({ stdout: row(1, cpu) }), readlink: async () => { throw Object.assign(new Error(), { code }); } });
    await collector.sample(signal()); clock += 1000; cpu = "00:01";
    expect(await collector.sample(signal())).toMatchObject({ valid: false, unknownCores: 1 });
    code = "EACCES"; clock += 1000; cpu = "00:02";
    expect((await collector.sample(signal())).valid).toBe(false);
  });
});
