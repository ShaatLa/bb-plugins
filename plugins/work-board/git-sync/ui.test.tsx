// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createStore, registerTasksApi } from "../api";
import { gitSyncService } from "./service";
import { createGitSyncStore } from "./store";
import { gitSyncConfigSchema, prSnapshotSchema } from "../shared/git-sync";
import { tasksRpcContract } from "../shared/contract";
import { taskTab } from "../test-fixtures.js";

window.matchMedia ??= (media) => ({
  matches: false,
  media,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
});
window.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Element.prototype.scrollIntoView ??= () => {};
const app = await loadPluginApp(() => import("../app"));
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  cleanup();
  localStorage.clear();
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});
function setup() {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  gitSyncService(host.bb, store, {
    discover: vi.fn(async () => []),
    referenceText: vi.fn(async () => ""),
    snapshot: vi.fn(async () =>
      prSnapshotSchema.parse({
        repository: "example/service",
        number: 42,
        remoteId: "PR_42",
        url: "https://github.com/example/service/pull/42",
        title: "A pull request",
        state: "merged",
        headSha: "a".repeat(40),
        mergeSha: "b".repeat(40),
        mergedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        observedAt: new Date().toISOString(),
        baseBranch: "trunk",
        checks: [
          {
            name: "Build",
            app: "GitHub Actions",
            appId: 1,
            sha: "a".repeat(40),
            url: "https://github.com/example/service/actions/runs/77",
            state: "passed",
            required: true,
          },
        ],
        requirementsKnown: false,
        ci: "passing",
        mergeState: "CLEAN",
        mergeable: true,
        review: "APPROVED",
        unresolvedThreads: 0,
        coverage: [
          {
            workflow: "Deploy",
            state: "passed",
            runId: 88,
            sha: "b".repeat(40),
            url: "https://github.com/example/service/actions/runs/88",
            superseded: false,
            originalRunId: null,
          },
        ],
      }),
    ),
  });
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({
    name: "Example",
    prefix: "ABC",
    color: "blue",
  });
  const task = store.tasks.createTask({
    projectId: project.id,
    title: "Example task",
  });
  const rpc = Object.fromEntries(
    Object.keys(tasksRpcContract).map((method) => [
      method,
      (input: unknown) => host.harness.callRpc(method, input),
    ]),
  );
  return { ...host, store, project, task, rpc };
}
it.each(["main", "side"])("orders PRs newest first by merge date in the %s task card", async (surface) => {
  const f = setup();
  createGitSyncStore(f.bb.storage.database()).setConfig(
    f.project.id, gitSyncConfigSchema.parse({ repositories: ["example/service"] }),
  );
  await f.rpc.linkPr!({ taskId: f.task.id, url: "https://github.com/example/service/pull/42" });
  await f.rpc.syncGit!({ projectId: f.project.id });
  const { links: [base] } = tasksRpcContract.listPrLinks.output.parse(
    await f.rpc.listPrLinks!({ taskId: f.task.id }),
  );
  const links = [
    { number: 42, mergedAt: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z" },
    { number: 43, mergedAt: "2026-10-10T00:00:00.000Z", updatedAt: "2026-10-26T00:00:00.000Z" },
    { number: 44, mergedAt: null, updatedAt: "2026-10-25T00:00:00.000Z" },
    { number: 45, mergedAt: null, updatedAt: null },
  ].map(({ number, mergedAt, updatedAt }) => {
    const url = `https://github.com/example/service/pull/${number}`;
    return {
      ...base!,
      link: { ...base!.link, number, url, createdAt: "2026-10-05T00:00:00.000Z" },
      snapshot: updatedAt ? { ...base!.snapshot!, number, url, mergedAt, updatedAt, state: mergedAt ? "merged" as const : "open" as const } : null,
    };
  });
  f.rpc.listPrLinks = async () => ({ links });
  const slot = surface === "main"
    ? renderSlot(app.navPanels[0]!, { subPath: `task/${f.task.key}` }, { rpc: f.rpc })
    : renderSlot(taskTab(app), { threadId: "thr_example", environment: null }, { rpc: f.rpc, experimental_fixedTabTarget: { tabId: "task", target: { taskKey: f.task.key } } });
  const region = await slot.findByRole("region", { name: "Task pull requests" });
  await within(region).findByRole("link", { name: "service#42" });
  expect(within(region).getAllByRole("link", { name: /^service#/ }).map((link) => link.textContent)).toEqual([
    "service#44", "service#42", "service#43", "service#45",
  ]);
});

it("configures repositories and enables background sync from compact project settings", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [
    {
      id: "proj_service",
      gitRemoteUrl: "https://github.com/example/service.git",
    },
    { id: "proj_other", gitRemoteUrl: "git@github.com:example/available.git" },
  ]);
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  // The section is collapsed; its summary shows the sync state and the repository count.
  const section = (await slot.findByText("Git and pull requests")).closest("details")!;
  expect(section.open).toBe(false);
  await waitFor(() => expect(slot.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories"));
  // Open the section before reaching for anything inside it, as a user must.
  fireEvent.click(slot.getByText("Git and pull requests"));
  expect(section.open).toBe(true);
  await slot.findByRole("checkbox", { name: "example/service" });
  expect(slot.queryByText("Unsaved changes")).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: "example/service" }));
  // The summary shows the saved state and flags the draft.
  expect(slot.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories · unsaved changes");
  expect(slot.getByText("Unsaved changes")).toBeTruthy();
  expect(slot.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(true);
  fireEvent.click(slot.getByRole("checkbox", { name: "example/available" }));
  fireEvent.click(slot.getByRole("checkbox", { name: "example/available" }));
  fireEvent.click(slot.getByText("Other repositories"));
  const input = await slot.findByRole("textbox", { name: "Git repositories" });
  await waitFor(() =>
    expect((input.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(
      false,
    ),
  );
  fireEvent.change(input, {
    target: { value: "example/infra" },
  });
  fireEvent.click(slot.getByRole("button", { name: /^Add$/ }));
  fireEvent.click(
    slot.getByRole("button", { name: "Remove repository example/infra" }),
  );
  fireEvent.change(input, { target: { value: "example/tools" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.click(slot.getByText("Advanced settings"));
  fireEvent.change(
    slot.getByRole("spinbutton", { name: "Discovery lookback (days)" }),
    { target: { value: "45" } },
  );
  const checks = slot.getByRole("textbox", { name: "Required GitHub checks" });
  fireEvent.change(checks, { target: { value: "build" } });
  fireEvent.keyDown(checks, { key: "Enter" });
  // An unfinished name is kept when the field loses focus.
  fireEvent.change(checks, { target: { value: "test" } });
  fireEvent.blur(checks);
  expect(slot.queryByRole("list", { name: "Overlap rules" })).toBeNull();
  fireEvent.click(slot.getByRole("switch", { name: "Highlight shared files between PRs" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Rule 1 pattern" }), { target: { value: "migrations/**" } });
  fireEvent.click(slot.getByRole("button", { name: "Add rule" }));
  fireEvent.click(slot.getByRole("button", { name: "Add rule" }));
  fireEvent.change(slot.getByRole("textbox", { name: "Rule 3 pattern" }), { target: { value: "docs/*.json" } });
  // An empty row is not a rule and is dropped on save.
  fireEvent.click(
    slot.getByRole("switch", { name: "Enable periodic synchronization" }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Save Git/PR settings" }));
  await slot.findByText("Git/PR settings saved.");
  const rules = [
    { pattern: "migrations/**", match: "changed" },
    { pattern: "docs/*.json", match: "changed" },
  ];
  expect(createGitSyncStore(f.bb.storage.database()).config(f.project.id)).toMatchObject({ overlapEnabled: true, overlapRules: rules });
  // Saved: the unsaved marker is gone and Sync now works again.
  await waitFor(() => expect(slot.queryByText("Unsaved changes")).toBeNull());
  expect(slot.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false);
  // Off saves the switch and keeps the rules; on again restores them.
  fireEvent.click(slot.getByRole("switch", { name: "Highlight shared files between PRs" }));
  expect(slot.queryByRole("list", { name: "Overlap rules" })).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Save Git/PR settings" }));
  await waitFor(() => expect(createGitSyncStore(f.bb.storage.database()).config(f.project.id).overlapEnabled).toBe(false));
  expect(createGitSyncStore(f.bb.storage.database()).config(f.project.id).overlapRules).toEqual(rules);
  fireEvent.click(slot.getByRole("switch", { name: "Highlight shared files between PRs" }));
  expect((slot.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("migrations/**");
  expect((slot.getByRole("textbox", { name: "Rule 2 pattern" }) as HTMLInputElement).value).toBe("docs/*.json");
  // Turning it on again is a change from the saved "off" until saved.
  expect(slot.getByText("Unsaved changes")).toBeTruthy();
  expect(
    createGitSyncStore(f.bb.storage.database()).config(f.project.id),
  ).toMatchObject({
    enabled: true,
    repositories: ["example/service", "example/tools"],
    lookbackDays: 45,
    requiredChecks: ["build", "test"],
  });
});
it("keeps the shared-file switch derived from the rules when overlapEnabled is absent", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const rules = [{ pattern: "migrations/**", match: "changed" as const }];
  // Saved before the key existed: rules mean on, no rules mean off, and neither shows unsaved changes.
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapRules: rules }));
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  const withRules = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  fireEvent.click(await withRules.findByText("Git and pull requests"));
  fireEvent.click(await withRules.findByText("Advanced settings"));
  await waitFor(() => expect(withRules.getByRole("switch", { name: "Highlight shared files between PRs" }).getAttribute("aria-checked")).toBe("true"));
  expect((withRules.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("migrations/**");
  expect(withRules.queryByText("Unsaved changes")).toBeNull();
  cleanup();
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({}));
  const empty = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  fireEvent.click(await empty.findByText("Git and pull requests"));
  fireEvent.click(await empty.findByText("Advanced settings"));
  await waitFor(() => expect(empty.getByRole("switch", { name: "Highlight shared files between PRs" })).toBeTruthy());
  expect(empty.getByRole("switch", { name: "Highlight shared files between PRs" }).getAttribute("aria-checked")).toBe("false");
  expect(empty.queryByText("Unsaved changes")).toBeNull();
  // An explicit "off" keeps its rules and shows off.
  cleanup();
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapRules: rules, overlapEnabled: false }));
  const off = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  fireEvent.click(await off.findByText("Git and pull requests"));
  fireEvent.click(await off.findByText("Advanced settings"));
  await waitFor(() => expect(off.getByRole("switch", { name: "Highlight shared files between PRs" }).getAttribute("aria-checked")).toBe("false"));
  fireEvent.click(off.getByRole("switch", { name: "Highlight shared files between PRs" }));
  expect((off.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("migrations/**");
});

it("writes the shared-file switch only once the owner touches it and keeps an explicit off winning", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const rules = [{ pattern: "docs/**", match: "changed" as const }];
  const effective = async () => (await f.harness.callRpc("config.get", { projectId: f.project.id, key: "git.overlapEnabled" }) as { values: Record<string, unknown> }).values["git.overlapEnabled"];
  const setRules = () => f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.overlapRules", value: rules });
  // A legacy project: an unrelated save and a no-op save leave the key absent, so an older rules-only write still applies.
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({}));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  fireEvent.click(await slot.findByText("Git and pull requests"));
  const interval = await slot.findByRole("spinbutton", { name: "Interval (minutes)" });
  await waitFor(() => expect((interval.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
  fireEvent.click(slot.getByRole("button", { name: "Save Git/PR settings" }));
  await slot.findByText("Git/PR settings saved.");
  fireEvent.change(interval, { target: { value: "9" } });
  fireEvent.click(slot.getByRole("button", { name: "Save Git/PR settings" }));
  await waitFor(() => expect(data.config(f.project.id).pollMinutes).toBe(9));
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  await setRules();
  expect(await effective()).toBe(true);
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  cleanup();
  // The owner turning the switch off writes an explicit false that later rules-only writes do not override.
  const owner = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  fireEvent.click(await owner.findByText("Git and pull requests"));
  fireEvent.click(await owner.findByText("Advanced settings"));
  const control = await owner.findByRole("switch", { name: "Highlight shared files between PRs" });
  await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(control);
  fireEvent.click(owner.getByRole("button", { name: "Save Git/PR settings" }));
  await waitFor(() => expect(data.config(f.project.id).overlapEnabled).toBe(false));
  await setRules();
  expect(await effective()).toBe(false);
  expect(data.config(f.project.id).overlapRules).toEqual(rules);
});

it("reconciles the Git form with the stored values after a save, so a trimmed pattern is not unsaved", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  fireEvent.click(await slot.findByText("Git and pull requests"));
  fireEvent.click(await slot.findByText("Advanced settings"));
  const pattern = await slot.findByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement;
  await waitFor(() => expect(pattern.value).toBe("docs/**"));
  fireEvent.change(pattern, { target: { value: "docs/** " } });
  expect(slot.queryByText("Unsaved changes")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Save Git/PR settings" }));
  await slot.findByText("Git/PR settings saved.");
  expect(data.config(f.project.id).overlapRules).toEqual([{ pattern: "docs/**", match: "changed" }]);
  await waitFor(() => expect((slot.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("docs/**"));
  expect(slot.queryByText("Unsaved changes")).toBeNull();
  expect(slot.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false);
  expect(slot.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories");
});

it.each(["main", "side"])(
  "links, refreshes and excludes a PR in the %s task card",
  async (surface) => {
    const f = setup();
    createGitSyncStore(f.bb.storage.database()).setConfig(
      f.project.id,
      gitSyncConfigSchema.parse({ repositories: ["example/service"] }),
    );
    const slot =
      surface === "main"
        ? renderSlot(
            app.navPanels[0]!,
            { subPath: `task/${f.task.key}` },
            { rpc: f.rpc, openUrl: () => true },
          )
        : renderSlot(taskTab(app), { threadId: "thr_example", environment: null }, { rpc: f.rpc, openUrl: () => true, experimental_fixedTabTarget: { tabId: "task", target: { taskKey: f.task.key } } });
    const region = await slot.findByRole("region", {
      name: "Task pull requests",
    });
    expect(region.closest("aside")?.getAttribute("aria-label")).toBe(
      "Task details",
    );
    expect(
      slot.getAllByRole("region", { name: "Task pull requests" }),
    ).toHaveLength(1);
    const section = within(region);
    fireEvent.click(section.getByRole("button", { name: "Link PR" }));
    fireEvent.change(section.getByRole("textbox", { name: "PR URL" }), {
      target: { value: "https://github.com/example/service/pull/42" },
    });
    fireEvent.click(section.getByRole("button", { name: "Save link" }));
    const summary = await section.findByLabelText(
      "PR details example/service#42",
    );
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    let finishSync!: () => void;
    const pendingSync = new Promise<void>((resolve) => { finishSync = resolve; });
    const originalSync = f.rpc.syncGit!;
    f.rpc.syncGit = async (input) => {
      await pendingSync;
      return originalSync(input);
    };
    const syncButton = section.getByRole("button", { name: "Sync PRs" });
    fireEvent.click(syncButton);
    expect(syncButton.getAttribute("aria-busy")).toBe("true");
    expect(syncButton.hasAttribute("disabled")).toBe(true);
    expect(syncButton.querySelector(".animate-spin")).not.toBeNull();
    const linkButton = section.getByRole("button", { name: "Link PR" });
    expect(linkButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(linkButton);
    fireEvent.change(section.getByRole("textbox", { name: "PR URL" }), {
      target: { value: "https://github.com/example/service/pull/99" },
    });
    expect(section.getByRole("button", { name: "Save link" }).hasAttribute("disabled")).toBe(false);
    expect(slot.getByRole("textbox", { name: "Task title" }).getAttribute("contenteditable")).toBe("true");
    finishSync();
    await section.findByRole("img", { name: "CI passing" });
    await waitFor(() => expect(syncButton.getAttribute("aria-busy")).toBe("false"));
    expect(syncButton.querySelector(".animate-spin")).toBeNull();
    expect((section.getByRole("textbox", { name: "PR URL" }) as HTMLInputElement).value).toBe("https://github.com/example/service/pull/99");
    fireEvent.click(linkButton);
    const prLink = section.getByRole("link", { name: "service#42" });
    expect(prLink.getAttribute("target")).toBeNull();
    fireEvent.click(prLink);
    expect(slot.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://github.com/example/service/pull/42",
    });
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    await section.findByText(/merged · CI passing/);
    fireEvent.click(section.getByText("Checks (1)"));
    fireEvent.click(section.getByRole("link", { name: "Build" }));
    fireEvent.click(section.getByRole("link", { name: "run 88" }));
    expect(slot.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://github.com/example/service/actions/runs/77",
    });
    expect(slot.navigateCalls).toContainEqual({
      method: "openUrl",
      url: "https://github.com/example/service/actions/runs/88",
    });
    fireEvent.click(section.getByRole("button", { name: "Exclude" }));
    await waitFor(() =>
      expect(
        createGitSyncStore(f.bb.storage.database()).links(f.task.id)[0]
          ?.excluded,
      ).toBe(true),
    );
  },
);
