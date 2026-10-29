// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { NavigationBadgeSettings } from "./navigation-badge-settings";
import { TasksRefreshProvider } from "../shell/refresh.js";

const Wrapped = () => (
  <TasksRefreshProvider>
    <NavigationBadgeSettings />
  </TasksRefreshProvider>
);

describe("navigation badge settings", () => {
  it("keeps the options in one collapsed block and saves a checked option", async () => {
    let saved: unknown = null;
    const slot = renderSlot({ component: Wrapped }, {}, {
      rpc: {
        getNavigationBadgeCriteria: () => ({ criteria: ["open"] }),
        setNavigationBadgeCriteria: (input: unknown) => {
          saved = input;
          return input;
        },
      },
    });
    const summary = await slot.findByText("Navigation badge");
    expect(summary.closest("details")?.open).toBe(false);
    const owner = await slot.findByRole("checkbox", { name: "Owner actions" });
    await waitFor(() => expect(owner.hasAttribute("disabled")).toBe(false));
    fireEvent.click(owner);
    await waitFor(() => expect(saved).toEqual({ criteria: ["open", "owner"] }));
  });
});
