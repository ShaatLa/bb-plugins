import { parseArgs } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { createMetrics } from "./metrics";
import type { createStart } from "./start";

function oneSelection(flag: string, values?: string[]) {
  if (values && values.length > 1) throw new Error(`Pass ${flag} only once`);
  return values?.[0];
}

export function registerGateCli(bb: BbPluginApi, { start, report, configGet, configSet, readInstructions }: {
  start: ReturnType<typeof createStart>;
  report: Awaited<ReturnType<typeof createMetrics>>["report"];
  configGet: (input: unknown) => Promise<unknown>;
  configSet: (input: unknown) => Promise<unknown>;
  readInstructions: (projectId: string, signal?: AbortSignal) => Promise<{ instruction: string; sourceBranch?: string; sourceCommit?: string }>;
}) {
  const usage = "bb agent-spawn-gate start [--project <id>] [--parent-thread <id>] [--machine <id-or-name>] [--requires-heavy-lease] [--dry-run] -- <builder args...>";
  const reportUsage = "bb agent-spawn-gate report [--project <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--events] [--json]";
  const instructionsUsage = "bb agent-spawn-gate instructions [--project <id>] [--json]";
  const configUsage = [
    "bb agent-spawn-gate config get [<key>] [--project <id>]",
    "bb agent-spawn-gate config set <key> <value> [--project <id>]",
  ].join("\n");
  const help = {
    start: [
      usage,
      "Script mode only. Omitted project and parent use the current thread context. Pass each selector once.",
      "Use --dry-run before -- to run the builder without minting or spawning. Builder args follow --.",
      "Use --machine to override the project's execution machine. Use --requires-heavy-lease if the child will need a heavy Slots lease.",
      "Example: bb agent-spawn-gate start --project proj_example --parent-thread thr_example --dry-run -- --card EXA-1",
    ].join("\n"),
    report: [
      reportUsage,
      "Reads all projects unless --project is passed. Dates are inclusive UTC, defaulting to seven days ending at --to (today if omitted). --events includes individual refusals, provider pace fallbacks and pinned overrides.",
      "Example: bb agent-spawn-gate report --project proj_example --from 2025-01-01 --to 2025-01-07 --events",
    ].join("\n"),
    instructions: [instructionsUsage, "Read current launch instructions for an Instruction-mode project."].join("\n"),
    config: [
      configUsage,
      "Omitting --project uses the current project. Pass it once. Read or change one field at a time.",
      "Fields: enabled (true|false), method (script|instruction), script (repository-relative path), remote (HTTPS or SSH Git remote, empty to use the project remote), branch (Git branch name, empty to use the remote default), instruction (legacy text), instructionFile (clone-relative path with Project Instructions), ttlMinutes (integer 1–60).",
      "Field machine accepts an enrolled machine ID or an unambiguous name. Set it to an empty string to restore normal placement.",
      "Example: bb agent-spawn-gate config set ttlMinutes 15 --project proj_example",
    ].join("\n"),
  };
  bb.cli.register({ name: "agent-spawn-gate", summary: "Start children with admission, configure projects, and report gate activity", rendersHelp: true,
    commands: [
      { name: "start", summary: "Refresh the builder, validate its JSON, mint and start", usage },
      { name: "report", summary: "Report gate activity over an inclusive UTC date window", usage: reportUsage },
      { name: "instructions", summary: "Read the current launch instructions", usage: instructionsUsage },
      { name: "config", summary: "Read or change per-project settings", usage: configUsage },
    ],
    async run(argv, ctx) {
      try {
        const separator = argv.indexOf("--");
        const options = argv.slice(1, separator < 0 ? undefined : separator);
        if (!argv.length || argv[0] === "--help" || options.includes("--help")) {
          const command = argv[0];
          const stdout = command === "start" || command === "report" || command === "config" || command === "instructions"
            ? help[command] : [usage, reportUsage, instructionsUsage, configUsage].join("\n");
          return { exitCode: 0, stdout };
        }
        if (argv[0] === "instructions") {
          const { values } = parseArgs({ args: argv.slice(1), options: {
            project: { type: "string", multiple: true }, json: { type: "boolean" },
          } });
          const projectId = oneSelection("--project", values.project) ?? ctx.projectId;
          if (!projectId) throw new Error("Supply --project when no bb project context is available");
          const result = await readInstructions(projectId, ctx.signal);
          return { exitCode: 0, stdout: values.json ? JSON.stringify(result) : result.instruction };
        }
        if (argv[0] === "report") {
          const { values } = parseArgs({ args: argv.slice(1), options: {
            project: { type: "string", multiple: true }, from: { type: "string" }, to: { type: "string" }, events: { type: "boolean" }, json: { type: "boolean" },
          } });
          const result = await report({ projectId: oneSelection("--project", values.project), from: values.from, to: values.to, events: values.events });
          return { exitCode: 0, stdout: JSON.stringify(result) };
        }
        if (argv[0] === "config") {
          const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
            project: { type: "string", multiple: true }, json: { type: "boolean" },
          } });
          const [action, key, rawValue] = positionals;
          const projectId = oneSelection("--project", values.project) ?? ctx.projectId;
          if (!projectId) throw new Error("Supply --project when no bb project context is available");
          if (action === "get" && positionals.length <= 2) {
            return { exitCode: 0, stdout: JSON.stringify(await configGet({ projectId, key })) };
          }
          if (action === "set" && positionals.length === 3) {
            if (key === "enabled" && rawValue !== "true" && rawValue !== "false") throw new Error("Set enabled to true or false");
            if (key === "ttlMinutes" && !/^(?:[1-9]|[1-5][0-9]|60)$/.test(rawValue)) throw new Error("Set ttlMinutes to a whole number from 1 to 60");
            const value = key === "enabled" ? rawValue === "true" : key === "ttlMinutes" ? Number(rawValue) : rawValue;
            return { exitCode: 0, stdout: JSON.stringify(await configSet({ projectId, key, value })) };
          }
          throw new Error(configUsage);
        }
        if (argv[0] !== "start") throw new Error(`Unknown command. ${usage}`);
        const { values } = parseArgs({ args: options, options: {
          project: { type: "string", multiple: true },
          "parent-thread": { type: "string", multiple: true },
          machine: { type: "string", multiple: true },
          "requires-heavy-lease": { type: "boolean" },
          "dry-run": { type: "boolean" },
          json: { type: "boolean" },
        } });
        const projectId = oneSelection("--project", values.project) ?? ctx.projectId;
        const parentThreadId = oneSelection("--parent-thread", values["parent-thread"]) ?? ctx.threadId;
        if (!projectId || !parentThreadId) throw new Error("Supply --project and --parent-thread for a parent in that project");
        const args = separator < 0 ? [] : argv.slice(separator + 1);
        const builderSeparator = args.indexOf("--");
        if (args.slice(0, builderSeparator < 0 ? undefined : builderSeparator).includes("--dry-run")) {
          throw new Error("Put --dry-run before the first -- to validate without launching");
        }
        const result = await start({
          projectId, parentThreadId, args, dryRun: values["dry-run"],
          machine: oneSelection("--machine", values.machine), requiresHeavyLease: values["requires-heavy-lease"],
        }, ctx.signal);
        return { exitCode: 0, stdout: JSON.stringify(result) };
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
