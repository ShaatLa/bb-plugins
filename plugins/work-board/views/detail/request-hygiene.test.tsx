// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setupPlanHost } from "../plan/test-setup";

window.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
const app = await loadPluginApp(() => import("../../app"));
const harnesses: FakePluginHarness[] = [];
afterEach(async () => {
  cleanup();
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
});

it("a task without an epic or attached threads fires no epic, bb-project or pull-request reads while idle", async () => {
  const host = setupPlanHost(harnesses);
  const calls: { method: string; input: unknown }[] = [];
  const rpc = Object.fromEntries(Object.entries(host.rpc).map(([method, fn]) => [method, (input: unknown) => { calls.push({ method, input }); return fn(input); }]));
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/EXA-1" }, { rpc });
  await slot.findByRole("textbox", { name: "Task title" });
  window.dispatchEvent(new Event("focus"));
  await new Promise((resolve) => setTimeout(resolve, 300));
  const methods = calls.map((call) => call.method);
  expect(methods).not.toContain("listBbProjects");
  expect(methods).not.toContain("listTaskPullRequests");
  expect(calls.filter((call) => call.method === "listTasks" && (call.input as { type?: string }).type === "epic")).toEqual([]);
});

const COMPONENTS = join(process.cwd(), "components");

it("every data-bb-plugin-root selector in components names the plugin next to it", () => {
  for (const file of readdirSync(COMPONENTS).filter((name) => /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name))) {
    const source = readFileSync(join(COMPONENTS, file), "utf8");
    for (const match of source.matchAll(/data-bb-plugin-root\]?/g)) {
      const around = source.slice(match.index!, match.index! + match[0].length + 40);
      expect(around, `${file} at ${match.index}`).toMatch(/data-bb-plugin-root\]\[data-bb-plugin="/);
    }
  }
});
