import { cliCommand, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { detail } from "../cli/format";
import { HISTORY_DAYS } from "./history";
import { checksService } from "./service";
import type { TransferResult } from "./transfer";

/** Helpers owned by cli/index.ts (project addressing, error mapping), injected so this module never imports the big CLI file. */
export interface ChecksCliHost {
  group(name: string, summary: string, subcommands: readonly (readonly [string, string])[]): ReturnType<typeof cliCommand>;
  project(ctx: PluginCliContext, address: string | undefined): Promise<{ id: string; prefix: string }>;
  guard(action: () => Promise<string | PluginCliResult>): Promise<PluginCliResult>;
}

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const PROJECT_OPTION = { type: "string", required: true, placeholder: "prefix-or-id", description: "Tracker project prefix or id such as ABC, never a bb project id (proj_...) (required)" } as const;
const when = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString());

const TRANSFER_NOTE = "Each command is idempotent and leaves the receiving side disabled; enabling stays the owner's action. Fingerprints differ slightly between Sweep and Work Board for archived-worktree and blank lines, so the first report after a transfer may repeat once.";

export function checksCliCommands(bb: BbPluginApi, host: ChecksCliHost) {
  const service = checksService(bb);
  const transferCommand = (name: string, summary: string, run: (trackerId: string) => Promise<TransferResult>) => [`checks ${name}`, cliCommand({
    summary: `${summary}. ${TRANSFER_NOTE}`,
    options: { project: PROJECT_OPTION, json: JSON_OPTION },
    run: (input, ctx) => host.guard(async () => {
      const project = await host.project(ctx, input.options.project);
      const result = await run(project.id);
      return input.options.json ? JSON.stringify(result) : `${result.message}${result.warning ? `\nWarning: ${result.warning}` : ""}`;
    }),
  })] as const;
  const transferCommands = () => Object.fromEntries([
    transferCommand("import-from-sweep", "Move Sweep's state for this bb project to Work Board; Sweep must be disabled, idle and drained", (id) => service.transfer.importFromSweep(id)),
    transferCommand("export-to-sweep", "Hand the runner state back to Sweep (rollback); resumes an unconfirmed send; Work Board checks must be disabled and drained", (id) => service.transfer.exportToSweep(id)),
    transferCommand("cancel-sweep-send", "Confirm or cancel a send from Sweep that Work Board never committed", (id) => service.transfer.cancelSweepSend(id)),
    transferCommand("abort-send", "Clear an unconfirmed send to Sweep that Sweep keeps refusing; Work Board keeps the runner and its state", (id) => service.transfer.abortSend(id)),
    transferCommand("release", "Give up Work Board's ownership of the runner of a single-plugin setup (a row without transfer lineage)", (id) => service.transfer.release(id)),
  ]);
  return {
    checks: host.group("checks", "Repository checks: status, a manual run, and run statistics", [
      ["status", "Last and next run, exit, failure stage, pending report and delivery"],
      ["run", "Refresh the checkout and run the script once; never delivers or changes state"],
      ["stats", "Scheduled-run statistics for the last 1-30 days"],
      ["import-from-sweep", "Move Sweep's state for this project to Work Board (Sweep must be disabled and idle)"],
      ["export-to-sweep", "Hand the runner state back to Sweep (rollback; Work Board checks must be disabled and drained)"],
      ["cancel-sweep-send", "Confirm or cancel a send from Sweep that Work Board never committed"],
      ["abort-send", "Clear a send to Sweep that Sweep keeps refusing; Work Board keeps the runner"],
      ["release", "Give up Work Board's ownership of the runner (single-plugin setups only)"],
    ]),
    "checks status": cliCommand({
      summary: "Read the runner's last and next run, exit, failure stage, pending report and delivery receipt",
      options: { project: PROJECT_OPTION, json: JSON_OPTION },
      run: (input, ctx) => host.guard(async () => {
        const project = await host.project(ctx, input.options.project);
        const status = service.status(project.id);
        if (input.options.json) return JSON.stringify(status);
        return detail([
          ["Project", `${project.prefix} → ${status.bbProjectId ?? "(not linked)"}`],
          ["Enabled", String(status.config.enabled)],
          ["Draining", String(status.draining)],
          ["Manager", status.manager ?? "(unset)"],
          ["Last run", when(status.lastRun)],
          ["Next run", when(status.nextRun)],
          ["Exit", String(status.exitCode ?? "-")],
          ["Failure stage", status.failureStage ?? "-"],
          ["Error", status.error ?? "-"],
          ["Delivery error", status.deliveryError ?? "-"],
          ["Blocked", status.blocked ?? "-"],
          ["Runner owner", status.runnerOwner],
          ["Unconfirmed send", status.unconfirmedSend ?? "-"],
          ["Pending", status.pending ? `${status.pending.reportId} (exit ${status.pending.exitCode}, tick ${status.pending.tickId})` : "-"],
          ["Last delivery", status.lastDelivery ? `${when(status.lastDelivery.at)} to ${status.lastDelivery.to} (${status.lastDelivery.receipt?.mode ?? "-"})` : "-"],
          ["Archived worktrees", `${status.reportedWorktrees} reported, ${status.pendingWorktrees} pending`],
          ["Manager error", status.managerError ?? "-"],
          ["Push error", status.pushError ?? "-"],
          ["State", status.stateMismatch ?? "ok"],
          ["Today", `${status.stats.ticks} ticks, ${status.stats.executed} executed, ${status.stats.deliveries} delivered`],
        ]);
      }),
    }),
    "checks run": cliCommand({
      summary: "Refresh the checkout and run the script once. It never stages, delivers, promotes or counts, and never retries a pending report; the script itself may still have side effects",
      options: { project: PROJECT_OPTION, "dry-run": { type: "boolean", description: "Accepted for clarity: a manual run never changes runner state" }, json: JSON_OPTION },
      run: (input, ctx) => host.guard(async () => {
        const project = await host.project(ctx, input.options.project);
        const result = await service.manualRun(project.id);
        return input.options.json ? JSON.stringify(result) : `exit ${result.exitCode}\n${result.output}`;
      }),
    }),
    ...transferCommands(),
    "checks stats": cliCommand({
      summary: `Read scheduled-run statistics for the last 1-${HISTORY_DAYS} days (default 1)`,
      options: { project: PROJECT_OPTION, days: { type: "integer", min: 1, max: HISTORY_DAYS, default: 1, description: `Days (1-${HISTORY_DAYS})` }, json: JSON_OPTION },
      run: (input, ctx) => host.guard(async () => {
        const project = await host.project(ctx, input.options.project);
        const stats = service.stats(project.id, input.options.days ?? 1);
        return input.options.json ? JSON.stringify(stats) : detail([
          ["Window", `${stats.days} day(s)`], ["Ticks", String(stats.ticks)], ["Executed", String(stats.executed)], ["Deliveries", String(stats.deliveries)],
          ["Repeats", String(stats.repeats)], ["Suppressed reports", String(stats.suppressedReports)], ["Refresh failures", String(stats.refreshFailures)],
          ["Script failures", String(stats.scriptFailures)], ["Delivery failures", String(stats.deliveryFailures)], ["Delivery unknown", String(stats.deliveryUnknown)], ["New items", JSON.stringify(stats.newItems)],
        ]);
      }),
    }),
  };
}
