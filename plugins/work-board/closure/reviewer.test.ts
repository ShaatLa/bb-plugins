import { afterEach, describe, expect, it } from "vitest";
import { closureFixture, type ClosureFixture } from "./fixture";

const fixtures: ClosureFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.harness.dispose()));
});

const PLAN = "# Plan\n\n## Steps\nAdd the table.\n\n## Risks\nNone known.\n";
const AUTHOR = "thr_author";
const REVIEWER = "thr_reviewer";

/** Planning is on, EXA-1 has a plan, and the named reviewer thread (a child of the author) is attached to it by title. */
async function reviewing(options: { dedicated?: boolean; extra?: Parameters<typeof closureFixture>[0] } = {}) {
  const f = await closureFixture(options.extra);
  fixtures.push(f);
  f.bb.storage.database().prepare("UPDATE projects SET planning = 'optional'").run();
  const task = f.card("Planned work");
  const ok = async (args: string[], threadId?: string) => {
    const result = await f.harness.runCli(args, threadId ? { threadId } : undefined);
    expect(result, `${args.join(" ")}: ${result.stderr}`).toMatchObject({ exitCode: 0 });
    return result.stdout;
  };
  await ok(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial"], AUTHOR);
  f.world.threads.set(REVIEWER, { parentThreadId: AUTHOR, title: "EXA-1 plan reviewer" });
  await f.emit("thread.active", REVIEWER);
  const submit = (reviewer = REVIEWER, dedicated = options.dedicated ?? true) =>
    ok(["plan", "submit", "EXA-1", "--reviewer", reviewer, ...(dedicated ? ["--dedicated-reviewer"] : [])], AUTHOR);
  const approve = () => ok(["plan", "approve", "EXA-1", "--version", "1"], REVIEWER);
  const state = () => f.bb.storage.database().prepare<[], { archive_state: string | null; dedicated_reviewer: number }>("SELECT archive_state, dedicated_reviewer FROM task_plan_reviews ORDER BY id DESC LIMIT 1").get()!;
  return { f, task, ok, submit, approve, state };
}

describe("archiving a plan reviewer after approval", () => {
  it("archives the named reviewer (spawned as a child, attached by title, submitted as dedicated) on its first idle after approving", async () => {
    const { f, task, submit, approve, state } = await reviewing();
    expect(f.origin(task.id, REVIEWER)).toEqual({ created_for_task: 0, link_origin: "discovery" });
    await submit();
    expect(state()).toEqual({ archive_state: null, dedicated_reviewer: 1 });
    await approve();
    expect(state().archive_state).toBe("pending");
    expect(f.world.archived).toEqual([]);
    await f.emit("thread.idle", REVIEWER);
    expect(f.world.archived).toEqual([REVIEWER]);
    expect(state().archive_state).toBe("archived");
  });

  it("does nothing when the setting is off", async () => {
    const { f, submit, approve, state } = await reviewing({ extra: { projectSettings: { archiveReviewerOnApproval: "off" } } });
    await submit();
    await approve();
    expect(state().archive_state).toBeNull();
    await f.emit("thread.idle", REVIEWER);
    expect(f.world.archived).toEqual([]);
  });

  it("never archives a reviewer submitted without the flag (a reused child or an existing session)", async () => {
    const { f, submit, approve, state } = await reviewing({ dedicated: false });
    await submit();
    await approve();
    await f.emit("thread.idle", REVIEWER);
    expect(state()).toEqual({ archive_state: null, dedicated_reviewer: 0 });
    expect(f.world.archived).toEqual([]);
  });

  it("keeps a reviewer that has another pending review", async () => {
    const { f, ok, submit, approve, state } = await reviewing();
    const second = f.card("Second plan");
    await ok(["plan", "set", second.id, "--body", PLAN, "--base-version", "0", "--summary", "Initial"], AUTHOR);
    await ok(["plan", "submit", second.id, "--reviewer", REVIEWER], AUTHOR);
    await submit();
    await approve();
    await f.emit("thread.idle", REVIEWER);
    expect(f.world.archived).toEqual([]);
    expect(state().archive_state).toBe("kept");
  });

  it.each([
    ["a manual link to an open card", (f: ClosureFixture, other: { id: string }) => f.link(other, REVIEWER, { spawned: false, origin: "manual" })],
    ["a Delegate link to an open card", (f: ClosureFixture, other: { id: string }) => f.link(other, REVIEWER, { spawned: true })],
    ["a Delegate preset named Auto attached", (f: ClosureFixture, other: { id: string }) => f.link(other, REVIEWER, { spawned: true, presetName: "Auto attached" })],
    ["a legacy link (no origin) to another open card", (f: ClosureFixture, other: { id: string }) => f.link(other, REVIEWER, { spawned: false, origin: null })],
  ])("never archives a reviewer with %s", async (_name, arrange) => {
    const { f, submit, approve, state } = await reviewing();
    await submit();
    await approve();
    arrange(f, f.card("Card work"));
    await f.emit("thread.idle", REVIEWER);
    expect(f.world.archived).toEqual([]);
    expect(state().archive_state).toBe("kept");
  });

  it("keeps a reviewer whose link to the reviewed card carries no discovery origin", async () => {
    const { f, task, submit, approve } = await reviewing();
    await submit();
    await approve();
    f.link(task, REVIEWER, { spawned: false, origin: null, presetName: "Auto attached" });
    await f.emit("thread.idle", REVIEWER);
    expect(f.world.archived).toEqual([]);
  });

  it("does not archive on a delayed idle after a newer review attempt or a new turn", async () => {
    const { f, ok, submit, approve } = await reviewing();
    await submit();
    await approve();
    await ok(["plan", "edit", "EXA-1", "--section", "Steps", "--body", "Add two tables.", "--base-version", "1", "--summary", "Revise"], AUTHOR);
    f.world.threads.set("thr_reviewer_two", { parentThreadId: AUTHOR });
    await submit("thr_reviewer_two");
    await f.emit("thread.idle", REVIEWER);
    expect(f.world.archived).toEqual([]);

    const turn = await reviewing();
    await turn.submit();
    await turn.approve();
    await turn.f.emit("thread.active", REVIEWER);
    await turn.f.emit("thread.idle", REVIEWER);
    expect(turn.f.world.archived).toEqual([]);
    expect(turn.state().archive_state).toBe("kept");
  });

  it("gives the unarchive hint for an archived reviewer and never unarchives anything, including after a rejected submit", async () => {
    const { f, ok, submit } = await reviewing();
    await submit();
    f.world.threads.set(REVIEWER, { parentThreadId: AUTHOR, archivedAt: 1 });
    const again = await ok(["plan", "submit", "EXA-1", "--reviewer", REVIEWER, "--dedicated-reviewer"], AUTHOR);
    expect(again).toContain("bb thread unarchive thr_reviewer");
    f.world.threads.set("thr_gone", { archivedAt: 1 });
    f.bb.storage.database().prepare("UPDATE task_plans SET state = 'draft'").run();
    const rejected = await f.harness.runCli(["plan", "submit", "EXA-1", "--reviewer", "thr_gone"], { threadId: AUTHOR });
    expect(rejected.exitCode).not.toBe(0);
    expect(f.world.unarchived).toEqual([]);
  });
});
