import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { DEFAULT_TASK_STATUSES } from "../shared/statuses";
import { isClosed, isDoneStatus, isNotStarted } from "../shared/status-roles";
import { closedSql, doneSql, isClosedIn, isDoneIn, notStartedSql } from "./status-sql";

const harnesses: FakePluginHarness[] = [];
afterEach(async () => { await Promise.all(harnesses.splice(0).map((h) => h.dispose())); });

const list = (...ids: string[]) => ids.map((id) => ({ id, name: id }));
const withoutOf = (...removed: string[]) => DEFAULT_TASK_STATUSES.filter((status) => !removed.includes(status.id));
const cases: Array<{ name: string; statuses: Array<{ id: string; name: string }> | null; policy: object | null }> = [
  { name: "defaults", statuses: null, policy: null },
  { name: "default list, stored policy", statuses: [...DEFAULT_TASK_STATUSES], policy: { doneStatus: "done", earlyStatuses: ["todo"] } },
  { name: "custom doneStatus, done still listed", statuses: [...list("backlog", "todo", "shipped", "done", "canceled")], policy: { doneStatus: "shipped" } },
  { name: "no todo", statuses: withoutOf("todo"), policy: null },
  { name: "no canceled", statuses: withoutOf("canceled"), policy: null },
  { name: "no done, doneStatus shipped", statuses: list("backlog", "shipped", "canceled"), policy: { doneStatus: "shipped" } },
  { name: "explicit closedStatuses without done", statuses: [...DEFAULT_TASK_STATUSES], policy: { closedStatuses: ["canceled"] } },
  { name: "explicit closed, done null", statuses: [...DEFAULT_TASK_STATUSES], policy: { closedStatuses: ["canceled"], doneStatus: null } },
  { name: "explicit null canceled, explicit not started", statuses: [...DEFAULT_TASK_STATUSES], policy: { canceledStatus: null, notStartedStatuses: ["backlog"] } },
  { name: "custom statuses only", statuses: list("a", "b", "c"), policy: { doneStatus: "c", closedStatuses: ["b"], notStartedStatuses: ["a", "gone"] } },
];

it("answers closed, done and not-started the same in TS and SQL, over the same projects", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  harnesses.push(harness);
  const store = createStore(bb);
  const db = bb.storage.database();
  for (const [index, entry] of cases.entries()) {
    const project = store.tasks.createProject({ name: entry.name, prefix: `P${index}`, color: "blue" });
    const ids = (entry.statuses ?? DEFAULT_TASK_STATUSES).map((status) => status.id);
    for (const id of ids) {
      const task = store.tasks.createTask({ projectId: project.id, title: id });
      db.prepare("UPDATE tasks SET status=? WHERE id=?").run(id, task.id);
    }
    db.prepare("UPDATE projects SET statuses=?, workflow_policy=? WHERE id=?").run(entry.statuses ? JSON.stringify(entry.statuses) : null, entry.policy ? JSON.stringify(entry.policy) : null, project.id);
    const stored = store.tasks.getProject(project.id)!;
    const sql = (fragment: (t: string, p: string) => string) => new Set(db.prepare<[string], { status: string }>(
      `SELECT t.status FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.project_id=? AND ${fragment("t", "p")}`).all(project.id).map((row) => row.status));
    const closed = sql(closedSql), done = sql(doneSql), notStarted = sql(notStartedSql);
    for (const status of ids) {
      expect({ case: entry.name, status, closed: closed.has(status) }).toEqual({ case: entry.name, status, closed: isClosed(stored, status) });
      expect({ case: entry.name, status, done: done.has(status) }).toEqual({ case: entry.name, status, done: isDoneStatus(stored, status) });
      expect({ case: entry.name, status, notStarted: notStarted.has(status) }).toEqual({ case: entry.name, status, notStarted: isNotStarted(stored, status) });
    }
    // The subquery forms agree with the joined ones.
    const viaSubquery = (fragment: string) => new Set(db.prepare<[string], { status: string }>(`SELECT t.status FROM tasks t WHERE t.project_id=? AND ${fragment}`).all(project.id).map((row) => row.status));
    expect(viaSubquery(isClosedIn("t"))).toEqual(closed);
    expect(viaSubquery(isDoneIn("t"))).toEqual(done);
  }
});
