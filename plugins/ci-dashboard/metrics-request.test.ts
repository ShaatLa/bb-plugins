import { afterEach, expect, it, vi } from "vitest";
import { githubRequest } from "./metrics";

const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([new DOMException("timeout", "TimeoutError"), new TypeError("fetch failed"), new Response(null, { status: 503 })])("retries transient failures", async (failure) => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementationOnce(() => failure instanceof Response ? Promise.resolve(failure) : Promise.reject(failure)).mockResolvedValue(new Response('{}'));
  vi.stubGlobal("fetch", fetcher);
  const result = githubRequest("/test", undefined, signal());
  await vi.runAllTimersAsync();
  await expect(result).resolves.toMatchObject({ body: {} });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([401, 404])("does not retry %s", async (status) => {
  const fetcher = vi.fn().mockResolvedValue(new Response(null, { status }));
  vi.stubGlobal("fetch", fetcher);
  await expect(githubRequest("/test", undefined, signal())).rejects.toThrow(`GitHub returned ${status}`);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("honours Retry-After", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503, headers: { 'Retry-After': '5' } })).mockResolvedValue(new Response('{}'));
  vi.stubGlobal("fetch", fetcher);
  const result = githubRequest("/test", undefined, signal());
  await vi.advanceTimersByTimeAsync(4999);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  await result;
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("prioritizes interactive waiters", async () => {
  const releases: (() => void)[] = [];
  const paths: string[] = [];
  vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((resolve) => { paths.push(url); releases.push(() => resolve(new Response('{}'))); })));
  const requests = Array.from({ length: 4 }, () => githubRequest('/busy', undefined, signal()));
  const background = githubRequest('/background', undefined, signal());
  const interactive = githubRequest('/interactive', undefined, signal(), undefined, undefined, { interactive: true });
  releases[0]!();
  await vi.waitFor(() => expect(paths[4]).toContain('/interactive'));
  releases.slice(1).forEach((release) => release());
  await vi.waitFor(() => expect(paths).toHaveLength(6));
  releases[5]!();
  await Promise.all([...requests, background, interactive]);
});

it("keeps a failure local to its load", async () => {
  const { loadMetrics } = await import('./metrics');
  const failure = new TypeError('fetch failed');
  const request = vi.fn().mockRejectedValue(failure);
  await loadMetrics('acme/widgets', undefined, signal(), undefined, undefined, undefined, { request });
  const other = vi.fn().mockResolvedValue({ body: {}, hasNext: false });
  await loadMetrics('acme/widgets', undefined, signal(), undefined, undefined, undefined, { request: other });
  expect(request).toHaveBeenCalled();
  expect(other).toHaveBeenCalled();
});

it("a permission 403 never blocks other callers, even though GitHub sends x-ratelimit-reset", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403, headers: { 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3000) } })).mockResolvedValue(new Response('{}'));
  vi.stubGlobal("fetch", fetcher);
  await expect(githubRequest('/forbidden', undefined, signal())).rejects.toThrow('GitHub returned 403');
  await githubRequest('/other', undefined, signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("blocks all callers until the rate limit resets", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '61' } })).mockResolvedValue(new Response('{}'));
  vi.stubGlobal("fetch", fetcher);
  await expect(githubRequest('/test', undefined, signal())).rejects.toThrow('GitHub rate limit reached');
  await expect(githubRequest('/other', undefined, signal())).rejects.toThrow('GitHub rate limit reached');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(61_000);
  await githubRequest('/other', undefined, signal());
  expect(fetcher).toHaveBeenCalledTimes(2);
});

