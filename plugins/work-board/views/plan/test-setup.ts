import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../../api";
import { tasksRpcContract, type PlanAuthor } from "../../shared/contract";

export const AGENT: PlanAuthor = { kind: "agent", threadId: "thr_example", name: "agent (thr_example)" };

export const BODY = [
  "# Release plan",
  "",
  "Intro paragraph.",
  "",
  "## Steps",
  "",
  "- [ ] first step",
  "- [ ] second step",
  "",
  "```sh",
  "# not a heading",
  "echo done",
  "```",
  "",
  "## Risks",
  "",
  "Nothing known.",
  "",
].join("\n");

/** A fake plugin host with one project (EXA), one task (EXA-1) and RPC functions for renderSlot. */
export function setupPlanHost(harnesses: FakePluginHarness[]) {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  registerTasksApi(bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  // Planning is the owner's setting (changed in the project settings), so the fixture sets it directly.
  store.tasks.updateProject(project.id, { planning: "optional" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Planned work" });
  const rpc = Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)]));
  const save = (input: Record<string, unknown>) =>
    harness.callRpc("saveTaskPlan", { taskId: task.id, summary: "Edit", author: AGENT, op: "replace", ...input }) as Promise<{ ok: boolean }>;
  return { store, project, task, rpc, save, harness, db: bb.storage.database() };
}
