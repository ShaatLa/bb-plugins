// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { rpcContract, type Entry, type Proposal } from "./contract";

afterEach(cleanup);
const app = await loadPluginApp(() => import("./app"));
const projectId = "proj_example", managerId = "thr_example", other = "thr_other";
const now = Date.now();
const project = { id: projectId, name: "Example project", timeZone: "UTC",
  managers: [{ id: managerId, name: "Release manager", reachable: true }, { id: other, name: "Quality manager", reachable: true }] };
const entry: Entry = { id: "entry_example", projectId, title: "Missed approval", failure: "No approval before release",
  gap: "The checklist accepted a pending approval", links: [], createdAt: now, createdBy: managerId };
const proposal: Proposal = { id: "proposal_example", entryId: entry.id, projectId, title: "Require approval", hypothesis: "Require review before release",
  rollbackCondition: "Review time exceeds the limit", links: [], metric: { definition: "Count misses", unit: "misses", baseline: 2, target: 0 },
  managerId, state: "measuring", checkAt: now - 10000, deadlineAt: now - 2000, revision: 4, obligation: 3, createdAt: now, updatedAt: now };
const row = { entry, proposal };
const fixture = () => ({
  projects: () => [project],
  list: vi.fn(() => ({ items: [{ ...row, nextAt: proposal.checkAt!, overdue: true }], nextOffset: null, timeZone: "UTC" })),
  digest: () => ({ applied: 1, kept: 0, reverted: 0, overdue: 1 }),
  "proposal.detail": () => ({ ...row, nextBefore: null, links: [], managerReachable: true, measured: true,
    events: [{ seq: 1, at: now, actor: managerId, kind: "measurement:manual", message: "Manual observation",
      observation: { value: 0, note: "**Verified evidence**" }, unit: "misses" }] }),
  "proposal.update": vi.fn(() => ({ ...proposal, managerId: other, revision: 5 })),
  "proposal.transition": vi.fn(() => ({ ...proposal, state: "kept" as const, revision: 6 })),
});

it("renders an Entry column, overdue proposal, metric and timeline, and sends owner actions with revisions", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/${proposal.id}` }, { experimental_rpcContract: rpcContract, rpc });
  expect(await screen.findByRole("region", { name: "Proposal detail" })).toBeTruthy();
  expect(await screen.findByRole("button", { name: /Require approval.*Overdue/ })).toBeTruthy();
  expect(await screen.findByRole("heading", { name: "Timeline" })).toBeTruthy();
  expect(screen.getAllByText("0 misses")).toHaveLength(2);
  expect(screen.getByText(/Verified evidence/)).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox", { name: "Assigned manager" }), { target: { value: other } });
  await waitFor(() => expect(rpc["proposal.update"]).toHaveBeenCalledWith(expect.objectContaining({
    projectId, proposalId: proposal.id, revision: 4, patch: { managerId: other },
  })));
  fireEvent.click(screen.getByRole("button", { name: "Keep" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Reason" }), { target: { value: "The metric met its target" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirm keep" }));
  await waitFor(() => expect(rpc["proposal.transition"]).toHaveBeenCalledWith(expect.objectContaining({
    proposalId: proposal.id, revision: 4, transition: { state: "kept", reason: "The metric met its target" },
  })));
});

it("scopes the history query to a manager and defaults to the three-month window", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: "" }, { experimental_rpcContract: rpcContract, rpc });
  await screen.findByRole("button", { name: "History" });
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Manager" }), { target: { value: managerId } });
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({
    projectId, managerId, view: "history", range: "quarter",
  })));
});
