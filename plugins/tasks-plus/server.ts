import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { createStore, registerTasksApi } from "./api";
import { registerAttachments } from "./attachments";
import { registerTasksCli } from "./cli";
import { registerDelegation } from "./delegate";
import { registerLifecycle } from "./lifecycle";
import { registerMentions } from "./mentions";

const TASKS_PLUGIN_NAME = "Tasks Plus";
export const TASKS_PLUGIN_VERSION = "0.1.0";

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

  bb.settings.define({
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

  bb.rpc.register(tasksRpcContract, {
    ping(): { ok: true; version: string } {
      return { ok: true, version: TASKS_PLUGIN_VERSION };
    },
  });
}
