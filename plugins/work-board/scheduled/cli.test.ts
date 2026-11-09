import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore } from "../api";
import plugin from "../server";
import { scheduledRpcContract, type Recurrence } from "../shared/scheduled";
import { buildRule, zonedToIso } from "./cli";
import { createScheduledStore } from "./store";

const THREAD = "thr_worker";

/**
 * Fake host whose plugins.callRpc validates every request/response through the real shared
 * contract and answers from the foundation scheduled store (run/retry/cancel are tiny stubs
 * because the runtime is owned elsewhere). No SDK network is involved.
 */
async function fixture() {
  const calls: { method: string; input: Record<string, unknown> }[] = [];
  const files = new Map<string, string>([["/invoking/desc.md", "# From the invoking host\nCheck the dashboards."]]);
  const reads: string[] = [];
  let scheduled!: ReturnType<typeof createScheduledStore>;
  const now = () => new Date().toISOString();
  const impl: Record<string, (input: any) => unknown> = {
    listSchedules: input => scheduled.list(input),
    getSchedule: input => scheduled.detail(input.scheduleId),
    createSchedule: input => ({ schedule: scheduled.create(input) }),
    updateSchedule: input => ({ schedule: scheduled.update(input) }),
    setScheduleEnabled: input => ({ schedule: scheduled.setEnabled(input.scheduleId, input.enabled) }),
    deleteSchedule: input => ({ deleted: scheduled.remove(input.scheduleId) }),
    previewSchedule: input => ({ dates: scheduled.preview(input.rule, input.after ? new Date(input.after) : undefined, input.count) }),
    // The occurrence key doubles as the idempotency key: the same key returns the existing reservation.
    runSchedule: input => ({ run: scheduled.reserve(input.scheduleId, `manual:${input.idempotencyKey}`, now()).run }),
    retryScheduleRun: input => ({ run: scheduled.updateRun(input.runId, { state: "starting", reason: `retry ${input.idempotencyKey}` }) }),
    cancelScheduleRun: input => ({ run: scheduled.updateRun(input.runId, { state: "canceled", finishedAt: now() }) }),
    resolveScheduleRun: input => ({ run: scheduled.resolve(input.runId, input.note) }),
    listScheduleRuns: input => scheduled.runs(input),
    listScheduleResults: input => scheduled.results(input),
    getTaskSchedule: input => ({ source: scheduled.source(input.taskId) }),
  };
  const host = createFakePluginHost({
    pluginId: "work-board",
    sdk: {
      files: {
        read: async ({ path }: { path: string }) => {
          reads.push(path);
          const content = files.get(path);
          if (content === undefined) throw new Error(`Path does not exist: ${path}`);
          return { path, content, contentEncoding: "utf8" as const, sizeBytes: content.length };
        },
      },
      plugins: {
        callRpc: async (args: { method: string; input: unknown; outputSchema: { parse(value: unknown): unknown } }) => {
          const contract = (scheduledRpcContract as Record<string, { input: { parse(v: unknown): unknown } }>)[args.method];
          expect(contract, `unknown scheduled method ${args.method}`).toBeDefined();
          const input = contract!.input.parse(args.input) as Record<string, unknown>;
          calls.push({ method: args.method, input });
          return args.outputSchema.parse(impl[args.method]!(input));
        },
      },
    } as never,
  });
  await plugin(host.bb);
  const store = createStore(host.bb);
  scheduled = createScheduledStore(host.bb, store);
  const project = store.tasks.createProject({ name: "Ops", prefix: "OPS", color: "blue" });
  const predecessor = store.tasks.createTask({ projectId: project.id, title: "Predecessor" });
  const cli = async (...argv: string[]) => host.harness.runCli(argv);
  const ok = async (...argv: string[]) => {
    const result = await cli(...argv);
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    return result.stdout;
  };
  const json = async (...argv: string[]) => JSON.parse(await ok(...argv, "--json"));
  return { host, store, scheduled, project, predecessor, calls, reads, cli, ok, json };
}

describe("easy recurrence flags", () => {
  it("converts wall-clock time to an explicit offset across DST, gaps and half-hour zones", () => {
    expect(zonedToIso("2026-12-01", "09:00", "Europe/Kyiv")).toBe("2026-12-01T09:00:00+02:00");
    expect(zonedToIso("2026-07-01", "09:00", "Europe/Kyiv")).toBe("2026-07-01T09:00:00+03:00");
    expect(zonedToIso("2026-01-15", "18:30", "America/New_York")).toBe("2026-01-15T18:30:00-05:00");
    expect(zonedToIso("2026-01-15", "08:00", "Asia/Kolkata")).toBe("2026-01-15T08:00:00+05:30");
    expect(() => zonedToIso("2026-03-29", "03:30", "Europe/Kyiv")).toThrow(/does not exist/);
    expect(() => zonedToIso("2026-02-30", "09:00", "UTC")).toThrow(/real calendar date/);
    expect(zonedToIso("2026-10-25", "03:30", "Europe/Kyiv")).toBe("2026-10-25T03:30:00+03:00"); // folded hour: earlier instant
  });

  it("inherits unspecified parts when editing and refuses ambiguous combinations", () => {
    const weekly: Recurrence = { kind: "weekly", time: "09:00", timezone: "UTC", weekdays: [1, 3] };
    const flags = { daily: false, weekly: false, at: undefined, time: undefined, timezone: undefined, days: [], rule: undefined };
    expect(buildRule({ ...flags, time: "10:15" }, weekly)).toEqual({ ...weekly, time: "10:15" });
    expect(buildRule({ ...flags, days: ["fri", "Monday"] }, weekly)).toEqual({ ...weekly, weekdays: [1, 5] });
    expect(buildRule({ ...flags, daily: true }, weekly)).toEqual({ kind: "daily", time: "09:00", timezone: "UTC" });
    expect(() => buildRule({ ...flags, days: ["mon"] }, { kind: "daily", time: "09:00", timezone: "UTC" })).toThrow(/--days only applies/);
    expect(() => buildRule({ ...flags, daily: true, days: ["mon"], time: "09:00", timezone: "UTC" })).toThrow(/--days only applies/);
    expect(() => buildRule({ ...flags, weekly: true, time: "09:00", timezone: "Mars/Base" })).toThrow(/unknown time zone/);
    expect(() => buildRule({ ...flags, weekly: true, time: "9am", timezone: "UTC", days: ["mon"] })).toThrow(/HH:MM/);
    expect(() => buildRule({ ...flags, rule: "{}", time: "09:00" })).toThrow(/do not combine/);
  });
});

describe("bb work-board schedule request validation", () => {
  it("rejects bad combinations before any RPC call and names the valid forms", async () => {
    const f = await fixture();
    try {
      const base = ["schedule", "create", "--project", "OPS", "--title", "Check", "--thread", THREAD];
      const bad: [string[], RegExp][] = [
        [[...base, "--daily", "--timezone", "UTC"], /--daily needs --time HH:MM/],
        [[...base, "--daily"], /--timezone is required/],
        [[...base, "--weekly", "--time", "09:00", "--timezone", "UTC"], /--weekly needs --days/],
        [[...base, "--daily", "--time", "09:00"], /--timezone is required/],
        [[...base, "--daily", "--weekly", "--time", "09:00", "--timezone", "UTC"], /exactly one|only one|--daily/i],
        [[...base, "--at", "2030-01-01", "--timezone", "UTC"], /date-only --at needs --time/],
        [[...base, "--at", "2030-01-01T09:00:00+02:00", "--time", "09:00", "--timezone", "UTC"], /cannot be combined with a full ISO/],
        [["schedule", "create", "--project", "OPS", "--title", "x", "--daily", "--time", "09:00", "--timezone", "UTC"], /--thread|--preset|exactly/i],
        [[...base, "--preset", "p", "--daily", "--time", "09:00", "--timezone", "UTC"], /exactly one|only one|--thread/i],
        [["schedule", "create", "--project", "OPS", "--title", "x", "--thread", "worker", "--daily", "--time", "09:00", "--timezone", "UTC"], /must look like thr_/],
        [["schedule", "create", "--project", "NOPE", "--title", "x", "--thread", THREAD, "--daily", "--time", "09:00", "--timezone", "UTC"], /project not found/],
        [[...base, "--daily", "--time", "09:00", "--timezone", "UTC", "--dependency", "OPS-999"], /task not found/],
        [["schedule", "edit", "00000000-0000-4000-8000-000000000000"], /missing required options: one of --title/],
        [["schedule", "show", "not-a-schedule"], /neither a schedule UUID nor a task key/],
        [["schedule", "retry", "nope"], /not a run UUID/],
        [["schedule", "list", "--limit", "101"], /limit/],
        [["schedule", "list", "--all", "--cursor", "5"], /cannot be combined with --cursor/],
        [["schedule", "delete", "00000000-0000-4000-8000-000000000000"], /--yes/],
        [["schedule", "resolve", "00000000-0000-4000-8000-000000000000"], /note/],
        [["schedule", "run-now", "00000000-0000-4000-8000-000000000000", "--idempotency-key", "k".repeat(129)], /128|too_big|Too big/i],
      ];
      for (const [argv, message] of bad) {
        const result = await f.cli(...argv);
        expect(result.exitCode, argv.join(" ")).not.toBe(0);
        expect(result.stderr, argv.join(" ")).toMatch(message);
      }
      expect((await f.cli(...base, "--daily", "--timezone", "UTC")).stderr).toContain("valid recurrence forms");
      expect(f.calls.filter(call => !["getTaskSchedule"].includes(call.method)).map(call => call.method)).not.toContain("createSchedule");
    } finally {
      await f.host.harness.dispose();
    }
  });
});

describe("bb work-board schedule management flow", () => {
  it("creates, reads, edits, pauses, runs, resolves, pages and deletes through the shared contract", async () => {
    const f = await fixture();
    try {
      // create: easy flags, dependency by KEY, description from the INVOKING host (never a server path read)
      const created = await f.json(
        "schedule", "create", "--project", "ops", "--title", "Morning check", "--weekly", "--days", "mon,wed", "--time", "09:00",
        "--timezone", "Europe/Kyiv", "--thread", THREAD, "--dependency", "OPS-1", "--priority", "high", "--description-file", "/invoking/desc.md",
      );
      expect(f.reads).toEqual(["/invoking/desc.md"]);
      expect(created.schedule).toMatchObject({ title: "Morning check", enabled: true, target: { kind: "thread", threadId: THREAD }, rule: { kind: "weekly", weekdays: [1, 3], time: "09:00", timezone: "Europe/Kyiv" } });
      const id: string = created.schedule.id;
      expect(f.calls.find(call => call.method === "createSchedule")!.input).toMatchObject({ dependencyIds: [f.predecessor.id], description: expect.stringContaining("invoking host"), priority: "high" });

      // show: template key/id for ordinary tooling, addressable by schedule id AND by the template task key
      const shown = await f.json("schedule", "show", id);
      expect(shown.task.key).toMatch(/^OPS-\d+$/);
      expect(await f.json("schedule", "show", shown.task.key)).toMatchObject({ schedule: { id } });
      const human = await f.ok("schedule", "show", id);
      expect(human).toContain(`Template task  ${shown.task.key}`);
      expect(human).toContain("weekly mon,wed 09:00 Europe/Kyiv");
      expect(human).toContain("OPS-1");
      expect(await f.ok("schedule", "list")).toMatch(new RegExp(`${id}\\s+OPS\\s+enabled\\s+Morning check\\s+weekly mon,wed 09:00 Europe/Kyiv\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d Europe/Kyiv\\s+thread ${THREAD}`));
      expect((await f.json("schedule", "list", "--search", "nothing-matches")).schedules).toEqual([]);

      // edit: only the time (weekdays inherited), rename, clear deps; reschedule via days
      await f.ok("schedule", "edit", id, "--time", "10:30", "--title", "Morning check v2", "--clear-dependencies");
      expect((await f.json("schedule", "show", id)).schedule.rule).toMatchObject({ weekdays: [1, 3], time: "10:30" });
      expect((await f.json("schedule", "show", id)).dependencyIds).toEqual([]);
      await f.ok("schedule", "reschedule", id, "--days", "fri");
      expect((await f.json("schedule", "show", id)).schedule.rule).toMatchObject({ weekdays: [5], time: "10:30", timezone: "Europe/Kyiv" });

      // pause / resume; an unassigned (imported) target cannot be enabled until one is chosen
      expect((await f.json("schedule", "pause", id)).schedule.enabled).toBe(false);
      const resumed = await f.ok("schedule", "resume", id);
      expect(resumed).toContain("Resumed schedule");
      f.scheduled.update({ scheduleId: id, enabled: false, target: { kind: "unassigned" } });
      const refused = await f.cli("schedule", "resume", id);
      expect(refused).toMatchObject({ exitCode: 1 });
      expect(refused.stderr).toMatch(/no target yet.*--thread thr_ID or --preset/s);
      await f.ok("schedule", "edit", id, "--thread", THREAD);
      expect((await f.json("schedule", "enable", id)).schedule).toMatchObject({ enabled: true, target: { kind: "thread" } });

      // preview mirrors the server computation
      expect((await f.json("schedule", "preview", "--at", "2099-05-01", "--time", "08:00", "--timezone", "Asia/Kolkata")).rule).toEqual({ kind: "once", at: "2099-05-01T08:00:00+05:30", timezone: "Asia/Kolkata" });

      // run-now: the same key never creates a second run; omitted key is generated and printed
      const first = await f.json("schedule", "run-now", id, "--idempotency-key", "k-1");
      const again = await f.json("schedule", "run-now", id, "--idempotency-key", "k-1");
      expect(again.run.id).toBe(first.run.id);
      expect(first.idempotencyKey).toBe("k-1");
      expect(await f.ok("schedule", "run-now", id)).toMatch(/idempotency key: cli-[0-9a-f-]{36}/);

      // runs: failed -> needs-attention -> retry / resolve / dismiss / cancel-queued
      const failedRun = f.scheduled.updateRun(first.run.id, { state: "failed", reason: "Target thread archived", finishedAt: new Date().toISOString() });
      expect(await f.ok("schedule", "needs-attention")).toContain("Target thread archived");
      expect((await f.json("schedule", "needs-attention", "--schedule", id)).runs.map((run: { id: string }) => run.id)).toContain(failedRun.id);
      expect((await f.json("schedule", "retry", failedRun.id, "--idempotency-key", "r-1")).run.reason).toBe("retry r-1");
      f.scheduled.updateRun(failedRun.id, { state: "failed", finishedAt: new Date().toISOString() });
      expect((await f.json("schedule", "resolve", failedRun.id, "--note", "Fixed by hand")).run.resolvedAt).not.toBeNull();
      const second = f.scheduled.reserve(id, "manual:other", new Date().toISOString()).run;
      f.scheduled.updateRun(second.id, { state: "failed", finishedAt: new Date().toISOString() });
      expect(await f.ok("schedule", "dismiss", second.id)).toContain("Dismissed run");
      expect(f.calls.filter(call => call.method === "resolveScheduleRun").at(-1)!.input.note).toContain("Dismissed from the CLI");
      const queued = f.scheduled.reserve(id, "manual:queued", new Date().toISOString()).run;
      f.scheduled.updateRun(queued.id, { state: "queued" });
      expect((await f.json("schedule", "cancel-queued", queued.id)).run.state).toBe("canceled");

      // pagination: single page keeps a cursor, --all follows every page
      const page = await f.json("schedule", "runs", "--schedule", id, "--limit", "1");
      expect(page.runs).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      expect(await f.ok("schedule", "runs", "--schedule", id, "--limit", "1")).toContain(`--cursor ${page.nextCursor}`);
      const all = await f.json("schedule", "runs", "--schedule", id, "--limit", "1", "--all");
      expect(all.runs.length).toBeGreaterThan(2);
      expect(all.nextCursor).toBeNull();

      // results: hidden by default in the ordinary list, visible through --include-scheduled and results
      const resultTask = f.scheduled.createRunTask(first.run.id);
      expect((await f.json("schedule", "results", "--schedule", id)).results).toEqual([expect.objectContaining({ task: expect.objectContaining({ key: resultTask.key }) })]);
      expect(await f.ok("schedule", "results")).toContain(resultTask.key);
      const ordinary = (await f.json("list", "--project", "OPS")).tasks.map((task: { key: string }) => task.key);
      expect(ordinary).not.toContain(resultTask.key);
      expect((await f.json("list", "--project", "OPS", "--include-scheduled")).tasks.map((task: { key: string }) => task.key)).toContain(resultTask.key);
      expect(await f.json("schedule", "show", resultTask.key)).toMatchObject({ schedule: { id } }); // a result task addresses its schedule

      // delete is guarded, then really removes the schedule while the result task stays reachable
      expect(await f.ok("schedule", "delete", id, "--yes")).toContain(`Deleted schedule ${id}`);
      expect((await f.json("schedule", "list")).schedules).toEqual([]);
      expect((await f.json("schedule", "results")).results).toHaveLength(1);
      const gone = await f.cli("schedule", "show", id);
      expect(gone.exitCode).not.toBe(0);
    } finally {
      await f.host.harness.dispose();
    }
  });

  it("resolves a preset target by name and records it by id", async () => {
    const f = await fixture();
    try {
      const preset = f.store.tasks.createPreset({ name: "Nightly", providerId: "codex", modelId: "gpt-5", reasoningLevel: "high", serviceTier: null, permissionMode: "full", environmentKind: "project-default", baseBranch: null, machineId: null, instructions: "", builtin: false });
      const created = await f.json("schedule", "create", "--project", "OPS", "--title", "Preset run", "--daily", "--time", "02:00", "--tz", "UTC", "--preset", "nightly", "--paused");
      expect(created.schedule).toMatchObject({ enabled: false, target: { kind: "preset", presetId: preset.id } });
      expect(await f.ok("schedule", "show", created.schedule.id)).toContain("new session, current preset at each run");
    } finally {
      await f.host.harness.dispose();
    }
  });
});
