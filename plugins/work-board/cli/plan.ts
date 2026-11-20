import { PluginCliError, cliCommand, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import type { createPlanReviewFlow, registerHandlers } from "../api";
import { planReviewerInputSchema, tasksRpcContract, type PlanAuthor, type SaveTaskPlanInput, type Task } from "../shared/contract";
import { getSection } from "../shared/plan";
import { buildFeedbackBody, noteLabel, orderNotes, parseNoteNumber, PLAN_NOTE_KINDS, renderNote } from "../shared/plan-notes";
import { oneLine, table } from "./format";

type Domain = ReturnType<typeof registerHandlers>;

/** The shared CLI helpers of cli/index.ts, passed in so this file stays free of import cycles. */
export interface PlanCliDeps {
  bb: BbPluginApi;
  domain: Domain;
  /** Reviewer commands and decisions; not part of the RPC contract. */
  review: ReturnType<typeof createPlanReviewFlow>;
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
  const { bb, domain, review, guard, resolveTask, resolveClientHostId, readTextOption, taskAuthor } = deps;
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

  /** The calling thread of a reviewer command; a call without one is refused. */
  function reviewerOf(ctx: PluginCliContext): PlanAuthor {
    if (!ctx.threadId) return fail("Reviewer commands run from the reviewer's own bb thread; this call has no thread id", "no_thread");
    return authorOf(ctx);
  }
  const versionOption = { type: "integer" as const, min: 1, max: MAX_VERSION, required: true as const, placeholder: "N", description: "The plan version you read; a decision on any other version is refused" };
  /** Note numbers such as `N1 3`, as printed by `plan notes`. */
  function noteNumbers(key: string, tokens: readonly string[]): number[] {
    if (tokens.length === 0) return fail("Name at least one note, for example N1", "missing_required");
    return tokens.map((token) => parseNoteNumber(token) ?? fail(`"${token}" is not a note number; use N1, N2 … as printed by \`bb work-board plan notes ${key} --all\``, "invalid_value"));
  }
  /** Who got a result, and what to do by hand when someone did not. A failed delivery never undoes the decision. */
  function deliveryReport(key: string, version: number, verdict: string, deliveries: ReadonlyArray<{ role: "actor" | "copy"; delivered: string; threadId: string | null }>): string {
    const lines = deliveries.map((entry) =>
      entry.delivered === "sent" ? `${entry.role === "actor" ? "Notified" : "Copy sent to"} ${entry.threadId}` : `Not delivered${entry.threadId ? ` to ${entry.threadId}` : ""} (${entry.delivered})`,
    );
    const missed = deliveries.filter((entry) => entry.delivered !== "sent");
    if (missed.length)
      lines.push(
        `Saved, but tell ${missed.map((entry) => entry.threadId ?? "the plan author").join(", ")} yourself: ${key} plan v${version} ${verdict}. They read it with \`bb work-board plan show ${key}\` and \`bb work-board plan notes ${key} --all\`.`,
      );
    return lines.join("\n");
  }

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
        "  bb work-board plan submit KEY --reviewer owner|thr_x   (owner only when the user asked to approve the plan)",
        "  bb work-board plan notes KEY [--all]",
        "  bb work-board plan reply KEY N1 --body TEXT [--addressed]",
        "  bb work-board plan reviews KEY",
        "Reviewer commands, from the reviewer thread only (every one takes --version N, the version you read):",
        '  bb work-board plan note KEY --version N --body TEXT [--quote TEXT [--section HEADING]] [--kind comment|remove|general]',
        "  bb work-board plan feedback KEY --version N",
        "  bb work-board plan dismiss KEY N1 … --version N",
        "  bb work-board plan resolve KEY N1 … --version N",
        "  bb work-board plan reopen KEY N1 … --version N",
        "  bb work-board plan approve KEY --version N [--note TEXT]",
      ].join("\n"),
      positionals: [{ name: "subcommand", description: "show, set, edit, restore, log, diff, submit, notes, reply, reviews, note, feedback, dismiss, resolve, reopen or approve", variadic: true }],
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
            `Plan v${plan.version} · ${plan.state} · updated ${plan.updatedAt} by ${plan.updatedBy.name}${plan.noteCounts.open ? ` · ${plan.noteCounts.open} open note${plan.noteCounts.open === 1 ? "" : "s"}` : ""}`,
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
      summary: "Submit the plan for review by a reviewer thread, or by the owner when the user asked to approve it",
      positionals: [deps.keyPositional],
      options: {
        reviewer: {
          type: "string",
          placeholder: "owner|thr_x",
          description: "Who approves the plan: a reviewer thread, or `owner` only when the user asked to approve the plan. Required on the first submit; later it defaults to the current reviewer. Another reviewer takes the review over",
        },
        ...common,
      },
      run(input, ctx) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          let reviewer: string | undefined;
          if (input.options.reviewer !== undefined) {
            const parsed = planReviewerInputSchema.safeParse(input.options.reviewer);
            if (!parsed.success) return fail(`--reviewer: ${parsed.error.issues[0]?.message ?? "invalid"}`, "invalid_value");
            reviewer = parsed.data;
          }
          // Notes sent to the author and nobody answered: submitting does not refuse, but the agent should know.
          // A new version already moved the plan from changes_requested back to draft, so the notes decide, not the state.
          const unanswered = (await domain.listPlanNotes({ taskId: task.id })).notes.filter((note) => note.state === "sent");
          const result = unwrap(tasksRpcContract.submitTaskPlan.output.parse(await domain.submitTaskPlan({ taskId: task.id, author: authorOf(ctx), ...(reviewer ? { reviewer } : {}) })));
          if (input.options.json) return JSON.stringify({ plan: result.plan, outcome: result.outcome, delivered: result.delivered, deliveryHint: result.deliveryHint, unansweredNotes: unanswered.map((note) => note.number) });
          const asked = result.plan.reviewer.kind === "thread" ? result.plan.reviewer.threadId : "the owner";
          const headline = {
            submitted: `${task.key} plan v${result.plan.version} submitted for review by ${asked}`,
            resent: `${task.key} plan v${result.plan.version} is already in review by ${asked}; the wake was sent again`,
            reassigned: `${task.key} plan v${result.plan.version}: review reassigned to ${asked}`,
          }[result.outcome];
          const delivery = result.delivered === "sent" ? `Reviewer ${asked} notified` : result.delivered === "failed" ? `Reviewer ${asked} not notified: ${result.deliveryHint}` : "The owner reviews it in the Plan tab";
          const warning = unanswered.length
            ? `\nWarning: ${unanswered.length} note${unanswered.length === 1 ? " is" : "s are"} still unanswered: ${unanswered.map((note) => noteLabel(note.number)).join(", ")}. Answer each with \`bb work-board plan reply ${task.key} N1 --body "…" --addressed\`.`
            : "";
          return `${oneLine(headline)}\n${delivery}${warning}`;
        });
      },
    }),
    "plan notes": cliCommand({
      summary: "The notes on the plan (the owner's and the reviewer's): the open ones by default, in the order of the review message",
      positionals: [deps.keyPositional],
      options: {
        all: { type: "boolean", description: "Every note with its state and your reply, not only the sent ones you have not answered" },
        ...common,
      },
      run(input) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const { plan } = tasksRpcContract.getTaskPlan.output.parse(await domain.getTaskPlan({ taskId: task.id }));
          if (!plan) return input.options.json ? JSON.stringify({ taskKey: task.key, version: null, notes: [] }) : fail(noPlan(task.key), "plan_not_found");
          const { notes } = tasksRpcContract.listPlanNotes.output.parse(await domain.listPlanNotes({ taskId: task.id }));
          const ordered = orderNotes(input.options.all ? notes : notes.filter((note) => note.state === "sent"), plan.requested.body);
          if (input.options.json) return JSON.stringify({ taskKey: task.key, version: plan.version, noteCounts: plan.noteCounts, notes: ordered.map(({ note, placement }) => ({ ...note, placement })) });
          if (ordered.length === 0) return input.options.all ? `${task.key} plan has no notes` : `${task.key} plan has no open notes`;
          if (input.options.all)
            return [`Notes on ${task.key} plan v${plan.version} (${ordered.length}), in plan order:`, "", ordered.map(({ note, placement }) => renderNote(note, placement, { detail: true })).join("\n\n")].join("\n");
          return buildFeedbackBody({ taskKey: task.key, version: plan.version, notes: ordered, reviewer: plan.reviewer.kind === "thread" && plan.reviewer.threadId ? plan.reviewer.threadId : "owner" });
        });
      },
    }),
    "plan reply": cliCommand({
      summary: "Answer one of the notes sent to you; --addressed marks it done in the current plan version",
      positionals: [deps.keyPositional, { name: "note", description: "Note number, for example N1", required: true }],
      options: {
        body: { type: "string", required: true, description: "What changed, or why not" },
        addressed: { type: "boolean", description: "The current plan version answers this note" },
        json: deps.jsonOption,
      },
      run(input, ctx) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const number = parseNoteNumber(input.positionals.note);
          if (number === null) return fail(`"${input.positionals.note}" is not a note number; use N1, N2 … as printed by \`bb work-board plan notes ${task.key}\``, "invalid_value");
          const result = unwrap(
            tasksRpcContract.replyPlanNote.output.parse(await domain.replyPlanNote({ taskId: task.id, number, body: input.options.body, addressed: input.options.addressed === true, author: authorOf(ctx) })),
          );
          return input.options.json
            ? JSON.stringify({ note: result.note })
            : oneLine(`${task.key} ${noteLabel(number)} answered${result.note.state === "addressed" ? ` · addressed in v${result.note.addressedInVersion}` : " · not marked addressed"}`);
        });
      },
    }),
    "plan reviews": cliCommand({
      summary: "The review attempts of the plan: version, reviewer thread, outcome and dates",
      positionals: [deps.keyPositional],
      options: common,
      run(input) {
        return guard(async () => {
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const { reviews } = tasksRpcContract.listPlanReviews.output.parse(await domain.listPlanReviews({ taskId: task.id }));
          if (input.options.json) return JSON.stringify({ taskKey: task.key, reviews });
          return table(
            ["VERSION", "REVIEWER", "SUBMITTED", "OUTCOME", "DECIDED", "BY"],
            reviews.map((review) => [`v${review.version}`, review.reviewer.kind === "thread" ? review.reviewer.threadId! : "owner", review.submittedAt, review.outcome, review.decidedAt ?? "-", review.decidedBy ?? "-"]),
            "(none)",
          );
        });
      },
    }),
    "plan note": cliCommand({
      summary: "Reviewer: add a draft note on the plan; `plan feedback` sends the drafts",
      positionals: [deps.keyPositional],
      options: {
        version: versionOption,
        body: { type: "string", description: "The note; required unless --kind remove" },
        quote: { type: "string", description: "Exact text of the passage; it must occur exactly once in the section (or in the whole plan without --section)" },
        section: { type: "string", placeholder: "heading", description: "Heading text or \"Parent > Child\" path that scopes the quote" },
        kind: { type: "string", placeholder: "comment|remove|general", choices: [...PLAN_NOTE_KINDS], description: "Default: comment with --quote, else general" },
        json: deps.jsonOption,
      },
      constraints: [{ kind: "requires", option: "section", needs: ["quote"] }],
      run(input, ctx) {
        return guard(async () => {
          const by = reviewerOf(ctx);
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const { quote, section, kind } = input.options;
          const result = unwrap(await review.addNote({ taskId: task.id, by, version: input.options.version, body: input.options.body ?? "", ...(quote !== undefined ? { quote } : {}), ...(section !== undefined ? { section } : {}), ...(kind ? { kind: kind as (typeof PLAN_NOTE_KINDS)[number] } : {}) }));
          return input.options.json ? JSON.stringify({ note: result.note }) : oneLine(`${task.key} ${noteLabel(result.note.number)} saved as a draft on v${result.note.madeOnVersion}; \`plan feedback ${task.key} --version ${result.note.madeOnVersion}\` sends your drafts`);
        });
      },
    }),
    "plan feedback": cliCommand({
      summary: "Reviewer: send every reviewer draft to the plan author and request changes",
      positionals: [deps.keyPositional],
      options: { version: versionOption, json: deps.jsonOption },
      run(input, ctx) {
        return guard(async () => {
          const by = reviewerOf(ctx);
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const result = unwrap(await review.sendFeedback(task.id, by, input.options.version));
          if (input.options.json) return JSON.stringify({ plan: result.plan, notes: result.notes, delivered: result.delivered, deliveries: result.deliveries });
          return [`${task.key} plan v${input.options.version}: changes requested · ${result.notes} note${result.notes === 1 ? "" : "s"} sent`, deliveryReport(task.key, input.options.version, "needs changes", result.deliveries)].join("\n");
        });
      },
    }),
    "plan dismiss": cliCommand({
      summary: "Reviewer: withdraw unsent drafts written by a reviewer thread (yours or a previous reviewer's)",
      positionals: [deps.keyPositional, { name: "notes", description: "Note numbers, for example N1 N2", required: true, variadic: true }],
      options: { version: versionOption, json: deps.jsonOption },
      run(input, ctx) {
        return guard(async () => {
          const by = reviewerOf(ctx);
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const numbers = noteNumbers(task.key, input.positionals.notes);
          const result = unwrap(await review.dismiss(task.id, by, input.options.version, numbers));
          return input.options.json ? JSON.stringify({ removed: result.removed }) : oneLine(`${task.key} dismissed ${result.removed.map(noteLabel).join(", ")}`);
        });
      },
    }),
    ...Object.fromEntries(
      (
        [
          ["resolve", "resolved", "Reviewer: resolve notes written by a reviewer thread (including a previous reviewer's) once the author's answer is enough"],
          ["reopen", "draft", "Reviewer: take notes written by a reviewer thread back to drafts, so the next feedback sends them again"],
        ] as const
      ).map(([action, state, summary]) => [
        `plan ${action}`,
        cliCommand({
          summary,
          positionals: [deps.keyPositional, { name: "notes", description: "Note numbers, for example N1 N2", required: true, variadic: true }],
          options: { version: versionOption, json: deps.jsonOption },
          run(input, ctx) {
            return guard(async () => {
              const by = reviewerOf(ctx);
              const task = await resolveTask(domain, input.positionals["key-or-id"]);
              const numbers = noteNumbers(task.key, input.positionals.notes);
              const result = unwrap(await review.setState(task.id, by, input.options.version, numbers, state));
              return input.options.json ? JSON.stringify({ notes: result.notes }) : oneLine(`${task.key} ${numbers.map(noteLabel).join(", ")} ${state === "resolved" ? "resolved" : "reopened as a draft"}`);
            });
          },
        }),
      ]),
    ),
    "plan approve": cliCommand({
      summary: "Reviewer: approve the plan; refused while any reviewer note is a draft or unresolved",
      positionals: [deps.keyPositional],
      options: { version: versionOption, note: { type: "string", description: "An optional remark that goes to the author" }, json: deps.jsonOption },
      run(input, ctx) {
        return guard(async () => {
          const by = reviewerOf(ctx);
          const task = await resolveTask(domain, input.positionals["key-or-id"]);
          const result = unwrap(await review.approve(task.id, by, input.options.note, input.options.version));
          if (input.options.json) return JSON.stringify({ plan: result.plan, delivered: result.delivered, deliveries: result.deliveries });
          return [`${task.key} plan v${input.options.version} approved`, deliveryReport(task.key, input.options.version, "is approved", result.deliveries)].join("\n");
        });
      },
    }),
  };
}
