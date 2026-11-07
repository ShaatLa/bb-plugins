import { it, expect } from "vitest";
import { createFakePluginHost, makeThreadResponse, makeHostResponse } from "@get-bb/plugin-sdk/testing";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { register } from "./server.js";
import { DiskStore } from "./runtime.js";
import { createCollector } from "./watch-collector.js";
import type { StatusView } from "./contract.js";

// Opt-in hardware measurement: SLOTS_MEASURE_REPORT=/absolute/report.json npm test -- watcher.measure.test.ts
it.skipIf(!process.env.SLOTS_MEASURE_REPORT)("measures the integrated watcher for five minutes without installing it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "slots-watch-measure-"));
  const path = process.cwd(), thread = makeThreadResponse({ id: "measurement", environmentId: "env" });
  let childCpuSeconds = 0, childCalls = 0;
  const collector = createCollector({ exec: async (file, args, options) => {
    childCalls++;
    const countCpu = (stderr: string) => { for (const match of stderr.matchAll(/^(?:user|sys)\s+([\d.]+)/gm)) childCpuSeconds += Number(match[1]); };
    const result = await promisify(execFile)("/usr/bin/time", ["-p", file, ...args], options).catch(error => { countCpu(error.stderr ?? ""); throw error; });
    countCpu(result.stderr);
    return { stdout: result.stdout };
  } });
  const host = createFakePluginHost({ pluginId: "slots", agentSkillIds: ["slots"], sdk: {
    hosts: { get: async () => ({ ...makeHostResponse({ id: "local", name: "Measurement host" }), connectMachineId: null, threadStorageRootPath: null }) },
    system: { config: async () => ({ primaryHostId: "local" }) },
    threads: { list: async () => [thread], get: async () => thread, send: async () => { throw new Error("Measurement must not send messages"); } },
    environments: { get: async () => ({ hostId: "local", path }) },
  } });
  try {
    const { invoke } = await register(host.bb, { store: new DiskStore(dir), watchCollector: collector });
    expect((await invoke("status", {})).ok).toBe(true);
    const start = Date.now();
    const service = host.harness.behavior.runService("watcher");
    await sleep(300500);
    service.controller.abort(); await service.done;
    const status = await invoke("status", {}); expect(status.ok).toBe(true);
    if (!status.ok) throw new Error(status.error.message);
    const diagnostics = (status.data as StatusView).watcher!;
    const elapsedMs = Date.now() - start;
    const cpuMs = diagnostics.average10m.cpuMs * diagnostics.average10m.runs;
    const report = { elapsedMs, childCalls, childCpuSeconds, inProcessCpuMs: cpuMs, inProcessCorePercent: cpuMs / elapsedMs * 100, totalCorePercent: (cpuMs + childCpuSeconds * 1000) / elapsedMs * 100, diagnostics, warnings: host.harness.logEntries };
    await writeFile(process.env.SLOTS_MEASURE_REPORT!, JSON.stringify(report, null, 2) + "\n");
    expect(diagnostics.average10m.runs).toBeGreaterThanOrEqual(10);
    expect(childCalls).toBeGreaterThanOrEqual(10);
  } finally { await host.harness.lifecycle.dispose(); await rm(dir, { recursive: true, force: true }); }
}, 330000);
