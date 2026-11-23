import { afterEach, expect, it } from "vitest";
import { setup } from "../attention/fixtures";
import { prIdentity, prSnapshotSchema } from "../shared/git-sync";
import { captureStatements } from "../test-capture";
import { createGitSyncStore } from "./store";

const fixtures: ReturnType<typeof setup>[] = [];
afterEach(async () => { await Promise.all(fixtures.splice(0).map((f) => f.dispose())); });

/** Two projects whose cards link the same PR identity; both have the stale-status observation on. */
async function twoProjects() {
  const f = setup();
  fixtures.push(f);
  await f.setMode("shadow");
  const other = f.store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red" });
  f.db.exec(`CREATE TEMP TABLE modes_copy AS SELECT * FROM attention_modes WHERE tracker_id='${f.tracker.id}';
    UPDATE modes_copy SET tracker_id='${other.id}'; INSERT INTO attention_modes SELECT * FROM modes_copy; DROP TABLE modes_copy;`);
  const own = f.card("Own", "in_review");
  const foreign = f.store.tasks.createTask({ projectId: other.id, title: "Foreign", status: "in_review" });
  const git = createGitSyncStore(f.db);
  const now = new Date().toISOString();
  const mk = (taskId: string) => git.saveLink({ taskId, provider: "github", host: "github.com", repository: "org/repo", number: 7, url: "https://github.com/org/repo/pull/7", remoteId: "7", role: "delivers", part: null, source: "manual", confirmed: true, excluded: false, createdAt: now, updatedAt: now });
  const ownLink = mk(own.id), foreignLink = mk(foreign.id);
  const snapshot = (repository = "org/repo") => prSnapshotSchema.parse({ repository, number: 7, remoteId: "7", url: `https://github.com/${repository}/pull/7`, title: "t", state: "open", headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: "2026-01-01", observedAt: now, checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [] });
  const open = (taskId: string) => f.db.prepare<[string], { signal: string }>("SELECT signal FROM manager_attention WHERE task_id=? AND cleared_at IS NULL").all(taskId);
  return { f, git, other, own, foreign, ownLink, foreignLink, snapshot, open };
}

it("a snapshot write recomputes only the cards of its own project that link the PR", async () => {
  const { f, git, other, own, foreign, ownLink, snapshot, open } = await twoProjects();
  // Both cards sit in review with no snapshot yet: each has an open stale-status occurrence.
  expect(open(own.id).length).toBeGreaterThan(0);
  expect(open(foreign.id).length).toBeGreaterThan(0);
  // A pending change on the foreign card that no touch has seen: its own project's snapshot now says the PR is open.
  f.db.prepare("INSERT INTO git_pr_snapshots(project_id, identity, payload, error) VALUES (?, ?, ?, NULL)").run(other.id, prIdentity(ownLink), JSON.stringify(snapshot()));
  git.saveSnapshot(f.tracker.id, ownLink, snapshot());
  expect(open(own.id)).toEqual([]);
  // Had the project predicate been dropped, the foreign card would have been recomputed and cleared as well.
  expect(open(foreign.id).length).toBeGreaterThan(0);
  // The failure path touches through the same lookup: the owning card now reads as unavailable, the foreign card is left alone.
  git.fail(f.tracker.id, ownLink, "outage");
  expect(open(own.id).map((row) => row.signal)).toContain("pr_state_unavailable");
  expect(open(foreign.id).length).toBeGreaterThan(0);
});

it("a repository rename rewrites only the link payloads of the snapshot's own project", async () => {
  const { f, git, own, foreign, ownLink, snapshot } = await twoProjects();
  git.saveSnapshot(f.tracker.id, ownLink, snapshot("org/renamed"));
  const repositories = (taskId: string) => f.db.prepare<[string], { payload: string }>("SELECT payload FROM task_pr_links WHERE task_id=?").all(taskId).map((row) => JSON.parse(row.payload).repository);
  expect(repositories(own.id)).toEqual(["org/renamed"]);
  expect(repositories(foreign.id)).toEqual(["org/repo"]);
});

it("serves each identity-first lookup from the identity index", async () => {
  const { f, git, ownLink, snapshot } = await twoProjects();
  const capture = captureStatements(f.db);
  // The reverse lookups are the SELECTs on task_pr_links that are not the observation read.
  const lookups = () => capture.take().filter((call) => /^\s*SELECT/.test(call.sql) && /task_pr_links/.test(call.sql) && !/git_pr_snapshots/.test(call.sql));
  try {
    git.saveSnapshot(f.tracker.id, ownLink, snapshot());
    const written = lookups();
    // One lookup of the link payloads and one of the cards to recompute.
    expect(written.map((call) => call.sql.match(/^\s*SELECT l\.(\w+)/)?.[1]).sort()).toEqual(["payload", "task_id"]);
    git.fail(f.tracker.id, ownLink, "outage");
    const failed = lookups();
    expect(failed.map((call) => call.sql.match(/^\s*SELECT l\.(\w+)/)?.[1])).toEqual(["task_id"]);
    for (const call of [...written, ...failed]) expect(capture.plan(call)).toMatch(/SEARCH l USING (COVERING )?INDEX idx_task_pr_links_identity \(identity=\?\)/);
  } finally { capture.restore(); }
});
