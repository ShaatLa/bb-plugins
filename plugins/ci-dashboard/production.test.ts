import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { dispatchProduction as dispatch, productionTargetFrom, productionWorkflowUrl } from "./production";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const target = { repository: "acme/widgets", workflow: "deploy.yaml", ref: "release" };
const dispatchProduction = (token: string | undefined, abort: AbortSignal) => dispatch(target, token, abort);

test("dispatches only the configured workflow and ref and constructs its run link from the returned ID", async () => {
  fetchMock.mockResolvedValue(Response.json({ workflow_run_id: 123, html_url: "https://untrusted.example/" }));
  expect(await dispatchProduction("private-token", signal())).toEqual({ url: `https://github.com/acme/widgets/actions/runs/123` });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe("https://api.github.com/repos/acme/widgets/actions/workflows/deploy.yaml/dispatches");
  expect(options).toMatchObject({ method: "POST", redirect: "error", headers: { Authorization: "Bearer private-token" } });
  expect(JSON.parse(options!.body as string)).toEqual({ ref: "release" });
});

test("accepted requests without run details link to the workflow instead of inviting a duplicate retry", async () => {
  for (const response of [new Response(null, { status: 204 }), Response.json({ unexpected: true })]) {
    fetchMock.mockResolvedValueOnce(response);
    expect(await dispatchProduction("token", signal())).toEqual({ url: productionWorkflowUrl(target) });
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
  await expect(dispatchProduction("token", controller.signal)).rejects.toThrow("Check the production workflow before retrying");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("the target needs both a repository and a workflow; the ref defaults to main", () => {
  expect(productionTargetFrom(undefined)).toBeNull();
  expect(productionTargetFrom({ productionRepository: "acme/widgets", productionWorkflow: " " })).toBeNull();
  expect(productionTargetFrom({ productionRepository: "", productionWorkflow: "deploy.yaml" })).toBeNull();
  expect(productionTargetFrom({ productionRepository: " acme/widgets ", productionWorkflow: "deploy.yaml", productionRef: "" })).toEqual({ repository: "acme/widgets", workflow: "deploy.yaml", ref: "main" });
});
