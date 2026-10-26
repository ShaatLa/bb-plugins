// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { makeTask, rpcInput } from "../../test-fixtures.js";
import { storeDefaultThread } from "./thread-preference.js";

if (!window.matchMedia) {
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

const app = await loadPluginApp(() => import("../../app"));

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT5";
const THREAD_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR1";
const OFFLINE_ROW_ID = "01HZZZZZZZZZZZZZZZZZZZZZR2";

const task = makeTask({
  id: TASK_ID,
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the PR pill",
  position: 1,
});

describe("existing thread dispatch", () => {
  it("works without presets and dispatches the selected running thread", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, {
      rpc: detailRpc({ listTaskThreads: () => ({ taskThreads: [] }), delegateToThread: () => ({ threadId: "thr_running" }) }),
      sdk: { threads: { list: async () => [{
        ...makeThreadResponse({ id: "thr_running", title: "Current work", status: "active", projectId: "proj_test" }),
        activity: { activeBackgroundAgentCount: 0, activeBackgroundCommandCount: 0, activeGoalCount: 0, activePlanModeCount: 0, activeWorkflowCount: 0 },
        environmentBranchName: null, environmentHostId: null, environmentIsWorktree: null,
        environmentName: null, environmentPath: null, environmentProviderId: null,
        environmentWorkspaceDisplayKind: "other", hasPendingInteraction: false,
        runtime: { displayStatus: "active" }, pinSortKey: null, queuedWork: "none",
      }] } },
    });
    fireEvent.click((await slot.findAllByRole("button", { name: "Existing thread…" }))[0]!);
    fireEvent.click(await slot.findByRole("checkbox", { name: "Use this thread by default" }));
    fireEvent.click(await slot.findByRole("button", { name: /Current work/ }));
    await waitFor(() => expect(slot.rpcCalls).toContainEqual({ method: "delegateToThread", input: { taskId: TASK_ID, threadId: "thr_running" } }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    const savedButtons = await slot.findAllByRole("button", { name: "Send task to Current work" });
    expect(savedButtons).toHaveLength(2);
    fireEvent.click(savedButtons[0]!);
    await waitFor(() => expect(slot.rpcCalls.filter(({ method }) => method === "delegateToThread")).toHaveLength(2));
    expect(slot.queryByRole("dialog")).toBeNull();
  });

  it("keeps the picker open and displays a failed send", async () => {
    const slot = renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, {
      rpc: detailRpc({ listTaskThreads: () => ({ taskThreads: [] }), delegateToThread: () => { throw new Error("Thread unavailable"); } }),
      sdk: { threads: { list: async () => [] } },
    });
    fireEvent.click((await slot.findAllByRole("button", { name: "Existing thread…" }))[0]!);
    fireEvent.click(await slot.findByRole("checkbox", { name: "Use this thread by default" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "Filter loaded threads or enter a thread ID" }), { target: { value: "thr_running" } });
    fireEvent.click(await slot.findByRole("button", { name: "Send to thr_running" }));
    expect((await slot.findByRole("alert")).textContent).toContain("Thread unavailable");
    expect(slot.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    expect(slot.queryByRole("button", { name: "Send task to Existing thread" })).toBeNull();
  });

  it("scopes the default to the task project and restores it after reopening", async () => {
    storeDefaultThread(PROJECT_ID, { id: "thr_saved", title: "Project worker" });
    const other = renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, {
      rpc: detailRpc({ listTaskThreads: () => ({ taskThreads: [] }), getTaskByKey: () => ({ task: { ...task, projectId: "01HZZZZZZZZZZZZZZZZZZZZZP2" } }) }),
    });
    await other.findAllByRole("button", { name: "Existing thread…" });
    expect(other.queryByRole("button", { name: "Send task to Project worker" })).toBeNull();
    other.lifecycle.unmount();
    const reopened = renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, { rpc: detailRpc({ listTaskThreads: () => ({ taskThreads: [] }) }), sdk: { threads: { list: async () => [] } } });
    expect(await reopened.findAllByRole("button", { name: "Send task to Project worker" })).toHaveLength(2);
    fireEvent.click(reopened.getAllByRole("button", { name: "Choose existing thread" })[0]!);
    await reopened.findByRole("dialog");
    fireEvent.click(reopened.getByRole("button", { name: "Clear default thread" }));
    expect(reopened.getByRole("checkbox", { name: "Use this thread by default" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(reopened.getByRole("button", { name: "Close" }));
    expect(reopened.getAllByRole("button", { name: "Existing thread…" })).toHaveLength(2);
    expect(reopened.rpcCalls.filter(({ method }) => method === "delegateToThread")).toHaveLength(0);
  });
});

it("opens the attached thread instead of sending the task again, including with a saved default", async () => {
  storeDefaultThread(PROJECT_ID, { id: "thr_other", title: "Other default" });
  let attached = true;
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, {
    rpc: detailRpc({ listTaskThreads: () => ({ taskThreads: attached ? [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")] : [] }) }),
  });
  const buttons = await slot.findAllByRole("button", { name: "Go to thread" });
  expect(buttons).toHaveLength(2);
  fireEvent.click(buttons[0]!);
  expect(slot.navigateCalls).toEqual([{ method: "toThread", threadId: "thr_worker000" }]);
  expect(slot.rpcCalls.filter(({ method }) => method === "delegateToThread")).toHaveLength(0);
  attached = false;
  await slot.behavior.emitRealtime("threads:changed", { taskId: TASK_ID });
  await slot.findAllByRole("button", { name: "Send task to Other default" });
  expect(slot.queryByRole("button", { name: "Go to thread" })).toBeNull();
});

function taskThreadRow(id: string, threadId: string, title: string) {
  return {
    id,
    taskId: TASK_ID,
    threadId,
    presetName: "Attached",
    title,
    liveStatus: "working",
    attachedAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
  };
}

function detailRpc(overrides: Record<string, unknown> = {}) {
  return {
    listProjects: () => ({
      projects: [
        {
          id: PROJECT_ID,
          name: "Tasks Plugin",
          prefix: "TSK",
          nextTaskNumber: 6,
          color: "blue",
          folderId: null,
          linkedBbProjectId: null,
          createdAt: "2026-07-15T00:00:00.000Z",
        },
      ],
    }),
    listFolders: () => ({ folders: [] }),
    listPresets: () => ({ presets: [] }),
    sidebarSummary: () => ({ projects: [] }),
    getTaskByKey: () => ({ task }),
    listTasks: (input: unknown) =>
      input !== null && rpcInput(input).parentTaskId
        ? { tasks: [] }
        : { tasks: [task] },
    listLabels: () => ({ labels: [] }),
    listAttachments: () => ({ attachments: [] }),
    listTaskThreads: () => ({
      taskThreads: [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
    }),
    listTaskPullRequests: () => ({
      pullRequests: [],
      unavailableThreadIds: [],
    }),
    listQuestions: () => ({ questions: [] }),
    listComments: () => ({ comments: [] }),
    listBbProjects: () => ({ bbProjects: [] }),
    ...overrides,
  };
}

describe("task detail pull request pills", () => {
  it("links a thread's pull request as a keyboard-reachable anchor", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        openUrl: () => true,
        rpc: detailRpc({
          listTaskPullRequests: () => ({
            pullRequests: [
              {
                url: "https://github.com/acme/bb/pull/12",
                number: 12,
                title: "Ship the PR pill",
                state: "merged",
                updatedAt: "2026-07-16T10:00:00.000Z",
                threadIds: ["thr_worker000"],
              },
            ],
            unavailableThreadIds: [],
          }),
        }),
      },
    );

    const link = (await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Merged)",
    })) as HTMLAnchorElement;
    expect(link.href).toBe("https://github.com/acme/bb/pull/12");
    expect(link.hasAttribute("target")).toBe(false);
    expect(link.textContent).toContain("#12");
    fireEvent.click(link);
    expect(slot.navigateCalls).toContainEqual({ method: "openUrl", url: "https://github.com/acme/bb/pull/12" });
  });

  it("marks threads whose PR lookup failed and stays quiet otherwise", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: [
              taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker"),
              taskThreadRow(OFFLINE_ROW_ID, "thr_offline00", "Offline worker"),
            ],
          }),
          listTaskPullRequests: () => ({
            pullRequests: [],
            unavailableThreadIds: ["thr_offline00"],
          }),
        }),
      },
    );

    await slot.findByText("Offline worker");
    expect(slot.getAllByText("PR unavailable")).toHaveLength(1);
    expect(slot.queryAllByRole("link").filter((link) => link.getAttribute("href")?.startsWith("https://github.com/"))).toHaveLength(0);
  });

  it("detaches a thread from its card after confirmation and refetches the list", async () => {
    let detached = false;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskThreads: () => ({
            taskThreads: detached
              ? []
              : [taskThreadRow(THREAD_ROW_ID, "thr_worker000", "Worker")],
          }),
          taskThreadsDetach: (input: unknown) => {
            detached = true;
            return { threadId: rpcInput(input).threadId };
          },
        }),
      },
    );

    fireEvent.click(await slot.findByRole("button", { name: "Detach Worker" }));
    fireEvent.click(await slot.findByRole("button", { name: "Detach" }));

    await waitFor(() => {
      expect(slot.rpcCalls).toContainEqual({
        method: "taskThreadsDetach",
        input: { taskId: TASK_ID, threadId: "thr_worker000" },
      });
    });
    await waitFor(() => expect(slot.queryByText("Worker")).toBeNull());
  });

  it("revalidates PR state on window focus without a task-thread mutation", async () => {
    const basePullRequest = {
      url: "https://github.com/acme/bb/pull/12",
      number: 12,
      title: "Ship the PR pill",
      updatedAt: "2026-07-16T10:00:00.000Z",
      threadIds: ["thr_worker000"],
    };
    let lookupCount = 0;
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      {
        rpc: detailRpc({
          listTaskPullRequests: () => {
            lookupCount += 1;
            return {
              pullRequests: [
                {
                  ...basePullRequest,
                  state: lookupCount === 1 ? "open" : "merged",
                },
              ],
              unavailableThreadIds: [],
            };
          },
        }),
      },
    );

    await slot.findByRole("link", {
      name: "Pull request #12: Ship the PR pill (Open)",
    });

    window.dispatchEvent(new Event("focus"));

    await waitFor(() => {
      expect(
        slot.getByRole("link", {
          name: "Pull request #12: Ship the PR pill (Merged)",
        }),
      ).toBeTruthy();
    });
  });
});

it("shows an epic's tasks and progress and creates a member without turning it into a sub-task", async () => {
  const epic = { ...task, type: "epic" as const };
  const member = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT6", key: "TSK-6", title: "First epic task", epicId: task.id, status: "done" });
  const remaining = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT7", key: "TSK-7", title: "Second epic task", epicId: task.id });
  const creates: Record<string, unknown>[] = [];
  const slot = renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, {
    rpc: detailRpc({
      getTaskByKey: () => ({ task: epic }),
      listTasks: (raw: unknown) => ({ tasks: rpcInput(raw).epicId === epic.id ? [member, remaining] : [], nextCursor: null }),
      createTask: (raw: unknown) => {
        const input = rpcInput(raw);
        creates.push(input);
        return { ok: true, task: makeTask({ ...input, id: "01HZZZZZZZZZZZZZZZZZZZZZT8" }) };
      },
    }),
  });
  await slot.findByRole("heading", { name: "Tasks in this epic" });
  expect(await slot.findByRole("button", { name: "1/2 tasks" })).toBeTruthy();
  expect(await slot.findByRole("button", { name: /First epic task/ })).toBeTruthy();
  fireEvent.click(slot.getByRole("button", { name: "Add task" }));
  const input = slot.getByPlaceholderText("Task in TSK-5…");
  fireEvent.change(input, { target: { value: "New member" } });
  fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(creates).toHaveLength(1));
  expect(creates[0]).toMatchObject({ projectId: PROJECT_ID, title: "New member", epicId: epic.id });
  expect(creates[0]!.parentTaskId).toBeUndefined();
  remaining.status = "done";
  await slot.behavior.emitRealtime("tasks:changed", { taskId: remaining.id, projectId: PROJECT_ID });
  await slot.findByRole("button", { name: "2/2 tasks" });
});

describe("copying the task key", () => {
  it.each(["main", "side"])(
    "copies only the key from the %s detail view",
    async (surface) => {
      const options = { rpc: detailRpc() };
      const slot =
        surface === "main"
          ? renderSlot(app.navPanels[0]!, { subPath: "task/TSK-5" }, options)
          : renderSlot(
              app.threadPanelActions[0]!,
              { threadId: "thr_copy", params: { taskKey: "TSK-5" } },
              options,
            );
      fireEvent.click(
        await slot.findByRole("button", { name: "Copy task key" }),
      );
      await slot.findByText("Task key copied");
      expect(slot.inspection.experimental_clipboardWrites).toEqual([
        { text: "TSK-5" },
      ]);
      expect(
        slot.getByRole("textbox", { name: "Task title" }).textContent,
      ).toBe(task.title);
      expect(slot.rpcCalls.some((call) => call.method === "updateTask")).toBe(
        false,
      );
      const back = slot.getByRole("button", {
        name: surface === "main" ? "Back (Esc)" : "Back to project board",
      });
      const heading = back.closest("header")!;
      expect(heading.getAttribute("aria-label")).toBe("Task heading");
      expect(slot.getByRole("button", { name: "Copy task key" }).closest("header")).toBe(heading);
      expect(slot.getByText(task.key).nextElementSibling).toBe(slot.getByRole("button", { name: "Copy task key" }));
      expect(
        heading.parentElement!.contains(
          slot.getByRole("textbox", { name: "Task title" }),
        ),
      ).toBe(true);
      expect(slot.getAllByText(task.key)).toHaveLength(1);
      if (surface === "main") {
        fireEvent.click(back);
        expect(slot.navigateCalls).toContainEqual({
          method: "toPluginPanel",
          path: "work-board",
          options: { subPath: "all" },
        });
      } else {
        expect(
          heading.contains(
            slot.getByRole("button", { name: "Open TSK-5 in Tasks" }),
          ),
        ).toBe(true);
      }
    },
  );

  it("copies only the key while the task title is being edited", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: "task/TSK-5" },
      { rpc: detailRpc() },
    );
    const title = await slot.findByRole("textbox", { name: "Task title" });
    title.textContent = "Updated task title";
    fireEvent.input(title);
    fireEvent.click(slot.getByRole("button", { name: "Copy task key" }));
    await slot.findByText("Task key copied");
    expect(slot.inspection.experimental_clipboardWrites).toEqual([
      { text: "TSK-5" },
    ]);
  });

  it.each(["refused", "failed"])(
    "reports clipboard writes that are %s",
    async (failure) => {
      const slot = renderSlot(
        app.navPanels[0]!,
        { subPath: "task/TSK-5" },
        {
          rpc: detailRpc(),
          experimental_copyToClipboard: async () => {
            if (failure === "failed") throw new Error("Clipboard unavailable");
            return false;
          },
        },
      );
      fireEvent.click(
        await slot.findByRole("button", { name: "Copy task key" }),
      );
      await slot.findByText("Could not copy task key. Please try again.");
      expect(slot.queryByText("Task key copied")).toBeNull();
    },
  );
});
