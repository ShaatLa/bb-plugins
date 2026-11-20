import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
});

const PLAN = "# Plan\n\n## Steps\nAdd the table.\nRoll it out slowly.\n\n## Risks\nAdd the table.\nNone known.\n";
const AUTHOR = "thr_author";
const REVIEWER = "thr_reviewer";

async function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "work-board",
    sdk: { threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }), send: async () => ({}) } },
  });
  disposers.push(() => harness.dispose());
  await plugin(bb);
  await harness.runCli(["project", "create", "--name", "Example", "--prefix", "EXA"]);
  // Planning is the owner's setting; the CLI refuses to write it, so the fixture sets it directly.
  bb.storage.database().prepare("UPDATE projects SET planning = 'optional'").run();
  await harness.runCli(["create", "--project", "EXA", "--title", "Planned work"]);
  const run = (args: string[], threadId?: string) => harness.runCli(args, threadId ? { threadId } : undefined);
  const ok = async (args: string[], threadId?: string) => {
    const result = await run(args, threadId);
    expect(result, `${args.join(" ")}: ${result.stderr}`).toMatchObject({ exitCode: 0, stderr: "" });
    return result.stdout;
  };
  const sentTo = (threadId: string) => (harness.sdk.callsTo("threads.send") as Array<[{ threadId: string; input: Array<{ text: string }> }]>).filter((entry) => entry[0].threadId === threadId).map((entry) => entry[0].input[0]!.text);
  await ok(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial"], AUTHOR);
  return { bb, harness, run, ok, sentTo };
}

describe("bb work-board plan: reviewer commands", () => {
  it("runs a whole review from the reviewer thread: note, feedback, resolve and approve, each with --version", async () => {
    const { ok, run, sentTo } = await setup();
    const submitted = await ok(["plan", "submit", "EXA-1", "--reviewer", REVIEWER], AUTHOR);
    expect(submitted).toBe(`EXA-1 plan v1 submitted for review by ${REVIEWER}\nReviewer ${REVIEWER} notified`);
    expect(sentTo(REVIEWER)[0]).toContain("EXA-1 · plan v1 submitted for your review");
    expect(await ok(["plan", "note", "EXA-1", "--version", "1", "--body", "Say which table.", "--quote", "Add the table.", "--section", "Steps"], REVIEWER)).toContain("EXA-1 N1 saved as a draft on v1");
    expect(await ok(["plan", "note", "EXA-1", "--version", "1", "--body", "Missing rollback."], REVIEWER)).toContain("N2 saved as a draft");
    expect(await ok(["plan", "note", "EXA-1", "--version", "1", "--kind", "remove", "--quote", "None known."], REVIEWER)).toContain("N3 saved");
    // An ambiguous quote and a missing section are refused with a hint.
    expect((await run(["plan", "note", "EXA-1", "--version", "1", "--body", "x", "--quote", "Add the table."], REVIEWER)).stderr).toContain("name its section with --section");
    expect((await run(["plan", "note", "EXA-1", "--version", "1", "--body", "x", "--section", "Steps"], REVIEWER)).stderr).toMatch(/quote|requires/i);
    expect(await ok(["plan", "dismiss", "EXA-1", "N3", "--version", "1"], REVIEWER)).toBe("EXA-1 dismissed N3");
    expect((await run(["plan", "approve", "EXA-1", "--version", "1"], REVIEWER)).stderr).toContain("N1 (draft), N2 (draft)");
    const feedback = await ok(["plan", "feedback", "EXA-1", "--version", "1"], REVIEWER);
    expect(feedback).toContain("EXA-1 plan v1: changes requested · 2 notes sent");
    expect(feedback).toContain(`Notified ${AUTHOR}`);
    expect(sentTo(AUTHOR).at(-1)).toContain("changes requested by agent (thr_reviewer)");
    expect(sentTo(AUTHOR).at(-1)).toContain(`plan submit EXA-1 --reviewer ${REVIEWER}`);
    // The author revises, answers and resubmits without --reviewer: it goes back to the current reviewer.
    await ok(["plan", "edit", "EXA-1", "--section", "Steps", "--body", "## Steps\nAdd the users table.\n", "--base-version", "1", "--summary", "Specific"], AUTHOR);
    await ok(["plan", "reply", "EXA-1", "N1", "--body", "Named it.", "--addressed"], AUTHOR);
    await ok(["plan", "reply", "EXA-1", "N2", "--body", "Added.", "--addressed"], AUTHOR);
    const again = await ok(["plan", "submit", "EXA-1"], AUTHOR);
    expect(again).toContain(`submitted for review by ${REVIEWER}`);
    expect(sentTo(REVIEWER).at(-1)).toContain("What changed: bb work-board plan diff EXA-1 --from 1 --to 2");
    expect((await run(["plan", "approve", "EXA-1", "--version", "1"], REVIEWER)).stderr).toContain("You reviewed v1");
    expect((await run(["plan", "approve", "EXA-1", "--version", "2"], REVIEWER)).stderr).toContain("N1 (addressed), N2 (addressed)");
    expect(await ok(["plan", "resolve", "EXA-1", "N1", "n2", "--version", "2"], REVIEWER)).toBe("EXA-1 N1, N2 resolved");
    const approved = await ok(["plan", "approve", "EXA-1", "--version", "2", "--note", "Good."], REVIEWER);
    expect(approved).toContain("EXA-1 plan v2 approved");
    expect(sentTo(AUTHOR).at(-1)).toContain(`EXA-1 · plan v2 approved by agent (${REVIEWER})`);
    expect(await ok(["plan", "show", "EXA-1"])).toContain("Plan v2 · approved");
    // The author's notes view shows each note's author.
    const all = JSON.parse(await ok(["plan", "notes", "EXA-1", "--all", "--json"]));
    expect(all.notes.map((note: { number: number; state: string; authorKind: string; authorThread: string }) => [note.number, note.state, note.authorKind, note.authorThread])).toEqual([[1, "resolved", "thread", REVIEWER], [2, "resolved", "thread", REVIEWER]]);
    expect(all.notes[0].reply).toBe("Named it.");
  });

  it("refuses reviewer commands without a thread id, from another thread and for a thread that is not the reviewer", async () => {
    const { ok, run } = await setup();
    await ok(["plan", "submit", "EXA-1", "--reviewer", REVIEWER], AUTHOR);
    for (const args of [
      ["plan", "note", "EXA-1", "--version", "1", "--body", "x"],
      ["plan", "feedback", "EXA-1", "--version", "1"],
      ["plan", "approve", "EXA-1", "--version", "1"],
      ["plan", "dismiss", "EXA-1", "N1", "--version", "1"],
      ["plan", "resolve", "EXA-1", "N1", "--version", "1"],
      ["plan", "reopen", "EXA-1", "N1", "--version", "1"],
    ]) {
      const anonymous = await run(args);
      expect(anonymous.exitCode, args.join(" ")).not.toBe(0);
      expect(anonymous.stderr).toContain("no thread id");
      const other = await run(args, "thr_other");
      expect(other.exitCode).not.toBe(0);
      expect(other.stderr).toContain("is not the reviewer");
    }
    expect((await run(["plan", "approve", "EXA-1"], REVIEWER)).stderr).toMatch(/version/);
    expect((await run(["plan", "dismiss", "EXA-1", "--version", "1"], REVIEWER)).stderr).toContain("missing required arguments: <notes>");
    expect((await run(["plan", "resolve", "EXA-1", "first", "--version", "1"], REVIEWER)).stderr).toContain("not a note number");
  });

  it("lists the review attempts and reports a failed wake with its hint", async () => {
    const { ok, harness, run } = await setup();
    harness.sdk.stub("threads.send", async () => {
      throw new Error("queue is full");
    });
    const failed = await ok(["plan", "submit", "EXA-1", "--reviewer", REVIEWER], AUTHOR);
    expect(failed).toContain(`Reviewer ${REVIEWER} not notified`);
    expect(failed).toContain(`plan submit EXA-1 --reviewer ${REVIEWER}`);
    const reassigned = await ok(["plan", "submit", "EXA-1", "--reviewer", "thr_second"], AUTHOR);
    expect(reassigned).toContain("review reassigned to thr_second");
    const table = await ok(["plan", "reviews", "EXA-1"]);
    expect(table).toMatch(/v1\s+thr_reviewer\s+\S+\s+reassigned/);
    expect(table).toMatch(/v1\s+thr_second\s+\S+\s+pending/);
    const json = JSON.parse(await ok(["plan", "reviews", "EXA-1", "--json"]));
    expect(json.reviews.map((review: { reviewer: { threadId: string }; outcome: string }) => [review.reviewer.threadId, review.outcome])).toEqual([[REVIEWER, "reassigned"], ["thr_second", "pending"]]);
    // A self-review and a plan with no plan are refused with a clear message.
    expect((await run(["plan", "submit", "EXA-1", "--reviewer", AUTHOR], AUTHOR)).stderr).toContain("wrote or submitted this plan");
  });

  it("prints each recipient of a decision and a manual handoff when one was not reached", async () => {
    const { ok, harness } = await setup();
    await ok(["plan", "submit", "EXA-1", "--reviewer", REVIEWER], "thr_submitter");
    await ok(["plan", "note", "EXA-1", "--version", "1", "--body", "Fix it."], REVIEWER);
    harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
      if (threadId === AUTHOR) throw new Error("thread is gone");
      return {};
    });
    const feedback = await ok(["plan", "feedback", "EXA-1", "--version", "1"], REVIEWER);
    expect(feedback).toContain("Notified thr_submitter");
    expect(feedback).toContain(`Not delivered to ${AUTHOR} (failed)`);
    expect(feedback).toContain(`Saved, but tell ${AUTHOR} yourself: EXA-1 plan v1 needs changes.`);
    expect(feedback).toContain("bb work-board plan show EXA-1");
    expect(feedback).toContain("bb work-board plan notes EXA-1 --all");
  });
});
