import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTasksStore } from "../db/store";
import { registerTasksCli } from "../cli";
import { createGitSyncStore } from "../git-sync/store";
import { prIdentity, prSnapshotSchema } from "../shared/git-sync";
import { historyLimits, receiptPolling } from "../steer";
import { attentionMarker } from "./service";
import { accept, BB_PROJECT, goLive, MANAGER, setup } from "./fixtures";

const fixtures: ReturnType<typeof setup>[] = [];
const make = async (mode: "off" | "shadow" | "live" = "shadow") => {
  const f = setup();
  fixtures.push(f);
  if (mode === "live") await goLive(f);
  else if (mode === "shadow") await f.setMode("shadow");
  return f;
};
const modes = async (f: ReturnType<typeof setup>) => (await f.sweep("attention.modes", { projectId: BB_PROJECT })).kinds["stale-status"];
const unknownAttempt = (f: ReturnType<typeof setup>, id: string, started = new Date().toISOString(), extra = "unknown") =>
  f.db.prepare("INSERT INTO attention_attempts(attempt_id, tracker_id, kind, generation, batch_id, recipient_thread_id, recipient_source, started_at, transport_started_at, outcome, rev) VALUES (?, ?, 'stale-status', 1, ?, ?, 'manager', ?, ?, ?, 1)")
    .run(id, f.tracker.id, `batch-${id}`, MANAGER, started, started, extra);
beforeEach(() => { receiptPolling.tries = 1; receiptPolling.delayMs = 0; });
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

describe("C1.2 one tracker per BB project", () => {
  it("refuses to start shadow while another tracker is linked to the same BB project", async () => {
    const f = await make("off");
    f.store.tasks.createProject({ name: "Twin", prefix: "TWN", color: "red", linkedBbProjectId: BB_PROJECT });
    await expect(f.setMode("shadow")).rejects.toThrow(/same BB project/);
    expect((await f.call("getAttentionSettings", { projectId: f.tracker.id })).state.effective.mode).toBe("off");
  });
});

describe("C1.3 deleting a tracker", () => {
  it("is refused, forced deletion included, until the mode is off with nothing pending", async () => {
    const f = await make("live");
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/Switch manager attention off/);
    await expect(f.call("deleteProject", { projectId: f.tracker.id, force: true })).rejects.toThrow(/Switch manager attention off/);
    await f.setMode("shadow");
    expect(() => f.store.tasks.deleteProject(f.tracker.id)).toThrow(/Switch manager attention off/);
    const transition = (await modes(f)).transition;
    await f.sweep("attention.ack", { projectId: BB_PROJECT, trackerId: f.tracker.id, kind: "stale-status", token: transition.token, generation: transition.generation, direction: "to_shadow", fenceId: "f" });
    await f.setMode("off");
    expect(f.store.tasks.deleteProject(f.tracker.id)).toBe(true);
  });
});

describe("C1.4 handback", () => {
  it("leaves a Done card's shadow-only no_merge_or_outcome out of a rollback", async () => {
    const f = await make("live");
    const done = f.card("Done without outcome", "done");
    const open = f.card("Open");
    expect(f.occurrences().map((o) => o.signal).sort()).toEqual(["no_active_thread", "no_merge_or_outcome"]);
    await f.setMode("shadow");
    const handback = (await modes(f)).transition.handback;
    expect(handback.map((entry: { taskId: string }) => entry.taskId)).toEqual([open.id]);
    expect(handback.map((entry: { taskId: string }) => entry.taskId)).not.toContain(done.id);
  });
});

describe("C1.5 a failed refresh is not a known answer", () => {
  const link = (f: ReturnType<typeof setup>, taskId: string, number: number) => {
    const git = createGitSyncStore(f.db);
    const now = new Date().toISOString();
    const saved = git.saveLink({ taskId, provider: "github", host: "github.com", repository: "org/repo", number, url: `https://github.com/org/repo/pull/${number}`, remoteId: String(number), role: "delivers", part: null, source: "manual", confirmed: true, excluded: false, createdAt: now, updatedAt: now });
    const snapshot = (state: "open" | "closed") => prSnapshotSchema.parse({ repository: "org/repo", number, remoteId: String(number), url: saved.url, title: "t", state, headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: "2026-01-01", observedAt: now, checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [] });
    return { save: (state: "open" | "closed") => git.saveSnapshot(f.tracker.id, saved, snapshot(state)), fail: () => git.fail(f.tracker.id, saved, "outage"), identity: prIdentity(saved) };
  };

  it("does not raise closed_unmerged_pr from a closed payload kept through an outage, nor let an open one hide pr_state_unavailable", async () => {
    const f = await make();
    const closed = f.card("Formerly closed", "todo");
    const closedPr = link(f, closed.id, 1);
    closedPr.save("closed");
    closedPr.fail();
    f.store.tasks.updateTask(closed.id, { status: "in_review" });
    expect(f.occurrences().filter((o) => o.task_id === closed.id).map((o) => o.signal)).not.toContain("closed_unmerged_pr");
    expect(f.occurrences().filter((o) => o.task_id === closed.id).map((o) => o.signal)).toContain("pr_state_unavailable");
    const open = f.card("Formerly open", "todo");
    const openPr = link(f, open.id, 2);
    openPr.save("open");
    openPr.fail();
    f.store.tasks.updateTask(open.id, { status: "in_review" });
    expect(f.occurrences().filter((o) => o.task_id === open.id).map((o) => o.signal)).toEqual(["pr_state_unavailable"]);
    // C2.3: the board's flags, which Sweep also reads, use the same known-PR rule as the ledger.
    expect(f.store.tasks.staleStatusFlags([open.id]).get(open.id)).toEqual(["pr_state_unavailable"]);
    expect(f.store.tasks.staleStatusFlags([closed.id]).get(closed.id)).toEqual(["pr_state_unavailable"]);
    // Once the refresh succeeds again the open PR is a known answer.
    openPr.save("open");
    expect(f.occurrences().filter((o) => o.task_id === open.id)).toHaveLength(0);
    expect(f.store.tasks.staleStatusFlags([open.id]).has(open.id)).toBe(false);
  });
});

describe("C1.6 moving a family", () => {
  it("recomputes every moved card in the move transaction", async () => {
    const f = await make();
    const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red", linkedBbProjectId: "proj_other" });
    await f.call("updateAttentionMode", { projectId: other.id, mode: "shadow" });
    const epic = f.card("Epic", "todo", { type: "epic" });
    const member = f.card("Member", "in_progress", { epicId: epic.id });
    expect(f.occurrences().map((o) => o.task_id)).toEqual([member.id]);
    const moved = f.store.tasks.moveTaskToProject(epic.id, other.id);
    expect(moved.moved.map((entry) => entry.task.id)).toContain(member.id);
    expect(f.occurrences()).toHaveLength(0);
    expect(f.occurrences(true).find((o) => o.task_id === member.id)).toMatchObject({ retired_reason: "moved" });
    const onNew = f.db.prepare("SELECT * FROM manager_attention WHERE tracker_id=? AND task_id=? AND cleared_at IS NULL").get(other.id, member.id) as { first_seen_at: string } | undefined;
    expect(onNew).toBeTruthy();
  });
});

describe("C1.7 the eligibility timer", () => {
  it("counts only occurrences that could actually be claimed", async () => {
    const f = await make("live");
    f.card("Accepted and still open");
    accept(f, f.occurrences()[0].id);
    f.makeEligible();
    expect(f.service.nextEligibleDelay()).toBeNull();
    f.card("Waiting for grace");
    const delay = f.service.nextEligibleDelay();
    expect(delay).toBeGreaterThan(60_000);
    expect(delay).toBeLessThanOrEqual(10 * 60_000);
    // A past-due occurrence that a drain can claim is the drain's work, not a timer's.
    f.makeEligible();
    expect(f.service.nextEligibleDelay()).toBeNull();
  });
});

describe("C1.8 late receipts", () => {
  it("searches more unknown attempts than one pass covers fairly across passes", async () => {
    const f = await make("live");
    const start = Date.now() - 3_600_000;
    for (let index = 1; index <= 22; index++) unknownAttempt(f, `a${String(index).padStart(2, "0")}`, new Date(start + index * 1000).toISOString());
    f.threads.addRow(MANAGER, `x ${attentionMarker("batch-a01")}`);
    f.threads.addRow(MANAGER, `y ${attentionMarker("batch-a22")}`);
    await f.service.recoverLate(f.tracker.id);
    await f.service.recoverLate(f.tracker.id);
    expect(f.attempts().filter((a) => a.outcome !== "unknown").map((a) => a.attempt_id).sort()).toEqual(["a01", "a22"]);
  });

  it("still records a receipt that arrives after a waiver and a rollback", async () => {
    const f = await make("live");
    f.card("Lost");
    f.makeEligible();
    f.threads.sendMode = "throw";
    await f.service.drain();
    const attempt = f.attempts()[0];
    await f.call("resolveAttentionAttempt", { attemptId: attempt.attempt_id, disposition: "waived_loss" });
    await f.setMode("shadow");
    const transition = (await modes(f)).transition;
    await f.sweep("attention.ack", { projectId: BB_PROJECT, trackerId: f.tracker.id, kind: "stale-status", token: transition.token, generation: transition.generation, direction: "to_shadow", fenceId: "f" });
    f.threads.addRow(MANAGER, `late ${attentionMarker(attempt.batch_id)}`);
    await f.service.reconcileAll();
    expect(f.attempts()[0]).toMatchObject({ outcome: "queued", disposition: "waived_loss" });
  });
});

describe("C1.9 receipt search depth", () => {
  it("finds an accepted event far behind later traffic on a busy thread", async () => {
    const f = await make("live");
    f.card("Busy");
    unknownAttempt(f, "busy", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('busy', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch(`notice ${attentionMarker("batch-busy")}`);
    for (let index = 0; index < 120; index++) f.threads.dispatch(`unrelated ${index}`);
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
    expect(f.threads.listCalls).toBeGreaterThan(2);
  });
});

describe("C2.2 receipt search across passes", () => {
  it("reaches an acceptance buried under more than one pass of newer requests, without calling the attempt unknown meanwhile", async () => {
    const f = await make("live");
    f.card("Very busy");
    unknownAttempt(f, "deep", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('deep', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch(`notice ${attentionMarker("batch-deep")}`);
    for (let index = 0; index < 2100; index++) f.threads.dispatch(`unrelated ${index}`);
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("sending");
    expect(f.attempts()[0].recovery_cursor).toBeTruthy();
    expect(f.threads.listCalls).toBeLessThanOrEqual(historyLimits.passPages + 2);
    for (let pass = 0; pass < 3 && f.attempts()[0].outcome === "sending"; pass++) await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
  });
});

describe("C3.1 an unreadable history", () => {
  const cursorOf = (f: ReturnType<typeof setup>, id: string) => JSON.parse((f.db.prepare("SELECT recovery_cursor FROM attention_attempts WHERE attempt_id=?").get(id) as { recovery_cursor: string }).recovery_cursor);
  const backdate = (f: ReturnType<typeof setup>, id: string, minutes: number) => {
    const cursor = cursorOf(f, id);
    cursor.errors.since = new Date(Date.now() - minutes * 60_000).toISOString();
    f.db.prepare("UPDATE attention_attempts SET recovery_cursor=? WHERE attempt_id=?").run(JSON.stringify(cursor), id);
  };

  it("gives a sending attempt up as unknown after five failed passes over thirty minutes, keeping the cursor for late evidence", async () => {
    const f = await make("live");
    f.card("Unreadable");
    unknownAttempt(f, "mute", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('mute', ?)").run(f.occurrences()[0].id);
    f.threads.eventsFail = true;
    const rollback = await f.setMode("shadow");
    expect(rollback.transition).toMatchObject({ state: "preparing" });
    expect(cursorOf(f, "mute").errors.count).toBe(1);
    backdate(f, "mute", 31);
    for (let pass = 0; pass < 3; pass++) await f.service.recover(f.tracker.id);
    // Four failed passes are not enough, however long they span.
    expect(f.attempts()[0].outcome).toBe("sending");
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", error: expect.stringContaining("History unreadable") });
    expect((await modes(f)).transition.state).toBe("preparing");
    // The owner can now resolve it, and the rollback goes on.
    await f.call("resolveAttentionAttempt", { attemptId: "mute", disposition: "waived_loss" });
    expect((await modes(f)).transition.state).toBe("ready");
    // Later evidence still becomes the attempt's receipt.
    f.threads.eventsFail = false;
    f.threads.dispatch(`late ${attentionMarker("batch-mute")}`);
    await f.service.recoverLate(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", disposition: "waived_loss" });
  });

  it("does not give up while the failed passes span less than thirty minutes", async () => {
    const f = await make("live");
    f.card("Briefly unreadable");
    unknownAttempt(f, "brief", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('brief', ?)").run(f.occurrences()[0].id);
    f.threads.eventsFail = true;
    for (let pass = 0; pass < 7; pass++) await f.service.recover(f.tracker.id);
    expect(cursorOf(f, "brief").errors.count).toBe(7);
    expect(f.attempts()[0].outcome).toBe("sending");
    f.threads.eventsFail = false;
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("unknown");
    expect(cursorOf(f, "brief").errors).toBeUndefined();
  });
});

describe("C3.2 fresh traffic between passes", () => {
  it("still reaches an older acceptance when thousands of new requests arrive before every pass", async () => {
    const f = await make("live");
    f.card("Buried and busy");
    unknownAttempt(f, "buried", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('buried', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch(`notice ${attentionMarker("batch-buried")}`);
    for (let index = 0; index < 4100; index++) f.threads.dispatch(`old ${index}`);
    let passes = 0;
    while (f.attempts()[0].outcome === "sending" && passes < 12) {
      await f.service.recover(f.tracker.id);
      passes++;
      for (let index = 0; index < 2100; index++) f.threads.dispatch(`fresh ${passes}-${index}`);
    }
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
    expect(passes).toBeLessThanOrEqual(6);
  });
});

describe("C4.1 the end of the acceptance history", () => {
  it("stays sending when the page budget ends on a full page of other acceptances, then goes straight to inline", async () => {
    const f = await make("live");
    f.card("Acceptance on the next page");
    unknownAttempt(f, "edge", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('edge', ?)").run(f.occurrences()[0].id);
    // The request is the oldest of 1861: the pass spends one page on the acceptance watermark and 38 on requests, so exactly
    // one page is left for the acceptance scan, which meets 50 unrelated acceptances before the matching one.
    const request = f.threads.requestOnly(`notice ${attentionMarker("batch-edge")}`);
    for (let index = 0; index < 60; index++) f.threads.dispatch(`other ${index}`);
    f.threads.acceptRequest(request);
    for (let index = 0; index < 1800; index++) f.threads.dispatch(`newer ${index}`);
    await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0].outcome).toBe("sending");
    // The watermark read and one full page of acceptances: the boundary is crossed inside the first pass.
    expect(f.threads.acceptedCalls).toBe(2);
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
  });
});

describe("C4.2 a fixed decision window", () => {
  it("decides unknown for an absent marker although new requests arrive before every pass, then lets the owner resolve it", async () => {
    const f = await make("live");
    f.card("Never sent");
    unknownAttempt(f, "absent", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('absent', ?)").run(f.occurrences()[0].id);
    for (let index = 0; index < 2100; index++) f.threads.dispatch(`backlog ${index}`);
    await f.setMode("shadow");
    let passes = 0;
    while (f.attempts()[0].outcome === "sending" && passes < 8) {
      for (let index = 0; index < 2100; index++) f.threads.dispatch(`fresh ${passes}-${index}`);
      await f.service.recover(f.tracker.id);
      passes++;
    }
    expect(f.attempts()[0]).toMatchObject({ outcome: "unknown", error: expect.stringContaining("No evidence") });
    expect(passes).toBeLessThanOrEqual(4);
    expect((await modes(f)).transition.state).toBe("preparing");
    await f.call("resolveAttentionAttempt", { attemptId: "absent", disposition: "waived_loss" });
    expect((await modes(f)).transition.state).toBe("ready");
  });

  it("still records a receipt from a request that arrives after the decision", async () => {
    const f = await make("live");
    f.card("Late request");
    unknownAttempt(f, "later", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('later', ?)").run(f.occurrences()[0].id);
    f.threads.dispatch("something else");
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("unknown");
    f.threads.dispatch(`queued notice dispatched at last ${attentionMarker("batch-later")}`);
    await f.service.recoverLate(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("inline");
  });
});

describe("C5 the acceptance window and the candidate set", () => {
  const limits = { ...historyLimits };
  afterEach(() => { Object.assign(historyLimits, limits); });
  const attemptFor = (f: Awaited<ReturnType<typeof make>>, id: string) => {
    unknownAttempt(f, id, new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES (?, ?)").run(id, f.occurrences()[0].id);
  };

  it("C5.1: decides an unaccepted marked request under continuing acceptance traffic, then records its late receipt", async () => {
    const f = await make("live");
    f.card("Unaccepted under traffic");
    attemptFor(f, "traffic");
    for (let index = 0; index < 100; index++) f.threads.dispatch(`before ${index}`);
    const request = f.threads.requestOnly(`notice ${attentionMarker("batch-traffic")}`);
    for (let index = 0; index < 2100; index++) f.threads.dispatch(`after ${index}`);
    await f.setMode("shadow");
    let passes = 1;
    while (f.attempts()[0].outcome === "sending" && passes < 14) {
      for (let index = 0; index < 500; index++) f.threads.dispatch(`more ${passes}-${index}`);
      await f.service.recover(f.tracker.id);
      passes++;
    }
    expect(f.attempts()[0].outcome).toBe("unknown");
    expect(passes).toBeLessThanOrEqual(8);
    await f.call("resolveAttentionAttempt", { attemptId: "traffic", disposition: "waived_loss" });
    expect((await modes(f)).transition.state).toBe("ready");
    // The acceptance arrives after the decision: late evidence, found without delaying anything.
    f.threads.acceptRequest(request);
    for (let pass = 0; pass < 40 && f.attempts()[0].outcome === "unknown"; pass++) await f.service.recoverLate(f.tracker.id);
    expect(f.attempts()[0].outcome).toBe("inline");
  });

  it("C5.2: stays sending when the last request page adds a second candidate after the first scan ended, until the second receipt is read", async () => {
    historyLimits.passPages = 4;
    historyLimits.acceptancePages = 2;
    const f = await make("live");
    f.card("Two candidates");
    attemptFor(f, "second");
    const marker = `notice ${attentionMarker("batch-second")}`;
    // Oldest to newest: R2 with its acceptance, 160 filler pairs, R1 (never accepted), 40 filler pairs.
    const older = f.threads.requestOnly(marker);
    f.threads.acceptRequest(older);
    for (let index = 0; index < 160; index++) f.threads.dispatch(`filler ${index}`);
    f.threads.requestOnly(marker);
    for (let index = 0; index < 40; index++) f.threads.dispatch(`newer ${index}`);
    await f.service.recover(f.tracker.id);
    await f.service.recover(f.tracker.id);
    // The second pass read the oldest request page and found the second candidate with no pages left.
    expect(f.attempts()[0].outcome).toBe("sending");
    await f.service.recover(f.tracker.id);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline", inline_event_ref: expect.any(String) });
  });
});

describe("C5 property: the recovery state machine under random arrival order", () => {
  const limits = { ...historyLimits };
  afterEach(() => { Object.assign(historyLimits, limits); });
  // A small deterministic generator, so a failing seed reproduces.
  const generator = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const MAX_DECISION_PASSES = 14;

  it.each(Array.from({ length: 80 }, (_, index) => index + 1))("seed %i: always decides within a bounded number of passes and never calls a windowed receipt unknown", async (seed) => {
    historyLimits.passPages = 4;
    historyLimits.acceptancePages = 2;
    const random = generator(seed);
    const pick = (n: number) => Math.floor(random() * n);
    const f = await make("live");
    f.card("Property");
    unknownAttempt(f, "p", new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES ('p', ?)").run(f.occurrences()[0].id);
    const marker = `notice ${attentionMarker("batch-p")}`;
    const lone: string[] = [];
    const noise = (count: number) => {
      for (let index = 0; index < count; index++) {
        const roll = pick(3);
        if (roll === 0) f.threads.dispatch(`pair ${seed}-${index}`);
        else if (roll === 1) lone.push(f.threads.requestOnly(`lone ${seed}-${index}`));
        else if (lone.length) f.threads.acceptRequest(lone.splice(pick(lone.length), 1)[0]!);
      }
    };
    // Kinds: the receipt is inside the first-pass window, absent, or arrives after the first pass (request, or only its acceptance).
    const kind = (["window", "absent", "unaccepted", "lateAcceptance", "lateRequest", "resent"] as const)[pick(6)]!;
    noise(pick(180));
    let request: string | undefined;
    if (kind !== "absent" && kind !== "lateRequest") request = f.threads.requestOnly(marker);
    noise(pick(120));
    if (kind === "window" || kind === "resent") f.threads.acceptRequest(request!);
    noise(pick(160));
    // A resend: a second request carrying the same marker, never accepted; the older one holds the receipt.
    if (kind === "resent") f.threads.requestOnly(marker);
    noise(pick(120));
    let lateRequestDue = kind === "lateRequest" ? 1 + pick(3) : -1;
    let lateAcceptanceDue = kind === "lateAcceptance" ? 1 + pick(3) : -1;
    const outcomes: string[] = [];
    let pass = 0;
    while (pass < MAX_DECISION_PASSES && (pass === 0 || f.attempts()[0].outcome === "sending")) {
      if (pass > 0) {
        noise(pick(260));
        if (pass === lateRequestDue) { request = f.threads.requestOnly(marker); f.threads.acceptRequest(request); }
        if (pass === lateAcceptanceDue) f.threads.acceptRequest(request!);
      }
      // Decision phase only: late recovery would hide a sending -> unknown -> inline transition inside one call.
      await f.service.recover(f.tracker.id, false, false);
      outcomes.push(f.attempts()[0].outcome);
      pass++;
    }
    const decided = f.attempts()[0].outcome;
    expect(decided, `seed ${seed} ${kind}: ${outcomes.join(",")}`).not.toBe("sending");
    if (kind === "window" || kind === "resent") expect(outcomes, `seed ${seed}`).not.toContain("unknown");
    if (kind === "window" || kind === "resent") expect(decided).toBe("inline");
    // Nothing was ever delivered inside the window: the only acceptable decision is unknown, never a receipt.
    if (kind === "absent" || kind === "unaccepted") expect(decided, `seed ${seed} ${kind}: ${outcomes.join(",")}`).toBe("unknown");
    expect(["inline", "unknown"]).toContain(decided);
    // A receipt that arrived after the window is still recorded as late evidence.
    if (kind === "lateAcceptance" || kind === "lateRequest") {
      for (let extra = 0; extra < 40 && f.attempts()[0].outcome === "unknown"; extra++) {
        if (lateRequestDue >= pass) { request = f.threads.requestOnly(marker); f.threads.acceptRequest(request); lateRequestDue = -1; }
        if (lateAcceptanceDue >= pass) { f.threads.acceptRequest(request!); lateAcceptanceDue = -1; }
        await f.service.recoverLate(f.tracker.id);
      }
      expect(f.attempts()[0].outcome, `seed ${seed} ${kind}`).toBe("inline");
    }
  });
});

describe("C6 the recovery machine", () => {
  const timeout = historyLimits.readTimeoutMs;
  afterEach(() => { historyLimits.readTimeoutMs = timeout; });
  const attemptFor = (f: Awaited<ReturnType<typeof make>>, id: string) => {
    unknownAttempt(f, id, new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES (?, ?)").run(id, f.occurrences()[0].id);
  };
  const cursor = (f: Awaited<ReturnType<typeof make>>, id: string) => JSON.parse((f.db.prepare("SELECT recovery_cursor FROM attention_attempts WHERE attempt_id=?").get(id) as { recovery_cursor: string }).recovery_cursor);

  it("C6.1: a queue-only outage is a failed read, never an absence, and a stalled queue read times out", async () => {
    const f = await make("live");
    f.card("Queued marker");
    attemptFor(f, "queue");
    f.threads.addRow(MANAGER, `notice ${attentionMarker("batch-queue")}`);
    f.threads.queueFail = true;
    await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0].outcome).toBe("sending");
    expect(cursor(f, "queue").errors).toMatchObject({ count: 1, last: expect.stringContaining("Queue unreadable") });
    // Positive history evidence still wins during the outage.
    f.threads.queueFail = false;
    await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0]).toMatchObject({ outcome: "queued" });
    // A stalled read ends at its timeout instead of blocking the pass.
    const g = await make("live");
    g.card("Stalled queue");
    attemptFor(g, "stall");
    historyLimits.readTimeoutMs = 20;
    g.threads.queueHang = true;
    const started = Date.now();
    await g.service.recover(g.tracker.id, false, false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(g.attempts()[0].outcome).toBe("sending");
    expect(cursor(g, "stall").errors.count).toBe(1);
  });

  it("C6.2: keeps the pages and candidates already read when a later page fails", async () => {
    const f = await make("live");
    f.card("Failing old page");
    attemptFor(f, "partial");
    for (let index = 0; index < 120; index++) f.threads.dispatch(`old ${index}`);
    const request = f.threads.requestOnly(`notice ${attentionMarker("batch-partial")}`);
    f.threads.acceptRequest(request);
    for (let index = 0; index < 10; index++) f.threads.dispatch(`new ${index}`);
    // Every request page below the marked request fails, repeatedly; the marked request and its acceptance stay readable.
    const failBelow = f.threads.requests.find((entry) => entry.requestId === request)!.seq;
    let acceptedReadable = false;
    f.threads.eventsFailWhen = ({ types, beforeSeq }) => (types.includes("client/turn/requested") && beforeSeq !== undefined && Number(beforeSeq) < failBelow) || (types.includes("turn/input/accepted") && !acceptedReadable);
    await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0].outcome).toBe("sending");
    expect(cursor(f, "partial").hit.requestIds).toEqual([request]);
    acceptedReadable = true;
    await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline" });
  });

  it("C6.3: recovery of one attempt runs one pass at a time", async () => {
    const f = await make("live");
    f.card("Overlapping passes");
    attemptFor(f, "serial");
    let release!: () => void;
    f.threads.listGateOnce = new Promise<void>((resolve) => { release = resolve; });
    const first = f.service.recover(f.tracker.id, false, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = f.service.recover(f.tracker.id, false, false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The second pass has not read anything while the first holds the attempt.
    expect(f.threads.queueCalls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(f.threads.queueCalls).toBeGreaterThanOrEqual(1);
  });

  it("C6.3: a failed pass does not overwrite a cursor another process moved, nor decide on its stale error count", async () => {
    const f = await make("live");
    f.card("Stale fifth failure");
    attemptFor(f, "stale");
    f.threads.eventsFail = true;
    await f.service.recover(f.tracker.id, false, false);
    f.threads.eventsFail = false;
    f.db.prepare("UPDATE attention_attempts SET recovery_cursor=? WHERE attempt_id='stale'").run(JSON.stringify({ ...cursor(f, "stale"), errors: { count: 4, since: new Date(Date.now() - 3_600_000).toISOString(), last: "x" } }));
    let release!: () => void;
    f.threads.eventsGateOnce = new Promise<void>((resolve) => { release = resolve; });
    const stale = f.service.recover(f.tracker.id, false, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Another process finished a good pass: the cursor moved on and the errors are gone.
    const moved = JSON.stringify({ high: 999, gaps: [{ from: 500, to: 10 }], accBound: 7 });
    f.db.prepare("UPDATE attention_attempts SET recovery_cursor=? WHERE attempt_id='stale'").run(moved);
    release();
    await stale;
    expect(f.attempts()[0].outcome).toBe("sending");
    expect(f.attempts()[0].recovery_cursor).toBe(moved);
  });

  it("C6.4: matches the marker only in delivered text blocks of our own, and still finds the genuine notice", async () => {
    const f = await make("live");
    f.card("Look-alikes");
    attemptFor(f, "meta");
    attemptFor(f, "foreign");
    attemptFor(f, "grouped");
    attemptFor(f, "genuine");
    // Metadata-only request (params), accepted: no receipt.
    f.threads.acceptRequest(f.threads.requestOnly("an unrelated notice", { extra: { params: { note: attentionMarker("batch-meta") } } }));
    // A request from another plugin carrying the marker in its text: no receipt either.
    f.threads.acceptRequest(f.threads.requestOnly(`foreign ${attentionMarker("batch-foreign")}`, { extra: { originPluginId: "other-plugin" } }));
    // A foreign queue row carrying the marker is not our notice.
    f.threads.addRow(MANAGER, `foreign row ${attentionMarker("batch-foreign")}`, "other-plugin");
    // The genuine ones: a grouped input accepted, and an appended notice in our own queue row.
    f.threads.acceptRequest(f.threads.requestOnly(`grouped ${attentionMarker("batch-grouped")}`, { grouped: true }));
    f.threads.addRow(MANAGER, `first part\n\n---\n\nsecond ${attentionMarker("batch-genuine")}`);
    await f.service.recover(f.tracker.id, false, false);
    const outcomes = Object.fromEntries(f.attempts().map((a) => [a.attempt_id, a.outcome]));
    expect(outcomes).toEqual({ meta: "unknown", foreign: "unknown", grouped: "inline", genuine: "appended" });
  });
});

describe("C7 ranges and the delivery path", () => {
  const limits = { ...historyLimits };
  afterEach(() => { Object.assign(historyLimits, limits); });
  const attemptFor = (f: Awaited<ReturnType<typeof make>>, id: string) => {
    unknownAttempt(f, id, new Date(Date.now() - 3_600_000).toISOString(), "sending");
    f.db.prepare("INSERT INTO attention_attempt_items(attempt_id, occurrence_id) VALUES (?, ?)").run(id, f.occurrences()[0].id);
  };
  const cursor = (f: Awaited<ReturnType<typeof make>>, id: string) => JSON.parse((f.db.prepare("SELECT recovery_cursor FROM attention_attempts WHERE attempt_id=?").get(id) as { recovery_cursor: string }).recovery_cursor);

  it("C7.1: a one-shot acceptance-read failure keeps the saved older ranges, so the older accepted candidate is still found", async () => {
    historyLimits.passPages = 4;
    historyLimits.acceptancePages = 2;
    const f = await make("live");
    f.card("Two candidates, one hiccup");
    attemptFor(f, "hiccup");
    const marker = `notice ${attentionMarker("batch-hiccup")}`;
    // Oldest to newest: R2 with its acceptance, 160 filler pairs, R1 (never accepted), 40 filler pairs.
    f.threads.acceptRequest(f.threads.requestOnly(marker));
    for (let index = 0; index < 160; index++) f.threads.dispatch(`filler ${index}`);
    f.threads.requestOnly(marker);
    for (let index = 0; index < 40; index++) f.threads.dispatch(`newer ${index}`);
    await f.service.recover(f.tracker.id, false, false);
    const before = cursor(f, "hiccup");
    expect(before.hit.requestIds).toHaveLength(1);
    expect(before.gaps.length).toBeGreaterThan(0);
    // The pass that starts with a saved candidate and older ranges fails on its very first read (the acceptance scan).
    f.threads.eventsFail = true;
    await f.service.recover(f.tracker.id, false, false);
    f.threads.eventsFail = false;
    // The failed pass still holds every range that was not read through, and the candidate.
    expect(cursor(f, "hiccup").gaps.filter((gap: { late?: boolean }) => !gap.late)).toEqual(before.gaps.filter((gap: { late?: boolean }) => !gap.late));
    expect(cursor(f, "hiccup").hit).toEqual(before.hit);
    for (let pass = 0; pass < 6 && f.attempts()[0].outcome === "sending"; pass++) await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline" });
  });

  it("C7.2: a head range that keeps failing neither blocks readable older ranges nor piles up identical saved ranges", async () => {
    historyLimits.passPages = 3;
    historyLimits.acceptancePages = 2;
    const f = await make("live");
    f.card("Failing head");
    attemptFor(f, "head");
    f.threads.acceptRequest(f.threads.requestOnly(`notice ${attentionMarker("batch-head")}`));
    for (let index = 0; index < 200; index++) f.threads.dispatch(`filler ${index}`);
    await f.service.recover(f.tracker.id, false, false);
    expect(f.attempts()[0].outcome).toBe("sending");
    for (let index = 0; index < 10; index++) f.threads.dispatch(`fresh ${index}`);
    // From here the newest page cannot be read at all; the older ranges can.
    f.threads.eventsFailWhen = ({ types, beforeSeq }) => types.includes("client/turn/requested") && beforeSeq === undefined;
    const headRanges = () => (cursor(f, "head").gaps as { from?: number; to?: number; late?: boolean }[]).filter((gap) => gap.from === undefined && gap.late);
    for (let pass = 0; pass < 8 && f.attempts()[0].outcome === "sending"; pass++) {
      await f.service.recover(f.tracker.id, false, false);
      expect(headRanges().length).toBeLessThanOrEqual(1);
    }
    expect(f.attempts()[0]).toMatchObject({ outcome: "inline" });
  });

  it("C7.4: a stalled queue read in the delivery path ends at its timeout, through drain and rollback", async () => {
    historyLimits.readTimeoutMs = 30;
    const f = await make("live");
    f.card("Stalled before any write");
    f.makeEligible();
    f.threads.queueHang = true;
    const started = Date.now();
    await f.service.drain();
    expect(Date.now() - started).toBeLessThan(3000);
    // Nothing was written, so the attempt is a definite failure to retry, and a rollback is not held by it.
    expect(f.attempts().map((a) => a.outcome)).toEqual(["failed"]);
    expect(f.threads.sends).toBe(0);
    expect(f.threads.updates).toBe(0);
    f.threads.queueHang = false;

    // A re-read that stalls after an ambiguous update keeps the outcome unknown instead of holding the transport.
    const g = await make("live");
    g.card("Stalled after an update");
    g.threads.addRow(MANAGER, "earlier notice");
    g.makeEligible();
    g.threads.dropRowOnUpdate = true;
    g.threads.queueHangOnCall = g.threads.queueCalls + 2;
    await g.service.drain();
    expect(g.attempts().map((a) => a.outcome)).toEqual(["unknown"]);
    expect(g.threads.sends).toBe(0);
    const rollback = await g.setMode("shadow");
    expect(rollback.transition).toMatchObject({ state: "preparing" });
    await g.call("resolveAttentionAttempt", { attemptId: g.attempts()[0].attempt_id, disposition: "waived_loss" });
    expect((await modes(g)).transition.state).toBe("ready");
  });
});

describe("C1.10 monotonic receipts", () => {
  it("does not let a stale empty search overwrite an acceptance another process recorded", async () => {
    const f = await make("live");
    f.card("Racing recovery");
    unknownAttempt(f, "race", new Date().toISOString(), "sending");
    let release!: () => void;
    f.threads.listGateOnce = new Promise<void>((resolve) => { release = resolve; });
    const stale = f.service.recover(f.tracker.id, false, false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Another process settles the attempt while this search is still reading an empty queue.
    f.db.prepare("UPDATE attention_attempts SET outcome='queued', queued_message_id='qm_other', accepted_at=? WHERE attempt_id='race'").run(new Date().toISOString());
    release();
    await stale;
    expect(f.attempts()[0]).toMatchObject({ outcome: "queued", error: null });
  });
});

describe("C1.11 mode changes through another handle", () => {
  it("lets a handle that cached all-off see a clear and a restore written right after shadow starts", async () => {
    const f = await make("off");
    const handle = new Proxy(f.db, { get: (target, key) => { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; } });
    const other = createTasksStore(handle);
    const task = other.createTask({ projectId: f.tracker.id, title: "Flapping", status: "in_progress" });
    // The cached handle has now answered "all off".
    other.updateTask(task.id, { title: "Still off" });
    await f.setMode("shadow");
    const original = f.occurrences()[0];
    other.updateTask(task.id, { status: "todo" });
    other.updateTask(task.id, { status: "in_progress" });
    const recurrence = f.occurrences()[0];
    expect(recurrence.id).not.toBe(original.id);
  });
});

describe("C1.13 task keys", () => {
  it("follows a prefix rename in the ledger and the delivered notice", async () => {
    const f = await make("live");
    const task = f.card("Renamed");
    f.store.tasks.updateProject(f.tracker.id, { prefix: "REN" });
    const key = f.store.tasks.getTask(task.id)!.key;
    expect(key.startsWith("REN-")).toBe(true);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    expect(ledger.occurrences.map((o: { taskKey: string }) => o.taskKey)).toEqual([key]);
    f.makeEligible();
    await f.service.drain();
    expect(f.threads.rows.map((row) => f.threads.text(row)).join("\n")).toContain(`[${key}]`);
  });

  it("follows a prefix rename in the handback", async () => {
    const f = await make("live");
    const task = f.card("Renamed before rollback");
    f.store.tasks.updateProject(f.tracker.id, { prefix: "REN" });
    await f.setMode("shadow");
    const handback = (await modes(f)).transition.handback;
    expect(handback.map((entry: { taskKey: string }) => entry.taskKey)).toEqual([f.store.tasks.getTask(task.id)!.key]);
  });
});

describe("C2.1 a published handback", () => {
  it("keeps the keys it was published with when a prefix changes before the ack, while live reads follow the rename", async () => {
    const f = await make("live");
    const task = f.card("Renamed after ready");
    await f.setMode("shadow");
    const before = await modes(f);
    const published = before.transition.handback.map((entry: { taskKey: string }) => entry.taskKey);
    f.store.tasks.updateProject(f.tracker.id, { prefix: "REN" });
    const after = await modes(f);
    expect(after.transition).toEqual(before.transition);
    expect(after.transition.handback.map((entry: { taskKey: string }) => entry.taskKey)).toEqual(published);
    const ledger = await f.sweep("attention.ledger", { projectId: BB_PROJECT, kind: "stale-status" });
    expect(ledger.occurrences[0].taskKey).toBe(f.store.tasks.getTask(task.id)!.key);
    expect(ledger.occurrences[0].taskKey).not.toBe(published[0]);
  });
});

describe("C1.14 recipient eligibility", () => {
  it("claims nothing while the manager is stopping and never falls back to its parent", async () => {
    const f = await make("live");
    f.card("One");
    f.makeEligible();
    f.threads.threads.set(MANAGER, { status: "stopping", parent: "thr_parent" });
    await f.service.drain();
    expect(f.attempts()).toHaveLength(0);
    expect(f.threads.sends).toBe(0);
    expect(f.occurrences()).toHaveLength(1);
  });
});

describe("C1.15 the manager key", () => {
  it("is read as `manager` through the CLI and refused by config set", async () => {
    const f = await make("off");
    registerTasksCli(f.bb, f.store, { name: "Work Board", version: "test" });
    const read = await f.harness.runCli(["config", "get", "manager", "--project", "ATT", "--json"]);
    expect(read.exitCode, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout).values).toEqual({ manager: MANAGER });
    const write = await f.harness.runCli(["config", "set", "manager", "thr_other", "--project", "ATT"]);
    expect(write.exitCode).not.toBe(0);
    expect(write.stderr + write.stdout).toMatch(/owner-only convention/);
  });
});
