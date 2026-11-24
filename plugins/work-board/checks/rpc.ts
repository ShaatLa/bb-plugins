import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { tasksRpcContract } from "../shared/contract";
import { checksService } from "./service";

/** The owner's calls from the settings UI. `enabled` is written only here: `config set` refuses it. */
export function checksUiHandlers(bb: BbPluginApi): Pick<PluginRpcHandlers<typeof tasksRpcContract>, "getChecksStatus" | "updateChecksSetting" | "checks.configPatch" | "updateChecksEnabled" | "retryChecksReport" | "resetChecksState"> {
  const service = checksService(bb);
  return {
    getChecksStatus: ({ projectId }) => service.status(projectId),
    updateChecksSetting({ projectId, key, value }) { service.setField(projectId, key, value); return { ok: true as const }; },
    "checks.configPatch"({ projectId, patch }) { service.setFields(projectId, patch); return { ok: true as const }; },
    updateChecksEnabled: ({ projectId, enabled }) => service.setEnabled(projectId, enabled),
    retryChecksReport: ({ projectId }) => service.retry(projectId),
    resetChecksState: ({ projectId }) => service.reset(projectId),
  };
}

/** Registers the scheduler (cron, watchdog service); the runner stays off for every project until the owner enables it. */
export function registerChecks(bb: BbPluginApi): void {
  checksService(bb).register();
}
