import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { createPlanStore } from "../plans/store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.harness.dispose()));
});

function setup() {
  const host = createFakePluginHost({ pluginId: "work-board", sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => undefined } } });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const project = store.tasks.createProject({ name: "Example", prefix: "EXA", color: "blue" });
  const card = (status = "todo") => store.tasks.createTask({ projectId: project.id, title: "Work", status });
  const entries = (taskId: string) => store.tasks.listComments(taskId).filter((comment) => comment.body.startsWith("Status changed to")).map((comment) => [comment.authorName, comment.kind, comment.body]);
  const call = (method: string, input: Record<string, unknown>) => host.harness.callRpc(method as never, input as never) as Promise<any>;
  return { host, store, project, card, entries, call };
}

describe("status history entries", () => {
  it("path 1: a manual update writes its own entry with the author, and keeps the other field lines apart", async () => {
    const f = setup();
    const task = f.card();
    await f.call("updateTask", { taskId: task.id, status: "in_progress", priority: "high", authorName: "Owner" });
    expect(f.entries(task.id)).toEqual([["Owner", "system", "Status changed to In Progress by Owner"]]);
    expect(f.store.tasks.listComments(task.id).map((comment) => comment.body)).toContain("Priority changed to High by Owner");
    await f.call("updateTask", { taskId: task.id, priority: "low", authorName: "Owner" });
    expect(f.entries(task.id)).toHaveLength(1);
  });

  it("path 2: a board move writes the entry, a same-column move writes none", async () => {
    const f = setup();
    const task = f.card();
    await f.call("boardMove", { taskId: task.id, status: "in_review", authorName: "Owner" });
    await f.call("boardMove", { taskId: task.id, status: "in_review", authorName: "Owner" });
    expect(f.entries(task.id)).toEqual([["Owner", "system", "Status changed to In Review by Owner"]]);
  });

  it("path 5: the first plan version writes the Work Board entry, a second version none", () => {
    const f = setup();
    f.store.tasks.updateProject(f.project.id, { planning: "optional" });
    const task = f.card("backlog");
    const plans = createPlanStore(f.host.bb.storage.database(), f.store.tasks);
    const author = { kind: "agent" as const, threadId: "thr_example", name: "agent (thr_example)" };
    plans.save({ taskId: task.id, op: "replace", baseVersion: 0, body: "# Plan\n", summary: "Plan", author });
    plans.save({ taskId: task.id, op: "replace", baseVersion: 1, body: "# Plan\n\nMore.\n", summary: "Plan", author });
    expect(f.entries(task.id)).toEqual([["Work Board", "system", "Status changed to Planning by Work Board (plan v1 written)"]]);
  });

  it("safety net: a store write without statusLog still names Work Board, with no cause", () => {
    const f = setup();
    const task = f.card();
    f.store.tasks.updateTask(task.id, { status: "in_progress" });
    f.store.tasks.updatePosition(task.id, { status: "done" });
    expect(f.entries(task.id)).toEqual([
      ["Work Board", "system", "Status changed to In Progress by Work Board"],
      ["Work Board", "system", "Status changed to Done by Work Board"],
    ]);
  });

  it("statusLog takes only { by, cause? }", () => {
    const f = setup();
    const task = f.card();
    for (const statusLog of [{ by: "" }, { by: "Owner", skip: true }, { cause: "x" }, { by: "Owner", cause: "" }])
      expect(() => f.store.tasks.updateTask(task.id, { status: "in_progress", statusLog } as never)).toThrow();
    expect(f.store.tasks.getTask(task.id)!.status).toBe("todo");
    expect(f.entries(task.id)).toEqual([]);
  });
});

type Source = { path: string; text: string };
type Violation = { file: string; line: number; reason: string };

/** Audited SQL writers of `tasks.status`, named by file and enclosing function; each has a runtime test above or in the module's own tests. */
const AUDITED_SQL_WRITERS = new Set([
  "db/store.ts createTaskTransaction",
  "db/store.ts updateTaskTransaction",
  "db/store.ts updatePositionTransaction",
  "archive/storage.ts restoreProject",
]);
// Store calls: `tasks.updateTask(` and friends, and the same names called bare (destructured or in-store). RPC calls (`domain.updateTask`) go through the API, which passes statusLog.
const STATUS_WRITING_CALLS = /(?<!function\s+)(?:\btasks\.(updateTask|moveTask|updatePosition)|(?<![\w.])(updateTask|moveTask|updatePosition|updateTaskTransaction))\s*\(/g;
// The schema migration's table rebuild copies rows with their status untouched, so it is not a status write.
const TASKS_SQL = /UPDATE\s+tasks\s+SET\s+([^`"';]*)|INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:tasks\b(?!\s+SELECT \* FROM tasks_status_backup)|\$\{table\})/gi;

const lineOf = (text: string, index: number) => text.slice(0, index).split("\n").length;

function callArguments(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return text.slice(open, i + 1);
  }
  return text.slice(open);
}

function enclosingFunction(text: string, index: number): string {
  const lines = text.slice(0, index).split("\n");
  let limit = lines[lines.length - 1]!.search(/\S|$/) + 1;
  for (let i = lines.length - 2; i >= 0; i--) {
    const line = lines[i]!;
    const indent = line.search(/\S|$/);
    if (!line.trim() || indent >= limit || /^\s*[)}\]]/.test(line)) continue;
    limit = indent;
    const name = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)|^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:db\.transaction\(|\(|async\b|function\b)/.exec(line);
    if (name) return name[1] ?? name[2]!;
  }
  return "<module>";
}

/** Reports a status-writing call without `statusLog`, and any SQL write of `tasks.status` outside the audited sites. */
export function findStatusWriteViolations(files: readonly Source[]): Violation[] {
  const found: Violation[] = [];
  for (const { path, text } of files) {
    // Client components (.tsx) reach the store only through the RPC, which writes the entry with the author.
    if (!path.endsWith(".tsx")) for (const match of text.matchAll(STATUS_WRITING_CALLS)) {
      const args = callArguments(text, match.index + match[0].length - 1);
      if (/\bstatus\b\s*[:,}]/.test(args) && !args.includes("statusLog"))
        found.push({ file: path, line: lineOf(text, match.index), reason: `${match[1] ?? match[2]}( changes status without statusLog` });
    }
    for (const match of text.matchAll(TASKS_SQL)) {
      if (match[1] !== undefined && !/\bstatus\s*=/.test(match[1])) continue;
      const site = `${path} ${enclosingFunction(text, match.index)}`;
      if (!AUDITED_SQL_WRITERS.has(site)) found.push({ file: path, line: lineOf(text, match.index), reason: `unaudited SQL write of tasks.status in ${site}` });
    }
  }
  return found;
}

function productionSources(): Source[] {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const out: Source[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (name === "node_modules" || name.startsWith(".")) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$|fixture\.ts$|^test-.*\.ts$|\.d\.ts$/.test(name)) out.push({ path: relative(root, full), text: readFileSync(full, "utf8") });
    }
  };
  walk(root);
  return out;
}

describe("findStatusWriteViolations", () => {
  it("reports a status-changing call without statusLog", () => {
    const text = "function run(id, status) {\n  store.tasks.updateTask(id, { status });\n  store.tasks.updateTask(id, { title: 'x' });\n  store.tasks.updateTask(id, { status, statusLog: { by: 'Work Board' } });\n}\n";
    expect(findStatusWriteViolations([{ path: "x/index.ts", text }])).toEqual([{ file: "x/index.ts", line: 2, reason: "updateTask( changes status without statusLog" }]);
  });

  it("reports bare updateTask( and moveTask( calls without statusLog", () => {
    const text = "function run(id, status) {\n  updateTask(id, { status });\n  moveTask(id, { status: 'done' });\n  updateTask(id, { status, statusLog: { by: 'Work Board', cause: 'x' } });\n}\nfunction updateTask(id, input) {}\n";
    expect(findStatusWriteViolations([{ path: "x/index.ts", text }])).toEqual([
      { file: "x/index.ts", line: 2, reason: "updateTask( changes status without statusLog" },
      { file: "x/index.ts", line: 3, reason: "moveTask( changes status without statusLog" },
    ]);
  });

  it("reports SQL that writes tasks.status in an unregistered function of an allowed file, and accepts the registered one", () => {
    const sql = (name: string) => `  function ${name}(id) {\n    db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run('x', id);\n  }\n`;
    expect(findStatusWriteViolations([{ path: "db/store.ts", text: sql("updatePositionTransaction") }])).toEqual([]);
    expect(findStatusWriteViolations([{ path: "db/store.ts", text: sql("quietlySetStatus") }])).toEqual([
      { file: "db/store.ts", line: 2, reason: "unaudited SQL write of tasks.status in db/store.ts quietlySetStatus" },
    ]);
    expect(findStatusWriteViolations([{ path: "db/store.ts", text: 'function other() {\n  db.prepare("UPDATE tasks SET position = ? WHERE id = ?");\n}\n' }])).toEqual([]);
  });

  it("finds no violation in the plugin's own sources, and every audited writer still exists", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(50);
    expect(findStatusWriteViolations(sources)).toEqual([]);
    const seen = new Set(sources.flatMap(({ path, text }) => [...text.matchAll(TASKS_SQL)].map((match) => `${path} ${enclosingFunction(text, match.index)}`)));
    for (const site of AUDITED_SQL_WRITERS) expect(seen.has(site), site).toBe(true);
  });
});
