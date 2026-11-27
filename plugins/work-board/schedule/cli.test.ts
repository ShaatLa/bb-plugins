import { afterEach, describe, expect, it, vi } from "vitest";
import { fixture, fixtures, rpcError } from "./fixture";

afterEach(async () => { delete process.env.BB_THREAD_ID; vi.useRealTimers(); await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("schedule commands", () => {
  it("schedules with --gate and the builder args after --, shows, changes, cancels and logs", async () => {
    const f = fixture();
    const set = await f.run(["schedule", f.task.key, "--at", "+3h", "--gate", "--", "--card", f.task.key, "--role", "check"]);
    expect(set.exitCode).toBe(0);
    expect(set.stdout).toContain("Spawn Gate `--card");
    expect(set.stdout).toContain("Nothing is sent to the session before it starts");
    expect(f.world.starts[0]!.args).toEqual(["--card", f.task.key, "--role", "check"]);
    expect((await f.run(["schedule", "show", f.task.key])).stdout).toContain("Scheduled for");
    expect((await f.run(["schedule", f.task.key, "--at", "+4h", "--gate"])).exitCode).not.toBe(0);
    expect((await f.run(["schedule", "change", f.task.key, "--at", "+5h"])).exitCode).toBe(0);
    expect((await f.run(["schedule", "change", f.task.key])).exitCode).not.toBe(0);
    expect((await f.run(["schedule", "cancel", f.task.key, "--reason", "not tonight"])).exitCode).toBe(0);
    const log = JSON.parse((await f.run(["schedule", "log", f.task.key, "--json"])).stdout);
    expect(log.events.map((event: { event: string }) => event.event)).toEqual(["scheduled", "changed", "canceled"]);
    expect((await f.run(["schedule", "log", "--project", f.tracker.prefix])).stdout).toContain("canceled");
  });

  it("needs one launch, takes a preset with a brief file, and refuses a stranger", async () => {
    const f = fixture();
    expect((await f.run(["schedule", f.task.key, "--at", "+3h"])).exitCode).not.toBe(0);
    expect((await f.run(["schedule", f.task.key, "--at", "+3h", "--gate", "--preset", "Night worker"])).exitCode).not.toBe(0);
    f.world.installed = false;
    const set = await f.run(["schedule", f.task.key, "--at", "+3h", "--preset", "night worker", "--json"]);
    expect(set.exitCode).toBe(0);
    expect(JSON.parse(set.stdout).scheduledStart).toMatchObject({ mode: "preset", presetName: "Night worker" });
    const refused = await f.run(["schedule", "cancel", f.task.key], { BB_THREAD_ID: "thr_stranger" });
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain("Only the setter");
  });

  it("resolves an unknown start from the command line", async () => {
    const f = fixture();
    await f.schedule("+10m");
    f.world.start = async (input) => { if (input.dryRun) return { dryRun: true }; throw rpcError("transport_error", "lost"); };
    f.due(); await f.sweep();
    expect(f.row().state).toBe("unknown");
    expect((await f.run(["schedule", "resolve", f.task.key])).exitCode).not.toBe(0);
    const done = await f.run(["schedule", "resolve", f.task.key, "--launched", "thr_found"]);
    expect(done.exitCode).toBe(0);
    expect(done.stdout).toContain("Launched thr_found");
  });
});

describe("create --start-at", () => {
  it("creates the card and schedules it in one call; show prints the schedule", async () => {
    const f = fixture();
    const made = await f.run(["create", "--project", f.tracker.prefix, "--title", "Night job", "--start-at", "+2h", "--start-gate", "--json", "--", "--card", "{key}", "--role", "impl"]);
    expect(made.exitCode).toBe(0);
    const { task, scheduledStart } = JSON.parse(made.stdout);
    expect(scheduledStart).toMatchObject({ state: "scheduled", builderArgs: ["--card", task.key, "--role", "impl"] });
    const shown = JSON.parse((await f.run(["show", task.key, "--json"])).stdout);
    expect(shown.scheduledStart).toMatchObject({ state: "scheduled", mode: "spawn_gate" });
    expect((await f.run(["show", task.key])).stdout).toContain("Scheduled start");
  });

  it("keeps the card and exits nonzero with the error when the schedule is refused", async () => {
    const f = fixture();
    f.world.start = async () => { throw rpcError("handler_error", 'builder exited 1: {"reasonCode":"no_scope"}'); };
    const made = await f.run(["create", "--project", f.tracker.prefix, "--title", "Refused schedule", "--start-at", "+2h", "--start-gate"]);
    expect(made.exitCode).not.toBe(0);
    expect(made.stdout).toContain("Created ");
    expect(made.stderr).toContain("no_scope");
    expect(f.rows()).toHaveLength(0);
    expect((await f.run(["list", "--json"])).stdout).toContain("Refused schedule");
  });

  it("refuses start options without --start-at", async () => {
    const f = fixture();
    expect((await f.run(["create", "--project", f.tracker.prefix, "--title", "x", "--start-gate"])).exitCode).not.toBe(0);
  });
});

describe("config set scheduledStartArgs", () => {
  const stored = async (f: ReturnType<typeof fixture>) => (await f.call("config.get", { projectId: f.tracker.id, key: "scheduledStartArgs" })).values.scheduledStartArgs;

  it("takes a value that starts with -- after `--`, quoted arguments kept whole", async () => {
    const f = fixture();
    const set = await f.run(["config", "set", "scheduledStartArgs", "--project", f.tracker.prefix, "--", "--card", "{key}", "--role", "impl", "--reason", "night run"]);
    expect(set.exitCode).toBe(0);
    expect(await stored(f)).toBe("--card {key} --role impl --reason 'night run'");
    expect((await f.run(["config", "get", "scheduledStartArgs", "--project", f.tracker.prefix, "--json"])).stdout).toContain("--role impl");
    // The stored text is what a bare --gate schedule launches with.
    await f.schedule("+10m", { kind: "gate" });
    expect(f.world.starts.at(-1)!.args).toEqual(["--card", f.task.key, "--role", "impl", "--reason", "night run"]);
  });

  it("still takes the value as a JSON string or plain text, and refuses the ambiguous forms", async () => {
    const f = fixture();
    expect((await f.run(["config", "set", "scheduledStartArgs", JSON.stringify("--card {key} --role check"), "--project", f.tracker.prefix])).exitCode).toBe(0);
    expect(await stored(f)).toBe("--card {key} --role check");
    expect((await f.run(["config", "set", "scheduledStartArgs", "plain {key}", "--project", f.tracker.prefix])).exitCode).toBe(0);
    expect(await stored(f)).toBe("plain {key}");
    expect((await f.run(["config", "set", "scheduledStartArgs", "x", "--project", f.tracker.prefix, "--", "--card"])).exitCode).not.toBe(0);
    expect((await f.run(["config", "set", "autoArchiveAfterDays", "--project", f.tracker.prefix, "--", "7"])).stderr).toContain("scheduledStartArgs only");
    expect((await f.run(["config", "set", "scheduledStartArgs", "--project", f.tracker.prefix])).stderr).toContain("missing the value");
    expect(await stored(f)).toBe("plain {key}");
  });

  it("explains both forms in the help", async () => {
    const f = fixture();
    const help = await f.run(["config", "set", "--help"]);
    expect(help.stdout).toContain("config set scheduledStartArgs --project EXA -- --card {key} --role impl");
    expect(help.stdout).toContain("JSON string");
  });
});
