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

// The Git card of the settings page, once its stored configuration has loaded.
async function openGit(slot: ReturnType<typeof renderSlot>) {
  const card = await slot.findByRole("region", { name: "Git and pull requests" });
  const interval = await within(card).findByRole("spinbutton", { name: "Interval (minutes)" });
  await waitFor(() => expect((interval.closest("fieldset") as HTMLFieldSetElement).disabled).toBe(false));
  return within(card);
}
const advanced = (git: ReturnType<typeof within>) => fireEvent.click(git.getByText("Advanced settings"));
// Autosave has written the form and the read after it is applied: the card shows Saved and nothing unsaved.
const saved = async (git: ReturnType<typeof within>) => {
  await waitFor(() => {
    expect(git.getByTestId("save-status").textContent).toBe("Saved");
    expect(git.queryByTestId("git-verifying")).toBeNull();
    expect(git.getByTestId("git-summary").textContent).not.toMatch(/unsaved/);
  }, { timeout: 3000 });
};
// Typing and leaving a field as a person can: a disabled field, or one under a disabled fieldset, takes neither.
const type = (field: HTMLElement, value: string) => {
  expect(field.matches(":disabled")).toBe(false);
  fireEvent.focus(field);
  fireEvent.change(field, { target: { value } });
};
const leave = (field: HTMLElement) => {
  expect(field.matches(":disabled")).toBe(false);
  fireEvent.blur(field);
};
// Holds the first call of an RPC open until `release`.
function hold(f: ReturnType<typeof setup>, method: "setGitSyncConfig") {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const call = f.rpc[method]!;
  let first = true;
  f.rpc[method] = async (input: unknown) => { if (first) { first = false; await held; } return call(input); };
  return { release };
}
const writes = (slot: ReturnType<typeof renderSlot>) => slot.rpcCalls.filter((call) => call.method === "setGitSyncConfig" || call.method === "config.set");
// An immediate control once the form is clean and verified.
async function waitForEnabled(git: ReturnType<typeof within>, name: string, role: "switch" | "combobox" = "switch") {
  await waitFor(() => expect(git.getByRole(role, { name }).hasAttribute("disabled")).toBe(false));
  return git.getByRole(role, { name });
}

it("saves switches, repository membership and rule matches at once, and tags, other repositories and rules by themselves", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [
    { id: "proj_service", gitRemoteUrl: "https://github.com/example/service.git" },
    { id: "proj_other", gitRemoteUrl: "git@github.com:example/available.git" },
  ]);
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  // The section is its own card, open, with a heading; the status line shows the sync state and the repository count.
  const git = await openGit(slot);
  expect(git.getByRole("heading", { level: 3, name: "Git and pull requests" })).toBeTruthy();
  await waitFor(() => expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories"));
  // Each BB repository is a named switch that saves at once.
  fireEvent.click(await git.findByRole("switch", { name: "example/service" }));
  await waitFor(() => expect(data.config(f.project.id).repositories).toEqual(["example/service"]));
  await waitFor(() => expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 1 repository"));
  fireEvent.click(await waitForEnabled(git, "Periodic synchronization"));
  await waitFor(() => expect(data.config(f.project.id).enabled).toBe(true));
  advanced(git);
  fireEvent.click(await waitForEnabled(git, "Highlight shared files"));
  await waitFor(() => expect(data.config(f.project.id).overlapEnabled).toBe(true));
  // A manual repository saves as it is added or removed.
  await saved(git);
  fireEvent.click(git.getByText("Other repositories"));
  const input = git.getByRole("textbox", { name: "Git repositories" });
  fireEvent.change(input, { target: { value: "example/infra" } });
  fireEvent.click(git.getByRole("button", { name: /^Add$/ }));
  await waitFor(() => expect(data.config(f.project.id).repositories).toEqual(["example/service", "example/infra"]));
  await saved(git);
  fireEvent.click(git.getByRole("button", { name: "Remove repository example/infra" }));
  await waitFor(() => expect(data.config(f.project.id).repositories).toEqual(["example/service"]));
  await saved(git);
  fireEvent.change(input, { target: { value: "example/tools" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(git.getByTestId("git-summary").textContent).toBe("Sync on · 1 repository · unsaved changes");
  expect(git.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(true);
  await saved(git);
  // A typed number waits for its field to be left; the tag added next saves both.
  fireEvent.change(git.getByRole("spinbutton", { name: "Discovery lookback (days)" }), { target: { value: "45" } });
  const checks = git.getByRole("textbox", { name: "Required GitHub checks" });
  fireEvent.change(checks, { target: { value: "build" } });
  fireEvent.keyDown(checks, { key: "Enter" });
  await saved(git);
  // An unfinished name is kept when the field loses focus, and saved.
  fireEvent.change(checks, { target: { value: "test" } });
  fireEvent.blur(checks);
  await saved(git);
  // A rule saves once it has a pattern; an empty row holds every save until it gets one or is removed.
  fireEvent.click(git.getByRole("button", { name: "Add rule" }));
  fireEvent.change(git.getByRole("textbox", { name: "Rule 1 pattern" }), { target: { value: "migrations/**" } });
  fireEvent.blur(git.getByRole("textbox", { name: "Rule 1 pattern" }));
  await saved(git);
  fireEvent.click(git.getByRole("button", { name: "Add rule" }));
  fireEvent.change(git.getByRole("textbox", { name: "Rule 2 pattern" }), { target: { value: "docs/*.json" } });
  fireEvent.click(git.getByRole("button", { name: "Add rule" }));
  expect(git.getByTestId("git-dirty")).toBeTruthy();
  fireEvent.blur(git.getByRole("textbox", { name: "Rule 2 pattern" }));
  const before = writes(slot).length;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(writes(slot)).toHaveLength(before);
  fireEvent.click(git.getByRole("button", { name: "Remove rule 3" }));
  await saved(git);
  const rules = [{ pattern: "migrations/**", match: "changed" }, { pattern: "docs/*.json", match: "changed" }];
  expect(data.config(f.project.id)).toMatchObject({
    enabled: true, overlapEnabled: true, overlapRules: rules,
    repositories: ["example/service", "example/tools"], lookbackDays: 45, requiredChecks: ["build", "test"],
  });
  expect(git.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false);
  // On the clean form a stored rule's match is written at once.
  await waitFor(() => expect(git.getByRole("combobox", { name: "Rule 2 match" }).hasAttribute("disabled")).toBe(false));
  fireEvent.click(git.getByRole("combobox", { name: "Rule 2 match" }));
  fireEvent.click(await slot.findByRole("option", { name: "Added" }));
  await waitFor(() => expect(data.config(f.project.id).overlapRules).toEqual([rules[0], { pattern: "docs/*.json", match: "added" }]));
  // Off is written at once and keeps the rules; on again shows them.
  fireEvent.click(await waitForEnabled(git, "Highlight shared files"));
  await waitFor(() => expect(data.config(f.project.id).overlapEnabled).toBe(false));
  await waitFor(() => expect(git.queryByRole("list", { name: "Overlap rules" })).toBeNull());
  fireEvent.click(await waitForEnabled(git, "Highlight shared files"));
  await waitFor(() => expect((git.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("migrations/**"));
  expect((git.getByRole("textbox", { name: "Rule 2 pattern" }) as HTMLInputElement).value).toBe("docs/*.json");
});

it("never sends an invalid value, not even with a switch flipped meanwhile, and Discard restores the stored values", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [{ id: "proj_service", gitRemoteUrl: "https://github.com/example/service.git" }]);
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  type(interval, "0");
  expect(git.getByTestId("git-invalid").textContent).toMatch(/^Not saved: Refresh interval: /);
  leave(interval);
  fireEvent.click(git.getByRole("switch", { name: "Periodic synchronization" }));
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(writes(slot)).toHaveLength(0);
  expect(data.config(f.project.id)).toMatchObject({ pollMinutes: 5, enabled: false });
  fireEvent.click(git.getByRole("button", { name: "Discard" }));
  expect(interval.value).toBe("5");
  expect(git.getByRole("switch", { name: "Periodic synchronization" }).getAttribute("aria-checked")).toBe("false");
  expect(git.queryByTestId("git-invalid")).toBeNull();
  expect(writes(slot)).toHaveLength(0);
});

it("saves a typed number only on blur or Enter, never while typing", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" });
  // A valid prefix typed during a pause is never written.
  fireEvent.change(interval, { target: { value: "1" } });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  fireEvent.change(interval, { target: { value: "12" } });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(writes(slot)).toHaveLength(0);
  expect(git.queryByTestId("save-status")).toBeNull();
  fireEvent.blur(interval);
  await saved(git);
  expect(writes(slot).map((call) => (call.input as { config: { pollMinutes: number } }).config.pollMinutes)).toEqual([12]);
  expect(data.config(f.project.id).pollMinutes).toBe(12);
  fireEvent.change(interval, { target: { value: "20" } });
  fireEvent.keyDown(interval, { key: "Enter" });
  await saved(git);
  expect(data.config(f.project.id).pollMinutes).toBe(20);
  expect(writes(slot)).toHaveLength(2);
});

it("disables the card's controls while a write is in flight and enables them after it", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const gate = hold(f, "setGitSyncConfig");
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  const controls = () => [
    git.getByRole("spinbutton", { name: "Interval (minutes)" }),
    git.getByRole("spinbutton", { name: "Discovery lookback (days)" }),
    git.getByRole("switch", { name: "Periodic synchronization" }),
    git.getByRole("textbox", { name: "Required GitHub checks" }),
    git.getByRole("switch", { name: "Highlight shared files" }),
    git.getByRole("button", { name: "Sync now" }),
  ];
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  type(interval, "9");
  leave(interval);
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toBe("Saving…"));
  // Held open: nothing can be edited or committed over it, and Enter or a second blur sends nothing.
  expect(controls().every((control) => control.matches(":disabled"))).toBe(true);
  fireEvent.keyDown(interval, { key: "Enter" });
  fireEvent.blur(interval);
  expect(writes(slot)).toHaveLength(1);
  gate.release();
  await saved(git);
  await waitFor(() => expect(controls().every((control) => !control.matches(":disabled"))).toBe(true));
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id).pollMinutes).toBe(9);
  expect(interval.value).toBe("9");
});

// Leaving a field for `next` as a click does: the field loses focus to it first, then the click lands.
function clickFrom(field: HTMLElement, next: HTMLElement) {
  expect(next.matches(":disabled")).toBe(false);
  fireEvent.blur(field, { relatedTarget: next });
  expect(next.matches(":disabled")).toBe(false);
  fireEvent.click(next);
}

it("saves an edited interval with the switch clicked next: one write stores both", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" });
  type(interval, "9");
  clickFrom(interval, git.getByRole("switch", { name: "Periodic synchronization" }));
  await saved(git);
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id)).toMatchObject({ pollMinutes: 9, enabled: true });
});

it("discards an edited interval when Discard is clicked next: no write, and the stored value is shown", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  type(interval, "9");
  clickFrom(interval, git.getByRole("button", { name: "Discard" }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(0);
  expect(interval.value).toBe("5");
  expect(data.config(f.project.id).pollMinutes).toBe(5);
  expect(git.getByTestId("git-summary").textContent).not.toMatch(/unsaved/);
});

it("adds a blank rule row when Add rule is clicked after an edit, and writes nothing", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  type(interval, "9");
  clickFrom(interval, git.getByRole("button", { name: "Add rule" }));
  expect((git.getByRole("textbox", { name: "Rule 2 pattern" }) as HTMLInputElement).value).toBe("");
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(0);
  expect(interval.value).toBe("9");
  expect(git.getByTestId("git-dirty")).toBeTruthy();
});

it("saves an edit once focus leaves the card, also from another control it moved to first", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" });
  const summary = git.getByText("Advanced settings").closest("summary")!;
  interval.focus();
  type(interval, "9");
  // Focus moves to the Advanced settings summary, inside the card: nothing is written.
  summary.focus();
  expect(document.activeElement).toBe(summary);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(0);
  // Then focus leaves the card from the summary: the edit is written once.
  slot.getByRole("combobox", { name: "Settings project" }).focus();
  await saved(git);
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id).pollMinutes).toBe(9);
});

it("saves an unfinished check name kept on the blur that leaves the card, and only keeps it in the draft inside the card", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  const checks = git.getByRole("textbox", { name: "Required GitHub checks" });
  checks.focus();
  type(checks, "build");
  git.getByRole("spinbutton", { name: "Interval (minutes)" }).focus();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(0);
  expect(git.getByRole("list", { name: "Required GitHub checks: added" }).textContent).toContain("build");
  checks.focus();
  type(checks, "test");
  slot.getByRole("combobox", { name: "Settings project" }).focus();
  await saved(git);
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id).requiredChecks).toEqual(["build", "test"]);
});

it("saves an edit once when a click on the card heading leaves focus on the page, before another project is chosen", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" });
  const heading = git.getByRole("heading", { level: 3, name: "Git and pull requests" });
  interval.focus();
  type(interval, "9");
  // The heading takes no focus: the field's blur has no relatedTarget while the pointer is down in the card.
  fireEvent.pointerDown(heading);
  interval.blur();
  expect(document.activeElement).toBe(document.body);
  expect(writes(slot)).toHaveLength(0);
  fireEvent.pointerUp(heading);
  fireEvent.click(heading);
  await saved(git);
  expect(writes(slot)).toHaveLength(1);
  expect(writes(slot)[0]!.method).toBe("setGitSyncConfig");
  expect(writes(slot)[0]!.input).toMatchObject({ config: { pollMinutes: 9 }, baseConfig: { pollMinutes: 5 } });
  fireEvent.click(slot.getByRole("combobox", { name: "Settings project" }));
  fireEvent.click(await slot.findByRole("option", { name: "Other" }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id).pollMinutes).toBe(9);
});

it("keeps focus in the card while the match menu (rendered outside it) is open, and saves both edits when Added is picked", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  const pattern = git.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement;
  pattern.focus();
  type(pattern, "docs/*.md");
  // Tab to the match selector and open it: its options render in a portal outside the card.
  const match = git.getByRole("combobox", { name: "Rule 1 match" });
  match.focus();
  fireEvent.click(match);
  const added = await slot.findByRole("option", { name: "Added" });
  expect(slot.getByRole("region", { name: "Git and pull requests", hidden: true }).contains(added)).toBe(false);
  added.focus();
  expect(document.activeElement).toBe(added);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(0);
  fireEvent.click(added);
  await saved(git);
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id).overlapRules).toEqual([{ pattern: "docs/*.md", match: "added" }]);
});

it("keeps a Discard click in Safari, where the clicked button takes no focus: no write, and the stored value shown", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  interval.focus();
  type(interval, "9");
  const discard = git.getByRole("button", { name: "Discard" });
  fireEvent.pointerDown(discard);
  interval.blur();
  expect(document.activeElement).toBe(document.body);
  expect(discard.matches(":disabled")).toBe(false);
  fireEvent.pointerUp(discard);
  fireEvent.click(discard);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(0);
  expect(interval.value).toBe("5");
  expect(data.config(f.project.id).pollMinutes).toBe(5);
  // A switch clicked the same way saves the edit with it, once.
  interval.focus();
  type(interval, "9");
  const sync = git.getByRole("switch", { name: "Periodic synchronization" });
  fireEvent.pointerDown(sync);
  interval.blur();
  fireEvent.pointerUp(sync);
  fireEvent.click(sync);
  await saved(git);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(writes(slot)).toHaveLength(1);
  expect(data.config(f.project.id)).toMatchObject({ pollMinutes: 9, enabled: true });
  // With no pointer in the card, a blur to nowhere (a click outside, or the window losing focus) writes.
  type(interval, "7");
  fireEvent.blur(interval, { relatedTarget: null });
  await saved(git);
  expect(data.config(f.project.id).pollMinutes).toBe(7);
  expect(writes(slot)).toHaveLength(2);
});

it("disables the card's controls while a Reload is in flight and shows the stored settings after it", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  await f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.pollMinutes", value: 12 });
  type(interval, "9");
  leave(interval);
  const conflict = await git.findByTestId("git-conflict");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const read = f.rpc.getGitSyncConfig!;
  f.rpc.getGitSyncConfig = async (input) => { await held; return read(input); };
  fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(interval.matches(":disabled")).toBe(true));
  expect(git.getByRole("switch", { name: "Periodic synchronization" }).matches(":disabled")).toBe(true);
  expect(interval.value).toBe("9");
  release();
  await waitFor(() => expect(interval.matches(":disabled")).toBe(false));
  expect(interval.value).toBe("12");
  expect(git.queryByTestId("git-conflict")).toBeNull();
  expect(data.config(f.project.id).pollMinutes).toBe(12);
});

it("stores a write still in flight when the settings switch to another project", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
  const gate = hold(f, "setGitSyncConfig");
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" });
  type(interval, "9");
  leave(interval);
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toBe("Saving…"));
  fireEvent.click(slot.getByRole("combobox", { name: "Settings project" }));
  fireEvent.click(await slot.findByRole("option", { name: "Other" }));
  await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "getGitSyncConfig", input: { projectId: other.id } }));
  gate.release();
  await waitFor(() => expect(data.config(f.project.id).pollMinutes).toBe(9));
  expect(data.config(other.id).pollMinutes).toBe(5);
});

it("ends with the last value after 5 → 9 → 5: the undo waits for the write of 9 and is then written", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const gate = hold(f, "setGitSyncConfig");
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  type(interval, "9");
  leave(interval);
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toBe("Saving…"));
  expect(interval.matches(":disabled")).toBe(true);
  gate.release();
  await saved(git);
  type(interval, "5");
  leave(interval);
  await waitFor(() => expect(writes(slot)).toHaveLength(2));
  await saved(git);
  expect(writes(slot).map((call) => (call.input as { config: { pollMinutes: number } }).config.pollMinutes)).toEqual([9, 5]);
  expect(data.config(f.project.id).pollMinutes).toBe(5);
  expect(interval.value).toBe("5");
});

it("keeps a toggled repository when another repository is added after its write", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [{ id: "proj_service", gitRemoteUrl: "https://github.com/example/service.git" }]);
  const data = createGitSyncStore(f.bb.storage.database());
  const gate = hold(f, "setGitSyncConfig");
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  fireEvent.click(git.getByText("Other repositories"));
  fireEvent.click(await git.findByRole("switch", { name: "example/service" }));
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toBe("Saving…"));
  // The manual add waits for the toggle's write.
  expect(git.getByRole("textbox", { name: "Git repositories" }).matches(":disabled")).toBe(true);
  gate.release();
  await saved(git);
  type(git.getByRole("textbox", { name: "Git repositories" }), "example/tools");
  fireEvent.click(git.getByRole("button", { name: /^Add$/ }));
  await waitFor(() => expect(writes(slot)).toHaveLength(2));
  await saved(git);
  expect(data.config(f.project.id).repositories).toEqual(["example/service", "example/tools"]);
  expect(git.getByRole("switch", { name: "example/service" }).getAttribute("aria-checked")).toBe("true");
});

it("clears a failed save and its Retry when the value is reverted or discarded", async () => {
  const f = setup();
  const write = f.rpc.setGitSyncConfig!;
  f.rpc.setGitSyncConfig = async () => { throw new Error("Storage is busy"); };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  type(interval, "9");
  leave(interval);
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toMatch(/^Failed: Storage is busy/));
  // Typed back to the stored value: nothing is left to retry.
  type(interval, "5");
  await waitFor(() => expect(git.queryByTestId("save-status")).toBeNull());
  type(interval, "9");
  leave(interval);
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toMatch(/^Failed: Storage is busy/));
  fireEvent.click(git.getByRole("button", { name: "Discard" }));
  expect(git.queryByTestId("save-status")).toBeNull();
  expect(interval.value).toBe("5");
  f.rpc.setGitSyncConfig = write;
});

it("forgets a failed value once another save succeeds: returning to it saves again", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  let fail = true;
  const write = f.rpc.setGitSyncConfig!;
  f.rpc.setGitSyncConfig = async (input) => { if (fail) throw new Error("Storage is busy"); return write(input); };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  fireEvent.change(interval, { target: { value: "9" } });
  fireEvent.blur(interval);
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toMatch(/^Failed: Storage is busy/));
  fail = false;
  fireEvent.change(interval, { target: { value: "7" } });
  fireEvent.blur(interval);
  await saved(git);
  expect(data.config(f.project.id).pollMinutes).toBe(7);
  fireEvent.change(interval, { target: { value: "9" } });
  fireEvent.blur(interval);
  await saved(git);
  expect(data.config(f.project.id).pollMinutes).toBe(9);
});

it("keeps a value whose save failed and offers Retry, which writes it", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  let fail = true;
  const write = f.rpc.setGitSyncConfig!;
  f.rpc.setGitSyncConfig = async (input) => { if (fail) throw new Error("Storage is busy"); return write(input); };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  fireEvent.change(interval, { target: { value: "9" } });
  fireEvent.blur(interval);
  const status = await git.findByRole("alert", {}, { timeout: 3000 });
  await waitFor(() => expect(git.getByTestId("save-status").textContent).toMatch(/^Failed: Storage is busy/));
  expect(status).toBeTruthy();
  expect(interval.value).toBe("9");
  // A failed save is not repeated by itself.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(writes(slot)).toHaveLength(1);
  fail = false;
  fireEvent.click(within(git.getByTestId("save-status")).getByRole("button", { name: "Retry" }));
  await saved(git);
  expect(data.config(f.project.id).pollMinutes).toBe(9);
  expect(interval.value).toBe("9");
});

it("never lets a deleted duplicate rule come back: the deletion saves the whole rule list at once", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const docs = { pattern: "docs/**", match: "changed" as const };
  const src = { pattern: "src/**", match: "changed" as const };
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [docs, docs, src] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  fireEvent.click(git.getByRole("button", { name: "Remove rule 2" }));
  await saved(git);
  expect(data.config(f.project.id).overlapRules).toEqual([docs, src]);
  // Clean again: the match is written on the stored rows, and one docs/** rule remains.
  fireEvent.click(await waitForEnabled(git, "Rule 2 match", "combobox"));
  fireEvent.click(await slot.findByRole("option", { name: "Added" }));
  await waitFor(() => expect(data.config(f.project.id).overlapRules).toEqual([docs, { pattern: "src/**", match: "added" }]));
  await waitFor(() => expect(git.getAllByRole("textbox", { name: /^Rule \d+ pattern$/ }).map((node) => (node as HTMLInputElement).value)).toEqual(["docs/**", "src/**"]));
});

it("after a write shows a clean form the next read, including another editor's change", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  // Another editor adds a repository right after this page's switch write lands.
  const write = f.rpc.setGitSyncConfig!;
  f.rpc.setGitSyncConfig = async (input) => {
    const result = await write(input);
    await f.harness.callRpc("setGitSyncConfig", { projectId: f.project.id, config: { ...data.config(f.project.id), repositories: ["example/service"], pollMinutes: 12 } });
    return result;
  };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  fireEvent.click(git.getByRole("switch", { name: "Periodic synchronization" }));
  await waitFor(() => expect(git.getByTestId("git-summary").textContent).toBe("Sync on · 1 repository"));
  expect((git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement).value).toBe("12");
  expect(git.getByTestId("git-summary").textContent).not.toMatch(/unsaved/);
});

it("never lets a read taken before a switch write replace the form", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  let hold: Promise<void> | null = null;
  const read = f.rpc.getGitSyncConfig!;
  // The response is taken first and delivered late, like a request already in flight.
  f.rpc.getGitSyncConfig = async (input) => { const result = await read(input); const gate = hold; if (gate) await gate; return result; };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  let release!: () => void;
  hold = new Promise((resolve) => { release = resolve; });
  await slot.behavior.emitRealtime("projects:changed", { projectId: f.project.id });
  await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getGitSyncConfig")).toHaveLength(2));
  hold = null;
  fireEvent.click(git.getByRole("switch", { name: "Periodic synchronization" }));
  await waitFor(() => expect(git.getByTestId("git-summary").textContent).toBe("Sync on · 0 repositories"));
  release();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(git.getByTestId("git-summary").textContent).toBe("Sync on · 0 repositories");
  fireEvent.change(git.getByRole("spinbutton", { name: "Interval (minutes)" }), { target: { value: "9" } });
  fireEvent.blur(git.getByRole("spinbutton", { name: "Interval (minutes)" }));
  await saved(git);
  expect(data.config(f.project.id)).toMatchObject({ enabled: true, pollMinutes: 9 });
});

it("refuses an autosave built on settings another editor changed, keeps the draft without retrying, and Reload shows the stored settings", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = () => git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  fireEvent.change(interval(), { target: { value: "9" } });
  // Another editor adds a repository while the interval draft is open; the dirty form keeps its snapshot.
  await f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.repositories", value: ["example/service"] });
  await slot.behavior.emitRealtime("projects:changed", { projectId: f.project.id });
  await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getGitSyncConfig")).toHaveLength(2));
  fireEvent.blur(interval());
  const conflict = await git.findByTestId("git-conflict");
  expect(conflict.textContent).toMatch(/^Settings changed elsewhere/);
  expect(data.config(f.project.id)).toMatchObject({ repositories: ["example/service"], pollMinutes: 5 });
  expect(interval().value).toBe("9");
  // The conflict is not a failed save, and autosave waits for Reload.
  expect(git.queryByTestId("save-status")).toBeNull();
  const attempts = writes(slot).length;
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(writes(slot)).toHaveLength(attempts);
  fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(git.queryByTestId("git-conflict")).toBeNull());
  await waitFor(() => expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 1 repository"));
  expect(interval().value).toBe("5");
  fireEvent.change(interval(), { target: { value: "9" } });
  fireEvent.blur(interval());
  await saved(git);
  expect(data.config(f.project.id)).toMatchObject({ repositories: ["example/service"], pollMinutes: 9 });
});

it("takes the latest read when an edit is undone by hand, before any immediate control works again", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [
    { id: "proj_service", gitRemoteUrl: "https://github.com/example/service.git" },
    { id: "proj_other", gitRemoteUrl: "git@github.com:example/available.git" },
  ]);
  const data = createGitSyncStore(f.bb.storage.database());
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = () => git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  fireEvent.change(interval(), { target: { value: "9" } });
  await f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.repositories", value: ["example/service"] });
  await slot.behavior.emitRealtime("projects:changed", { projectId: f.project.id });
  await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getGitSyncConfig")).toHaveLength(2));
  expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories · unsaved changes");
  fireEvent.change(interval(), { target: { value: "5" } });
  await waitFor(() => expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 1 repository"));
  fireEvent.click(await waitForEnabled(git, "example/available"));
  await waitFor(() => expect(data.config(f.project.id).repositories).toEqual(["example/service", "example/available"]));
});

it("treats a new blank rule row as a draft: nothing saves until it has a pattern, and Discard removes it", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  fireEvent.click(git.getByRole("button", { name: "Add rule" }));
  expect(git.getByTestId("git-dirty")).toBeTruthy();
  fireEvent.click(git.getByRole("switch", { name: "Periodic synchronization" }));
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(writes(slot)).toHaveLength(0);
  fireEvent.click(git.getByRole("button", { name: "Discard" }));
  expect(git.queryByRole("textbox", { name: "Rule 2 pattern" })).toBeNull();
  expect(git.getByRole("switch", { name: "Periodic synchronization" }).getAttribute("aria-checked")).toBe("false");
  expect(data.config(f.project.id).enabled).toBe(false);
});

it("refuses a repository switch or rule match built on outdated settings, shows Reload, and leaves the other write stored", async () => {
  const f = setup();
  f.harness.sdk.stub("projects.list", async () => [
    { id: "proj_service", gitRemoteUrl: "https://github.com/example/service.git" },
    { id: "proj_other", gitRemoteUrl: "git@github.com:example/available.git" },
  ]);
  const data = createGitSyncStore(f.bb.storage.database());
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  // Another page, loaded from the same snapshot, writes first; this page has not read it yet.
  await f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.repositories", value: ["example/service"], expected: [] });
  fireEvent.click(await waitForEnabled(git, "example/available"));
  const conflict = await git.findByTestId("git-conflict");
  expect(data.config(f.project.id).repositories).toEqual(["example/service"]);
  expect(git.queryByTestId("save-status")).toBeNull();
  fireEvent.click(within(conflict).getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(git.queryByTestId("git-conflict")).toBeNull());
  await waitFor(() => expect(git.getByRole("switch", { name: "example/service" }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(await waitForEnabled(git, "example/available"));
  await waitFor(() => expect(data.config(f.project.id).repositories).toEqual(["example/service", "example/available"]));
  await saved(git);
  // A rule match written over an outdated rule list is refused the same way.
  await f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.overlapRules", value: [{ pattern: "src/**", match: "changed" }] });
  fireEvent.click(await waitForEnabled(git, "Rule 1 match", "combobox"));
  fireEvent.click(await slot.findByRole("option", { name: "Added" }));
  await git.findByTestId("git-conflict");
  expect(data.config(f.project.id).overlapRules).toEqual([{ pattern: "src/**", match: "changed" }]);
  // `expected` is only for git.* keys.
  await expect(f.harness.callRpc("config.set", { projectId: f.project.id, key: "staleIdleMinutes", value: "30", expected: "45" })).rejects.toThrow(/git\.\* keys only/);
});

it("sends Discard through Reload while a conflict stands, and clears the conflict only once a later read is adopted", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  let hold: Promise<void> | null = null;
  const read = f.rpc.getGitSyncConfig!;
  f.rpc.getGitSyncConfig = async (input) => { const gate = hold; if (gate) await gate; return read(input); };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  const interval = () => git.getByRole("spinbutton", { name: "Interval (minutes)" }) as HTMLInputElement;
  fireEvent.change(interval(), { target: { value: "9" } });
  await f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.repositories", value: ["example/service"] });
  fireEvent.blur(interval());
  await git.findByTestId("git-conflict");
  let release!: () => void;
  hold = new Promise((resolve) => { release = resolve; });
  const reads = slot.rpcCalls.filter((call) => call.method === "getGitSyncConfig").length;
  fireEvent.click(git.getByRole("button", { name: "Discard" }));
  await waitFor(() => expect(slot.rpcCalls.filter((call) => call.method === "getGitSyncConfig").length).toBeGreaterThan(reads));
  // The read is still out: the conflict and the lock stay.
  expect(git.getByTestId("git-conflict")).toBeTruthy();
  hold = null;
  release();
  await waitFor(() => expect(git.queryByTestId("git-conflict")).toBeNull());
  expect(interval().value).toBe("5");
  expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 1 repository");
  expect(data.config(f.project.id).pollMinutes).toBe(5);
});

it("keeps the shared-file switch derived from the rules when overlapEnabled is absent", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const rules = [{ pattern: "migrations/**", match: "changed" as const }];
  // Saved before the key existed: rules mean on, no rules mean off, and neither shows unsaved changes.
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapRules: rules }));
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  const withRules = await openGit(renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc }));
  advanced(withRules);
  await waitFor(() => expect(withRules.getByRole("switch", { name: "Highlight shared files" }).getAttribute("aria-checked")).toBe("true"));
  expect((withRules.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("migrations/**");
  expect(withRules.getByTestId("git-summary").textContent).not.toMatch(/unsaved/);
  // An autosave that keeps the rules leaves the key absent.
  fireEvent.change(withRules.getByRole("textbox", { name: "Rule 1 pattern" }), { target: { value: "migrations/*.sql" } });
  fireEvent.blur(withRules.getByRole("textbox", { name: "Rule 1 pattern" }));
  await saved(withRules);
  expect(data.config(f.project.id)).toMatchObject({ overlapRules: [{ pattern: "migrations/*.sql", match: "changed" }] });
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  cleanup();
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({}));
  const empty = await openGit(renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc }));
  advanced(empty);
  expect(empty.getByRole("switch", { name: "Highlight shared files" }).getAttribute("aria-checked")).toBe("false");
  expect(empty.getByTestId("git-summary").textContent).not.toMatch(/unsaved/);
  // An explicit "off" keeps its rules and shows off; turning it on writes on at once.
  cleanup();
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapRules: rules, overlapEnabled: false }));
  const off = await openGit(renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc }));
  advanced(off);
  await waitFor(() => expect(off.getByRole("switch", { name: "Highlight shared files" }).getAttribute("aria-checked")).toBe("false"));
  fireEvent.click(off.getByRole("switch", { name: "Highlight shared files" }));
  await waitFor(() => expect(data.config(f.project.id).overlapEnabled).toBe(true));
  await waitFor(() => expect((off.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("migrations/**"));
});

it("writes the shared-file switch only once the owner touches it and keeps an explicit off winning", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  const rules = [{ pattern: "docs/**", match: "changed" as const }];
  const effective = async () => (await f.harness.callRpc("config.get", { projectId: f.project.id, key: "git.overlapEnabled" }) as { values: Record<string, unknown> }).values["git.overlapEnabled"];
  const setRules = () => f.harness.callRpc("config.set", { projectId: f.project.id, key: "git.overlapRules", value: rules });
  // A legacy project: an unrelated save leaves the key absent, so an older rules-only write still applies.
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({}));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  fireEvent.change(git.getByRole("spinbutton", { name: "Interval (minutes)" }), { target: { value: "9" } });
  fireEvent.blur(git.getByRole("spinbutton", { name: "Interval (minutes)" }));
  await waitFor(() => expect(data.config(f.project.id).pollMinutes).toBe(9));
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  await setRules();
  expect(await effective()).toBe(true);
  expect(data.config(f.project.id).overlapEnabled).toBeUndefined();
  cleanup();
  // The owner turning the switch off writes an explicit false at once that later rules-only writes do not override.
  const owner = await openGit(renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc }));
  advanced(owner);
  const control = owner.getByRole("switch", { name: "Highlight shared files" });
  await waitFor(() => expect(control.getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(control);
  await waitFor(() => expect(data.config(f.project.id).overlapEnabled).toBe(false));
  await setRules();
  expect(await effective()).toBe(false);
  expect(data.config(f.project.id).overlapRules).toEqual(rules);
});

it("writes an explicit switch value only when it differs from what the saved rules imply", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  // Legacy with rules: deleting every rule while the switch shows on stores an explicit on.
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const git = await openGit(renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc }));
  advanced(git);
  await waitFor(() => expect(git.getByRole("switch", { name: "Highlight shared files" }).getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(git.getByRole("button", { name: "Remove rule 1" }));
  await saved(git);
  expect(data.config(f.project.id)).toMatchObject({ overlapEnabled: true, overlapRules: [] });
});

it("shows Unavailable in the Git card when the configuration cannot be loaded", async () => {
  const f = setup();
  f.rpc.getGitSyncConfig = async () => { throw new Error("Configuration unavailable"); };
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  await waitFor(() => expect(slot.getByTestId("git-summary").textContent).toBe("Unavailable"));
  expect(within(slot.getByRole("region", { name: "Git and pull requests" })).getByRole("switch", { name: "Periodic synchronization" }).hasAttribute("disabled")).toBe(true);
});

it("reconciles the Git form with the stored values after a save, so a trimmed pattern is not unsaved", async () => {
  const f = setup();
  const data = createGitSyncStore(f.bb.storage.database());
  data.setConfig(f.project.id, gitSyncConfigSchema.parse({ overlapEnabled: true, overlapRules: [{ pattern: "docs/**", match: "changed" }] }));
  const slot = renderSlot(app.settingsSections[0]!, {}, { rpc: f.rpc });
  const git = await openGit(slot);
  advanced(git);
  const pattern = git.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement;
  await waitFor(() => expect(pattern.value).toBe("docs/**"));
  fireEvent.change(pattern, { target: { value: "docs/** " } });
  expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories");
  fireEvent.change(pattern, { target: { value: "docs/**  " } });
  fireEvent.change(git.getByRole("spinbutton", { name: "Interval (minutes)" }), { target: { value: "9" } });
  fireEvent.blur(git.getByRole("spinbutton", { name: "Interval (minutes)" }));
  await saved(git);
  expect(data.config(f.project.id).overlapRules).toEqual([{ pattern: "docs/**", match: "changed" }]);
  await waitFor(() => expect((git.getByRole("textbox", { name: "Rule 1 pattern" }) as HTMLInputElement).value).toBe("docs/**"));
  expect(git.getByRole("button", { name: "Sync now" }).hasAttribute("disabled")).toBe(false);
  expect(git.getByTestId("git-summary").textContent).toBe("Sync off · 0 repositories");
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
