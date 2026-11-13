// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFakePluginHost,
  makeThreadResponse,
  type FakePluginHarness,
} from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../api";
import { tasksRpcContract } from "../shared/contract";
import { taskTab } from "../test-fixtures.js";

window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  window.localStorage.clear();
  await Promise.all(harnesses.splice(0).map((h) => h.dispose()));
});

describe("waiting question surfaces", () => {
  it.each(["list", "board", "side"])(
    "shows and filters waiting work on %s",
    async (surface) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
      harnesses.push(harness);
      const store = createStore(bb);
      registerTasksApi(bb, store);
      const project = store.tasks.createProject({
        name: "Owner work",
        prefix: "OWN",
        color: "blue",
        linkedBbProjectId: "proj_owner",
      });
      const owner = store.tasks.createTask({
        projectId: project.id,
        title: "Grant registry access",
        });
      await harness.callRpc("createQuestion", { taskId: owner.id, kind: "check", prompt: "Validate result" });
      const agent = store.tasks.createTask({
        projectId: project.id,
        title: "Build image",
      });
      const rpc = Object.fromEntries(
        Object.keys(tasksRpcContract).map((method) => [
          method,
          (input: unknown) => harness.callRpc(method, input),
        ]),
      );
      const slot =
        surface === "side"
          ? renderSlot(taskTab(app), { threadId: "thr_board", environment: null }, {
                rpc,
                sdk: {
                  threads: {
                    get: async () =>
                      makeThreadResponse({
                        id: "thr_board",
                        projectId: "proj_owner",
                      }),
                  },
                },
              })
          : renderSlot(
              app.navPanels[0]!,
              { subPath: `${project.id}?view=${surface}` },
              { rpc },
            );
      await waitFor(() =>
        expect(
          slot.container.querySelector(`[data-task-key="${owner.key}"]`),
        ).not.toBeNull(),
      );
      const ownerCard = slot.container.querySelector(
        `[data-task-key="${owner.key}"]`,
      )!;
      expect(slot.queryByRole("button", { name: "Executor" })).toBeNull();
      expect(ownerCard.textContent).not.toContain("Waiting on you");
      await waitFor(() => expect(ownerCard.className).toContain("border-l-warning"));
      fireEvent.click(slot.getByRole("button", { name: "Waiting on me" }));
      await waitFor(() =>
        expect(
          slot.container.querySelector(`[data-task-key="${agent.key}"]`),
        ).toBeNull(),
      );
      expect(
        slot.container.querySelector(`[data-task-key="${owner.key}"]`),
      ).not.toBeNull();
      fireEvent.click(slot.getByRole("button", { name: "Waiting on me" }));
      await waitFor(() =>
        expect(
          slot.container.querySelector(`[data-task-key="${agent.key}"]`),
        ).not.toBeNull(),
      );
    },
  );
});
