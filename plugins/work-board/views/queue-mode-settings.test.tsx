// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerAttention } from "../attention/rpc";
import { tasksRpcContract } from "../shared/contract";

window.matchMedia ??= (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
window.PointerEvent ??= window.MouseEvent as typeof PointerEvent;
Element.prototype.setPointerCapture ??= () => {};

const app = await loadPluginApp(() => import("../app"));
afterEach(cleanup);

it("shows the work queue mode next to the automatic pause control and switches it through the RPC", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerAttention(bb);
    const project = store.tasks.createProject({ name: "Alpha", prefix: "ALP", color: "blue", linkedBbProjectId: "proj_example" });
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      sdk: { threads: { list: async () => [] } },
    });
    const select = await settings.findByLabelText("Work queue") as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(false));
    expect(select.value).toBe("trial");
    expect(settings.getByLabelText("Automatic pause").parentElement?.nextElementSibling).toBe(select.parentElement);
    fireEvent.change(select, { target: { value: "off" } });
    await waitFor(() => expect(settings.rpcCalls).toContainEqual({ method: "updateQueueMode", input: { projectId: project.id, mode: "off" } }));
    await waitFor(() => expect((settings.getByLabelText("Work queue") as HTMLSelectElement).value).toBe("off"));
    expect(bb.storage.database().prepare("SELECT mode FROM queue_modes WHERE project_id=?").get(project.id)).toEqual({ mode: "off" });
  } finally {
    await harness.dispose();
  }
});
