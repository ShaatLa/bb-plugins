import { cliCommand, type PluginCliContext, type PluginCliResult, type PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { detail } from "../cli/format";
import type { tasksRpcContract } from "../shared/contract";

type Domain = Pick<PluginRpcHandlers<typeof tasksRpcContract>, "queueList" | "queueAdd" | "queueMove" | "queueRemove" | "queueReport">;

/** Helpers owned by cli/index.ts (addressing, error mapping), injected so this module never imports the big CLI file. */
export interface QueueCliHost {
  domain: Domain;
  group(name: string, summary: string, subcommands: readonly (readonly [string, string])[]): ReturnType<typeof cliCommand>;
  guard(action: () => Promise<string | PluginCliResult>): Promise<PluginCliResult>;
  task(address: string): Promise<{ id: string; key: string; projectId: string }>;
  project(address: string): Promise<{ id: string; prefix: string }>;
  fail(message: string): Error;
}

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const PROJECT_OPTION = { type: "string", placeholder: "prefix-or-id", description: "Tracker project prefix or id such as ABC, never a bb project id (proj_...)" } as const;
const THREAD_OPTION = { type: "string", placeholder: "thr_...", description: "Executor thread whose queue it is" } as const;
const KEY = { name: "key-or-id", description: "Task key such as ABC-12 or its ULID", required: true } as const;
const POSITION = { type: "integer", min: 1, max: 1000, description: "Place in the queue; 1 is the current card" } as const;
const actorOf = (ctx: PluginCliContext) => ctx.threadId ?? process.env.BB_THREAD_ID ?? "owner";

export function queueCliCommands(host: QueueCliHost) {
  const { domain, guard } = host;
  /** Without --thread the caller's own queue; `add` names the executor explicitly. */
  const threadOf = (ctx: PluginCliContext, option: string | undefined) => {
    const id = option ?? ctx.threadId ?? process.env.BB_THREAD_ID;
    if (!id) throw host.fail("missing --thread and BB_THREAD_ID is not set");
    return id;
  };
  const checkProject = async (address: string | undefined, task: { key: string; projectId: string }) => {
    if (address && (await host.project(address)).id !== task.projectId) throw host.fail(`${task.key} is not in project ${address}; a card joins only the queue of its own project`);
  };
  return {
    queue: host.group("queue", "The manual work queue of an executor thread: the first card is current, the rest wait", [
      ["list", "Show a thread's queue, per project"],
      ["add", "Put a card into a thread's queue (appends unless --position)"],
      ["move", "Move a queued card to another place"],
      ["remove", "Take a card out of its queue"],
      ["report", "Compare cards with and without queues (the trial)"],
    ]),
    "queue list": cliCommand({
      summary: "Show an executor thread's queue in order",
      options: { thread: THREAD_OPTION, project: PROJECT_OPTION, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const project = input.options.project ? await host.project(input.options.project) : undefined;
        const { queues } = await domain.queueList({ threadId: threadOf(ctx, input.options.thread), ...(project ? { projectId: project.id } : {}) });
        if (input.options.json) return JSON.stringify({ queues });
        if (!queues.length) return "The queue is empty.";
        return queues.map((queue) => [`Project ${queue.projectId} · thread ${queue.threadId}`, ...queue.entries.map((entry) => `${entry.position === 1 ? "Current" : `#${entry.position}`}  ${entry.key} · ${entry.title} (${entry.status})`)].join("\n")).join("\n\n");
      }),
    }),
    "queue add": cliCommand({
      summary: "Put a card into an executor thread's queue; the order is yours, nothing starts by itself",
      positionals: [KEY],
      options: { thread: { ...THREAD_OPTION, required: true }, position: POSITION, project: PROJECT_OPTION, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        await checkProject(input.options.project, task);
        const result = await domain.queueAdd({ taskId: task.id, threadId: input.options.thread, ...(input.options.position ? { position: input.options.position } : {}), actor: actorOf(ctx) });
        return input.options.json ? JSON.stringify(result) : `${task.key} is ${result.position === 1 ? "current" : `queued #${result.position}`} for ${result.threadId}`;
      }),
    }),
    "queue move": cliCommand({
      summary: "Move a queued card to another place in its queue",
      positionals: [KEY],
      options: { position: { ...POSITION, required: true }, project: PROJECT_OPTION, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        await checkProject(input.options.project, task);
        const result = await domain.queueMove({ taskId: task.id, position: input.options.position, actor: actorOf(ctx) });
        return input.options.json ? JSON.stringify(result) : `${task.key} is ${result.position === 1 ? "current" : `queued #${result.position}`} for ${result.threadId}`;
      }),
    }),
    "queue remove": cliCommand({
      summary: "Take a card out of its queue",
      positionals: [KEY],
      options: { project: PROJECT_OPTION, json: JSON_OPTION },
      run: (input, ctx) => guard(async () => {
        const task = await host.task(input.positionals["key-or-id"]);
        await checkProject(input.options.project, task);
        const result = await domain.queueRemove({ taskId: task.id, actor: actorOf(ctx) });
        return input.options.json ? JSON.stringify(result) : `${task.key} left the queue of ${result.threadId}`;
      }),
    }),
    "queue report": cliCommand({
      summary: "Queue trial: stale-status flags and ordering workarounds per covered unit-day, with and without queues",
      options: { project: { ...PROJECT_OPTION, required: true }, since: { type: "string", description: "Window start (ISO); default: first coverage" }, json: JSON_OPTION },
      run: (input) => guard(async () => {
        const project = await host.project(input.options.project);
        const report = await domain.queueReport({ projectId: project.id, ...(input.options.since ? { since: input.options.since } : {}) });
        if (input.options.json) return JSON.stringify(report);
        const arms = report.arms as Record<string, { units: number; unitDays: number; coverageShare: number | null }>;
        const primary = report.primary as Record<string, { occurrences: number; perUnitDay: number | null }>;
        const secondary = report.secondary as Record<string, { count: number; perUnitDay: number | null }>;
        const rate = (value: number | null | undefined) => (value == null ? "n/a" : value.toFixed(3));
        return [
          `Window ${String(report.since)} to ${String(report.until)}; excluded days (mode change): ${(report.excludedDays as string[]).join(", ") || "none"}`,
          ...(["auto", "control"] as const).map((arm) => detail([[arm, `${arms[arm]!.units} units, ${arms[arm]!.unitDays.toFixed(2)} covered unit-days (coverage ${rate(arms[arm]!.coverageShare)}); stale-status ${rate(primary[arm]!.occurrences)} = ${rate(primary[arm]!.perUnitDay)}/unit-day; workarounds ${secondary[arm]!.count} = ${rate(secondary[arm]!.perUnitDay)}/unit-day`]])),
          `Unmatched occurrences: ${JSON.stringify((report.primary as { unmatchedByArm: unknown }).unmatchedByArm)}`,
          "Limitations:", ...(report.limitations as string[]).map((line) => `- ${line}`),
          "Use --json for the baseline, the sensitivity results and every matched row.",
        ].join("\n");
      }),
    }),
  };
}
