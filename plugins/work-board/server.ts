import { registerPublicApi } from "./public-api";
import { migrateSettings } from "./settings";
import { registerGlobalSettings } from "./global-settings";
import { storageService } from "./storage";
import { gitSyncService } from "./git-sync/service";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { createStore, publishProjectsChanged, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerAttention } from "./attention/rpc";
import { registerChecks } from "./checks/rpc";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { TASK_LINK_INSTRUCTIONS } from "./shared/task-link";
import { registerMentions } from "./mentions";
import { planDebtService } from "./plan-debt/service";
import { autoArchiveTasks } from "./lifecycle/task-archive";
import { sweepPauseSignals } from "./pause/signals";
import { samplePauses } from "./pause/sample";
import pkg from "./package.json" with { type: "json" };

const WORK_BOARD_PLUGIN_NAME = "Work Board";
export const WORK_BOARD_PLUGIN_VERSION: string = pkg.version;

const tasksRpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ ok: z.literal(true), version: z.string() }),
  },
});

function statusPayload() {
  return { name: WORK_BOARD_PLUGIN_NAME, version: WORK_BOARD_PLUGIN_VERSION };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`${WORK_BOARD_PLUGIN_NAME} ${WORK_BOARD_PLUGIN_VERSION} loaded`);

  const store = createStore(bb);
  await migrateSettings(bb);
  await registerGlobalSettings(bb, () => {
    bb.realtime.publish("badge:changed", {});
    publishProjectsChanged(bb, null);
  });
  registerTasksApi(bb, store);
  registerAttention(bb);
  registerChecks(bb);
  registerAttachments(bb, store.tasks);
  registerTasksCli(bb, store, statusPayload());
  registerDelegation(bb, store);
  registerPublicApi(bb, store.tasks);
  registerMentions(bb, store);
  planDebtService(bb, store.tasks).register();
  // Read when a provider session starts, so only threads started or resumed after install see it.
  bb.agents.contributeInstructions(({ projectId }) =>
    store.tasks.listProjects().some((project) => project.linkedBbProjectId === projectId)
      ? TASK_LINK_INSTRUCTIONS
      : null,
  );
  // Reconciling every attached thread takes one SDK call each; doing it before load completes
  // made the plugin miss bb's 30 s load deadline on a busy server. Event handlers register synchronously.
  void registerLifecycle(bb, store).catch((error) => bb.log.warn(`Thread reconcile failed: ${String(error)}`));
  bb.background.schedule("auto-archive-tasks", "0 * * * *", async () => {
    const count = autoArchiveTasks(bb, store);
    if (count) bb.log.info(`Automatically archived ${count} tasks`);
  });

  bb.background.schedule("git-pr-sync", "* * * * *", () => gitSyncService(bb, store).runDue());
  bb.background.schedule("pause-signals", "* * * * *", () => sweepPauseSignals(bb));
  bb.background.schedule("pause-samples", "*/10 * * * *", () => samplePauses(bb));
  bb.events.on("thread.idle", () => { void sweepPauseSignals(bb); });
  void gitSyncService(bb, store).startEvents().catch((error: unknown) => bb.log.warn(`PR event startup failed: ${error instanceof Error ? error.message : String(error)}`));
  bb.background.schedule("storage-maintenance", "17 3 * * *", async () => {
    const result = await storageService(bb).run(false);
    if (result.removedFiles || result.removedRows) bb.log.info(`Storage cleanup removed ${result.removedFiles} files and ${result.removedRows} cache rows`);
  });

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: WORK_BOARD_PLUGIN_VERSION };
    },
  });
}
