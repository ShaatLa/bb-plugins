import { useEffect, useState } from "react";
import type { PlanAuthor } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { useTasksQuery, useTasksRpc, type TasksRpc } from "../../shell/data.js";

/** Same display name the other person-written records of the board use (the RPC default). */
export const PERSON_AUTHOR: PlanAuthor = { kind: "person", threadId: null, name: "You" };

/** Version bodies never change, so every body read stays in memory for the session (bounded, oldest out first). */
const BODY_CACHE_LIMIT = 40;
const bodies = new Map<string, string>();
const bodyKey = (taskId: string, version: number) => `${taskId}:${version}`;

function rememberBody(taskId: string, version: number, body: string) {
  const key = bodyKey(taskId, version);
  bodies.delete(key);
  bodies.set(key, body);
  if (bodies.size > BODY_CACHE_LIMIT) bodies.delete(bodies.keys().next().value!);
}

export async function loadPlanBody(rpc: TasksRpc, taskId: string, version: number): Promise<string> {
  const cached = bodies.get(bodyKey(taskId, version));
  if (cached !== undefined) return cached;
  const { plan } = await rpc.call("getTaskPlan", { taskId, version });
  if (!plan) throw new Error("This task has no plan");
  rememberBody(taskId, version, plan.requested.body);
  return plan.requested.body;
}

/** One version's Markdown; undefined while loading. Version 0 is the empty plan before the first version. */
export function usePlanBody(taskId: string | null, version: number | null): { body: string | undefined; error: string | null } {
  const rpc = useTasksRpc();
  const key = taskId !== null && version !== null ? bodyKey(taskId, version) : null;
  const [fetched, setFetched] = useState<{ key: string; error: string | null } | null>(null);
  useEffect(() => {
    if (key === null || version === 0 || bodies.has(key)) return;
    let live = true;
    loadPlanBody(rpc, taskId!, version!).then(
      () => live && setFetched({ key, error: null }),
      (error: unknown) => live && setFetched({ key, error: errorMessage(error) }),
    );
    return () => { live = false; };
  }, [rpc, key, taskId, version]);
  if (key === null) return { body: undefined, error: null };
  if (version === 0) return { body: "", error: null };
  return { body: bodies.get(key), error: fetched?.key === key ? fetched.error : null };
}

/** The planning mode of a project; undefined while it loads. With `off` nothing of the plan is shown or read. */
export function usePlanning(projectId: string | null): "off" | "optional" | "required" | undefined {
  const projects = useTasksQuery(async (rpc) => (await rpc.call("listProjects", {})).projects, ["projects:changed"], [], { enabled: projectId !== null });
  return projectId === null ? undefined : projects.data?.find((project) => project.id === projectId) ? (projects.data.find((project) => project.id === projectId)!.planning ?? "off") : undefined;
}

/** The plan head and the metadata of every version, live on `tasks:changed` for that task. */
export function usePlanOverview(taskId: string | null) {
  return useTasksQuery(
    async (rpc) => (taskId === null ? null : await rpc.call("listTaskPlanVersions", { taskId })),
    ["tasks:changed"],
    [taskId],
    { enabled: taskId !== null, relevantTaskIds: taskId === null ? [] : [taskId] },
  );
}

/** What a person has typed in the plan editor and not saved yet; survives a tab switch, not a reload. */
export interface PlanDraft {
  text: string;
  summary: string;
  /** The plan version the text was started from; sent as `baseVersion` on save. */
  baseVersion: number;
  /** The text as it was when editing started, to tell a real edit from an opened-and-left editor. */
  original: string;
}
export const planDrafts = new Map<string, PlanDraft>();
