import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { getWorkflowPolicy, isClosedStatus } from "../shared/workflow-policy.js";
import { prIdentity, type PrLink, type PrSnapshot } from "../shared/git-sync";
import type { createTasksStore } from "../db/store";

type TasksStore = ReturnType<typeof createTasksStore>;

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
interface Marker { reviewed_head: string | null; state: "open" | "not_open" }

/**
 * Moves the cards a PR delivers into review when the PR becomes reviewable, and keeps the durable marker that makes it
 * happen once per head. Returns the ids of the cards it moved.
 *
 * A PR enters review when its snapshot is open (not a draft) and the card has no marker for it, the marker says it
 * was not open, or the head differs from the last reviewable head. The marker is written with the move, in one
 * transaction, so a crash leaves nothing and the next poll retries. A card an agent moved back to fix findings stays
 * there until a new head arrives.
 */
export function moveCardsToReview(
  db: Database,
  store: { tasks: TasksStore; transaction<T>(operation: () => T): T },
  projectId: string,
  snapshot: PrSnapshot,
  links: readonly PrLink[],
): string[] {
  const project = store.tasks.getProject(projectId);
  if (!project) return [];
  const policy = getWorkflowPolicy(project);
  const statuses = project.statuses ?? DEFAULT_TASK_STATUSES;
  const target = statuses.findIndex((status) => status.id === policy.reviewStatus);
  if (target < 0) return [];
  const identity = prIdentity(snapshot);
  const head = snapshot.headSha.toLowerCase();
  const read = db.prepare<[string, string], Marker>("SELECT reviewed_head, state FROM pr_review_moves WHERE task_id=? AND identity=?");
  const mark = db.prepare<[string, string, string]>(
    "INSERT INTO pr_review_moves(task_id, identity, reviewed_head, state) VALUES (?, ?, ?, 'open') ON CONFLICT(task_id, identity) DO UPDATE SET reviewed_head=excluded.reviewed_head, state='open'");
  const moved: string[] = [];
  for (const link of links) {
    if (prIdentity(link) !== identity || link.excluded || !link.confirmed || link.role !== "delivers") continue;
    const task = store.tasks.getTask(link.taskId);
    if (!task || task.projectId !== projectId || task.archivedAt) continue;
    const row = read.get(task.id, identity);
    // A draft, closed or merged PR changes only the state: the head stays the last reviewable baseline.
    if (snapshot.state !== "open") {
      if (row && row.state !== "not_open") db.prepare<[string, string]>("UPDATE pr_review_moves SET state='not_open' WHERE task_id=? AND identity=?").run(task.id, identity);
      continue;
    }
    if (row && row.state === "open" && row.reviewed_head?.toLowerCase() === head) continue;
    const bugfix = task.status === policy.bugfixStatus;
    const past = !bugfix && (isClosedStatus(project, task.status) || statuses.findIndex((status) => status.id === task.status) >= target);
    const early = !bugfix && !past && policy.earlyStatuses.includes(task.status);
    // Backlog, Planning and the like keep no marker, so the PR is looked at again once the card reaches an early status.
    if (!bugfix && !past && !early) continue;
    // A bugfix card moves only when a new head was pushed after a reviewable one; a first sighting just sets the marker.
    const move = early || (bugfix && !!row && row.reviewed_head?.toLowerCase() !== head);
    if (move && store.tasks.planGate(task, policy.reviewStatus!)) continue;
    store.transaction(() => {
      if (move) store.tasks.updateTask(task.id, { status: policy.reviewStatus!, statusLog: { by: "Work Board", cause: `${snapshot.repository}#${snapshot.number} ready for review at ${head.slice(0, 7)}` } });
      mark.run(task.id, identity, head);
    });
    if (move) moved.push(task.id);
  }
  return moved;
}
