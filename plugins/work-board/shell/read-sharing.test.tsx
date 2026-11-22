// @vitest-environment jsdom
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("../app"));
const { useTasksQuery, useTasksRpc } = await import("./data.js");
const { TasksRefreshProvider } = await import("./refresh.js");
afterEach(() => cleanup());

let rpc: ReturnType<typeof useTasksRpc>;
/** Mounts the shared read cache and a query that listens to both channels under test. */
function Probe() {
  rpc = useTasksRpc();
  useTasksQuery(async () => 1, ["comments:changed", "settings:changed"]);
  return null;
}
const Mounted = () => <TasksRefreshProvider><Probe /></TasksRefreshProvider>;

/** One shared read is outstanding when `between` runs; returns how many RPCs the two identical reads issued. */
async function overlappingReads(between: (slot: ReturnType<typeof renderSlot>) => Promise<unknown>) {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const slot = renderSlot({ ...app.navPanels[0]!, component: Mounted }, { subPath: "" }, {
    rpc: {
      listTaskCardMeta: async () => { calls++; await gate; return { metadata: [] }; },
      getChecksStatus: async () => ({}),
    } as never,
  });
  await waitFor(() => expect(rpc).toBeDefined());
  const first = rpc.call("listTaskCardMeta", { taskIds: ["a"] });
  await between(slot);
  const second = rpc.call("listTaskCardMeta", { taskIds: ["a"] });
  release();
  await Promise.all([first, second]);
  return calls;
}

describe("shared reads", () => {
  it("is cleared by a comments signal (control), but not by a settings signal or a settings fetch", async () => {
    expect(await overlappingReads((slot) => slot.emitRealtime("comments:changed", { taskId: "x" }))).toBe(2);
    expect(await overlappingReads((slot) => slot.emitRealtime("settings:changed", { projectId: "p" }))).toBe(1);
    expect(await overlappingReads(() => rpc.call("getChecksStatus" as never, { projectId: "p" } as never))).toBe(1);
  });
});
