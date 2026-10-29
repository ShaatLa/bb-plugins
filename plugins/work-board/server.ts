import { gitSyncService } from "./git-sync/service";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { createStore, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { TASK_LINK_INSTRUCTIONS } from "./shared/task-link";
import { registerMentions } from "./mentions";
import { autoArchiveTasks } from "./lifecycle/task-archive";

const WORK_BOARD_PLUGIN_NAME = "Work Board";
export const WORK_BOARD_PLUGIN_VERSION = "0.15.3";

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

  const settings = bb.settings.define({
    autoArchiveAfterDays: {
      type: "select",
      label: "Automatically archive completed tasks",
      description:
        "Checks hourly. Counts days without task, comment, attachment or question activity. Unfinished children, unanswered questions and working agents prevent archival.",
      options: ["off", "7", "14", "30"],
      experimental_optionLabels: {
        off: "Off",
        "7": "After 7 days",
        "14": "After 14 days",
        "30": "After 30 days",
      },
      default: "off",
    },
    staleIdleMinutes: {
      type: "select",
      label: "Flag idle threads without task updates",
      description:
        "Shows an amber marker on a task card when its attached thread has been idle this long and the task has had no update, comment or evidence. Display only: nothing is sent to the thread.",
      options: ["off", "30", "45", "60", "120"],
      experimental_optionLabels: {
        off: "Off",
        "30": "After 30 minutes",
        "45": "After 45 minutes",
        "60": "After 60 minutes",
        "120": "After 2 hours",
      },
      default: "45",
    },
    defaultScreen: {
      type: "select",
      label: "Open by default",
      description: "The last selected project is remembered on this device.",
      options: ["last-project-board", "last-project-list", "all", "active"],
      experimental_optionLabels: {
        "last-project-board": "Last project · Kanban",
        "last-project-list": "Last project · List",
        all: "All tasks",
        active: "Active tasks",
      },
      default: "last-project-board",
    },
  });

  const store = createStore(bb);
  registerTasksApi(bb, store, async () => {
    const { staleIdleMinutes } = await settings.get();
    return staleIdleMinutes === "off" ? null : Number(staleIdleMinutes);
  });
  registerAttachments(bb, store.tasks);
  registerTasksCli(bb, store, statusPayload());
  registerDelegation(bb, store);
  registerMentions(bb, store);
  // Read when a provider session starts, so only threads started or resumed after install see it.
  bb.agents.contributeInstructions(({ projectId }) =>
    store.tasks.listProjects().some((project) => project.linkedBbProjectId === projectId)
      ? TASK_LINK_INSTRUCTIONS
      : null,
  );
  await registerLifecycle(bb, store);
  bb.background.schedule("auto-archive-tasks", "0 * * * *", async () => {
    const { autoArchiveAfterDays } = await settings.get();
    if (autoArchiveAfterDays === "off") return;
    const count = autoArchiveTasks(bb, store, Number(autoArchiveAfterDays));
    if (count) bb.log.info(`Automatically archived ${count} tasks`);
  });

  bb.background.schedule("git-pr-sync", "* * * * *", () => gitSyncService(bb, store).runDue());

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: WORK_BOARD_PLUGIN_VERSION };
    },
  });
}
