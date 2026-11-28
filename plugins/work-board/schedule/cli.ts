import { cliCommand, type PluginCliContext, type PluginCliResult, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { ScheduledStartInfo, tasksRpcContract } from "../shared/contract";
import { describeAgent } from "./store";
import { formatStartTime } from "./when";

type Domain = Pick<PluginRpcHandlers<typeof tasksRpcContract>, "scheduleStart" | "changeScheduledStart" | "cancelScheduledStart" | "resolveScheduledStart" | "getScheduledStart" | "listScheduledStartLog">;

/** Helpers owned by cli/index.ts (addressing, error mapping, files), injected so this module never imports the big CLI file. */
export interface ScheduleCliHost {
  domain: Domain;
  guard(action: () => Promise<string | PluginCliResult>): Promise<PluginCliResult>;
  task(address: string): Promise<{ id: string; key: string; projectId: string }>;
  project(address: string): Promise<{ id: string; prefix: string }>;
  preset(address: string): Promise<{ id: string; name: string }>;
  readText(ctx: PluginCliContext, file: string): Promise<string>;
  fail(message: string): Error;
}

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const PROJECT_OPTION = { type: "string", placeholder: "prefix-or-id", description: "Tracker project prefix or id such as ABC, never a bb project id (proj_...)" } as const;
const KEY = { name: "key-or-id", description: "Task key such as ABC-12 or its ULID", required: true } as const;
const AT_TEXT = "When to start: an ISO time with an offset (2026-11-29T02:00:00+03:00, or Z) or a relative +30m, +2h, +1d; at least 2 minutes ahead";
const AT_REQUIRED = { type: "string", placeholder: "time", required: true, description: AT_TEXT } as const;
const AT_OPTIONAL = { type: "string", placeholder: "time", description: AT_TEXT } as const;
const GATE = { type: "boolean", description: "Launch through the project's Spawn Gate builder. Builder arguments go after `--` (default: the project's scheduledStartArgs, else `--card KEY --role impl`)" } as const;
const PRESET = { type: "string", placeholder: "name-or-id", description: "Launch from this agent preset (for a project without Spawn Gate's Script mode)" } as const;
const AGENT = { type: "string", placeholder: "provider/model", description: "Launch this provider and model itself in the project's default environment (for a project without Spawn Gate's Script mode), e.g. codex/gpt-5; the model must be one the provider lists" } as const;
const REASONING = { type: "string", placeholder: "level", description: "With --agent: the reasoning level (default: the model's own)" } as const;
const PERMISSION = { type: "string", placeholder: "mode", description: "With --agent: accept-edits, auto or full (default auto)" } as const;
const BRIEF_FILE = { type: "string", placeholder: "path", description: "Preset or agent launch only: extra brief text for the session, read from this UTF-8 file" } as const;
export const actorOf = (ctx: PluginCliContext) => ctx.threadId ?? process.env.BB_THREAD_ID ?? "owner";

/** What a schedule says about itself: nothing is sent to the session before it exists. */
export const SCHEDULE_NOTE = "Nothing is sent to the session before it starts: it does not exist until the time comes.";

export const describeStart = (start: ScheduledStartInfo) =>
  `${formatStartTime(start.at)}, ${start.mode === "spawn_gate" ? `Spawn Gate \`${(start.builderArgs ?? []).join(" ")}\`` : start.agent ? describeAgent(start.agent) : `preset ${start.presetName ?? start.presetId}`}`;

function stateLine(start: ScheduledStartInfo): string {
  switch (start.state) {
    case "scheduled": return `Scheduled for ${describeStart(start)}, set by ${start.setter}`;
    case "launching": return `Launching now (${describeStart(start)})`;
    case "launched": return `Launched ${start.threadId} (scheduled ${formatStartTime(start.at)})`;
    case "refused": return `Start refused at ${formatStartTime(start.at)}${start.reasonCode ? ` (${start.reasonCode})` : ""}: ${start.error}`;
    case "unknown": return `Start outcome unknown (${formatStartTime(start.at)}): ${start.error}`;
    case "canceled": return "Canceled";
  }
}
export const startSummary = (key: string, start: ScheduledStartInfo) => `${key}: ${stateLine(start)}`;

/** `--gate`, `--preset` or `--agent provider/model` (and the text after `--` for a gate) as the RPC's launch; exactly one of the three. */
export async function launchFromOptions(host: ScheduleCliHost, ctx: PluginCliContext, options: { gate?: boolean | undefined; preset?: string | undefined; agent?: string | undefined; reasoning?: string | undefined; permission?: string | undefined; briefFile?: string | undefined }, passthrough: readonly string[], required: boolean) {
  if ([options.gate, options.preset, options.agent].filter(Boolean).length > 1) throw host.fail("choose one launch: --gate, --preset or --agent");
  if (!options.gate && !options.preset && !options.agent) {
    if (required) throw host.fail("choose how it starts: --gate (Spawn Gate's builder), --agent <provider>/<model> or --preset <name>");
    return undefined;
  }
  if ((options.reasoning || options.permission) && !options.agent) throw host.fail("--reasoning and --permission apply to an --agent launch");
  if (options.gate) {
    if (options.briefFile) throw host.fail("--brief-file applies to a --preset or --agent launch; a Spawn Gate builder writes its own brief");
    return { kind: "gate" as const, ...(passthrough.length ? { args: [...passthrough] } : {}) };
  }
  if (passthrough.length) throw host.fail("arguments after `--` apply to a --gate launch");
  const brief = options.briefFile ? await host.readText(ctx, options.briefFile) : undefined;
  if (options.agent) {
    const slash = options.agent.indexOf("/");
    if (slash < 1 || slash === options.agent.length - 1) throw host.fail("--agent takes provider/model, for example codex/gpt-5");
    const permission = options.permission;
    if (permission && !["accept-edits", "auto", "full"].includes(permission)) throw host.fail("--permission is accept-edits, auto or full");
    return { kind: "agent" as const, providerId: options.agent.slice(0, slash), model: options.agent.slice(slash + 1), ...(options.reasoning ? { reasoningLevel: options.reasoning } : {}), ...(permission ? { permissionMode: permission as "accept-edits" | "auto" | "full" } : {}), ...(brief?.trim() ? { brief } : {}) };
  }
  const preset = await host.preset(options.preset!);
  return { kind: "preset" as const, presetId: preset.id, ...(brief?.trim() ? { brief } : {}) };
}

export function scheduleCliCommands(host: ScheduleCliHost) {
  const { domain, guard } = host;
  const out = (json: boolean | undefined, key: string, start: ScheduledStartInfo, verb: string) => (json ? JSON.stringify({ key, scheduledStart: start }) : `${verb} ${key} for ${describeStart(start)}. ${SCHEDULE_NOTE}`);
  return {
    schedule: cliCommand({
      summary: "Schedule a card's start: at that time Work Board launches its session itself",
      description: [
        "Use it for night runs or when capacity is short. At the time Work Board starts the session through the project's Spawn Gate builder (--gate), or itself with a provider and model (--agent) or an agent preset (--preset), so the admission, the pace check and the provider rules still apply.",
        SCHEDULE_NOTE,
        "A refused or failed launch is written on the card and the setter (else its nearest live parent, else the manager) is told. Subcommands:",
        "  bb work-board schedule show KEY                  Show the card's scheduled start",
        "  bb work-board schedule change KEY [--at …] [launch options]",
        "  bb work-board schedule cancel KEY [--reason …]",
        "  bb work-board schedule resolve KEY --launched thr_… | --not-launched   Answer a start whose outcome is unknown",
        "  bb work-board schedule log [KEY] [--project P]   The history of scheduled starts",
        "Example: bb work-board schedule EXA-1 --at +3h --gate -- --card EXA-1 --role impl",
        "         bb work-board schedule EXA-1 --at +3h --agent codex/gpt-5 --reasoning high   (a project without Spawn Gate's Script mode)",
      ].join("\n"),
      positionals: [KEY],
      passthrough: true,
      options: { at: AT_REQUIRED, gate: GATE, preset: PRESET, agent: AGENT, reasoning: REASONING, permission: PERMISSION, "brief-file": BRIEF_FILE, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        const launch = (await launchFromOptions(host, ctx, { gate: input.options.gate, preset: input.options.preset, agent: input.options.agent, reasoning: input.options.reasoning, permission: input.options.permission, briefFile: input.options["brief-file"] }, input.passthrough, true))!;
        const { scheduledStart } = await domain.scheduleStart({ taskId: task.id, at: input.options.at, launch, actor: actorOf(ctx) });
        return out(input.options.json, task.key, scheduledStart, "Scheduled");
      }),
    }),
    "schedule show": cliCommand({
      summary: "Show a card's scheduled start (or its last refused, unknown or launched one)",
      positionals: [KEY],
      options: { json: JSON_OPTION },
      run: (input) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        const { scheduledStart } = await domain.getScheduledStart({ taskId: task.id });
        if (input.options.json) return JSON.stringify({ key: task.key, scheduledStart });
        return scheduledStart ? startSummary(task.key, scheduledStart) : `${task.key} has no scheduled start.`;
      }),
    }),
    "schedule change": cliCommand({
      summary: "Change a scheduled start's time or launch; refused once its launch is in progress",
      positionals: [KEY],
      passthrough: true,
      options: { at: AT_OPTIONAL, gate: GATE, preset: PRESET, agent: AGENT, reasoning: REASONING, permission: PERMISSION, "brief-file": BRIEF_FILE, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        const launch = await launchFromOptions(host, ctx, { gate: input.options.gate, preset: input.options.preset, agent: input.options.agent, reasoning: input.options.reasoning, permission: input.options.permission, briefFile: input.options["brief-file"] }, input.passthrough, false);
        if (!input.options.at && !launch) throw host.fail("nothing to change: give --at, --gate, --agent or --preset");
        const { scheduledStart } = await domain.changeScheduledStart({ taskId: task.id, ...(input.options.at ? { at: input.options.at } : {}), ...(launch ? { launch } : {}), actor: actorOf(ctx) });
        return out(input.options.json, task.key, scheduledStart, "Changed the start of");
      }),
    }),
    "schedule cancel": cliCommand({
      summary: "Cancel a scheduled start; refused once its launch is in progress",
      positionals: [KEY],
      options: { reason: { type: "string", description: "Why it is canceled (at most 300 characters)" }, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        const { scheduledStart } = await domain.cancelScheduledStart({ taskId: task.id, ...(input.options.reason ? { reason: input.options.reason } : {}), actor: actorOf(ctx) });
        return input.options.json ? JSON.stringify({ key: task.key, scheduledStart }) : `Canceled the scheduled start of ${task.key}.`;
      }),
    }),
    "schedule resolve": cliCommand({
      summary: "Answer a start whose outcome is unknown: the thread it started, or that it started nothing",
      positionals: [KEY],
      options: { launched: { type: "string", placeholder: "thr_...", description: "The thread the start created; it is attached to the card" }, "not-launched": { type: "boolean", description: "The start created no session" }, json: JSON_OPTION },
      constraints: [{ kind: "exactly-one", options: ["launched", "not-launched"] }],
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        const { scheduledStart } = await domain.resolveScheduledStart({ taskId: task.id, ...(input.options.launched ? { launchedThreadId: input.options.launched } : { notLaunched: true }), actor: actorOf(ctx) });
        return input.options.json ? JSON.stringify({ key: task.key, scheduledStart }) : startSummary(task.key, scheduledStart);
      }),
    }),
    "schedule log": cliCommand({
      summary: "The history of scheduled starts: every schedule, change, cancel, launch, refusal and resolution",
      positionals: [{ name: "key-or-id", description: "Task key such as ABC-12; omit it with --project for a whole project" }],
      options: { project: PROJECT_OPTION, limit: { type: "integer", min: 1, max: 1000, description: "Newest N events (default 100)" }, json: JSON_OPTION },
      run: (input) => guard(async () => {
        const task = input.positionals["key-or-id"] ? await host.task(input.positionals["key-or-id"]) : undefined;
        const project = input.options.project ? await host.project(input.options.project) : undefined;
        if (!task && !project) throw host.fail("give a task key or --project");
        const { events } = await domain.listScheduledStartLog({ ...(task ? { taskId: task.id } : { projectId: project!.id }), ...(input.options.limit ? { limit: input.options.limit } : {}) });
        if (input.options.json) return JSON.stringify({ events });
        if (!events.length) return "No scheduled start events.";
        return events.map((event) => `${event.at}  ${event.taskKey ?? event.taskId ?? "-"}  ${event.event}  by ${event.actor ?? "-"}  ${JSON.stringify(event.detail)}`).join("\n");
      }),
    }),
  };
}
