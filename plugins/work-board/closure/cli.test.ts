import { afterEach, describe, expect, it } from "vitest";
import { closedThreadsBlock } from "./format";
import { closureFixture, type ClosureFixture } from "./fixture";

const fixtures: ClosureFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => f.harness.dispose()));
});
async function setup() {
  const f = await closureFixture();
  fixtures.push(f);
  return f;
}

describe("the closing command tells the agent what happened to the threads", () => {
  it("prints one block with the archived, delayed and kept threads, and keeps the usual result", async () => {
    const f = await setup();
    const task = f.card("Closed work");
    const other = f.card("Other work");
    f.link(task, "thr_a");
    f.link(task, "thr_b", { liveStatus: "working" });
    f.link(task, "thr_c");
    f.link(other, "thr_c", { spawned: false });
    f.link(task, "thr_d", { spawned: false, origin: "manual" });
    const result = await f.harness.runCli(["update", "EXA-1", "--status", "done"]);
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    const lines = result.stdout.split("\n");
    expect(lines[0]).toBe("Updated EXA-1  Closed work");
    expect(lines.slice(1)).toEqual([
      "EXA-1 closed. thr_a archived; thr_b will be archived when its turn ends.",
      "Kept: thr_c (linked to EXA-2), thr_d (not created by Work Board).",
      "Do not reuse thr_a or thr_b for new work; start a new thread. Reopen EXA-1 if it is not finished.",
    ]);
    expect(f.world.archived).toEqual(["thr_a"]);

    const json = await f.harness.runCli(["update", "EXA-2", "--status", "done", "--json"]);
    const parsed = JSON.parse(json.stdout);
    expect(parsed.task.key).toBe("EXA-2");
    expect(parsed.closedThreads).toEqual([{ threadId: "thr_c", action: "kept", reason: "not created by Work Board" }]);
  });

  it("gives no start-fresh instruction for a thread that is only kept", async () => {
    const f = await setup();
    const task = f.card("Closed work");
    f.link(task, "thr_a", { spawned: false });
    const result = await f.harness.runCli(["update", "EXA-1", "--status", "done"]);
    expect(result.stdout).toContain("Kept: thr_a (not created by Work Board).");
    expect(result.stdout).not.toContain("Do not reuse");
    expect(closedThreadsBlock("EXA-1", [{ threadId: "thr_x", action: "kept", reason: "pinned" }])).toBe("EXA-1 closed.\nKept: thr_x (pinned).");
    expect(closedThreadsBlock("EXA-1", [])).toBe("EXA-1 closed. No linked sessions.");
  });

  it("prints nothing extra when the change does not close the card", async () => {
    const f = await setup();
    f.card("Open work");
    const result = await f.harness.runCli(["update", "EXA-1", "--priority", "high"]);
    expect(result.stdout).toBe("Updated EXA-1  Open work");
  });

  it("reflects the caller attached by --progress in the same write", async () => {
    const f = await setup();
    const task = f.card("Closed work");
    f.world.threads.set("thr_caller", { parentThreadId: "thr_lead", title: "Caller" });
    const result = await f.harness.runCli(["update", "EXA-1", "--status", "done", "--progress", "Finished"], { threadId: "thr_caller" });
    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(result.stdout).toContain("; attached thr_caller");
    expect(result.stdout).toContain("Kept: thr_caller (not created by Work Board).");
    expect(f.store.tasks.getTaskThreadByThreadId(task.id, "thr_caller")?.presetName).toBe("Attached");
    expect(f.origin(task.id, "thr_caller")).toEqual({ created_for_task: 0, link_origin: "manual" });
  });

  it("returns the evaluation of a board drag from the RPC without a second archive", async () => {
    const f = await setup();
    const task = f.card("Closed work");
    f.link(task, "thr_a");
    const result = await f.harness.callRpc("boardMove", { taskId: task.id, status: "done" }) as { ok: boolean; closedThreads?: unknown[]; task: { status: string } };
    expect(result.ok).toBe(true);
    expect(result.task.status).toBe("done");
    expect(result.closedThreads).toEqual([{ threadId: "thr_a", action: "archived", reason: null }]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.world.archived).toEqual(["thr_a"]);
    const reopened = await f.harness.callRpc("boardMove", { taskId: task.id, status: "in_progress" }) as { closedThreads?: unknown[] };
    expect(reopened.closedThreads).toBeUndefined();
  });

  it("reads and changes both settings one key at a time", async () => {
    const f = await setup();
    const get = async (key: string) => JSON.parse((await f.harness.runCli(["config", "get", key, "--project", "EXA", "--json"])).stdout).values;
    expect(await get("archiveThreadsOnClose")).toEqual({ archiveThreadsOnClose: "on" });
    expect(await get("archiveReviewerOnApproval")).toEqual({ archiveReviewerOnApproval: "on" });
    expect(await f.harness.runCli(["config", "set", "archiveThreadsOnClose", "off", "--project", "EXA"])).toMatchObject({ exitCode: 0 });
    expect(await f.harness.runCli(["config", "set", "archiveReviewerOnApproval", "off", "--project", "EXA"])).toMatchObject({ exitCode: 0 });
    expect(await get("archiveThreadsOnClose")).toEqual({ archiveThreadsOnClose: "off" });
    expect(await get("archiveReviewerOnApproval")).toEqual({ archiveReviewerOnApproval: "off" });
    expect((await f.harness.runCli(["config", "set", "archiveThreadsOnClose", "maybe", "--project", "EXA"])).exitCode).not.toBe(0);
    expect(f.store.tasks.getProject(f.project.id)).toMatchObject({ archiveThreadsOnClose: "off", archiveReviewerOnApproval: "off" });
  });
});

describe("a close with no links", () => {
  it("says so in one line", async () => {
    const f = await setup();
    f.card("Closed work");
    const result = await f.harness.runCli(["update", "EXA-1", "--status", "done"]);
    expect(result.stdout).toBe("Updated EXA-1  Closed work\nEXA-1 closed. No linked sessions.");
    expect(JSON.parse((await f.harness.runCli(["update", "EXA-1", "--status", "in_progress", "--json"])).stdout).closedThreads).toBeUndefined();
  });
});
