import { randomUUID } from "node:crypto";
import {
  PluginCliError,
  cliCommand,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";
import { detail, oneLine, table } from "../cli/format";
import type { Project, Task } from "../shared/contract";
import { TASK_PRIORITIES } from "../shared/contract";
import { errorMessage } from "../shared/errors";
import {
  recurrenceSchema,
  scheduleTargetSchema,
  scheduledRpcContract,
  type Recurrence,
  type Schedule,
  type ScheduleRun,
} from "../shared/scheduled";

/**
 * Helpers owned by cli/index.ts (project/task/preset addressing, client-host file reads).
 * They are injected so this module never imports the big CLI file and never reads a
 * user path on the server: `readText` goes through the SDK files API of the INVOKING host.
 */
export interface ScheduledCliHost {
  group(name: string, summary: string, subcommands: readonly (readonly [string, string])[]): ReturnType<typeof cliCommand>;
  projects(): Promise<readonly Project[]>;
  /** Tracker project from --project (prefix or id); without an address falls back to the thread's linked project. */
  project(ctx: PluginCliContext, address: string | undefined, required: boolean): Promise<Project | undefined>;
  /** Ordinary task lookup by key or ULID (also reaches hidden template/result tasks). */
  task(address: string): Promise<Task>;
  preset(address: string): Promise<{ id: string; name: string }>;
  readText(ctx: PluginCliContext, machine: string | undefined, path: string): Promise<string>;
}

type Rpc = typeof scheduledRpcContract;
type Target = z.infer<typeof scheduleTargetSchema>;

const MAX_PAGES = 50; // --all stops after 50 pages (5000 rows) and reports the remaining cursor
const THREAD_ID = /^thr_[A-Za-z0-9_-]+$/;
const TASK_ADDRESS = /^([A-Za-z][A-Za-z0-9]{0,9}-\d+|[0-7][0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{25})$/;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const RECURRENCE_FORMS =
  "valid recurrence forms: --daily --time HH:MM --timezone ZONE | --weekly --days mon,wed --time HH:MM --timezone ZONE | --at YYYY-MM-DD --time HH:MM --timezone ZONE | --at <ISO instant with offset> --timezone ZONE | --rule <json>";
const TARGET_FORMS = "valid targets: --thread thr_ID (or current) | --preset NAME_OR_ID | --target <json>";

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const MACHINE_OPTION = {
  type: "string",
  placeholder: "id-or-name",
  description: "Enrolled machine that owns --description-file; defaults to the invoking thread's machine",
} as const;
const PROJECT_OPTION = {
  type: "string",
  placeholder: "prefix-or-id",
  description: "Tracker project prefix or id such as ABC (never a bb project id proj_...)",
} as const;
const pageOptions = {
  project: PROJECT_OPTION,
  search: { type: "string", placeholder: "query", aliases: ["query", "q"], description: "Match title and task text" },
  limit: { type: "integer", min: 1, max: 100, default: 50, description: "Rows per page (1-100)" },
  cursor: { type: "string", placeholder: "opaque", description: "Continue from a previous page's nextCursor with identical filters" },
  all: { type: "boolean", description: `Follow nextCursor automatically (at most ${MAX_PAGES} pages); incompatible with --cursor` },
  json: JSON_OPTION,
} as const;
const scheduleFilter = {
  schedule: { type: "string", placeholder: "schedule", description: "Only this schedule (UUID, or key/ULID of its template or a result task)" },
} as const;
const recurrenceOptions = {
  daily: { type: "boolean", description: "Repeat every day at --time" },
  weekly: { type: "boolean", description: "Repeat on --days at --time" },
  at: {
    type: "string",
    placeholder: "date-or-instant",
    description: "One-time run: a date YYYY-MM-DD (needs --time), a local YYYY-MM-DDTHH:MM, or an ISO instant with offset",
  },
  time: { type: "string", placeholder: "HH:MM", description: "24-hour local time for --daily, --weekly or a date-only --at" },
  timezone: { type: "string", placeholder: "IANA-zone", aliases: ["tz"], description: "IANA time zone such as Europe/Kyiv; always shown with schedule times" },
  days: { type: "string", repeatable: true, split: ",", placeholder: "mon,wed,fri", description: "Weekdays for --weekly: sun..sat or 0-6 (Sunday=0)" },
  rule: { type: "string", placeholder: "json", description: "Advanced: full recurrence JSON; cannot be combined with --time/--timezone/--days" },
} as const;
const targetOptions = {
  thread: { type: "string", placeholder: "thr_ID|current", description: "Existing thread to run in; queued while it is busy ('current' = the invoking thread)" },
  preset: { type: "string", placeholder: "name-or-id", description: "Start a NEW session from this preset; its CURRENT settings are read at every attempt" },
  target: { type: "string", placeholder: "json", description: "Advanced: {kind:thread,threadId}|{kind:preset,presetId}|{kind:unassigned}" },
} as const;
const contentOptions = {
  description: { type: "string", placeholder: "markdown", aliases: ["body"], description: "Template description (what each run's agent receives)" },
  "description-file": { type: "string", placeholder: "path", aliases: ["body-file"], description: "Read the description from this UTF-8 file on the invoking machine" },
  machine: MACHINE_OPTION,
  priority: { type: "enum", values: TASK_PRIORITIES, description: "Task priority copied to every run" },
  dependency: { type: "string", repeatable: true, split: ",", placeholder: "key-or-id", aliases: ["dependencies", "depends-on"], description: "Predecessor tasks (warnings only, copied into each run); keys such as ABC-12 or ULIDs" },
} as const;
const SCHEDULE_POSITIONAL = {
  name: "schedule",
  description: "Schedule UUID, or the key/ULID of its template or any of its result tasks",
  required: true,
} as const;
const RUN_POSITIONAL = {
  name: "run",
  description: "Run UUID from `schedule runs` or `schedule needs-attention`",
  required: true,
} as const;
const IDEMPOTENCY_OPTION = {
  type: "string",
  placeholder: "key",
  aliases: ["idempotencyKey"],
  description: "Retry-safe key (1-128 chars): repeating the same key never sends twice; generated and printed when omitted",
} as const;
const RECURRENCE_FLAGS = ["daily", "weekly", "at", "time", "timezone", "days", "rule"] as const;
const TARGET_FLAGS = ["thread", "preset", "target"] as const;

function fail(message: string, code = "invalid_value", hint?: string): never {
  throw new PluginCliError(oneLine(message), { code, ...(hint ? { hint } : {}) });
}

function friendly(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return `${issue?.path.length ? `${issue.path.join(".")}: ` : ""}${issue?.message ?? "invalid input"}`;
  }
  return errorMessage(error);
}

async function guard(action: () => Promise<string | PluginCliResult>): Promise<PluginCliResult> {
  try {
    const result = await action();
    return typeof result === "string" ? { exitCode: 0, stdout: result } : result;
  } catch (error) {
    if (error instanceof PluginCliError) throw error;
    throw new PluginCliError(oneLine(friendly(error)));
  }
}

function parseJson(flag: string, value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fail(`${flag} is not valid JSON`);
  }
}

// ---- time helpers ---------------------------------------------------------

function validTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** Offset of `timezone` from UTC at an instant, in minutes. */
function offsetMinutes(ms: number, timezone: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(new Date(ms)).map(part => [part.type, part.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Wall-clock date+time in a zone -> ISO instant with explicit offset. Gap times are refused; folded times pick the earlier instant. */
export function zonedToIso(date: string, time: string, timezone: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(wanted);
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) fail(`--at ${date} is not a real calendar date`);
  // Probe the offsets on both sides of the date so a folded hour resolves to its earlier instant.
  const offsets = new Set([offsetMinutes(wanted - 86_400_000, timezone), offsetMinutes(wanted + 86_400_000, timezone)]);
  const instant = [...offsets]
    .map(offset => wanted - offset * 60_000)
    .filter(candidate => offsetMinutes(candidate, timezone) * 60_000 + candidate === wanted)
    .sort((a, b) => a - b)[0];
  if (instant === undefined) fail(`${date} ${time} does not exist in ${timezone} (daylight-saving gap); pick another time`);
  const offset = offsetMinutes(instant, timezone);
  const abs = Math.abs(offset);
  return `${date}T${time}:00${offset < 0 ? "-" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** ISO instant rendered as wall-clock time in the schedule's own zone, always with the zone name. */
function inZone(iso: string | null, timezone: string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    }).formatToParts(date).map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timezone}`;
}

const utc = (iso: string | null) => (iso ? iso.replace(/:\d\d(\.\d+)?(Z|\+00:00)$/, "Z") : "-");

function parseDays(values: readonly string[]): number[] {
  const days = values.map(raw => {
    const value = raw.trim().toLowerCase();
    if (/^[0-6]$/.test(value)) return Number(value);
    const index = DAY_NAMES.findIndex(name => value === name || (value.length > 3 && value.startsWith(name) && "sunday monday tuesday wednesday thursday friday saturday".split(" ").includes(value)));
    return index >= 0 ? index : fail(`unknown weekday "${raw}"; use sun..sat or 0-6 (Sunday=0)`);
  });
  return [...new Set(days)].sort((a, b) => a - b);
}

interface RecurrenceFlags {
  daily: boolean;
  weekly: boolean;
  at: string | undefined;
  time: string | undefined;
  timezone: string | undefined;
  days: readonly string[];
  rule: string | undefined;
}

/** Build a recurrence from the easy flags; with `existing`, unspecified parts are inherited (edit/reschedule). */
export function buildRule(flags: RecurrenceFlags, existing?: Recurrence): Recurrence {
  if (flags.rule !== undefined) {
    if (flags.time || flags.timezone || flags.days.length || flags.daily || flags.weekly || flags.at) {
      fail("--rule already contains the full recurrence; do not combine it with other recurrence flags", "invalid_value", RECURRENCE_FORMS);
    }
    return recurrenceSchema.parse(parseJson("--rule", flags.rule));
  }
  const kind = flags.daily ? "daily" : flags.weekly ? "weekly" : flags.at !== undefined ? "once" : existing?.kind;
  if (!kind) fail("no recurrence given", "missing_required", RECURRENCE_FORMS);
  const timezone = flags.timezone ?? existing?.timezone;
  if (!timezone) fail(`--timezone is required (IANA name such as Europe/Kyiv)`, "missing_required");
  if (!validTimezone(timezone)) fail(`unknown time zone "${timezone}"; use an IANA name such as Europe/Kyiv`);
  if (flags.time !== undefined && !/^([01]\d|2[0-3]):[0-5]\d$/.test(flags.time)) fail("--time must be 24-hour HH:MM such as 09:30");
  if (kind === "once") {
    if (flags.daily || flags.weekly) fail("--at cannot be combined with --daily or --weekly", "invalid_value", RECURRENCE_FORMS);
    if (flags.days.length) fail("--days only applies to --weekly", "invalid_value", RECURRENCE_FORMS);
    if (flags.at === undefined) {
      if (existing?.kind !== "once") fail("one-time schedules need --at", "missing_required", RECURRENCE_FORMS);
      if (flags.time) fail("to change a one-time schedule pass --at again (date plus --time, or a full instant)", "invalid_value");
      return { kind: "once", at: existing.at, timezone };
    }
    const at = flags.at.trim();
    const local = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?$/.exec(at);
    if (local) {
      const time = local[2] ?? flags.time;
      if (!time) fail("a date-only --at needs --time HH:MM", "missing_required", RECURRENCE_FORMS);
      if (local[2] && flags.time) fail("--at already contains a time; drop --time", "invalid_value");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("--at time must be 24-hour HH:MM");
      return recurrenceSchema.parse({ kind: "once", at: zonedToIso(local[1]!, time, timezone), timezone });
    }
    if (flags.time) fail("--time cannot be combined with a full ISO --at instant", "invalid_value", RECURRENCE_FORMS);
    if (!z.iso.datetime({ offset: true }).safeParse(at).success) fail(`--at "${at}" must be YYYY-MM-DD, YYYY-MM-DDTHH:MM, or an ISO instant with offset (2026-12-01T09:00:00+02:00)`);
    return recurrenceSchema.parse({ kind: "once", at, timezone });
  }
  if (flags.at !== undefined) fail("--at cannot be combined with --daily or --weekly", "invalid_value", RECURRENCE_FORMS);
  const time = flags.time ?? (existing && existing.kind !== "once" ? existing.time : undefined);
  if (!time) fail(`--${kind} needs --time HH:MM`, "missing_required", RECURRENCE_FORMS);
  if (kind === "daily") {
    if (flags.days.length) fail("--days only applies to --weekly", "invalid_value", RECURRENCE_FORMS);
    return recurrenceSchema.parse({ kind, time, timezone });
  }
  const weekdays = flags.days.length ? parseDays(flags.days) : existing?.kind === "weekly" ? existing.weekdays : undefined;
  if (!weekdays) fail("--weekly needs --days such as mon,wed,fri", "missing_required", RECURRENCE_FORMS);
  return recurrenceSchema.parse({ kind, time, timezone, weekdays });
}

// ---- display --------------------------------------------------------------

function describeRule(rule: Recurrence): string {
  if (rule.kind === "daily") return `daily ${rule.time} ${rule.timezone}`;
  if (rule.kind === "weekly") return `weekly ${rule.weekdays.map(day => DAY_NAMES[day]).join(",")} ${rule.time} ${rule.timezone}`;
  return `once ${inZone(rule.at, rule.timezone)}`;
}

function describeTarget(target: Target): string {
  if (target.kind === "thread") return `thread ${target.threadId} (queued while busy)`;
  if (target.kind === "preset") return `preset ${target.presetId} (new session, current preset at each run)`;
  return "unassigned (imported; set --thread or --preset before enabling)";
}

const stateOf = (schedule: Schedule) => (schedule.enabled ? "enabled" : "paused");

function runRow(run: ScheduleRun, keys: Map<string, string>) {
  return [
    run.id,
    run.state + (run.missCount > 1 ? ` x${run.missCount}` : "") + (run.historical ? " (imported)" : ""),
    utc(run.scheduledFor),
    run.taskId ? (keys.get(run.taskId) ?? run.taskId) : "-",
    run.threadId ?? "-",
    run.reason ?? "",
  ];
}
const RUN_HEADERS = ["RUN", "STATE", "SCHEDULED FOR (UTC)", "TASK", "THREAD", "REASON"] as const;

function pageFooter(nextCursor: string | null): string {
  return nextCursor ? `\nMore rows: re-run with --cursor ${nextCursor} (or add --all)` : "";
}

/** Names the prefix-or-id project filter for table rows. */
function prefixOf(projects: readonly Project[]) {
  const map = new Map(projects.map(project => [project.id, project.prefix]));
  return (id: string) => map.get(id) ?? id;
}

// ---------------------------------------------------------------------------

export function scheduledCliCommands(bb: BbPluginApi, host: ScheduledCliHost) {
  const call = async <M extends keyof Rpc>(
    method: M,
    input: z.input<Rpc[M]["input"]>,
    signal?: AbortSignal,
  ): Promise<z.output<Rpc[M]["output"]>> => {
    const parsed = scheduledRpcContract[method].input.parse(input);
    return bb.sdk.plugins.callRpc({
      pluginId: "work-board",
      method,
      input: parsed as never,
      outputSchema: scheduledRpcContract[method].output as unknown as z.ZodType<z.output<Rpc[M]["output"]>>,
      ...(signal ? { signal } : {}),
    });
  };

  const keyCache = new Map<string, string>();
  /** task ULID -> key; best effort because a missing task must not break a listing. */
  const taskKeys = async (ids: readonly (string | null)[]) => {
    for (const id of new Set(ids.filter((value): value is string => !!value && !keyCache.has(value)))) {
      await host.task(id).then(task => keyCache.set(id, task.key), () => undefined);
    }
    return keyCache;
  };

  const scheduleId = async (address: string, signal?: AbortSignal): Promise<string> => {
    const value = address.trim();
    if (z.uuid().safeParse(value).success) return value;
    if (!TASK_ADDRESS.test(value)) fail(`"${address}" is neither a schedule UUID nor a task key/ULID`, "invalid_value", "run bb work-board schedule list");
    const task = await host.task(value);
    const { source } = await call("getTaskSchedule", { taskId: task.id }, signal);
    if (!source) fail(`${task.key} is not a scheduled template or result task`, "not_scheduled", "run bb work-board schedule list");
    return source.scheduleId;
  };
  const runId = (value: string) =>
    z.uuid().safeParse(value.trim()).success ? value.trim() : fail(`"${value}" is not a run UUID`, "invalid_value", "run bb work-board schedule runs");

  /** One page, or every page with --all (bounded). */
  const paged = async <T extends { nextCursor: string | null }>(
    options: { all?: boolean; cursor?: string; limit: number },
    fetch: (cursor: string | undefined) => Promise<T>,
    merge: (pages: T[]) => T,
  ): Promise<T> => {
    if (options.all && options.cursor) fail("--all cannot be combined with --cursor");
    if (!options.all) return fetch(options.cursor);
    const pages: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await fetch(cursor);
      pages.push(page);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && pages.length < MAX_PAGES);
    return merge(pages);
  };

  const filters = async (options: { project?: string; schedule?: string; search?: string }, ctx: PluginCliContext) => ({
    ...(options.project ? { projectId: (await host.project(ctx, options.project, true))!.id } : {}),
    ...(options.schedule ? { scheduleId: await scheduleId(options.schedule, ctx.signal) } : {}),
    ...(options.search ? { search: options.search } : {}),
  });

  const resolveTarget = async (options: { thread?: string; preset?: string; target?: string }, ctx: PluginCliContext): Promise<Target | undefined> => {
    if (options.target !== undefined) return scheduleTargetSchema.parse(parseJson("--target", options.target));
    if (options.thread !== undefined) {
      const id = options.thread === "current" ? (ctx.threadId ?? process.env.BB_THREAD_ID) : options.thread.trim();
      if (!id) fail("--thread current needs an invoking thread (BB_THREAD_ID is not set)", "missing_required", TARGET_FORMS);
      if (!THREAD_ID.test(id)) fail(`--thread "${options.thread}" must look like thr_xxxx or be "current"`, "invalid_value", TARGET_FORMS);
      return { kind: "thread", threadId: id };
    }
    if (options.preset !== undefined) return { kind: "preset", presetId: (await host.preset(options.preset)).id };
    return undefined;
  };

  const resolveDependencies = async (values: readonly string[]) => [
    ...new Set(await Promise.all(values.map(async value => (await host.task(value)).id))),
  ];

  const readDescription = async (options: { description?: string; "description-file"?: string; machine?: string }, ctx: PluginCliContext) =>
    options["description-file"] !== undefined ? host.readText(ctx, options.machine, options["description-file"]) : options.description;

  const scheduleLine = async (verb: string, schedule: Schedule) => {
    const key = (await taskKeys([schedule.templateTaskId])).get(schedule.templateTaskId);
    const next = schedule.nextDueAt ? `next ${inZone(schedule.nextDueAt, schedule.rule.timezone)}` : schedule.enabled ? "no upcoming run" : "paused";
    return `${verb} schedule ${schedule.id}${key ? ` (template ${key})` : ""}  ${describeRule(schedule.rule)}  ${next}`;
  };

  const runLine = async (verb: string, run: ScheduleRun) => {
    const key = run.taskId ? (await taskKeys([run.taskId])).get(run.taskId) : undefined;
    return `${verb} run ${run.id}  state ${run.state}${key ? `  task ${key}` : ""}${run.threadId ? `  thread ${run.threadId}` : ""}${run.reason ? `  ${run.reason}` : ""}`;
  };

  const requireUsableTarget = (schedule: Schedule) => {
    if (schedule.target.kind === "unassigned") {
      fail(
        "this schedule has no target yet (imported); choose one before enabling",
        "target_required",
        `run bb work-board schedule edit ${schedule.id} with --thread thr_ID or --preset NAME, then resume`,
      );
    }
  };

  const setEnabled = (enabled: boolean, summary: string) =>
    cliCommand({
      summary,
      positionals: [SCHEDULE_POSITIONAL],
      options: { json: JSON_OPTION },
      run(input, ctx) {
        return guard(async () => {
          const id = await scheduleId(input.positionals.schedule, ctx.signal);
          // Pause never stops running work nor cancels an accepted queue; resume computes the next FUTURE slot.
          if (enabled) requireUsableTarget((await call("getSchedule", { scheduleId: id }, ctx.signal)).schedule);
          const result = await call("setScheduleEnabled", { scheduleId: id, enabled }, ctx.signal);
          return input.options.json ? JSON.stringify(result) : scheduleLine(enabled ? "Resumed" : "Paused", result.schedule);
        });
      },
    });

  const runAction = (summary: string, method: "cancelScheduleRun" | "resolveScheduleRun", verb: string, noteRequired: boolean | "optional", hidden = false) =>
    cliCommand({
      summary,
      hidden,
      positionals: [RUN_POSITIONAL],
      options: {
        ...(noteRequired ? { note: { type: "string", placeholder: "text", required: noteRequired === true, description: "What was done or why (1-1000 chars)" } as const } : {}),
        json: JSON_OPTION,
      },
      run(input, ctx) {
        return guard(async () => {
          const id = runId(input.positionals.run);
          const note = (input.options as { note?: string }).note;
          const result = method === "cancelScheduleRun"
            ? await call("cancelScheduleRun", { runId: id }, ctx.signal)
            : await call("resolveScheduleRun", { runId: id, note: note ?? `Dismissed from the CLI${ctx.threadId ? ` by ${ctx.threadId}` : ""}` }, ctx.signal);
          return input.options.json ? JSON.stringify(result) : runLine(verb, result.run);
        });
      },
    });

  const runsCommand = (summary: string, forceAttention: boolean) =>
    cliCommand({
      summary,
      // Hidden from the top-level listing only: its long name would widen every help column; `schedule --help` lists it.
      hidden: forceAttention,
      options: {
        ...pageOptions,
        ...scheduleFilter,
        ...(forceAttention ? {} : { "needs-attention": { type: "boolean", description: "Only failed, missed, unknown or otherwise unresolved runs" } as const }),
      },
      run(input, ctx) {
        return guard(async () => {
          const base = await filters(input.options, ctx);
          const needsAttention = forceAttention || (input.options as { "needs-attention"?: boolean })["needs-attention"] === true;
          const result = await paged(
            input.options,
            cursor => call("listScheduleRuns", { ...base, ...(needsAttention ? { needsAttention: true } : {}), limit: input.options.limit, ...(cursor ? { cursor } : {}) }, ctx.signal),
            pages => ({ runs: pages.flatMap(page => page.runs), nextCursor: pages.at(-1)?.nextCursor ?? null }),
          );
          if (input.options.json) return JSON.stringify(result);
          const keys = await taskKeys(result.runs.map(run => run.taskId));
          return (
            table(RUN_HEADERS, result.runs.map(run => runRow(run, keys)), needsAttention ? "Nothing needs attention." : "No runs.") + pageFooter(result.nextCursor)
          );
        });
      },
    });

  const createRecurrence = [
    { kind: "exactly-one", options: ["daily", "weekly", "at", "rule"] },
    { kind: "exactly-one", options: [...TARGET_FLAGS] },
  ] as const;
  const contentConstraints = [
    { kind: "at-most-one", options: ["description", "description-file"] },
    { kind: "requires", option: "machine", needs: ["description-file"] },
  ] as const;

  return {
    schedule: host.group("schedule", "Create and manage recurring and one-time scheduled tasks", [
      ["list", "List schedules"],
      ["show", "Show a schedule, its template task and recent runs"],
      ["create", "Create a schedule"],
      ["edit", "Change title, description, priority, dependencies, recurrence or target"],
      ["reschedule", "Change only the recurrence of future firings"],
      ["enable", "Enable a schedule (alias: resume)"],
      ["pause", "Stop future firings; running work and accepted queues are untouched"],
      ["resume", "Resume a paused schedule at its next future slot"],
      ["delete", "Delete a schedule for real (needs --yes)"],
      ["preview", "Preview upcoming fire times for a recurrence"],
      ["run-now", "Start a run immediately"],
      ["retry", "Retry a failed, skipped or unknown run"],
      ["cancel-queued", "Cancel a run still waiting in a thread queue"],
      ["resolve", "Record how a failed or missed run was handled"],
      ["dismiss", "Acknowledge a failed or missed run without further action"],
      ["runs", "List run records (history)"],
      ["needs-attention", "List unresolved failed, missed or unknown runs"],
      ["results", "List result tasks created by schedules"],
    ]),

    "schedule list": cliCommand({
      summary: "List schedules",
      options: { ...pageOptions, "needs-attention": { type: "boolean", description: "Only schedules with an unresolved failed or missed run" } },
      run(input, ctx) {
        return guard(async () => {
          const base = await filters(input.options, ctx);
          const result = await paged(
            input.options,
            cursor => call("listSchedules", { ...base, ...(input.options["needs-attention"] ? { needsAttention: true } : {}), limit: input.options.limit, ...(cursor ? { cursor } : {}) }, ctx.signal),
            pages => ({ schedules: pages.flatMap(page => page.schedules), nextCursor: pages.at(-1)?.nextCursor ?? null }),
          );
          if (input.options.json) return JSON.stringify(result);
          const prefix = prefixOf(await host.projects());
          return (
            table(
              ["ID", "PROJECT", "STATE", "TITLE", "WHEN", "NEXT", "TARGET"],
              result.schedules.map(schedule => [
                schedule.id, prefix(schedule.projectId), stateOf(schedule) + (schedule.overlapRunIds.length ? " (overlap)" : ""), schedule.title,
                describeRule(schedule.rule), inZone(schedule.nextDueAt, schedule.rule.timezone), describeTarget(schedule.target).split(" (")[0],
              ]),
              "No schedules.",
            ) + pageFooter(result.nextCursor)
          );
        });
      },
    }),

    "schedule show": cliCommand({
      summary: "Show a schedule, its template task key and recent runs",
      positionals: [SCHEDULE_POSITIONAL],
      options: { json: JSON_OPTION },
      run(input, ctx) {
        return guard(async () => {
          const id = await scheduleId(input.positionals.schedule, ctx.signal);
          const result = await call("getSchedule", { scheduleId: id }, ctx.signal);
          if (input.options.json) return JSON.stringify(result);
          const { schedule, task } = result;
          const [projects, dependencies, runs] = await Promise.all([
            host.projects(),
            taskKeys(result.dependencyIds),
            call("listScheduleRuns", { scheduleId: id, limit: 5 }, ctx.signal),
          ]);
          const keys = await taskKeys(runs.runs.map(run => run.taskId));
          const overlap = schedule.overlapRunIds.length ? `${schedule.overlapRunIds.length} unfinished earlier run(s): ${schedule.overlapRunIds.join(", ")}` : "none";
          return [
            detail([
              ["Schedule", schedule.id],
              ["Template task", `${task.key}  ${task.id}  (use ordinary task commands on it: show, comment, attachment, question, dependency, evidence)`],
              ["Project", prefixOf(projects)(schedule.projectId)],
              ["Title", schedule.title],
              ["State", stateOf(schedule)],
              ["Recurrence", describeRule(schedule.rule)],
              ["Timezone", schedule.rule.timezone],
              ["Next run", schedule.nextDueAt ? `${inZone(schedule.nextDueAt, schedule.rule.timezone)}  (${schedule.nextDueAt})` : "none"],
              ["Target", describeTarget(schedule.target)],
              ["Priority", task.priority],
              ["Dependencies", result.dependencyIds.map(dep => dependencies.get(dep) ?? dep).join(", ") || "none"],
              ["Overlap", overlap],
              ["Updated", schedule.updatedAt],
            ]),
            "",
            "Recent runs:",
            table(RUN_HEADERS, runs.runs.map(run => runRow(run, keys)), "  none yet"),
            runs.nextCursor ? `  more: bb work-board schedule runs --schedule ${id}` : "",
            `Result tasks: bb work-board schedule results --schedule ${id}`,
          ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");
        });
      },
    }),

    "schedule create": cliCommand({
      summary: "Create a scheduled task",
      description: `${RECURRENCE_FORMS}\n${TARGET_FORMS}\nThe description is the template: every run is a fresh task cloned from it. A preset target starts a new session with the preset's CURRENT settings at every run.`,
      options: {
        project: PROJECT_OPTION,
        title: { type: "string", required: true, placeholder: "text", description: "Task title (1-500 chars)" },
        ...contentOptions,
        paused: { type: "boolean", description: "Create disabled; resume later" },
        ...recurrenceOptions,
        ...targetOptions,
        json: JSON_OPTION,
      },
      constraints: [...createRecurrence, ...contentConstraints],
      run(input, ctx) {
        return guard(async () => {
          const project = (await host.project(ctx, input.options.project, true))!;
          const rule = buildRule(input.options);
          const target = await resolveTarget(input.options, ctx);
          const description = await readDescription(input.options, ctx);
          const result = await call("createSchedule", {
            projectId: project.id,
            title: input.options.title,
            ...(description !== undefined ? { description } : {}),
            ...(input.options.priority ? { priority: input.options.priority } : {}),
            dependencyIds: await resolveDependencies(input.options.dependency),
            rule,
            target: target!,
            enabled: !input.options.paused,
          }, ctx.signal);
          return input.options.json ? JSON.stringify(result) : scheduleLine("Created", result.schedule);
        });
      },
    }),

    ...Object.fromEntries(
      (["edit", "update"] as const).map(name => [`schedule ${name}`, cliCommand({
        summary: "Change a schedule; only the flags you pass are updated",
        hidden: name === "update",
        description: `${RECURRENCE_FORMS}\n${TARGET_FORMS}\nTime, timezone or days alone modify the existing recurrence; --dependency replaces the whole predecessor list (--clear-dependencies empties it). Edits affect future runs only.`,
        positionals: [SCHEDULE_POSITIONAL],
        options: {
          title: { type: "string", placeholder: "text", description: "New task title" },
          ...contentOptions,
          "clear-dependencies": { type: "boolean", description: "Remove every predecessor" },
          ...recurrenceOptions,
          ...targetOptions,
          json: JSON_OPTION,
        },
        constraints: [
          { kind: "at-least-one", options: ["title", "description", "description-file", "priority", "dependency", "clear-dependencies", ...RECURRENCE_FLAGS, ...TARGET_FLAGS] },
          { kind: "at-most-one", options: ["daily", "weekly", "at", "rule"] },
          { kind: "at-most-one", options: [...TARGET_FLAGS] },
          { kind: "at-most-one", options: ["dependency", "clear-dependencies"] },
          ...contentConstraints,
        ],
        run(input, ctx) {
          return guard(async () => {
            const id = await scheduleId(input.positionals.schedule, ctx.signal);
            const touchesRule = RECURRENCE_FLAGS.some(flag => { const value = input.options[flag]; return Array.isArray(value) ? value.length > 0 : !!value; });
            const rule = touchesRule ? buildRule(input.options, (await call("getSchedule", { scheduleId: id }, ctx.signal)).schedule.rule) : undefined;
            const target = await resolveTarget(input.options, ctx);
            const description = await readDescription(input.options, ctx);
            const dependencyIds = input.options["clear-dependencies"] ? [] : input.options.dependency.length ? await resolveDependencies(input.options.dependency) : undefined;
            const result = await call("updateSchedule", {
              scheduleId: id,
              ...(input.options.title !== undefined ? { title: input.options.title } : {}),
              ...(description !== undefined ? { description } : {}),
              ...(input.options.priority ? { priority: input.options.priority } : {}),
              ...(dependencyIds ? { dependencyIds } : {}),
              ...(rule ? { rule } : {}),
              ...(target ? { target } : {}),
            }, ctx.signal);
            return input.options.json ? JSON.stringify(result) : scheduleLine("Updated", result.schedule);
          });
        },
      })]),
    ),

    "schedule reschedule": cliCommand({
      summary: "Change only the recurrence (future firings); use `schedule retry` to redo a missed run",
      hidden: true, // same reason as needs-attention: the name would widen the top-level help column
      description: RECURRENCE_FORMS,
      positionals: [SCHEDULE_POSITIONAL],
      options: { ...recurrenceOptions, json: JSON_OPTION },
      constraints: [
        { kind: "at-least-one", options: [...RECURRENCE_FLAGS] },
        { kind: "at-most-one", options: ["daily", "weekly", "at", "rule"] },
      ],
      run(input, ctx) {
        return guard(async () => {
          const id = await scheduleId(input.positionals.schedule, ctx.signal);
          const rule = buildRule(input.options, (await call("getSchedule", { scheduleId: id }, ctx.signal)).schedule.rule);
          const result = await call("updateSchedule", { scheduleId: id, rule }, ctx.signal);
          return input.options.json ? JSON.stringify(result) : scheduleLine("Rescheduled", result.schedule);
        });
      },
    }),

    "schedule enable": setEnabled(true, "Enable a schedule at its next future slot"),
    "schedule resume": setEnabled(true, "Resume a paused schedule at its next future slot (no replay of the paused period)"),
    "schedule pause": setEnabled(false, "Stop future firings; running work and already accepted queues are not touched"),

    "schedule delete": cliCommand({
      summary: "Delete a schedule for real (pending queued runs are canceled first; past results stay reachable)",
      positionals: [SCHEDULE_POSITIONAL],
      options: { yes: { type: "boolean", description: "Confirm the irreversible deletion" }, json: JSON_OPTION },
      run(input, ctx) {
        return guard(async () => {
          if (!input.options.yes) fail("deleting a schedule is irreversible; re-run with --yes", "confirmation_required", "use `schedule pause` to stop firing without deleting");
          const id = await scheduleId(input.positionals.schedule, ctx.signal);
          const result = await call("deleteSchedule", { scheduleId: id }, ctx.signal);
          if (!result.deleted) return { exitCode: 1, stdout: input.options.json ? JSON.stringify(result) : `Schedule ${id} was not deleted; it may already be gone or have an uncancelable queued run` };
          return input.options.json ? JSON.stringify(result) : `Deleted schedule ${id}. Past result tasks and incident records stay available via schedule results / runs.`;
        });
      },
    }),

    "schedule preview": cliCommand({
      summary: "Preview upcoming fire times (server computed)",
      description: RECURRENCE_FORMS,
      options: { ...recurrenceOptions, count: { type: "integer", min: 1, max: 10, default: 3, description: "How many dates (1-10)" }, from: { type: "string", placeholder: "instant", description: "Preview after this ISO instant (default now)" }, json: JSON_OPTION },
      constraints: [{ kind: "exactly-one", options: ["daily", "weekly", "at", "rule"] }],
      run(input, ctx) {
        return guard(async () => {
          const rule = buildRule(input.options);
          const result = await call("previewSchedule", { rule, count: input.options.count, ...(input.options.from ? { after: input.options.from } : {}) }, ctx.signal);
          if (input.options.json) return JSON.stringify({ rule, ...result });
          return [describeRule(rule), ...result.dates.map(date => `  ${inZone(date, rule.timezone)}  (${date})`), result.dates.length ? "" : "  no upcoming run"].join("\n").trimEnd();
        });
      },
    }),

    "schedule run-now": cliCommand({
      summary: "Start a run immediately (advisory overlap warning only; never blocked)",
      positionals: [SCHEDULE_POSITIONAL],
      options: { "idempotency-key": IDEMPOTENCY_OPTION, json: JSON_OPTION },
      run(input, ctx) {
        return guard(async () => {
          const key = input.options["idempotency-key"] ?? `cli-${randomUUID()}`;
          const result = await call("runSchedule", { scheduleId: await scheduleId(input.positionals.schedule, ctx.signal), idempotencyKey: key }, ctx.signal);
          return input.options.json ? JSON.stringify({ ...result, idempotencyKey: key }) : `${await runLine("Started", result.run)}\nidempotency key: ${key} (repeat it to retry safely; the same key never sends twice)`;
        });
      },
    }),

    "schedule retry": cliCommand({
      summary: "Retry a failed, skipped or unknown run (an unknown run may already have executed)",
      positionals: [RUN_POSITIONAL],
      options: { "idempotency-key": IDEMPOTENCY_OPTION, json: JSON_OPTION },
      run(input, ctx) {
        return guard(async () => {
          const key = input.options["idempotency-key"] ?? `cli-${randomUUID()}`;
          const result = await call("retryScheduleRun", { runId: runId(input.positionals.run), idempotencyKey: key }, ctx.signal);
          return input.options.json ? JSON.stringify({ ...result, idempotencyKey: key }) : `${await runLine("Retried", result.run)}\nidempotency key: ${key}`;
        });
      },
    }),

    "schedule cancel-queued": runAction("Cancel a run that is still waiting in a thread queue (active work is not stopped)", "cancelScheduleRun", "Canceled", false, true),
    "schedule resolve": runAction("Record how a failed, missed or unknown run was handled", "resolveScheduleRun", "Resolved", true),
    "schedule dismiss": runAction("Acknowledge a failed or missed run; the optional note is recorded", "resolveScheduleRun", "Dismissed", "optional"),
    "schedule runs": runsCommand("List run records (history is trimmed after 30 days; results stay)", false),
    "schedule needs-attention": runsCommand("List unresolved failed, missed, unknown or cancel-pending runs", true),

    "schedule results": cliCommand({
      summary: "List result tasks created by schedules (stay available after history cleanup and schedule deletion)",
      options: { ...pageOptions, ...scheduleFilter },
      run(input, ctx) {
        return guard(async () => {
          const base = await filters(input.options, ctx);
          const result = await paged(
            input.options,
            cursor => call("listScheduleResults", { ...base, limit: input.options.limit, ...(cursor ? { cursor } : {}) }, ctx.signal),
            pages => ({ results: pages.flatMap(page => page.results), nextCursor: pages.at(-1)?.nextCursor ?? null }),
          );
          if (input.options.json) return JSON.stringify(result);
          return (
            table(
              ["KEY", "STATUS", "ROLE", "SCHEDULED FOR (UTC)", "STARTED (UTC)", "SCHEDULE", "TITLE"],
              result.results.map(({ task, source }) => [task.key, task.status, source.role, utc(source.scheduledFor), utc(source.startedAt), source.scheduleTitle, task.title]),
              "No scheduled results.",
            ) + pageFooter(result.nextCursor)
          );
        });
      },
    }),
  };
}
