import { expect, test } from "vitest";
import { prLifecycleBatch, prLifecycleEvents, prLifecycleQuery } from "./ci-pr-lifecycle";

const head = "a".repeat(40), merge = "b".repeat(40), url = "https://github.com/acme/app/pull/12";
const check = (name = "build", conclusion = "SUCCESS", isRequired = true, status = "COMPLETED") => ({ __typename: "CheckRun", name, conclusion, isRequired, status });
const legacy = (state = "SUCCESS", isRequired = true) => ({ __typename: "StatusContext", context: "test", state, isRequired });
function body(checks: unknown[], overrides = {}, commitOverrides = {}) {
  return { data: { repository: { pr12: { number: 12, state: "OPEN", merged: false, mergedAt: null, mergeCommit: null, headRefOid: head, url,
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: { contexts: { nodes: checks, pageInfo: { hasNextPage: false } } }, ...commitOverrides } }] }, ...overrides } } } };
}
test("required contexts alone decide CI, including legacy statuses", () => {
  expect(prLifecycleEvents(body([check(), legacy(), check("optional", "FAILURE", false)]))[0]?.text).toBe(`PR CI green · #12 · head ${head} · 2 required checks passed · ${url}`);
  expect(prLifecycleEvents(body([check(), check("optional", "", false, "QUEUED")]))).toHaveLength(1);
});
test("without required contexts all contexts decide CI and the line says checks", () => {
  expect(prLifecycleEvents(body([check("build", "NEUTRAL", false), legacy("SUCCESS", false), check("lint", "SKIPPED", false)]))[0]?.text).toContain("3 checks passed");
});
test.each(["QUEUED", "IN_PROGRESS", "PENDING", "EXPECTED"])("nonterminal check status %s waits", status => {
  expect(prLifecycleEvents(body([check("build", "SUCCESS", true, status)]))).toEqual([]);
});
test.each(["PENDING", "EXPECTED"])("legacy status %s waits", state => {
  expect(prLifecycleEvents(body([legacy(state)]))).toEqual([]);
});
test("a required check that has not reported yet (rollup EXPECTED) waits", () => {
  expect(prLifecycleEvents(body([], {}, { statusCheckRollup: { state: "EXPECTED", contexts: { nodes: [check("labeler", "SUCCESS", false)], pageInfo: { hasNextPage: false } } } }))).toEqual([]);
});
test("missing, empty, truncated or stale-head evidence waits", () => {
  for (const input of [body([]), body([], {}, { statusCheckRollup: null }), body([check()], {}, { oid: merge }), body([], {}, { statusCheckRollup: { contexts: { nodes: [check()], pageInfo: { hasNextPage: true } } } })]) expect(prLifecycleEvents(input)).toEqual([]);
});
test("red lines count failures and cap labels without any log or annotation text", () => {
  const checks = [check("build", "FAILURE"), legacy("ERROR"), check("lint", "CANCELLED"), check("types", "TIMED_OUT"), check("format", "ACTION_REQUIRED"), check("extra", "STALE")];
  expect(prLifecycleEvents(body(checks))[0]?.text).toBe(`PR CI red · #12 · head ${head} · 6 of 6 required checks failed: build, test, lint, types, format, +1 · ${url}`);
});
test("merged and closed take precedence over CI", () => {
  expect(prLifecycleEvents(body([check()], { state: "MERGED", merged: true, mergeCommit: { oid: merge }, mergedAt: "2026-10-20T12:00:00Z" }))).toEqual([{ number: 12, key: "pr_merged:12", text: `PR merged · #12 · merge commit ${merge} · 2026-10-20T12:00:00Z · ${url}` }]);
  expect(prLifecycleEvents(body([check()], { state: "CLOSED" }))).toEqual([{ number: 12, key: "pr_closed:12", closed: true, text: `PR closed · #12 · not merged, subscription ended · ${url}` }]);
});
test("batching deduplicates PRs, skips merged/closed and paces at exactly 60 seconds", () => {
  const pace = {};
  expect(prLifecycleBatch([], {}, pace, 0)).toEqual([]);
  expect(prLifecycleBatch([12, 12, 13, 14], { "pr_merged:13": 0, "pr_closed:14": 0 }, pace, 0)).toEqual([12]);
  expect(prLifecycleBatch([12], {}, pace, 59_999)).toEqual([]);
  expect(prLifecycleBatch([12], {}, pace, 60_000)).toEqual([12]);
});
test("large subscription lists rotate through batches capped at 25", () => {
  const pace = {}, numbers = Array.from({ length: 55 }, (_, i) => i + 1);
  expect(prLifecycleBatch(numbers, {}, pace, 0)).toEqual(numbers.slice(0, 25));
  expect(prLifecycleBatch(numbers, {}, pace, 60_000)).toEqual(numbers.slice(25, 50));
  expect(prLifecycleBatch(numbers, {}, pace, 120_000)).toEqual(numbers.slice(50));
  expect(prLifecycleBatch(numbers, {}, pace, 180_000)).toEqual(numbers.slice(0, 25));
});
test("query batches aliases with per-PR required-context lookup and no log fields", () => {
  const query = prLifecycleQuery([12, 13]);
  for (const number of [12, 13]) {
    expect(query).toContain(`pr${number}:pullRequest(number:${number})`);
    expect(query.match(new RegExp(`isRequired\\(pullRequestNumber:${number}\\)`, "g"))).toHaveLength(2);
  }
  expect(query).toContain("commits(last:1)"); expect(query).toContain("contexts(first:100)");
  expect(query).not.toMatch(/annotations|logs/);
});
