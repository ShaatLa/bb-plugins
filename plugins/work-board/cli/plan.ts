import { PluginCliError, cliCommand, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { registerHandlers } from "../api";
import { tasksRpcContract, type PlanAuthor, type SaveTaskPlanInput, type Task } from "../shared/contract";
import { getSection } from "../shared/plan";
import { oneLine, table } from "./format";

type Domain = ReturnType<typeof registerHandlers>;

/** The shared CLI helpers of cli/index.ts, passed in so this file stays free of import cycles. */
export interface PlanCliDeps {
  bb: BbPluginApi;
  domain: Domain;
  guard: (action: () => Promise<string | PluginCliResult>) => Promise<PluginCliResult>;
  resolveTask: (domain: Domain, address: string) => Promise<Task>;
  resolveClientHostId: (bb: BbPluginApi, domain: Domain, machine: string | undefined, ctx: PluginCliContext) => Promise<string | undefined>;
  readTextOption: (
    bb: BbPluginApi,
    ctx: PluginCliContext,
    hostId: string | undefined,
    inline: string | undefined,
    file: string | undefined,
  ) => Promise<string | undefined>;
  taskAuthor: (ctx: PluginCliContext) => string;
  keyPositional: { readonly name: "key-or-id"; readonly description: string; readonly required: true };
  jsonOption: { type: "boolean"; description: string };
  machineOption: { type: "string"; placeholder: string; description: string };
}

const MAX_VERSION = 1_000_000;
const lines = (added: number, removed: number) => `+${added} −${removed} lines`;

export function planCommands(deps: PlanCliDeps) {
  const { bb, domain, guard, resolveTask, resolveClientHostId, readTextOption, taskAuthor } = deps;
  const common = { json: deps.jsonOption };
  const writeOptions = {
    "base-version": { type: "integer" as const, min: 0, max: MAX_VERSION, required: true as const, placeholder: "N", description: "Plan version you edited from (0 for the first version); `plan show` prints it" },
    summary: { type: "string" as const, required: true as const, description: "What changed, up to 300 characters" },
    json: deps.jsonOption,
  };
  const authorOf = (ctx: PluginCliContext): PlanAuthor => ({ kind: ctx.threadId ? "agent" : "person", threadId: ctx.threadId ?? null, name: taskAuthor(ctx) });
  const fail = (message: string, code?: string): never => {
    throw new PluginCliError(message, code ? { code } : undefined);
  };

  /** Unwraps a mutation result; refusals keep their multi-line message for the agent. */
  function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
    if (!result.ok) {
      const { error } = result as unknown as { error: { code: string; message: string } };
      return fail(error.message, error.code);
    }
    return result as Extract<T, { ok: true }>;
  }

  async function save(
    input: { positionals: { "key-or-id": string }; options: { "base-version": number; summary: string; json?: boolean } },
    ctx: PluginCliContext,
    edit: (taskId: string) => Omit<SaveTaskPlanInput, "taskId" | "baseVersion" | "summary" | "author">,
  ) {
    const task = await resolveTask(domain, input.positionals["key-or-id"]);
    const result = unwrap(
      tasksRpcContract.saveTaskPlan.output.parse(
        await domain.saveTaskPlan(
          tasksRpcContract.saveTaskPlan.input.parse({
            ...edit(task.id),
            taskId: task.id,
            baseVersion: input.options["base-version"],
            summary: input.options.summary,
            author: authorOf(ctx),
          }),
        ),
      ),
    );
    const version = result.version!;
    const summary = `${task.key} plan saved as v${version.version} · ${lines(version.added, version.removed)} · state ${result.plan.state}. Next edit: --base-version ${version.version}`;
    return input.options.json ? JSON.stringify({ plan: result.plan, version }) : summary;
  }

  /** Text from a file on the calling machine, or inline when no file is given. */
  async function body(ctx: PluginCliContext, machine: string | undefined, file: string | undefined, inline?: string) {
    const hostId = file === undefined ? undefined : await resolveClientHostId(bb, domain, machine, ctx);
    return readTextOption(bb, ctx, hostId, inline, file);
  }

  const noPlan = (key: string) => `${key} has no plan yet; create it with \`bb work-board plan set ${key} --file plan.md --base-version 0 --summary "..."\``;

  return {
    plan: cliCommand({
      summary: "Task plan: one versioned Markdown document per task",
      hidden: true,
      description: [
        "Subcommands:",
        "  bb work-board plan show KEY [--section HEADING] [--version N]",
        "  bb work-board plan set KEY (--file PATH | --body TEXT) --base-version N --summary TEXT",
        "  bb work-board plan edit KEY --section HEADING (--file PATH | --body TEXT) --base-version N --summary TEXT",
        "  bb work-board plan edit KEY --find-file PATH --replace-file PATH --base-version N --summary TEXT",
        "  bb work-board plan restore KEY --version N --base-version N --summary TEXT",
        "  bb work-board plan log KEY",
        "  bb work-board plan diff KEY [--from N] [--to M]",
        "  bb work-board plan submit KEY",
      ].join("\n"),
      positionals: [{ name: "subcommand", description: "show, set, edit, restore, log, diff or submit", variadic: true }],
      options: common,
      run(input) {
        const [subcommand] = input.positionals.subcommand;
        if (subcommand === undefined) return { exitCode: 1, stdout: input.help };
        throw new PluginCliError(`unknown command: plan ${subcommand}`, { code: "unknown_command", hint: "run bb work-board plan --help for its subcommands" });
      },
    }),
    "plan show": cliCommand({
      summary: "Print the task plan with its version, state and the base version for the next edit",
      positionals: [deps.keyPositional],
      options: {
        section: { type: "string", placeholder: "heading", description: 'Only this section, by heading text or "Parent > Child" path' },
        version: { type: "integer", min: 1, max: MAX_VERSION, placeholder: "N", description: "An earlier version instead of the current one" },
        ...common,
      },
      run(input) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const { plan } = tasksRpcContract.getTaskPlan.output.parse(await domain.getTaskPlan({ taskId: task.id, version: input.options.version }));
          if (!plan) return input.options.json ? JSON.stringify({ plan: null }) : fail(noPlan(task.key), "plan_not_found");
          let text = plan.requested.body;
          if (input.options.section !== undefined) {
            try {
              text = getSection(text, input.options.section);
            } catch (error) {
              return fail(error instanceof Error ? error.message : String(error), "section_not_found");
            }
          }
          if (input.options.json)
            return JSON.stringify({ taskKey: task.key, plan: { ...plan, requested: undefined }, requested: { ...plan.requested, body: undefined }, section: input.options.section ?? null, body: text });
          const historical = plan.requested.version !== plan.version;
          return [
            `Plan v${plan.version} · ${plan.state} · updated ${plan.updatedAt} by ${plan.updatedBy.name}`,
            `Next edit: --base-version ${plan.version}`,
            ...(historical ? [`Showing historical v${plan.requested.version} (${plan.requested.summary}); do not use it as a base version`] : []),
            ...(input.options.section !== undefined ? [`Section: ${input.options.section}`] : []),
            "",
            text,
          ].join("\n");
        });
      },
    }),
    "plan set": cliCommand({
      summary: "Replace the whole plan (the first version uses --base-version 0)",
      positionals: [deps.keyPositional],
      options: {
        file: { type: "string", placeholder: "path", description: "Markdown file with the full plan" },
        body: { type: "string", description: "The full plan as text" },
        machine: deps.machineOption,
        ...writeOptions,
      },
      constraints: [{ kind: "exactly-one", options: ["file", "body"] }],
      run(input, ctx) {
        return guard(async () => {
          const text = await body(ctx, input.options.machine, input.options.file, input.options.body);
          return save(input, ctx, () => ({ op: "replace", body: text! }));
        });
      },
    }),
    "plan edit": cliCommand({
      summary: "Edit one section (by heading) or one exact fragment of the plan",
      positionals: [deps.keyPositional],
      options: {
        section: { type: "string", placeholder: "heading", description: 'Heading text or "Parent > Child" path; the replacement covers the heading line too, and an empty one deletes the section' },
        file: { type: "string", placeholder: "path", description: "Markdown file with the new section" },
        body: { type: "string", description: "The new section as text" },
        "find-file": { type: "string", placeholder: "path", description: "File with the exact text to replace; it must occur exactly once in the plan" },
        "replace-file": { type: "string", placeholder: "path", description: "File with the replacement text (may be empty)" },
        machine: deps.machineOption,
        ...writeOptions,
      },
      constraints: [
        { kind: "exactly-one", options: ["section", "find-file"] },
        { kind: "at-most-one", options: ["file", "body"] },
        { kind: "requires", option: "find-file", needs: ["replace-file"] },
        { kind: "requires", option: "replace-file", needs: ["find-file"] },
      ],
      run(input, ctx) {
        return guard(async () => {
          const { section } = input.options;
          if (section !== undefined) {
            if (input.options.file === undefined && input.options.body === undefined) fail("--section needs the new section from --file or --body", "missing_required");
            const text = await body(ctx, input.options.machine, input.options.file, input.options.body);
            return save(input, ctx, () => ({ op: "section", section, body: text! }));
          }
          if (input.options.file !== undefined || input.options.body !== undefined) fail("--find-file edits take --replace-file, not --file or --body", "invalid_value");
          const find = await body(ctx, input.options.machine, input.options["find-file"]);
          const replace = await body(ctx, input.options.machine, input.options["replace-file"]);
          return save(input, ctx, () => ({ op: "fragment", find: find!, replace: replace! }));
        });
      },
    }),
    "plan restore": cliCommand({
      summary: "Make an earlier version the newest one (history is kept)",
      positionals: [deps.keyPositional],
      options: {
        version: { type: "integer", min: 1, max: MAX_VERSION, required: true, placeholder: "N", description: "Version to restore" },
        ...writeOptions,
      },
      run(input, ctx) {
        return guard(() => save(input, ctx, () => ({ op: "restore", restoreVersion: input.options.version })));
      },
    }),
    "plan log": cliCommand({
      summary: "List plan versions: who changed what and how much",
      positionals: [deps.keyPositional],
      options: common,
      run(input) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const { plan, versions } = tasksRpcContract.listTaskPlanVersions.output.parse(await domain.listTaskPlanVersions({ taskId: task.id }));
          if (input.options.json) return JSON.stringify({ plan, versions });
          if (!plan) return noPlan(task.key);
          return table(
            ["VERSION", "WHEN", "AUTHOR", "OP", "CHANGE", "SUMMARY"],
            versions.map((version) => [`v${version.version}`, version.createdAt, version.author.name, version.target ? `${version.op} ${version.target}` : version.op, lines(version.added, version.removed), version.summary]),
            "(none)",
          );
        });
      },
    }),
    "plan diff": cliCommand({
      summary: "Unified line diff between two versions (default: previous → current)",
      positionals: [deps.keyPositional],
      options: {
        from: { type: "integer", min: 0, max: MAX_VERSION, placeholder: "N", description: "Older version (0 is the empty plan)" },
        to: { type: "integer", min: 1, max: MAX_VERSION, placeholder: "M", description: "Newer version (default: current)" },
        ...common,
      },
      run(input) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const result = tasksRpcContract.diffTaskPlan.output.parse(await domain.diffTaskPlan({ taskId: task.id, from: input.options.from, to: input.options.to }));
          return input.options.json ? JSON.stringify(result) : `${task.key} plan v${result.from} → v${result.to} · ${lines(result.added, result.removed)}\n${result.patch}`;
        });
      },
    }),
    "plan submit": cliCommand({
      summary: "Mark the plan ready for the owner's review",
      positionals: [deps.keyPositional],
      options: common,
      run(input, ctx) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const result = unwrap(tasksRpcContract.submitTaskPlan.output.parse(await domain.submitTaskPlan({ taskId: task.id, author: authorOf(ctx) })));
          return input.options.json ? JSON.stringify({ plan: result.plan }) : oneLine(`${task.key} plan v${result.plan.version} submitted for review`);
        });
      },
    }),
  };
}
