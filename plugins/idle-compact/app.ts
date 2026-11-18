// The Compact button in the open thread's header: compacts that thread through the server, which logs it as "manual".
import { useState } from "react";
import { definePluginApp, experimental_THREAD_ACTION_GROUPS as GROUPS, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type State = "busy" | "failed";

export default definePluginApp(app => {
  app.slots.experimental_threadAction({
    id: "compact",
    title: "Compact",
    icon: "Minimize2",
    group: GROUPS.state,
    placement: "header",
    useData() {
      const rpc = useRpc<typeof rpcContract>();
      const [states, setStates] = useState<Record<string, State>>({});
      return { rpc, states, setStates };
    },
    item({ thread, data }) {
      if (thread.archivedAt) return null;
      const state = data.states[thread.id];
      const set = (value?: State) => data.setStates(({ [thread.id]: _, ...rest }) => value ? { ...rest, [thread.id]: value } : rest);
      return {
        label: state === "busy" ? "Compacting…" : state === "failed" ? "Compact failed" : "Compact",
        icon: "Minimize2",
        // bb compacts only a thread that is idle or errored.
        disabled: state === "busy" || (thread.status !== "idle" && thread.status !== "error"),
        async run() {
          set("busy");
          try { await data.rpc.call("compact", { threadId: thread.id }); set(); } catch (error) { set("failed"); throw error; }
        },
      };
    },
  });
});
