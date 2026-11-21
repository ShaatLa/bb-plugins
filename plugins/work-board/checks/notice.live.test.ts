import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatNotification } from "./notification";
import { checksStore } from "./store";
import { BB_PROJECT, cleanTempDirs, setup, tempDir, type Fixture } from "./fixtures";

/**
 * Opt-in lost-reply check against a real Agent Hub: `WB_LIVE_NOTICE=1`. It creates one test notice (and its push) in that Agent Hub.
 * Delivery only: a report is pre-staged on a disabled tracker whose manager is unset, so the drain delivers it as a notice. The first
 * request reaches the real receiver and its success is discarded at the sender boundary; the next tick replays the same key.
 */
const live = process.env.WB_LIVE_NOTICE === "1";
const fixtures: Fixture[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); cleanTempDirs(); });

const hubCall = (method: string, input: unknown): any => {
  const file = join(tempDir("checks-live-"), "input.json");
  writeFileSync(file, JSON.stringify(input));
  const parsed = JSON.parse(execFileSync("bb", ["plugin", "rpc", "call", "agent-hub", method, "--input-file", file, "--json"], { encoding: "utf8" }));
  return parsed && typeof parsed === "object" && "result" in parsed ? parsed.result : parsed;
};

describe.skipIf(!live)("live notice, lost reply", () => {
  it("delivers one Agent Hub item and one local promotion for a replayed key, with no push and no manager dispatch", async () => {
    const f = await setup(); fixtures.push(f);
    f.control.hub.enabled = true;
    f.setManager(null);
    const tick = `${f.tracker.id}:live-${randomUUID()}`;
    const body = "ACTION idle EXA-1\n";
    const candidate = Buffer.from(`{"live":"${randomUUID()}"}`);
    f.db.transaction(() => checksStore(f.db).stage(f.tracker.id, { reportId: randomUUID(), project: BB_PROJECT, exit: 1, tick, body, snapshot: candidate }))();
    // Both outgoing requests and both remote replies are kept: the first reply is discarded at the sender boundary, the second is the replay's.
    const requests: Record<string, unknown>[] = [];
    const replies: { id: string; created: boolean }[] = [];
    f.control.hub.forward = async (input) => {
      requests.push(input);
      const reply = hubCall("notice", input);
      replies.push(reply);
      if (requests.length === 1) throw new Error("reply lost at the sender boundary");
      return reply;
    };
    const tickRows = () => f.db.prepare<[], { delivered: number; notices: number }>("SELECT delivered, notices FROM checks_ticks ORDER BY at, rowid").all();
    await f.tick();
    expect(requests).toHaveLength(1);
    expect(f.db.prepare("SELECT outcome FROM checks_notice_attempts").all()).toEqual([{ outcome: "sending" }]);
    expect(tickRows().map((t) => [t.delivered, t.notices])).toEqual([[0, 0]]);
    await f.tick();
    expect(requests).toHaveLength(2);
    // Both calls carry the staged report's source, key and payload.
    for (const request of requests) expect(request).toMatchObject({ source: "work-board", tickId: tick, projectId: BB_PROJECT, markdown: formatNotification(1, body) });
    expect(replies[0]).toMatchObject({ id: expect.stringMatching(/^ans_/), created: true });
    expect(replies[1]).toEqual({ id: replies[0]!.id, created: false });
    const id = replies[0]!.id;
    const row = f.db.prepare<[], { outcome: string; notice_id: string; tick_id: string }>("SELECT outcome, notice_id, tick_id FROM checks_notice_attempts").get()!;
    // The item and the receipt belong to the staged report: the key is its tick, the id is the remote one, and the committed bytes are its candidate.
    expect(row).toEqual({ outcome: "accepted", notice_id: id, tick_id: tick });
    expect(f.db.prepare("SELECT committed FROM checks_delivery").get()).toEqual({ committed: candidate });
    const items = hubCall("list", { view: "all", notices: true, limit: 50 }).items as { id: string }[];
    expect(items.filter((item) => item.id === id)).toHaveLength(1);
    expect(f.state()).toMatchObject({ receipt: { mode: "notice", id }, deliveredTickId: tick });
    // The acceptance tick has its own history row and counts one delivery and one notice, whatever the synthetic staged tick has.
    expect(tickRows().map((t) => [t.delivered, t.notices])).toEqual([[0, 0], [1, 1]]);
    expect(f.pushes).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
  }, 120_000);
});
