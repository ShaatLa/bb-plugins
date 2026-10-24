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

describe("executor filter surfaces", () => {
  it.each(["list", "board", "side"])(
    "shows and filters owner work on %s",
    async (surface) => {
      const { bb, harness } = createFakePluginHost({ pluginId: "tasks-plus" });
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
        executionTarget: "owner",
      });
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
          ? renderSlot(
              app.threadPanelActions[0]!,
              { threadId: "thr_board", params: null },
              {
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
              },
            )
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
      expect(ownerCard.textContent).toContain("Owner");
      expect(ownerCard.className).toContain("border-l-warning");
      fireEvent.keyDown(slot.getByRole("button", { name: "Executor" }), {
        key: "ArrowDown",
      });
      fireEvent.click(
        await slot.findByRole("menuitemcheckbox", {
          name: "Owner",
        }),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() =>
        expect(
          slot.container.querySelector(`[data-task-key="${agent.key}"]`),
        ).toBeNull(),
      );
      expect(
        slot.container.querySelector(`[data-task-key="${owner.key}"]`),
      ).not.toBeNull();
      fireEvent.keyDown(slot.getByRole("button", { name: /^Executor/ }), {
        key: "ArrowDown",
      });
      fireEvent.click(
        await slot.findByRole("menuitemcheckbox", { name: "All" }),
      );
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
      await waitFor(() =>
        expect(
          slot.container.querySelector(`[data-task-key="${agent.key}"]`),
        ).not.toBeNull(),
      );
    },
  );
});
