import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { randomUUID } from "node:crypto";
import { MIGRATIONS } from "./schema";
import { createUlid } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

export function scheduleHistory(db: Database) {
  return ["task_schedules", "task_scheduled_sources", "task_schedule_runs"].map(table =>
    db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

/** Build a populated database at the schema revision immediately before schedule retirement. */
export function legacyBoard(db: Database) {
  const now = "2026-01-01T09:00:00.000Z";
  db.pragma("foreign_keys = OFF"); // Early migrations rebuild projects and tasks.
  db.exec("CREATE TABLE schema_version(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
  for (const [index, migration] of MIGRATIONS.slice(0, 53).entries()) {
    if (typeof migration === "string") db.exec(migration);
    else migration(db, () => {});
    db.prepare("INSERT INTO schema_version VALUES (?, ?)").run(index + 1, now);
  }
  db.pragma("foreign_keys = ON");
  const projectId = createUlid();
  db.prepare("INSERT INTO projects(id, name, prefix, next_task_number, color, linked_bb_project_id, status_notifications, auto_archive_after_days, stale_idle_minutes, created_at) VALUES (?, 'Example', 'EXA', 7, 'blue', 'proj_example', 'all', 'off', '45', ?)").run(projectId, now);
  const card = (number: number, title: string, status: string) => {
    const id = createUlid();
    db.prepare("INSERT INTO tasks(id, project_id, number, title, description, status, priority, position, created_at, updated_at) VALUES (?, ?, ?, ?, 'Original body', ?, 'none', ?, ?, ?)").run(id, projectId, number, title, status, number, now, now);
    return id;
  };
  const template = card(1, "Weekly review", "backlog");
  const pending = card(2, "Pending result", "todo");
  const completed = card(3, "Completed result", "done");
  const parent = card(4, "Parent", "todo");
  const once = card(5, "One-time result", "done");
  const expired = card(6, "Expired run result", "done");
  db.prepare("UPDATE tasks SET parent_task_id=? WHERE id=?").run(parent, completed);
  db.prepare("INSERT INTO comments(id, task_id, kind, author_name, body, created_at) VALUES (?, ?, 'user', 'Owner', 'Keep this note', ?)").run(createUlid(), template, now);
  const id = randomUUID();
  const rule = { kind: "weekly", weekdays: [1], time: "09:00", timezone: "UTC" };
  const title = "Weekly review";
  db.prepare("INSERT INTO task_schedules VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)").run(id, projectId, template, JSON.stringify(rule), JSON.stringify({ kind: "thread", threadId: "thr_example" }), now, now, now);
  const schedules = [{ id, projectId, templateTaskId: template, title, rule, target: { kind: "unassigned" }, enabled: false, nextDueAt: null, createdAt: now, updatedAt: now }];
  const onceScheduleId = randomUUID(); // One-time schedule removed after execution.
  const scheduleRuns = [pending, completed, once].map((taskId, index) => {
    const done = taskId !== pending;
    const run = { id: randomUUID(), scheduleId: taskId === once ? onceScheduleId : id, projectId, scheduleTitle: taskId === once ? "One-time review" : title, occurrenceKey: `slot:${index}`, scheduledFor: now,
      state: done ? "completed" : "queued", taskId, threadId: "thr_example", queueId: done ? null : "queue_example", requestId: "request_example",
      reason: null, startedAt: done ? now : null, finishedAt: done ? now : null, resolvedAt: null, createdAt: now, updatedAt: now,
      pushState: "not_attempted", pushChannels: [], pushError: null, execution: null, historical: false };
    db.prepare("INSERT INTO task_schedule_runs VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)").run(run.id, run.scheduleId, projectId, run.occurrenceKey, run.state, run.finishedAt, run.threadId, JSON.stringify(run));
    db.prepare("INSERT INTO task_threads(id, task_id, thread_id, preset_name, title, live_status, attached_at, updated_at, created_for_task, link_origin) VALUES (?, ?, ?, 'Example', 'Review', ?, ?, ?, ?, ?)").run(createUlid(), taskId, "thr_example", done ? "completed" : "idle", now, now, done ? 1 : 0, done ? "scheduled_spawn" : "scheduled_existing");
    return { ...run, threadId: null, queueId: null, requestId: null, historical: true };
  });
  const scheduleSources = [
    { taskId: template, scheduleId: id, scheduleTitle: title, role: "template", scheduledFor: null, startedAt: null, runId: null, occurrenceKey: null },
    ...scheduleRuns.map(run => ({ taskId: run.taskId, scheduleId: run.scheduleId, scheduleTitle: run.scheduleTitle, role: run.taskId === once ? "one_time_run" : "recurring_run", scheduledFor: now, startedAt: run.startedAt, runId: run.id, occurrenceKey: run.occurrenceKey })),
    { taskId: expired, scheduleId: randomUUID(), scheduleTitle: "Removed schedule", role: "recurring_run", scheduledFor: now, startedAt: now, runId: randomUUID(), occurrenceKey: "slot:expired" },
  ];
  for (const source of scheduleSources) db.prepare("INSERT INTO task_scheduled_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(source.taskId, source.scheduleId, source.scheduleTitle, source.role, source.scheduledFor, source.startedAt, source.runId, source.occurrenceKey);
  return { projectId, template, pending, completed, parent, once, expired, schedules, scheduleSources, scheduleRuns };
}
