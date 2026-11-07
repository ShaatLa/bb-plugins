import { cliCommand, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { scheduledRpcContract } from "../shared/scheduled";

const json = { type: "boolean" as const, description: "Emit machine-readable JSON" };
const text = (description: string) => ({ type: "string" as const, description });

/** Thin CLI adapter: validation and all schedule behavior stay in scheduled RPC handlers. */
export function scheduledCliCommands(bb: BbPluginApi) {
  const call = async (method: keyof typeof scheduledRpcContract, input: unknown, signal?: AbortSignal): Promise<any> =>
    bb.sdk.plugins.callRpc({ pluginId: "work-board", method, input: input as never, outputSchema: scheduledRpcContract[method].output as unknown as z.ZodType<any>, signal });
  const pageOptions = {
    project: text("Tracker project prefix or ID"),
    schedule: text("Schedule ID"),
    search: text("Search title or task text"),
    limit: { type: "integer" as const, min: 1, max: 100, description: "Maximum rows (1-100)" },
    cursor: text("Continuation cursor"), json,
  };
  const pageInput = (options: Record<string, unknown>) => ({ projectId: options.project, scheduleId: options.schedule, search: options.search, limit: options.limit, cursor: options.cursor });
  const command = (summary: string, options: any, run: (input: any, ctx: any) => Promise<any>) => cliCommand({ summary, options, run: (input, ctx) => run(input, ctx) });
  return {
    "schedule list": command("List scheduled tasks", pageOptions, async (i, c) => { const result = await call("listSchedules", pageInput(i.options), c.signal); return i.options.json ? JSON.stringify(result) : JSON.stringify(result.schedules); }),
    "schedule show": command("Show a schedule", { schedule: { ...text("Schedule ID"), required: true }, json }, async (i, c) => { const result = await call("getSchedule", { scheduleId: i.options.schedule }, c.signal); return JSON.stringify(result); }),
    "schedule create": command("Create a scheduled task", { project: { ...text("Tracker project ID"), required: true }, title: { ...text("Task title"), required: true }, description: text("Task description"), rule: { ...text("Recurrence JSON: daily/weekly/once with timezone"), required: true }, target: { ...text("Target JSON: {kind:thread,threadId} or {kind:preset,presetId}"), required: true }, priority: text("Task priority"), dependencies: text("Comma-separated predecessor IDs"), json }, async (i, c) => { const rule = JSON.parse(i.options.rule); const target = JSON.parse(i.options.target); const result = await call("createSchedule", { projectId: i.options.project, title: i.options.title, description: i.options.description ?? "", priority: i.options.priority ?? "none", dependencyIds: i.options.dependencies?.split(",").filter(Boolean) ?? [], rule, target }, c.signal); return JSON.stringify(result); }),
    "schedule preview": command("Preview upcoming schedule times", { rule: { ...text("Recurrence JSON"), required: true }, count: { type: "integer", min: 1, max: 10, description: "Number of dates" }, json }, async (i, c) => JSON.stringify(await call("previewSchedule", { rule: JSON.parse(i.options.rule), count: i.options.count }, c.signal))),
    "schedule runs": command("List scheduled runs", pageOptions, async (i, c) => JSON.stringify(await call("listScheduleRuns", pageInput(i.options), c.signal))),
    "schedule results": command("List scheduled result tasks", pageOptions, async (i, c) => JSON.stringify(await call("listScheduleResults", pageInput(i.options), c.signal))),
  };
}
