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
  await slot.findByRole("checkbox", { name: "example/service" });
  fireEvent.click(slot.getByRole("checkbox", { name: "example/service" }));
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
  fireEvent.change(
    slot.getByRole("textbox", { name: "Required GitHub checks" }),
    { target: { value: "build\ntest" } },
  );
  fireEvent.click(
    slot.getByRole("switch", { name: "Enable periodic synchronization" }),
  );
  fireEvent.click(slot.getByRole("button", { name: "Save Git/PR settings" }));
  await slot.findByText("Git/PR settings saved.");
  expect(
    createGitSyncStore(f.bb.storage.database()).config(f.project.id),
  ).toMatchObject({
    enabled: true,
    repositories: ["example/service", "example/tools"],
    lookbackDays: 45,
    requiredChecks: ["build", "test"],
  });
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
        : renderSlot(
            app.threadPanelActions[0]!,
            { threadId: "thr_example", params: { taskKey: f.task.key } },
            { rpc: f.rpc, openUrl: () => true },
          );
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
