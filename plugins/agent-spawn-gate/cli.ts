import { parseArgs } from "node:util";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { createMetrics } from "./metrics";
import type { createStart } from "./start";

export function registerGateCli(bb: BbPluginApi, { start, report, configGet, configSet }: {
  start: ReturnType<typeof createStart>;
  report: Awaited<ReturnType<typeof createMetrics>>["report"];
  configGet: (input: unknown) => Promise<unknown>;
  configSet: (input: unknown) => Promise<unknown>;
}) {
  const usage = "bb agent-spawn-gate start [--project <id>] [--parent-thread <id>] [--dry-run] -- <builder args...>";
  const reportUsage = "bb agent-spawn-gate report [--project <id>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]";
  const configUsage = "bb agent-spawn-gate config get [<key>] | set <key> <value> --project <id>";
  bb.cli.register({ name: "agent-spawn-gate", summary: "Start children with admission, configure projects, and report gate activity", rendersHelp: true,
    commands: [
      { name: "start", summary: "Refresh the builder, validate its JSON, mint and start", usage },
      { name: "report", summary: "Report gate activity over an inclusive UTC date window", usage: reportUsage },
      { name: "config", summary: "Read or change per-project settings", usage: configUsage },
    ],
    async run(argv, ctx) {
      try {
        if (!argv.length || argv.includes("--help") && !argv.includes("--")) {
          const stdout = argv[0] === "report" ? reportUsage : argv[0] === "config" ? configUsage : [usage, reportUsage, configUsage].join("\n");
          return { exitCode: 0, stdout };
        }
        if (argv[0] === "report") {
          const { values } = parseArgs({ args: argv.slice(1), options: {
            project: { type: "string" }, from: { type: "string" }, to: { type: "string" }, json: { type: "boolean" },
          } });
          const result = await report({ projectId: values.project, from: values.from, to: values.to });
          return { exitCode: 0, stdout: JSON.stringify(result) };
        }
        if (argv[0] === "config") {
          const { values, positionals } = parseArgs({ args: argv.slice(1), allowPositionals: true, options: {
            project: { type: "string" }, json: { type: "boolean" },
          } });
          const [action, key, rawValue] = positionals;
          const projectId = values.project ?? ctx.projectId;
          if (!projectId) throw new Error("Supply --project when no bb project context is available");
          if (action === "get" && positionals.length <= 2) {
            return { exitCode: 0, stdout: JSON.stringify(await configGet({ projectId, key })) };
          }
          if (action === "set" && positionals.length === 3) {
            const value = key === "enabled" || key === "ttlMinutes" ? JSON.parse(rawValue!) : rawValue;
            return { exitCode: 0, stdout: JSON.stringify(await configSet({ projectId, key, value })) };
          }
          throw new Error(configUsage);
        }
        if (argv[0] !== "start") throw new Error(`Unknown command. ${usage}`);
        let projectId = ctx.projectId, parentThreadId = ctx.threadId, dryRun = false, args: string[] = [];
        for (let i = 1; i < argv.length; i++) {
          const flag = argv[i];
          if (flag === "--") { args = argv.slice(i + 1); break; }
          if (flag === "--dry-run") dryRun = true;
          else if (flag === "--json") continue;
          else if (flag === "--project" || flag === "--parent-thread") {
            const value = argv[++i];
            if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
            if (flag === "--project") projectId = value; else parentThreadId = value;
          } else throw new Error(`Unknown option ${flag}; builder arguments must follow --`);
        }
        if (!projectId || !parentThreadId) throw new Error("Supply --project and --parent-thread when no bb thread context is available");
        const result = await start({ projectId, parentThreadId, args, dryRun }, ctx.signal);
        return { exitCode: 0, stdout: JSON.stringify(result) };
      } catch (error) { return { exitCode: 1, stderr: error instanceof Error ? error.message : String(error) }; }
    },
  });
}
