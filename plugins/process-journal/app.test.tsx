// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { methods, rpcContract, type Entry, type Proposal } from "./contract";
import { proposalPath } from "./paths";

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
const kept = { ...proposal, id: "proposal_kept", state: "kept" as const, title: "Keep the release checklist", checkAt: null };
function page(raw: unknown) {
  const input = methods.list.input.parse(raw);
  return {
    items: [
      { ...row, nextAt: proposal.checkAt!, overdue: true },
      { ...row, proposal: kept, nextAt: now, overdue: false },
    ].filter(item => !input.state || item.proposal.state === input.state),
    nextOffset: input.state === "measuring" && !input.offset ? 25 : null,
    timeZone: "UTC",
  };
}
const fixture = () => ({
  projects: () => [project],
  list: vi.fn(page),
  digest: () => ({ applied: 1, kept: 0, reverted: 0, overdue: 1 }),
  "proposal.detail": vi.fn(() => ({ ...row, nextBefore: null, links: [], managerReachable: true, measured: true,
    events: [{ seq: 1, at: now, actor: managerId, kind: "measurement:manual", message: "Manual observation",
      observation: { value: 0, note: "**Verified evidence**" }, unit: "misses" }] })),
  "proposal.update": vi.fn(() => ({ ...proposal, managerId: other, revision: 5 })),
  "proposal.transition": vi.fn(() => ({ ...proposal, state: "kept" as const, revision: 6 })),
});

it("opens the existing proposal URL as its own page with the entry, observations and revision-checked actions", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/${proposal.id}` }, { experimental_rpcContract: rpcContract, rpc });
  expect(await screen.findByRole("region", { name: "Proposal detail" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Status columns" })).toBeNull();
  expect(rpc.list).not.toHaveBeenCalled();
  expect(await screen.findByRole("heading", { name: entry.title })).toBeTruthy();
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

it("shows five stable columns and pages only the selected status", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: projectId }, { experimental_rpcContract: rpcContract, rpc });
  const columns = within(await screen.findByRole("region", { name: "Status columns" }));
  expect(columns.getAllByRole("heading").map(heading => heading.textContent))
    .toEqual(["Proposed", "Applied", "Measuring", "Kept", "Reverted"]);
  const measuring = within(columns.getByRole("region", { name: "Measuring" }));
  const card = await measuring.findByRole("link", { name: /Require approval.*Missed approval.*Overdue/ });
  expect(card.getAttribute("href")).toBe(proposalPath(projectId, proposal.id));
  expect(within(columns.getByRole("region", { name: "Kept" })).getByText("Last 3 months")).toBeTruthy();
  expect(await within(columns.getByRole("region", { name: "Kept" })).findByRole("link", { name: /Keep the release checklist/ })).toBeTruthy();
  expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ view: "history", range: "quarter", state: "kept" }));
  expect(await within(columns.getByRole("region", { name: "Applied" })).findByText("No proposals.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Proposal detail" })).toBeNull();
  expect(rpc["proposal.detail"]).not.toHaveBeenCalled();
  rpc.list.mockClear();
  fireEvent.click(measuring.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rpc.list).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    state: "measuring", view: "board", offset: 25,
  })));
  const pagedCard = await measuring.findByRole("link", { name: /Require approval/ });
  fireEvent.click(pagedCard);
  expect(screen.inspection.navigateCalls).toContainEqual({
    method: "toPluginPanel", path: "process-journal", options: { subPath: `${projectId}/${proposal.id}` },
  });
  const Journal = app.navPanels[0].component;
  const viewport = screen.getByRole("main");
  viewport.scrollTop = 320;
  screen.rerender(<Journal subPath={`${projectId}/${proposal.id}`} />);
  expect(viewport.scrollTop).toBe(0);
  expect(await screen.findByRole("heading", { name: "Timeline" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Status columns" })).toBeNull();
  const back = screen.getByRole("link", { name: "Back to board" });
  expect(back.getAttribute("href")).toBe(`/plugins/process-journal/process-journal/${projectId}`);
  expect(back.closest("header")?.classList.contains("sticky")).toBe(true);
  fireEvent.click(back);
  expect(screen.inspection.navigateCalls.at(-1)).toEqual({
    method: "toPluginPanel", path: "process-journal", options: { subPath: projectId },
  });
  rpc.list.mockClear();
  viewport.scrollTop = 480;
  screen.rerender(<Journal subPath={projectId} />);
  expect(viewport.scrollTop).toBe(0);
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ state: "measuring", offset: 25 })));
  rpc.list.mockClear();
  fireEvent.click(screen.getByRole("checkbox", { name: "Overdue only" }));
  expect(within(screen.getByRole("region", { name: "Kept" })).queryByRole("link")).toBeNull();
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ state: "measuring", overdue: true, offset: 0 })));
  expect(rpc.list).not.toHaveBeenCalledWith(expect.objectContaining({ state: "kept" }));
});

it("retains history filters on the way back from a proposal", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: "" }, { experimental_rpcContract: rpcContract, rpc });
  await screen.findByRole("button", { name: "History" });
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  fireEvent.change(screen.getByRole("combobox", { name: "Manager" }), { target: { value: managerId } });
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({
    projectId, managerId, view: "history", range: "quarter",
  })));
  fireEvent.change(screen.getByRole("combobox", { name: "Range" }), { target: { value: "month" } });
  fireEvent.click(await screen.findByRole("link", { name: /Require approval/ }));
  expect(screen.inspection.navigateCalls).toContainEqual({
    method: "toPluginPanel", path: "process-journal", options: { subPath: `${projectId}/${proposal.id}` },
  });
  const Journal = app.navPanels[0].component;
  screen.rerender(<Journal subPath={`${projectId}/${proposal.id}`} />);
  expect(await screen.findByRole("link", { name: "Back to history" })).toBeTruthy();
  rpc.list.mockClear();
  screen.rerender(<Journal subPath={projectId} />);
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({
    projectId, managerId, view: "history", range: "month",
  })));
});

it("reports an unavailable project without querying another project's proposal", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: `proj_missing/${proposal.id}` }, { experimental_rpcContract: rpcContract, rpc });
  expect((await screen.findByRole("alert")).textContent).toContain("This project is unavailable");
  expect(screen.getByRole("link", { name: "Back to Process Journal" })).toBeTruthy();
  expect(rpc.list).not.toHaveBeenCalled();
  expect(rpc["proposal.detail"]).not.toHaveBeenCalled();
});
