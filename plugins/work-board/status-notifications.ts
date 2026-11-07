import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { TasksStore } from "./db/store";
import type { Task } from "./db/types";
import { statusLabel } from "./shared/statuses";

const pushOutput = z.object({ ok: z.literal(true), channels: z.array(z.enum(["web", "desktop", "mobile"])) });

/** Observe both edit and drag/drop, including CLI and agent calls to the shared store. */
export function observeStatusNotifications(bb: BbPluginApi, tasks: TasksStore) {
  const pending = new Map<string, Pick<Task, "id" | "status">>();
  let draining = false;
  let closed = false;
  bb.onDispose(() => { closed = true; pending.clear(); });
  async function drain() {
    try {
      while (!closed && pending.size) {
        const batch = [...pending.values()].slice(0, 128);
        for (const task of batch) pending.delete(task.id);
        await Promise.resolve();
        for (const before of batch) {
          if (closed) return;
          // Read after the synchronous transaction: rolled-back and transient changes do not notify.
          const task = tasks.getTask(before.id);
          if (!task || task.status === before.status || task.archivedAt || task.scheduledRole === "template") continue;
          if (task.ordinaryVisible === false && task.status !== "done") continue;
          const project = tasks.getProject(task.projectId);
          if (!project || !project.statusNotifications || project.statusNotifications === "off") continue;
          if (project.statusNotifications === "done" && task.status !== "done") continue;
          const statuses = project.statuses;
          try {
            const result = await bb.sdk.plugins.callRpc({
              pluginId: "push-notifications", method: "notifications.send",
              input: {
                title: `${task.key} · ${statusLabel(task.status, statuses)}`.slice(0, 80),
                body: `${task.title} · ${statusLabel(before.status, statuses)} → ${statusLabel(task.status, statuses)}`.slice(0, 180),
              },
              outputSchema: pushOutput,
            });
            if (!result.channels.length) bb.log.warn(`Status push not delivered for ${task.key}`);
          } catch { bb.log.warn(`Status push failed for ${task.key}`); }
        }
      }
    } catch { if (!closed) bb.log.warn("Could not read status notification settings"); }
    finally { draining = false; }
  }
  function changed(before: Task | undefined, after: Task) {
    if (closed || !before || before.status === after.status) return;
    // Off projects must not schedule deferred reads during unrelated lifecycle work.
    const mode = tasks.getProject(after.projectId)?.statusNotifications ?? "off";
    if (mode === "off" || (mode === "done" && after.status !== "done")) return;
    // Retain only one tiny record per changed card, never task bodies or a history of edits.
    if (!pending.has(before.id)) pending.set(before.id, { id: before.id, status: before.status });
    if (!draining) { draining = true; queueMicrotask(() => { void drain(); }); }
  }
  const updateTask = tasks.updateTask;
  tasks.updateTask = (id, input) => {
    const before = input.status === undefined ? undefined : tasks.getTask(id);
    const task = updateTask(id, input);
    changed(before, task);
    return task;
  };
  const updatePosition = tasks.updatePosition;
  tasks.updatePosition = (id, input) => {
    const before = tasks.getTask(id);
    const task = updatePosition(id, input);
    changed(before, task);
    return task;
  };
}
