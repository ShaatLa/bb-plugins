import { afterEach, describe, expect, it } from "vitest";
import { epicTasksInWork } from "./observe";
import { goLive, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const make = async () => { const f = setup(); fixtures.push(f); await goLive(f); return f; };
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

const epicCard = (f: ReturnType<typeof setup>, title: string) => f.card(title, "in_progress", { type: "epic" });
const flagged = (f: ReturnType<typeof setup>, id: string) => f.occurrences().some((o) => o.task_id === id && o.signal === "no_active_thread");
const meta = async (f: ReturnType<typeof setup>, id: string) => (await f.call("listTaskCardMeta", { taskIds: [id] })).metadata[0];

describe("an epic with a task in work", () => {
  it("lists in-work tasks by effective epic, leaving out Backlog, Todo, closed and archived cards", async () => {
    const f = await make();
    const epic = epicCard(f, "Epic");
    const t = (title: string, status: string, extra: Record<string, unknown> = {}) => f.store.tasks.createTask({ projectId: f.tracker.id, title, status, epicId: epic.id, ...extra } as never);
    t("Backlog", "backlog"); t("Todo", "todo"); t("Done", "done"); t("Canceled", "canceled");
    f.db.prepare("UPDATE tasks SET archived_at=? WHERE id=?").run(new Date().toISOString(), t("Archived", "in_progress").id);
    expect(epicTasksInWork(f.db).size).toBe(0);
    const review = t("Review", "in_review");
    const parent = t("Backlog parent", "backlog");
    const sub = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Sub", status: "in_progress", parentTaskId: parent.id } as never);
    expect(epicTasksInWork(f.db, [epic.id]).get(epic.id)).toEqual([review.key, sub.key].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1])));
    expect(epicTasksInWork(f.db, [], f.tracker.id).size).toBe(0);
  });

  it("is Working with an explanation, has no stale flag; with none in work it keeps today's behavior", async () => {
    const f = await make();
    const epic = epicCard(f, "Epic");
    const idle = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Idle", status: "todo", epicId: epic.id } as never);
    expect(f.store.tasks.staleStatusFlags([epic.id]).get(epic.id)).toContain("no_active_thread");
    expect(flagged(f, epic.id)).toBe(true);
    expect((await meta(f, epic.id)).activity.state).toBeNull();
    f.store.tasks.updateTask(idle.id, { status: "in_progress" });
    expect(f.store.tasks.staleStatusFlags([epic.id]).has(epic.id)).toBe(false);
    expect(flagged(f, epic.id)).toBe(false);
    expect((await meta(f, epic.id)).activity).toMatchObject({ state: "working", workingCount: 0, attachedCount: 0, diagnostics: { explanation: `Its tasks are in work: ${idle.key}.` } });
  });

  it("is Working when the only in-work card is a sub-task of a Backlog task of the epic", async () => {
    const f = await make();
    const epic = epicCard(f, "Epic");
    const parent = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Parent", status: "backlog", epicId: epic.id } as never);
    f.store.tasks.createTask({ projectId: f.tracker.id, title: "Sub", status: "in_progress", parentTaskId: parent.id } as never);
    expect(f.store.tasks.staleStatusFlags([epic.id]).has(epic.id)).toBe(false);
    expect((await meta(f, epic.id)).activity.state).toBe("working");
  });

  // Each case ends the last task in work in one write; the epic's signal must come back in that same write.
  const leaving: [string, (f: ReturnType<typeof setup>, child: { id: string }, epic: { id: string }) => void][] = [
    ["moved back to Todo", (f, child) => { f.store.tasks.updateTask(child.id, { status: "todo" }); }],
    ["moved to Done", (f, child) => { f.store.tasks.updateTask(child.id, { status: "done" }); }],
    ["deleted", (f, child) => { f.store.tasks.deleteTask(child.id); }],
    ["epic removed", (f, child) => { f.store.tasks.updateTask(child.id, { epicId: null }); }],
    ["moved to another project", (f, child) => { f.store.tasks.moveTaskToProject(child.id, f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" }).id); }],
  ];
  for (const [name, act] of leaving) {
    it(`brings the stale flag back in the same write when the last task in work is ${name}`, async () => {
      const f = await make();
      const epic = epicCard(f, "Epic");
      const child = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Child", status: "todo", epicId: epic.id } as never);
      expect(flagged(f, epic.id)).toBe(true);
      f.store.tasks.updateTask(child.id, { status: "in_progress" });
      expect(flagged(f, epic.id)).toBe(false);
      act(f, child, epic);
      expect(flagged(f, epic.id)).toBe(true);
    });
  }

  // Archiving needs a Done or Canceled family, so an archive never changes an epic's in-work set: it stays flagged throughout.
  it("keeps the epic flagged in the same write through Done, archive and unarchive of its last task", async () => {
    const f = await make();
    const epic = epicCard(f, "Epic");
    const child = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Child", status: "in_progress", epicId: epic.id } as never);
    const sub = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Sub", status: "in_progress", parentTaskId: child.id } as never);
    expect(flagged(f, epic.id)).toBe(false);
    expect(() => f.store.tasks.setTaskArchived(child.id, true)).toThrow();
    expect(flagged(f, epic.id)).toBe(false);
    f.store.tasks.updateTask(sub.id, { status: "done" });
    expect(flagged(f, epic.id)).toBe(false);
    f.store.tasks.updateTask(child.id, { status: "done" });
    expect(flagged(f, epic.id)).toBe(true);
    f.store.tasks.setTaskArchived(child.id, true);
    expect(flagged(f, epic.id)).toBe(true);
    expect(epicTasksInWork(f.db, [epic.id]).size).toBe(0);
    f.store.tasks.setTaskArchived(child.id, false);
    expect(flagged(f, epic.id)).toBe(true);
    expect(epicTasksInWork(f.db, [epic.id]).size).toBe(0);
  });

  it("moves the signal between epics in the write that moves the task, also through a Backlog parent", async () => {
    const f = await make();
    const [one, two] = [epicCard(f, "One"), epicCard(f, "Two")];
    const child = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Child", status: "in_progress", epicId: one.id } as never);
    expect(flagged(f, one.id)).toBe(false);
    expect(flagged(f, two.id)).toBe(true);
    f.store.tasks.updateTask(child.id, { epicId: two.id });
    expect([flagged(f, one.id), flagged(f, two.id)]).toEqual([true, false]);
    const parent = f.store.tasks.createTask({ projectId: f.tracker.id, title: "Parent", status: "backlog", epicId: two.id } as never);
    f.store.tasks.updateTask(child.id, { epicId: null, parentTaskId: parent.id });
    expect(flagged(f, two.id)).toBe(false);
    f.store.tasks.updateTask(parent.id, { epicId: one.id });
    expect([flagged(f, one.id), flagged(f, two.id)]).toEqual([false, true]);
    f.store.tasks.updateTask(child.id, { parentTaskId: null });
    expect(flagged(f, one.id)).toBe(true);
  });
});
