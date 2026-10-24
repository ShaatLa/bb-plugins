import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchProduction, productionTarget, productionWorkflowUrl } from "./production";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;

test("dispatches only Production on main and constructs its run link from the returned ID", async () => {
  fetchMock.mockResolvedValue(Response.json({ workflow_run_id: 123, html_url: "https://untrusted.example/" }));
  expect(await dispatchProduction("private-token", signal())).toEqual({ url: `https://github.com/${productionTarget.repository}/actions/runs/123` });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.github.com/repos/simple-life-app/anvil/actions/workflows/production.yaml/dispatches");
  expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-token" } });
  expect(JSON.parse(options!.body as string)).toEqual({ ref: "main" });
});

test("accepted requests without run details link to the workflow instead of inviting a duplicate retry", async () => {
  for (const response of [new Response(null, { status: 204 }), Response.json({ unexpected: true })]) {
    fetchMock.mockResolvedValueOnce(response);
    expect(await dispatchProduction("token", signal())).toEqual({ url: productionWorkflowUrl });
  }
});

test("missing authorization never sends a request", async () => {
  await expect(dispatchProduction(undefined, signal())).rejects.toThrow("Actions write");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("permission failures never expose GitHub response bodies", async () => {
  fetchMock.mockResolvedValue(new Response("private-token", { status: 403 }));
  await expect(dispatchProduction("token", signal())).rejects.toThrow("HTTP 403");
  await expect(dispatchProduction("token", signal())).rejects.not.toThrow("private-token");
});

test("unconfirmed requests are not retried and respect lifecycle cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  fetchMock.mockImplementation(async (_url, options) => { options?.signal?.throwIfAborted(); throw new Error("private-token"); });
  await expect(dispatchProduction("token", controller.signal)).rejects.toThrow("Check the Production workflow before retrying");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
