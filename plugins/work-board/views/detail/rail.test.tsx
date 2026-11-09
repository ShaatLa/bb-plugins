// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  installTestPluginRuntime,
  renderSlot,
} from "@get-bb/plugin-sdk/testing/app";
import { makeTask, rpcInput } from "../../test-fixtures.js";

if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

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

installTestPluginRuntime();
const { PropertiesRail, InlineProperties } = await import("./rail");
const { TasksRefreshProvider } = await import("../../shell/refresh");

function RailHarness(props: ComponentProps<typeof PropertiesRail>) {
  return (
    <TasksRefreshProvider>
      <PropertiesRail {...props} />
    </TasksRefreshProvider>
  );
}

afterEach(cleanup);

const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const BB_PROJECT_ID = "proj_bb0000000000000000000001";

function projectRow(linkedBbProjectId: string | null) {
  return {
    id: PROJECT_ID,
    name: "Tasks Plugin",
    prefix: "TSK",
    nextTaskNumber: 6,
    color: "blue",
    folderId: null,
    linkedBbProjectId,
    createdAt: "2026-07-15T00:00:00.000Z",
  };
}

const task = makeTask({
  id: "01HZZZZZZZZZZZZZZZZZZZZZT5",
  projectId: PROJECT_ID,
  number: 5,
  key: "TSK-5",
  title: "Ship the rail",
  position: 1,
});

const HOME_PROJECT = {
  ...projectRow(null),
  id: "01HZZZZZZZZZZZZZZZZZZZZZP2",
  name: "Home",
  prefix: "HOME",
  color: "purple",
};

function railProps(
  linkedBbProjectId: string | null,
  onMoveToProject: (projectId: string) => void = () => {},
) {
  const project = projectRow(linkedBbProjectId);
  return {
    task,
    project,
    projects: [project, HOME_PROJECT],
    labels: [],
    onUpdate: () => {},
    onMoveToProject,
    onError: () => {},
  };
}

describe("project rail control", () => {
  it("moves the task only when a different project is picked", async () => {
    const moves: string[] = [];
    const slot = renderSlot(
      { component: RailHarness },
      railProps(null, (projectId) => moves.push(projectId)),
      { rpc: { listBbProjects: () => ({ bbProjects: [] }) } },
    );
    fireEvent.click(slot.getByRole("button", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("option", { name: /Tasks Plugin/ }));
    expect(moves).toEqual([]);

    fireEvent.click(slot.getByRole("button", { name: "Move to project" }));
    fireEvent.click(await slot.findByRole("option", { name: /Home/ }));
    expect(moves).toEqual([HOME_PROJECT.id]);
  });
});

describe("dispatch target rail control", () => {
  it("links a discovered bb project", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot({ component: RailHarness }, railProps(null), {
      rpc: {
        listBbProjects: () => ({
          bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }],
        }),
        updateProject: (raw: unknown) => {
          const input = rpcInput(raw);
          updateCalls.push(input);
          return {
            project: {
              ...projectRow(input.linkedBbProjectId as string | null),
            },
          };
        },
      },
    });
    fireEvent.click(slot.getByRole("button", { name: "Edit dispatch target" }));
    fireEvent.click(await slot.findByLabelText("Linked bb project"));
    fireEvent.click(await slot.findByRole("option", { name: "bb monorepo" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({
      projectId: PROJECT_ID,
      linkedBbProjectId: BB_PROJECT_ID,
    });
  });

  it("shows the linked bb project's name and unlinks it", async () => {
    const updateCalls: Array<Record<string, unknown>> = [];
    const slot = renderSlot(
      { component: RailHarness },
      railProps(BB_PROJECT_ID),
      {
        rpc: {
          listBbProjects: () => ({
            bbProjects: [{ id: BB_PROJECT_ID, name: "bb monorepo" }],
          }),
          updateProject: (raw: unknown) => {
            const input = rpcInput(raw);
            updateCalls.push(input);
            return {
              project: {
                ...projectRow(input.linkedBbProjectId as string | null),
              },
            };
          },
        },
      },
    );
    const trigger = slot.getByRole("button", {
      name: "Edit dispatch target",
    });
    await slot.findByText("bb monorepo");

    fireEvent.click(trigger);
    fireEvent.click(await slot.findByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(updateCalls).toHaveLength(1));
    expect(updateCalls[0]).toEqual({
      projectId: PROJECT_ID,
      linkedBbProjectId: null,
    });
  });
});

it("assigns and clears an epic using the existing property controls", async () => {
  const epic = makeTask({
    id: "01HZZZZZZZZZZZZZZZZZZZZZT6",
    number: 6,
    key: "TSK-6",
    title: "Big initiative",
    type: "epic",
  });
  const updates: unknown[] = [];
  const slot = renderSlot(
    { component: RailHarness },
    { ...railProps(null), onUpdate: (input) => updates.push(input) },
    {
      rpc: {
        listBbProjects: () => ({ bbProjects: [] }),
        listTasks: () => ({ tasks: [epic], nextCursor: null }),
      },
    },
  );
  fireEvent.click(slot.getByRole("button", { name: "Epic" }));
  fireEvent.click(
    await slot.findByRole("option", { name: /TSK-6 · Big initiative/ }),
  );
  expect(updates).toEqual([{ epicId: epic.id }]);
  fireEvent.click(slot.getByRole("button", { name: "Epic" }));
  fireEvent.click(await slot.findByRole("option", { name: "No epic" }));
  expect(updates.at(-1)).toEqual({ epicId: null });
  fireEvent.keyDown(slot.getByRole("button", { name: "Task type" }), {
    key: "ArrowDown",
  });
  fireEvent.click(await slot.findByRole("menuitem", { name: "Epic" }));
  expect(updates.at(-1)).toEqual({ type: "epic" });
});

describe("Owner action controls", () => {
  it("hides dispatch and lets the current thread become the requester", async () => {
    const updates: unknown[] = [];
    const slot = renderSlot(
      { component: RailHarness },
      {
        ...railProps(BB_PROJECT_ID),
        task: { ...task, executionTarget: "owner" },
        onUpdate: (update) => updates.push(update),
      },
      {
        context: { threadId: "thr_initiator" },
        rpc: { listBbProjects: () => ({ bbProjects: [] }) },
      },
    );
    expect(slot.queryByRole("button", { name: "Existing thread…" })).toBeNull();
    expect(slot.queryByText("Dispatch target")).toBeNull();
    expect(slot.getByText("No requester thread")).toBeTruthy();
    fireEvent.keyDown(slot.getByRole("button", { name: "Executor" }), {
      key: "ArrowDown",
    });
    fireEvent.click(
      await slot.findByRole("menuitem", {
        name: "Use this thread as requester",
      }),
    );
    expect(updates).toEqual([{ requesterThreadId: "thr_initiator" }]);
  });
});

it.each(["rail", "inline"])("opens the selected epic independently of its picker in %s properties", async layout => {
  const epic = makeTask({ id: "01HZZZZZZZZZZZZZZZZZZZZZT6", number: 6, key: "TSK-6", title: "Big initiative", type: "epic" });
  const props = { ...railProps(null), task: { ...task, epicId: epic.id } };
  function Harness() { return <TasksRefreshProvider>{layout === "rail" ? <PropertiesRail {...props} /> : <InlineProperties {...props} />}</TasksRefreshProvider>; }
  const slot = renderSlot({ component: Harness }, {}, { rpc: { listBbProjects: () => ({ bbProjects: [] }), listTasks: () => ({ tasks: [epic], nextCursor: null }) } });
  fireEvent.click(await slot.findByRole("button", { name: "Open epic TSK-6" }));
  expect(slot.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "work-board", options: { subPath: "task/TSK-6" } });
  expect(slot.queryByPlaceholderText("Choose an epic…")).toBeNull();
  fireEvent.click(slot.getByRole("button", { name: "Epic" }));
  expect(await slot.findByRole("option", { name: "No epic" })).toBeTruthy();
});

const ongoingLabel = { id: "01HZZZZZZZZZZZZZZZZZZZZZL1", projectId: PROJECT_ID, name: "ongoing", color: "purple" };

it.each(["rail", "inline"].flatMap(layout => ["ongoing", "Ongoing"].map(name => ({ layout, name }))))("changes an $name epic to no deadline or a date in $layout properties", async ({ layout, name }) => {
  const updates: unknown[] = [];
  const props = { ...railProps(null), task: { ...task, type: "epic" as const, labelIds: ["other", ongoingLabel.id] }, labels: [{ ...ongoingLabel, name }], onUpdate: (update: unknown) => updates.push(update) };
  function Harness() { return <TasksRefreshProvider>{layout === "rail" ? <PropertiesRail {...props} /> : <InlineProperties {...props} />}</TasksRefreshProvider>; }
  const slot = renderSlot({ component: Harness }, {}, { rpc: { listBbProjects: () => ({ bbProjects: [] }) } });
  expect(slot.getByRole("button", { name: "Timeframe" }).textContent).toContain("Ongoing");
  fireEvent.click(slot.getByRole("button", { name: "Timeframe" }));
  fireEvent.click(await slot.findByRole("button", { name: "Ongoing" }));
  expect(updates).toEqual([{ dueDate: null, labelIds: ["other", ongoingLabel.id] }]);
  updates.length = 0;
  fireEvent.click(slot.getByRole("button", { name: "Timeframe" }));
  fireEvent.click(await slot.findByRole("button", { name: "No deadline" }));
  expect(updates).toEqual([{ dueDate: null, labelIds: ["other"] }]);
  fireEvent.click(slot.getByRole("button", { name: "Timeframe" }));
  fireEvent.click(await slot.findByRole("button", { name: "Due date…" }));
  fireEvent.change(slot.getByLabelText("Due date"), { target: { value: "2027-01-12" } });
  expect(updates[1]).toEqual({ dueDate: "2027-01-12", labelIds: ["other"] });
});

it.each([false, true])("creates the ongoing label safely (creation fails: %s)", async fails => {
  const updates: unknown[] = [];
  const creates: unknown[] = [];
  const slot = renderSlot({ component: RailHarness }, {
    ...railProps(null), task: { ...task, type: "epic", dueDate: "2027-01-12", labelIds: ["other"] },
    onUpdate: update => updates.push(update),
  }, { rpc: {
    listBbProjects: () => ({ bbProjects: [] }),
    createLabel: raw => { creates.push(rpcInput(raw)); if (fails) throw new Error("Cannot create label"); return { label: ongoingLabel }; },
  } });
  fireEvent.click(slot.getByRole("button", { name: "Timeframe" }));
  fireEvent.click(await slot.findByRole("button", { name: "Ongoing" }));
  if (fails) {
    expect(await slot.findByRole("alert")).toBeTruthy();
    expect(updates).toEqual([]);
  } else {
    await waitFor(() => expect(updates).toEqual([{ dueDate: null, labelIds: ["other", ongoingLabel.id] }]));
  }
  expect(creates).toEqual([{ projectId: PROJECT_ID, name: "ongoing", color: "slateblue" }]);
});

it("keeps the ordinary task date picker", async () => {
  const updates: unknown[] = [];
  const slot = renderSlot({ component: RailHarness }, { ...railProps(null), onUpdate: update => updates.push(update) }, { rpc: { listBbProjects: () => ({ bbProjects: [] }) } });
  fireEvent.click(slot.getByRole("button", { name: "Set due date" }));
  expect(slot.queryByRole("button", { name: "Ongoing" })).toBeNull();
  fireEvent.change(slot.getByLabelText("Due date"), { target: { value: "2027-01-12" } });
  expect(updates).toEqual([{ dueDate: "2027-01-12" }]);
});
