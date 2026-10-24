import { afterEach, expect, test, vi } from "vitest";
import { cardDetailsOutput, loadCardDetails } from "./card-details";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const range = { kind: "ci" as const, repository: "acme/widgets", since: "2026-10-19T00:00:00.000Z", until: "2026-10-19T23:59:59.999Z" };

test("fetches only five failed runs in the selected range with safe constructed links", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ workflow_runs: [{ id: 123, name: "Tests", display_title: "Fix widgets", created_at: range.since, conclusion: "failure", html_url: "javascript:unsafe" }] }));
  vi.stubGlobal("fetch", fetchMock);
  const result = await loadCardDetails(range, "private-token", signal());
  expect(cardDetailsOutput.parse(result).items).toEqual([{ id: 123, title: "Tests · Fix widgets", createdAt: range.since, state: "failure", url: "https://github.com/acme/widgets/actions/runs/123", compareUrl: null }]);
  const url = new URL(fetchMock.mock.calls[0][0]);
  expect(url.searchParams.get("status")).toBe("failure");
  expect(url.searchParams.get("per_page")).toBe("5");
  expect(url.searchParams.get("created")).toBe(`${range.since}..${range.until}`);
  expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: "error", headers: { Authorization: "Bearer private-token" } });
  expect(JSON.stringify(result)).not.toContain("private-token");
});

test("production history compares immutable SHAs and keeps partial status failures explicit", async () => {
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.pathname.endsWith("/deployments")) return Response.json([2, 1].map((id) => ({ id, environment: "production/us", ref: "main", sha: String(id).repeat(40), created_at: range.since })));
    if (url.pathname.includes("/2/statuses")) return Response.json([{ state: "success", log_url: "https://user:password@example.com/log" }]);
    return new Response("private server error", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchMock);
  const result = await loadCardDetails({ kind: "production", repository: range.repository, environment: "production/us" }, "token", signal());
  expect(new URL(fetchMock.mock.calls[0][0]).searchParams.get("environment")).toBe("production/us");
  expect(cardDetailsOutput.parse(result).items).toMatchObject([
    { state: "success", url: "https://github.com/acme/widgets/deployments", compareUrl: `https://github.com/acme/widgets/compare/${"1".repeat(40)}...${"2".repeat(40)}` },
    { state: "unavailable", compareUrl: null },
  ]);
  expect(JSON.stringify(result)).not.toContain("private server error");
  expect(JSON.stringify(result)).not.toContain("password");
});

test("empty history remains empty and invalid intervals never make requests", async () => {
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ workflow_runs: [] }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await loadCardDetails(range, undefined, signal())).items).toEqual([]);
  fetchMock.mockClear();
  await expect(loadCardDetails({ ...range, since: range.until, until: range.since }, undefined, signal())).rejects.toThrow("Invalid statistics");
  await expect(loadCardDetails({ ...range, since: "2025-10-19T23:59:59.999Z" }, undefined, signal())).rejects.toThrow("Invalid statistics");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("failed queries and out-of-range GitHub data do not become empty successful results", async () => {
  const fetchMock = vi.fn().mockResolvedValueOnce(new Response("secret-token", { status: 403 })).mockResolvedValueOnce(Response.json({ workflow_runs: [{ id: 1, conclusion: "failure", created_at: "2026-10-18T00:00:00Z" }] }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(loadCardDetails(range, undefined, signal())).rejects.toThrow("GitHub returned 403");
  await expect(loadCardDetails(range, undefined, signal())).rejects.toThrow("outside the selected range");
});
