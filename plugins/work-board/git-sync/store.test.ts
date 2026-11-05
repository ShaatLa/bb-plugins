import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore } from "../api";
import { gitSyncConfigSchema, prLinkSchema, prSnapshotSchema, prIdentity } from "../shared/git-sync";
import { createGitSyncStore } from "./store";

it("refreshes cached overlaps after database, snapshot, link and rule changes", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  try {
    const tasks = createStore(host.bb).tasks;
    const project = tasks.createProject({ name: "Example", prefix: "ABC", color: "blue" });
    const a = tasks.createTask({ projectId: project.id, title: "A" });
    const b = tasks.createTask({ projectId: project.id, title: "B" });
    const db = host.bb.storage.database();
    const store = createGitSyncStore(db);
    const config = gitSyncConfigSchema.parse({ repositories: ["org/repo"] });
    store.setConfig(project.id, config);
    const link = (taskId: string, number: number) => prLinkSchema.parse({ taskId, repository: "org/repo", number, url: `https://github.com/org/repo/pull/${number}`, source: "manual", confirmed: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    const snapshot = (number: number, filename: string) => prSnapshotSchema.parse({ repository: "org/repo", number, remoteId: String(number), url: `https://github.com/org/repo/pull/${number}`, title: "test", state: "open", headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: "2026-01-01", observedAt: "2026-01-01T00:00:00.000Z", checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [], files: { entries: [{ filename, status: "added" }], truncated: false } });
    const la = link(a.id, 1), lb = link(b.id, 2);
    store.saveLink(la); store.saveLink(lb);
    store.saveSnapshot(project.id, la, snapshot(1, "same")); store.saveSnapshot(project.id, lb, snapshot(2, "same"));
    expect(store.overlaps(a.id)).toHaveLength(1);
    expect(store.overlaps(a.id)).toHaveLength(1);
    store.saveSnapshot(project.id, lb, snapshot(2, "other"));
    expect(store.overlaps(a.id)).toHaveLength(0);
    store.setConfig(project.id, { ...config, overlapRules: [{ match: "added", pattern: "*" }] });
    expect(store.overlaps(a.id)).toHaveLength(1);
    store.saveLink({ ...lb, excluded: true });
    expect(store.overlaps(a.id)).toHaveLength(0);
    store.saveLink(lb);
    db.prepare("UPDATE tasks SET number=99 WHERE id=?").run(b.id);
    expect(store.overlaps(a.id)[0]?.otherTaskKey).toBe("ABC-99");
    db.prepare("UPDATE git_pr_snapshots SET payload=NULL WHERE project_id=? AND identity=?").run(project.id, prIdentity(lb));
    expect(store.overlaps(a.id)).toHaveLength(0);
    store.saveSnapshot(project.id, lb, snapshot(2, "same"));
    expect(store.overlaps(a.id)).toHaveLength(2);
    db.prepare("DELETE FROM task_pr_links WHERE task_id=?").run(b.id);
    expect(store.overlaps(a.id)).toHaveLength(0);
  } finally { await host.harness.dispose(); }
});
