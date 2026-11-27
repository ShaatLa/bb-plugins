import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { TasksStore } from "../db/store";
import { isClosedStatus } from "../shared/workflow-policy";

type Thread = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];
type Candidate = { id: string; thread_id: string; live_status: "idle" | "starting"; updated_at: string; status: string; workflow_policy: string | null };

async function readCapacity(bb: BbPluginApi, ids: readonly string[]) {
  const threads = new Map<string, Thread>();
  const waits = new Map<string, string>();
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    for (const thread of await bb.sdk.threads.list({ threadIds: [...batch], limit: batch.length, includeHidden: true })) threads.set(thread.id, thread);
  }
  await Promise.all([...threads.values()].filter(t => t.queuedWork === "waiting" && t.archivedAt == null && t.deletedAt == null).map(async thread => {
    const rows = await bb.sdk.threads.queuedMessages.list({ threadId: thread.id });
    const row = rows.find(row => row.state === "waiting" && row.waitingOn?.kind === "plugin" && row.waitingOn.pluginId === "concurrency-limit");
    if (row?.waitingOn?.kind === "plugin") waits.set(thread.id, row.waitingOn.reason);
  }));
  return { threads, waits };
}

export async function capacityWait(bb: BbPluginApi, threadIds: readonly string[]): Promise<Map<string, string>> {
  return (await readCapacity(bb, [...new Set(threadIds)])).waits;
}

export function capacityCandidates(bb: BbPluginApi, trackerId?: string): Candidate[] {
  const rows = bb.storage.database().prepare<[string | null, string | null], Candidate>(`SELECT l.id,l.thread_id,l.live_status,l.updated_at,t.status,p.workflow_policy
    FROM task_threads l JOIN tasks t ON t.id=l.task_id JOIN projects p ON p.id=t.project_id
    WHERE l.live_status IN ('idle','starting') AND t.archived_at IS NULL AND (? IS NULL OR t.project_id=?)`).all(trackerId ?? null, trackerId ?? null);
  return rows.filter(row => !isClosedStatus({ workflowPolicy: row.workflow_policy ? JSON.parse(row.workflow_policy) : null }, row.status));
}

export async function checkCapacityCandidates(bb: BbPluginApi, store: TasksStore, candidates: Candidate[], reset = false): Promise<void> {
  const { threads, waits } = await readCapacity(bb, [...new Set(candidates.map(row => row.thread_id))]);
  for (const row of candidates) {
    const thread = threads.get(row.thread_id);
    if (!thread || thread.archivedAt != null || thread.deletedAt != null || thread.status === "error") continue;
    const next = row.live_status === "idle" && waits.has(row.thread_id) ? "starting"
      : reset && row.live_status === "starting" && thread.status === "idle" && !waits.has(row.thread_id) ? "idle" : null;
    if (next) store.setLinkLiveStatusIf(row.id, { liveStatus: row.live_status, updatedAt: row.updated_at }, next);
  }
}

const running = new WeakMap<BbPluginApi, { promise: Promise<void>; rerun: boolean }>();
export function syncCapacityWaits(bb: BbPluginApi, store: TasksStore): Promise<void> {
  const current = running.get(bb);
  if (current) { current.rerun = true; return current.promise; }
  const state = { promise: Promise.resolve(), rerun: false };
  state.promise = (async () => {
    do {
      state.rerun = false;
      try { await checkCapacityCandidates(bb, store, capacityCandidates(bb), true); }
      catch (error) { bb.log.warn(`Capacity wait read failed: ${String(error)}`); }
    } while (state.rerun);
  })().finally(() => running.delete(bb));
  running.set(bb, state);
  return state.promise;
}
