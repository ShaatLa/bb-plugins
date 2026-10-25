import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { createStore, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { registerMentions } from "./mentions";
import { autoArchiveTasks } from "./lifecycle/task-archive";

const TASKS_PLUGIN_NAME = "Tasks Plus";
export const TASKS_PLUGIN_VERSION = "0.8.1";

const tasksRpcContract = defineRpcContract({
  ping: {
    input: z.null(),
    output: z.object({ ok: z.literal(true), version: z.string() }),
  },
});

function statusPayload() {
  return { name: TASKS_PLUGIN_NAME, version: TASKS_PLUGIN_VERSION };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info(`${TASKS_PLUGIN_NAME} ${TASKS_PLUGIN_VERSION} loaded`);

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
  registerTasksApi(bb, store);
  registerAttachments(bb, store.tasks);
  registerTasksCli(bb, store, statusPayload());
  registerDelegation(bb, store);
  registerMentions(bb, store);
  await registerLifecycle(bb, store);
  bb.background.schedule("auto-archive-tasks", "0 * * * *", async () => {
    const { autoArchiveAfterDays } = await settings.get();
    if (autoArchiveAfterDays === "off") return;
    const count = autoArchiveTasks(bb, store, Number(autoArchiveAfterDays));
    if (count) bb.log.info(`Automatically archived ${count} tasks`);
  });

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: TASKS_PLUGIN_VERSION };
    },
  });
}
