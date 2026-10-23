import { afterEach, expect, test, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import plugin from "./app.tsx";
import { diagnosticsFixture as fixture } from "./test/settings-fixture.ts";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const hosts = [{ id: "machine-1", name: "Test Mac", status: "connected" }, { id: "machine-2", name: "Remote", status: "connected" }];
test("settings read live values, scope credit writes to the selected machine, and check updates only on request", async () => {
  const app = await loadPluginApp(plugin);
  const changes: unknown[] = [], requests: any[] = [];
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    sdk: { hosts: { list: async () => hosts as any } },
    rpc: {
      diagnostics: (input: any) => { requests.push(input); return { ...fixture, usage: { ...fixture.usage, accountEmail: input.hostId === "machine-1" ? "first@example.test" : "second@example.test" } }; },
      setCreditUsage: (input: any) => { changes.push(input); return { ...fixture.nativeSettings, useG1Credits: input.enabled, revision: "b".repeat(64) }; },
    },
  });
  await slot.findByText("first@example.test");
  expect(changes).toHaveLength(0);
  expect(requests[0]).toEqual({hostId:"machine-1",checkUpdates:false});
  expect(slot.getByText("0")).toBeTruthy();
  fireEvent.change(slot.getByRole("combobox", {name:"Machine"}), {target:{value:"machine-2"}});
  await slot.findByText("second@example.test");
  expect(slot.queryByText("first@example.test")).toBeNull();
  fireEvent.click(slot.getByRole("switch"));
  await waitFor(() => expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
  expect(changes).toEqual([{hostId:"machine-2",enabled:true,expectedRevision:"a".repeat(64)}]);
  fireEvent.click(slot.getByRole("button", {name:"Check CLI updates"}));
  await waitFor(() => expect(requests.at(-1)).toEqual({hostId:"machine-2",checkUpdates:true}));
  slot.lifecycle.unmount();
});
test("unavailable balances and malformed native config are not displayed as zero or editable defaults", async () => {
  const app = await loadPluginApp(plugin);
  let fail = false;
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    sdk: { hosts: { list: async () => hosts as any } },
    rpc: { diagnostics: () => {
      if (fail) throw Error("SECRET_TOKEN");
      return {...fixture,credits:{status:"error",remainingCredits:null,message:"Unavailable"},nativeSettings:{...fixture.nativeSettings,useG1Credits:null,editable:false,revision:null}};
    } },
  });
  await slot.findByText("Current credit policy is unknown; editing is disabled.");
  expect((slot.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
  expect(slot.queryByText("0")).toBeNull();
  fail = true;
  fireEvent.click(slot.getByRole("button", {name:"Refresh"}));
  await slot.findByRole("alert");
  expect(slot.getByText("fixture@example.test")).toBeTruthy();
  expect(slot.container.textContent).not.toContain("SECRET_TOKEN");
  slot.lifecycle.unmount();
});

test("Refresh recovers a machine that connected after settings were opened", async () => {
  const app = await loadPluginApp(plugin);
  let connected = false;
  const slot = renderSlot(app.settingsSections[0]!, {}, {
    sdk: { hosts: { list: async () => [{...hosts[0],status:connected?"connected":"disconnected"}] as any } },
    rpc: { diagnostics: () => fixture },
  });
  await slot.findByText("No connected machine");
  connected = true;
  fireEvent.click(slot.getByRole("button",{name:"Refresh"}));
  await slot.findByText("fixture@example.test");
  slot.lifecycle.unmount();
});


test("diagnostics cache survives navigation, expires per machine, and Refresh bypasses it", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(100_000);
  const app = await loadPluginApp(plugin);
  let calls = 0;
  let resolveRead!: (data: typeof fixture) => void;
  const options = {
    sdk: { hosts: { list: async () => hosts as any } },
    rpc: { diagnostics: () => { calls++; return new Promise<typeof fixture>(resolve => { resolveRead = resolve; }); } },
  };
  let slot = renderSlot(app.settingsSections[0]!, {}, options);
  await waitFor(() => expect(calls).toBe(1));
  expect(slot.getByRole("status").textContent).toContain("Reading agy diagnostics");
  expect(slot.container.querySelector(".agy-spinner")).toBeTruthy();
  slot.lifecycle.unmount();
  slot = renderSlot(app.settingsSections[0]!, {}, options);
  await slot.findByText("Reading agy diagnostics…");
  expect(calls).toBe(1);
  await act(async () => resolveRead(fixture));
  await slot.findByText("fixture@example.test");
  expect(slot.queryByRole("status")).toBeNull();
  slot.lifecycle.unmount();
  clock.mockReturnValue(159_999);
  slot = renderSlot(app.settingsSections[0]!, {}, options);
  await slot.findByText("fixture@example.test");
  expect(calls).toBe(1);
  fireEvent.click(slot.getByRole("button", {name:"Refresh"}));
  await waitFor(() => expect(calls).toBe(2));
  expect(slot.getByText("fixture@example.test")).toBeTruthy();
  expect(slot.getByRole("status").textContent).toContain("Refreshing agy diagnostics");
  slot.lifecycle.unmount();
  slot = renderSlot(app.settingsSections[0]!, {}, options);
  await slot.findByText("Refreshing agy diagnostics…");
  expect(slot.getByText("fixture@example.test")).toBeTruthy();
  expect(calls).toBe(2);
  await act(async () => resolveRead({...fixture,usage:{...fixture.usage,accountEmail:"fresh@example.test"}}));
  await slot.findByText("fresh@example.test");
  slot.lifecycle.unmount();
  clock.mockReturnValue(220_000);
  slot = renderSlot(app.settingsSections[0]!, {}, options);
  await waitFor(() => expect(calls).toBe(3));
  expect(slot.getByText("fresh@example.test")).toBeTruthy();
  await act(async () => resolveRead(fixture));
  await waitFor(() => expect(slot.queryByRole("status")).toBeNull());
  fireEvent.change(slot.getByRole("combobox",{name:"Machine"}),{target:{value:"machine-2"}});
  await waitFor(() => expect(calls).toBe(4));
  expect(slot.queryByText("fixture@example.test")).toBeNull();
  await act(async () => resolveRead({...fixture,usage:{...fixture.usage,accountEmail:"remote@example.test"}}));
  await slot.findByText("remote@example.test");
  fireEvent.change(slot.getByRole("combobox",{name:"Machine"}),{target:{value:"machine-1"}});
  await slot.findByText("fixture@example.test");
  expect(calls).toBe(4);
  slot.lifecycle.unmount();
});

test("confirmed credit changes are retained in cached diagnostics across navigation", async () => {
  const app = await loadPluginApp(plugin);
  let calls = 0;
  const options = {
    sdk: { hosts: { list: async () => hosts as any } },
    rpc: {
      diagnostics: () => { calls++; return fixture; },
      setCreditUsage: () => ({...fixture.nativeSettings,useG1Credits:true,revision:"b".repeat(64)}),
    },
  };
  let slot = renderSlot(app.settingsSections[0]!, {}, options);
  await slot.findByText("fixture@example.test");
  fireEvent.click(slot.getByRole("switch"));
  await waitFor(() => expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("true"));
  slot.lifecycle.unmount();
  slot = renderSlot(app.settingsSections[0]!, {}, options);
  await slot.findByText("fixture@example.test");
  expect(slot.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  expect(calls).toBe(1);
  slot.lifecycle.unmount();
});
