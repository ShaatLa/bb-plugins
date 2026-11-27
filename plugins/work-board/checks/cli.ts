import { cliCommand, type BbPluginApi, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { detail } from "../cli/format";
import { HISTORY_DAYS } from "./history";
import { checksService } from "./service";

/** Helpers owned by cli/index.ts (project addressing, error mapping), injected so this module never imports the big CLI file. */
export interface ChecksCliHost {
  group(name: string, summary: string, subcommands: readonly (readonly [string, string])[]): ReturnType<typeof cliCommand>;
  project(ctx: PluginCliContext, address: string | undefined): Promise<{ id: string; prefix: string }>;
  guard(action: () => Promise<string | PluginCliResult>): Promise<PluginCliResult>;
}

const JSON_OPTION = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const PROJECT_OPTION = { type: "string", required: true, placeholder: "prefix-or-id", description: "Tracker project prefix or id such as ABC, never a bb project id (proj_...) (required)" } as const;
const when = (ms: number | null) => (ms === null ? "-" : new Date(ms).toISOString());

export function checksCliCommands(bb: BbPluginApi, host: ChecksCliHost) {
  const service = checksService(bb);
  return {
    checks: host.group("checks", "Repository checks: status, a manual run, and run statistics", [
      ["status", "Last and next run, exit, failure stage, pending report and delivery"],
      ["run", "Refresh the checkout and run the script once; never delivers or changes state"],
      ["stats", "Scheduled-run statistics for the last 1-30 days"],
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
          ["Last decision", status.lastDecision ? `${status.lastDecision.decision === "skip-unchanged" ? "skipped (unchanged)" : status.lastDecision.decision === "deliver" ? `staged (${status.lastDecision.reasons.join(", ")})` : status.lastDecision.decision === "remind" ? "reminder staged" : "quiet"} · ${when(status.lastDecision.at)}` : "-"],
          ["Next run", when(status.nextRun)],
          ["Exit", String(status.exitCode ?? "-")],
          ["Failure stage", status.failureStage ?? "-"],
          ["Error", status.error ?? "-"],
          ["Delivery error", status.deliveryError ?? "-"],
          ["Blocked", status.blocked ?? "-"],
          ["Pending", status.pending ? `${status.pending.reportId} (exit ${status.pending.exitCode}, tick ${status.pending.tickId})` : "-"],
          ["Last delivery", status.lastDelivery ? `${when(status.lastDelivery.at)} to ${status.lastDelivery.to} (${status.lastDelivery.receipt?.mode ?? "-"})` : "-"],
          ["Fallback reason", status.fallbackReason ?? "-"],
          ["Archived worktrees", `${status.reportedWorktrees} reported, ${status.pendingWorktrees} pending, ${status.worktreeRootFailures} unreadable roots`],
          ["Manager error", status.managerError ?? "-"],
          ["Push error", status.pushError ?? "-"],
          ["State", status.stateMismatch ?? "ok"],
          ["Today", `${status.stats.ticks} ticks, ${status.stats.executed} executed, ${status.stats.deliveries} delivered (${status.stats.notices} as notice)`],
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
    "checks stats": cliCommand({
      summary: `Read scheduled-run statistics for the last 1-${HISTORY_DAYS} days (default 1)`,
      options: { project: PROJECT_OPTION, days: { type: "integer", min: 1, max: HISTORY_DAYS, default: 1, description: `Days (1-${HISTORY_DAYS})` }, json: JSON_OPTION },
      run: (input, ctx) => host.guard(async () => {
        const project = await host.project(ctx, input.options.project);
        const stats = service.stats(project.id, input.options.days ?? 1);
        return input.options.json ? JSON.stringify(stats) : detail([
          ["Window", `${stats.days} day(s)`], ["Ticks", String(stats.ticks)], ["Executed", String(stats.executed)], ["Deliveries", String(stats.deliveries)], ["Delivered as notice", String(stats.notices)],
          ["Repeats", String(stats.repeats)], ["Suppressed reports", String(stats.suppressedReports)], ["Refresh failures", String(stats.refreshFailures)],
          ["Script failures", String(stats.scriptFailures)], ["Delivery failures", String(stats.deliveryFailures)], ["Delivery unknown", String(stats.deliveryUnknown)], ["New items", JSON.stringify(stats.newItems)],
        ]);
      }),
    }),
  };
}
