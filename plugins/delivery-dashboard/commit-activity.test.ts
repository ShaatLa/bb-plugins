import { expect, test, vi } from "vitest";
import { loadCommitActivity } from "./commit-activity";

const since = "2026-10-13T12:00:00Z", until = "2026-10-20T12:00:00Z";
const row = (oid: string, additions: number, deletions: number) => ({ oid, additions, deletions, committedDate: "2026-10-19T12:00:00Z" });
const target = (nodes: ReturnType<typeof row>[], totalCount: number, next: string | null = null) => ({
  oid: "head", history: { totalCount, nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } },
});
const first = (value: ReturnType<typeof target> | null) => ({ body: { data: { repository: { defaultBranchRef: value ? { name: "main", target: value } : null } } } });

test("paginates commit statistics against an immutable head and counts each commit once", async () => {
  const request = vi.fn().mockResolvedValueOnce(first(target([row("head", 10, 2)], 2, "next")))
    .mockResolvedValueOnce({ body: { data: { repository: { target: target([row("head", 10, 2), row("second", 5, 0)], 2) } } } });
  expect(await loadCommitActivity("acme/widgets", "token", since, until, request)).toEqual({ commits: 2, additions: 15, deletions: 2, branch: "main", error: null });
  const input = JSON.parse(request.mock.calls[1][1].body);
  expect(input.variables).toMatchObject({ head: "head", cursor: "next", since, until });
  expect(input.query).toContain("object(oid:$head)");
});

test("empty repositories and an empty seven-day history have real zero counts", async () => {
  const request = vi.fn().mockResolvedValueOnce(first(null)).mockResolvedValueOnce(first(target([], 0)));
  expect(await loadCommitActivity("acme/widgets", "token", since, until, request)).toMatchObject({ commits: 0, additions: 0, deletions: 0, branch: null });
  expect(await loadCommitActivity("acme/widgets", "token", since, until, request)).toMatchObject({ commits: 0, additions: 0, deletions: 0, branch: "main" });
});

test("missing authorization skips GraphQL and explains unavailable statistics", async () => {
  const request = vi.fn();
  await expect(loadCommitActivity("acme/widgets", undefined, since, until, request)).rejects.toThrow("authorization is required");
  expect(request).not.toHaveBeenCalled();
});

test("incomplete and invalid cursor histories never produce partial statistics", async () => {
  const request = vi.fn().mockResolvedValueOnce(first(target([row("head", 10, 1)], 2)))
    .mockResolvedValueOnce(first(target([row("head", 10, 1)], 2, "next")))
    .mockResolvedValueOnce({ body: { data: { repository: { target: target([row("head", 10, 1)], 2, "next") } } } });
  await expect(loadCommitActivity("acme/widgets", "token", since, until, request)).rejects.toThrow("incomplete");
  await expect(loadCommitActivity("acme/widgets", "token", since, until, request)).rejects.toThrow("cursor");
});

test("GraphQL partial errors and invalid statistics are rejected without leaking messages", async () => {
  const request = vi.fn().mockResolvedValueOnce({ body: { errors: [{ message: "sensitive-details" }], data: { repository: null } } })
    .mockResolvedValueOnce(first(target([row("head", -1, 0)], 1)));
  await expect(loadCommitActivity("acme/widgets", "token", since, until, request)).rejects.toThrow("Check repository permissions");
  await expect(loadCommitActivity("acme/widgets", "token", since, until, request)).rejects.toThrow();
});

test("loads more than 1,000 commits anchored to the initial head", async () => {
  const request = vi.fn(async (_path, init) => {
    const { variables } = JSON.parse(init.body);
    const page = Number(variables.cursor ?? 0);
    if (page > 0) expect(variables.head).toBe("head");
    const nodes = Array.from({ length: page < 12 ? 100 : 1 }, (_, index) => row(`${page * 100 + index}`, 3, 2));
    const value = target(nodes, 1201, page < 12 ? String(page + 1) : null);
    return page === 0 ? first(value) : { body: { data: { repository: { target: value } } } };
  });
  expect(await loadCommitActivity("acme/widgets", "token", since, until, request)).toEqual({
    commits: 1201, additions: 3603, deletions: 2402, branch: "main", error: null,
  });
  expect(request).toHaveBeenCalledTimes(13);
});
