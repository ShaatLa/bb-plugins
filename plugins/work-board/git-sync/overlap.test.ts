import { expect, it } from "vitest";
import { evaluateOverlaps, matchesGlob } from "./overlap";
import { gitSyncConfigSchema, prLinkSchema, prSnapshotSchema } from "../shared/git-sync";

it("matches path globs without crossing directories for single stars", () => {
  expect(matchesGlob("migrations/**", "migrations/a/b.sql")).toBe(true);
  expect(matchesGlob("docs/**/*.json", "docs/file.json")).toBe(true);
  expect(matchesGlob("docs/*.json", "docs/sub/file.json")).toBe(false);
  expect(matchesGlob("a?.sql", "ab.sql")).toBe(true);
});
it("finds changed, added and renamed overlaps only across distinct tasks and PRs", () => {
  const entry = (taskId: string, number: number, files: unknown[]) => ({ taskId, taskKey: `ABC-${number}`, link: prLinkSchema.parse({ taskId: taskId.padStart(26, "0"), repository: "org/repo", number, url: `https://github.com/org/repo/pull/${number}`, source: "manual", confirmed: true, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }), snapshot: prSnapshotSchema.parse({ repository: "org/repo", number, remoteId: "id", url: `https://github.com/org/repo/pull/${number}`, title: "test", state: "open", headSha: "a".repeat(40), mergeSha: null, mergedAt: null, baseBranch: "main", updatedAt: "2026-01-01", observedAt: "2026-01-01T00:00:00.000Z", checks: [], requirementsKnown: false, ci: "no_checks", mergeState: null, mergeable: null, review: null, unresolvedThreads: null, coverage: [], files: { entries: files, truncated: false } }) });
  const a = entry("1", 1, [{ filename: "migrations/1.sql", status: "added" }, { filename: "docs/a.json", status: "modified" }]);
  const b = entry("2", 2, [{ filename: "migrations/2.sql", status: "renamed", previous_filename: "old.sql" }, { filename: "docs/a.json", status: "removed" }]);
  const same = entry("1", 3, [{ filename: "docs/a.json", status: "modified" }]);
  const rules = [{ pattern: "migrations/**", match: "added" as const }, { pattern: "docs/*.json", match: "changed" as const }];
  expect(evaluateOverlaps([a, b, same], "1", rules)).toEqual(expect.arrayContaining([expect.objectContaining({ otherTaskKey: "ABC-2", rule: rules[0], files: ["migrations/1.sql", "migrations/2.sql"] }), expect.objectContaining({ rule: rules[1], files: ["docs/a.json"] }), expect.objectContaining({ rule: null, files: ["docs/a.json"] })]));
  expect(evaluateOverlaps([a, same], "1", rules)).toEqual([]);
});
it("validates optional overlap rules", () => {
  expect(gitSyncConfigSchema.parse({}).overlapRules).toBeUndefined();
  expect(gitSyncConfigSchema.safeParse({ overlapRules: [{ pattern: "x", match: "invalid" }] }).success).toBe(false);
  expect(gitSyncConfigSchema.safeParse({ overlapRules: Array(51).fill({ pattern: "x", match: "added" }) }).success).toBe(false);
});
