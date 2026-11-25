import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { backfillApprovalComments } from "../db/schema";
import { prIdentity, prSnapshotSchema } from "../shared/git-sync";
import { recordPrAuthors } from "./authors";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.harness.dispose())); });

const H1 = "1".repeat(40);
const H2 = "2".repeat(40);
const MOVER = "thr_mover";

function fixture(repositories = ["owner/repo"]) {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  registerTasksApi(host.bb, store);
  const db = host.bb.storage.database();
  const project = store.tasks.createProject({ name: "Gate", prefix: "EXA", color: "blue" });
  store.tasks.updateProject(project.id, { doneRequiresReview: "on" });
  db.prepare("INSERT INTO git_sync_projects(project_id, payload) VALUES (?, ?)").run(project.id, JSON.stringify({ repositories }));
  const task = store.tasks.createTask({ projectId: project.id, title: "Card", status: "in_progress" });
  const now = new Date().toISOString();
  const addLink = (number: number, over: Record<string, unknown> = {}, repository = "owner/repo") => {
    const link = { taskId: task.id, provider: "github", host: "github.com", repository, number, url: `https://github.com/${repository}/pull/${number}`, remoteId: null,
      role: "delivers", part: null, source: "manual", confirmed: true, excluded: false, createdAt: now, updatedAt: now, ...over };
    db.prepare("INSERT INTO task_pr_links(task_id, identity, payload) VALUES (?, ?, ?)").run(task.id, prIdentity(link as never), JSON.stringify(link));
    return prIdentity(link as never);
  };
  const addSnapshot = (number: number, over: Record<string, unknown> = {}, repository = "owner/repo") => {
    const snapshot = prSnapshotSchema.parse({ repository, number, remoteId: `PR_${number}`, url: `https://github.com/${repository}/pull/${number}`, title: "Work",
      state: "merged", headSha: H1, mergeSha: H2, mergedAt: now, baseBranch: "main", updatedAt: now, observedAt: now, checks: [], requirementsKnown: false,
      ci: "no_checks", mergeState: "CLEAN", mergeable: true, review: null, unresolvedThreads: null, coverage: [], ...over });
    db.prepare("INSERT OR REPLACE INTO git_pr_snapshots(project_id, identity, payload, last_attempt_at) VALUES (?, ?, ?, 0)").run(project.id, prIdentity(snapshot), JSON.stringify(snapshot));
  };
  const comment = (evidence: Record<string, unknown>) => store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Reviewer", body: "Reviewed", evidence: evidence as never });
  const approve = (number: number | undefined, head: string, thread: string, verdict = "approve") =>
    comment({ kind: "review", ...(number ? { pr: number } : {}), head, verdict, thread });
  const merge = (number: number, head = H1) => comment({ kind: "merge", pr: number, head, merge: H2 });
  const gate = (authors?: { failed: boolean; byIdentity: Map<string, string[]> }, mover: string | null = MOVER) =>
    store.tasks.reviewGate(store.tasks.getTask(task.id)!, "done", undefined, undefined, { mover, authors })!;
  const decisions = () => db.prepare<[], { path: string; result: string; detail: string }>("SELECT path, result, detail FROM review_gate_decisions ORDER BY id").all();
  return { ...host, store, db, project, task, addLink, addSnapshot, comment, approve, merge, gate, decisions };
}

describe("Done gate: card without a delivered PR (path B)", () => {
  it("refuses the transit alone and names the missing evidence", () => {
    const f = fixture();
    f.store.tasks.updateTask(f.task.id, { status: "in_review", statusLog: { by: "test" } });
    f.store.tasks.updateTask(f.task.id, { status: "done", statusLog: { by: "test" } });
    f.store.tasks.updateTask(f.task.id, { status: "in_review", statusLog: { by: "test" } });
    const result = f.gate();
    expect(result.decision.path).toBe("B");
    expect(result.refusal).toContain("no approving review from a thread other than you since the card last entered In Progress");
    expect(result.refusal).not.toContain("--status");
  });

  it("needs an approval from another thread after the last In Progress", () => {
    const f = fixture();
    f.approve(undefined, H1, "thr_reviewer");
    f.store.tasks.updateTask(f.task.id, { status: "todo", statusLog: { by: "test" } });
    f.store.tasks.updateTask(f.task.id, { status: "in_progress", statusLog: { by: "test" } });
    expect(f.gate().refusal).toContain("no approving review");
    f.approve(undefined, H1, MOVER);
    expect(f.gate().refusal).toContain("no approving review");
    f.approve(undefined, H1, "thr_reviewer");
    const passed = f.gate();
    expect(passed.refusal).toBeNull();
    expect(passed.clause).toBe("review: approve by thr_reviewer");
    expect(passed.decision.detail).toMatchObject({ lastInProgress: { id: expect.any(Number) }, approval: { thread: "thr_reviewer" } });
  });

  it("orders by review-log id alone: a same-millisecond approval qualifies, an earlier one does not", () => {
    const f = fixture();
    f.approve(undefined, H1, "thr_reviewer"); // before the card re-enters In Progress
    f.store.tasks.updateTask(f.task.id, { status: "todo", statusLog: { by: "test" } });
    f.store.tasks.updateTask(f.task.id, { status: "in_progress", statusLog: { by: "test" } });
    expect(f.gate().refusal).toContain("no approving review from a thread other than you");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const last = f.db.prepare<[], { at: string }>("SELECT at FROM task_review_log WHERE status='in_progress' ORDER BY id DESC LIMIT 1").get()!.at;
      vi.setSystemTime(new Date(last)); // the approval's createdAt equals the status row's at
      f.approve(undefined, H1, "thr_reviewer");
    } finally { vi.useRealTimers(); }
    expect(f.gate().refusal).toBeNull();
    f.db.prepare("UPDATE task_review_log SET at=NULL WHERE kind='status'").run();
    expect(f.gate().refusal).toBeNull(); // rows without `at` are ordered by id too
  });

  it("counts a backfilled independent approval, not a self-approval or an unmatched row", () => {
    const f = fixture();
    const first = f.approve(undefined, H1, MOVER);
    const second = f.approve(undefined, H1, "thr_reviewer");
    f.db.prepare("UPDATE task_review_log SET comment_id=NULL, at=NULL WHERE kind='approval'").run();
    expect(f.gate().refusal).toBeTruthy();
    backfillApprovalComments(f.db);
    expect(f.db.prepare("SELECT comment_id FROM task_review_log WHERE kind='approval' ORDER BY id").all()).toEqual([{ comment_id: first.id }, { comment_id: second.id }]);
    expect(f.gate().refusal).toBeNull();
    f.db.prepare("UPDATE task_review_log SET comment_id=NULL WHERE kind='approval'").run();
    f.db.prepare("DELETE FROM task_review_log WHERE kind='approval' AND id=(SELECT max(id) FROM task_review_log WHERE kind='approval')").run();
    backfillApprovalComments(f.db); // counts differ: nothing is paired
    expect(f.gate().refusal).toBeTruthy();
  });

  it("logs a QA pass as an approval", () => {
    const f = fixture();
    f.comment({ kind: "qa", head: H1, verdict: "pass", thread: "thr_qa" });
    expect(f.gate().refusal).toBeNull();
  });
});

describe("Done gate: card that delivers PRs (path A)", () => {
  it("passes on an approval at the merged head even when it predates the last In Progress", () => {
    const f = fixture();
    f.addLink(12);
    f.addSnapshot(12);
    f.approve(12, H1, "thr_reviewer");
    f.store.tasks.updateTask(f.task.id, { status: "todo", statusLog: { by: "test" } });
    f.store.tasks.updateTask(f.task.id, { status: "in_progress", statusLog: { by: "test" } });
    const result = f.gate();
    expect(result.refusal).toBeNull();
    expect(result.clause).toBe("review: #12 approve@1111111 by thr_reviewer (no author known)");
    expect(result.decision.detail).toMatchObject({ prs: [{ headSource: "merged_snapshot", gateHead: H1, snapshotHead: H1, authorsKnown: 0, snapshot: { state: "merged", stale: false } }] });
  });

  it("refuses an approval at another head, by the mover, or by a recorded author", () => {
    const f = fixture();
    const identity = f.addLink(12);
    f.addSnapshot(12);
    f.approve(12, H2, "thr_reviewer");
    expect(f.gate().refusal).toContain("owner/repo#12 (head 1111111): no approval at this head from a thread other than you or the PR's authors");
    f.approve(12, H1, MOVER);
    expect(f.gate().refusal).toContain(`approved only by you (${MOVER})`);
    f.approve(12, H1, "thr_author");
    recordPrAuthors(f.db, f.project.id, identity, ["thr_author"]);
    expect(f.gate().refusal).toContain("approved only by an author thread");
    expect(f.gate().refusal).toContain("--kind review --pr 12 --head <sha>");
  });

  it("names the PR that lacks an approval when two are delivered", () => {
    const f = fixture();
    f.addLink(12); f.addLink(13);
    f.addSnapshot(12); f.addSnapshot(13, { headSha: H2 });
    f.approve(12, H1, "thr_reviewer");
    const refusal = f.gate().refusal!;
    expect(refusal).toContain("owner/repo#13 (head 2222222)");
    expect(refusal).not.toContain("owner/repo#12 (head");
  });

  it("fails closed without a current snapshot, and trusts a merged one however old", () => {
    const f = fixture();
    f.addLink(12);
    f.approve(12, H1, "thr_reviewer");
    expect(f.gate().refusal).toContain("PR state for owner/repo#12 is unknown or stale; run bb work-board sync --project EXA and retry");
    const old = new Date(Date.now() - 3_600_000).toISOString();
    f.addSnapshot(12, { state: "open", observedAt: old });
    expect(f.gate().refusal).toContain("unknown or stale");
    f.addSnapshot(12, { state: "open" });
    expect(f.gate().decision.detail).toMatchObject({ prs: [{ headSource: "open_snapshot", snapshotHead: H1, gateHead: H1 }] });
    expect(f.gate().refusal).toBeNull();
    f.addSnapshot(12, { state: "merged", observedAt: old });
    expect(f.gate().refusal).toBeNull();
  });

  it("never lets a stale closed snapshot drop the link into the review-free path, while a current one does", () => {
    const f = fixture();
    f.addLink(12);
    f.approve(undefined, H1, "thr_reviewer"); // unrelated to the PR
    f.addSnapshot(12, { state: "closed", mergedAt: null, mergeSha: null, observedAt: new Date(Date.now() - 3_600_000).toISOString() });
    const stale = f.gate();
    expect(stale.decision.path).toBe("A");
    expect(stale.refusal).toContain("PR state for owner/repo#12 is unknown or stale");
    f.addSnapshot(12, { state: "closed", mergedAt: null, mergeSha: null });
    expect(f.gate().decision.path).toBe("B"); // closed without merge, seen now: nothing to deliver
    expect(f.gate().refusal).toBeNull();
  });

  it("gates a PR a merge record names, at once, from the record's head", () => {
    const f = fixture();
    f.addLink(12, { role: "related", source: "title", confirmed: false });
    f.merge(12, H1);
    expect(f.db.prepare("SELECT payload FROM task_pr_links").all().map((row) => JSON.parse((row as { payload: string }).payload))).toMatchObject([{ role: "delivers", confirmed: true }]);
    expect(f.store.tasks.listComments(f.task.id).some((comment) => comment.body === "owner/repo#12 confirmed as delivering: a merge was recorded on this card")).toBe(true);
    expect(f.gate().refusal).toContain("owner/repo#12 (head 1111111): no approval");
    f.addSnapshot(12, { state: "open", observedAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(f.gate().refusal).toContain("unknown or stale"); // a snapshot that is stale beats the record's head
    f.db.prepare("DELETE FROM git_pr_snapshots").run();
    f.db.prepare("DELETE FROM task_pr_links").run();
    expect(f.gate().refusal).toContain("owner/repo#12 (head 1111111): no approval");
    f.approve(12, H1, "thr_reviewer");
    expect(f.gate().decision.detail).toMatchObject({ prs: [{ headSource: "merge_evidence", snapshotHead: null, mergeCommentId: expect.any(String) }] });
    expect(f.gate().refusal).toBeNull();
  });

  it("resolves a merge record's repository only when there is exactly one", () => {
    const one = fixture();
    one.merge(12);
    expect(one.gate().refusal).toContain("owner/repo#12 (head 1111111)");
    const two = fixture(["owner/repo", "owner/other"]);
    two.merge(12);
    expect(two.gate().refusal).toContain("link it with bb work-board pr link EXA-1 <url> --role delivers");
    const none = fixture([]);
    none.merge(12);
    expect(none.gate().refusal).toContain("pr link EXA-1");
  });

  it("refuses two delivering links that share a number", () => {
    const f = fixture(["owner/repo", "owner/other"]);
    f.addLink(12); f.addLink(12, {}, "owner/other");
    f.addSnapshot(12); f.addSnapshot(12, {}, "owner/other");
    expect(f.gate().refusal).toContain("two linked PRs share #12; unlink one, or the owner can move the card");
  });

  it("does not touch a manual role, an excluded link or a number several links share", () => {
    const f = fixture(["owner/repo", "owner/other"]);
    f.addLink(1, { role: "design" });
    f.addLink(2, { excluded: true, confirmed: false, role: "related", source: "title" });
    f.addLink(3, { confirmed: false, role: "related", source: "title" });
    f.addLink(3, { confirmed: false, role: "related", source: "title" }, "owner/other");
    f.addLink(4, { confirmed: false, role: "related", source: "manual" });
    for (const number of [1, 2, 3, 4]) f.merge(number);
    const roles = f.db.prepare("SELECT payload FROM task_pr_links ORDER BY identity").all().map((row) => JSON.parse((row as { payload: string }).payload)).map((link) => [link.number, link.role, link.confirmed]);
    expect(roles).toContainEqual([1, "design", true]);
    expect(roles).toContainEqual([2, "related", false]);
    expect(roles).toContainEqual([4, "related", false]); // a manual link is never touched, confirmed or not
    expect(roles.filter((link) => link[0] === 3)).toEqual([[3, "related", false], [3, "related", false]]);
  });

  it("excludes a known author, and only the known ones (best effort)", () => {
    const f = fixture();
    const identity = f.addLink(12);
    f.addSnapshot(12);
    f.approve(12, H1, "thr_live");
    const live = { failed: false, byIdentity: new Map([[identity, ["thr_live"]]]) };
    expect(f.gate(live).refusal).toContain("approved only by an author thread (thr_live)");
    expect(f.gate().refusal).toBeNull(); // an author seen by nobody is not excluded
    recordPrAuthors(f.db, f.project.id, identity, ["thr_recorded"]);
    f.approve(12, H1, "thr_recorded");
    const both = f.gate(live);
    expect(both.refusal).toContain("approved only by an author thread (thr_live, thr_recorded)");
    expect(both.decision.detail).toMatchObject({ prs: [{ authorsKnown: 2, authors: expect.arrayContaining([{ thread: "thr_live", source: "live" }, { thread: "thr_recorded", source: "record" }]) }] });
    // The second author never recorded: its approval still qualifies. This is the documented limit.
    f.approve(12, H1, "thr_unrecorded");
    expect(f.gate(live).clause).toBe("review: #12 approve@1111111 by thr_unrecorded");
  });

  it("refuses when the live author lookup failed", () => {
    const f = fixture();
    f.addLink(12);
    f.addSnapshot(12);
    f.approve(12, H1, "thr_reviewer");
    expect(f.gate({ failed: true, byIdentity: new Map() }).refusal).toContain("could not resolve the PR's author threads; retry, or the owner can move the card");
  });
});

describe("Done gate through the API", () => {
  const move = (f: ReturnType<typeof fixture>, extra: Record<string, unknown> = {}) =>
    f.harness.callRpc("updateTask", { taskId: f.task.id, agentThreadId: MOVER, status: "done", ...extra });

  it("records every attempt, adds the review clause to the Done entry, and lets the owner move without one", async () => {
    const f = fixture();
    f.addLink(12);
    f.addSnapshot(12);
    await expect(move(f)).rejects.toThrow(/no approval at this head/);
    expect(f.decisions().map((row) => [row.path, row.result])).toEqual([["A", "refused"]]);
    f.approve(12, H1, "thr_reviewer");
    await move(f);
    expect(f.decisions().map((row) => row.result)).toEqual(["refused", "passed"]);
    expect(JSON.parse(f.decisions()[1]!.detail)).toMatchObject({
      links: [{ identity: prIdentity({ repository: "owner/repo", number: 12 }), role: "delivers", confirmed: true, excluded: false }],
      prs: [{ headSource: "merged_snapshot", gateHead: H1, qualifying: [expect.any(String)], approvals: [{ thread: "thr_reviewer", head: H1 }] }],
    });
    expect(f.store.tasks.listComments(f.task.id).map((comment) => comment.body)).toContainEqual(expect.stringMatching(/^Status changed to Done by .* \(review: #12 approve@1111111 by thr_reviewer \(no author known\)\)$/));
    const other = f.store.tasks.createTask({ projectId: f.project.id, title: "Owner card", status: "in_progress" });
    await f.harness.callRpc("updateTask", { taskId: other.id, status: "done" });
    expect(f.decisions()).toHaveLength(2);
  });

  it("learns authors live, keeps them after the worktree is gone, and refuses when the lookup fails", async () => {
    const f = fixture();
    f.addLink(12);
    f.addSnapshot(12);
    f.approve(12, H1, "thr_author");
    f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId: "thr_author", title: "Worker", presetName: "Default", liveStatus: "working" });
    f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_a" }));
    f.harness.sdk.stub("plugins.callRpc", async () => ({ env_a: { outcome: "available", pullRequest: { number: 12, title: "Work", state: "merged", url: "https://github.com/owner/repo/pull/12", updatedAt: new Date().toISOString() } } }));
    await expect(move(f)).rejects.toThrow(/approved only by an author thread \(thr_author\)/);
    expect(f.db.prepare("SELECT thread_id FROM pr_author_threads").all()).toEqual([{ thread_id: "thr_author" }]);
    f.harness.sdk.stub("threads.get", async () => { throw Object.assign(new Error("gone"), { code: "thread_not_found" }); });
    await expect(move(f)).rejects.toThrow(/approved only by an author thread/);
    f.harness.sdk.stub("threads.get", async () => { throw new Error("unavailable"); });
    await expect(move(f)).rejects.toThrow(/could not resolve the PR's author threads/);
    expect(f.decisions().map((row) => row.result)).toEqual(["refused", "refused", "refused"]);
  });
});

describe("Done gate: the live author lookup", () => {
  const move = (f: ReturnType<typeof fixture>) => f.harness.callRpc("updateTask", { taskId: f.task.id, agentThreadId: MOVER, status: "done" });
  const attach = (f: ReturnType<typeof fixture>, threadId: string) =>
    f.store.tasks.upsertTaskThread({ taskId: f.task.id, threadId, title: "Worker", presetName: "Default", liveStatus: "working" });

  it("fails the lookup, and so refuses, when an available PR's URL cannot be read", async () => {
    const f = fixture();
    f.addLink(12); f.addSnapshot(12); f.approve(12, H1, "thr_reviewer");
    attach(f, "thr_worker");
    f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_a" }));
    f.harness.sdk.stub("plugins.callRpc", async () => ({ env_a: { outcome: "available", pullRequest: { number: 12, title: "Work", state: "merged", url: "not a url", updatedAt: new Date().toISOString() } } }));
    await expect(move(f)).rejects.toThrow(/could not resolve the PR's author threads/);
    expect(f.decisions().map((row) => row.result)).toEqual(["refused"]);
  });

  it("refuses when the card's threads changed while the lookup ran, and passes on the retry", async () => {
    const f = fixture();
    f.addLink(12); f.addSnapshot(12); f.approve(12, H1, "thr_reviewer");
    attach(f, "thr_worker");
    let late = true;
    f.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (late) { late = false; attach(f, "thr_late"); }
      return makeThreadResponse({ id: threadId, environmentId: "env_a" });
    });
    f.harness.sdk.stub("plugins.callRpc", async () => ({ env_a: { outcome: "absent" } }));
    await expect(move(f)).rejects.toThrow(/could not resolve the PR's author threads; retry/);
    expect(f.store.tasks.getTask(f.task.id)!.status).toBe("in_progress");
    expect(f.decisions().map((row) => row.result)).toEqual(["refused"]);
    await move(f);
    expect(f.store.tasks.getTask(f.task.id)!.status).toBe("done");
  });
});

describe("PR link history", () => {
  it("writes a row for a new link, a role change, a confirmation, an exclusion and an unlink", () => {
    const f = fixture();
    const identity = f.addLink(12, { role: "related", confirmed: false });
    const update = (patch: Record<string, unknown>) => {
      const row = f.db.prepare<[string], { payload: string }>("SELECT payload FROM task_pr_links WHERE task_id=?").get(f.task.id)!;
      f.db.prepare("UPDATE task_pr_links SET payload=? WHERE task_id=?").run(JSON.stringify({ ...JSON.parse(row.payload), ...patch }), f.task.id);
    };
    update({ updatedAt: new Date().toISOString() }); // no relevant change: no row
    update({ role: "delivers" });
    update({ confirmed: true });
    update({ excluded: true });
    f.db.prepare("DELETE FROM task_pr_links").run();
    const rows = f.db.prepare("SELECT role, confirmed, excluded, deleted FROM pr_link_history WHERE identity=? ORDER BY id").all(identity);
    expect(rows).toEqual([
      { role: "related", confirmed: 0, excluded: 0, deleted: 0 },
      { role: "delivers", confirmed: 0, excluded: 0, deleted: 0 },
      { role: "delivers", confirmed: 1, excluded: 0, deleted: 0 },
      { role: "delivers", confirmed: 1, excluded: 1, deleted: 0 },
      { role: "delivers", confirmed: 1, excluded: 1, deleted: 1 },
    ]);
  });
});
