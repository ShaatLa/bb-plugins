// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen as documentScreen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { afterEach, expect, it, vi } from "vitest";
import { configSchema, methods, rpcContract, type Entry, type Proposal, type ReviewRound, type ReviewSummary } from "./contract";
import { hiddenColumnsPath, proposalPath, reviewRunsPath } from "./paths";
import { defaultColumns } from "./status-display";
import type { BoardColumnDisplay } from "./board-display-contract";

Element.prototype.scrollIntoView ??= () => {};

afterEach(cleanup);

async function openSelect(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return within(await documentScreen.findByRole("listbox"));
}

async function selectOption(trigger: HTMLElement, name: string) {
  fireEvent.click((await openSelect(trigger)).getByRole("option", { name }));
}
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
const review: ReviewSummary = { reviewerId: "thr_reviewer", generation: 1, legacy: false,
  hypothesis: { version: 1, status: "approved" }, result: { version: 1, status: "approved" } };
const kept = { ...proposal, id: "proposal_kept", state: "kept" as const, title: "Keep the release checklist", checkAt: null };
function page(raw: unknown) {
  const input = methods.list.input.parse(raw);
  return {
    items: [
      { ...row, nextAt: proposal.checkAt!, overdue: true, review },
      { ...row, proposal: kept, nextAt: now, overdue: false },
    ].filter(item => !input.state || item.proposal.state === input.state),
    nextOffset: input.state === "measuring" && !input.offset ? 25 : null,
    timeZone: "UTC",
    ...(input.withTotal ? { total: input.state === "measuring" ? 26 : 1 } : {}),
  };
}
const fixture = () => ({
  projects: () => [project],
  "config.get": vi.fn(() => ({ revision: 0, columns: null as BoardColumnDisplay[] | null })),
  list: vi.fn(page),
  digest: () => ({ applied: 1, kept: 0, reverted: 0, overdue: 1 }),
  "proposal.detail": vi.fn(() => ({ ...row, nextBefore: null, links: [], managerReachable: true, measured: true, review,
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
  const failure = within(await screen.findByRole("region", { name: "Process failure" }));
  expect(failure.getByRole("heading", { name: entry.title })).toBeTruthy();
  expect(failure.getByRole("heading", { name: "Process gap" })).toBeTruthy();
  const fix = within(screen.getByRole("region", { name: "Fix hypothesis" }));
  expect(fix.getByRole("heading", { name: "Rollback condition" })).toBeTruthy();
  const metrics = within(screen.getByRole("region", { name: "Metric history" }));
  expect(metrics.getAllByText("0 misses")).toHaveLength(2);
  expect(metrics.getByText(/Verified evidence/)).toBeTruthy();
  const timeline = within(screen.getByRole("region", { name: "Timeline" }));
  expect(timeline.getByRole("textbox", { name: "Comment" })).toBeTruthy();
  await selectOption(screen.getByRole("combobox", { name: "Assigned manager" }), "Quality manager");
  await waitFor(() => expect(rpc["proposal.update"]).toHaveBeenCalledWith(expect.objectContaining({
    projectId, proposalId: proposal.id, revision: 4, patch: { managerId: other },
  })));
  fireEvent.click(within(screen.getByRole("region", { name: "Decision" })).getByRole("button", { name: "Keep" }));
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
  expect(within(card).getByText("Result · Approved")).toBeTruthy();
  expect(within(columns.getByRole("region", { name: "Kept" })).getByText("Last 3 months")).toBeTruthy();
  expect(await within(columns.getByRole("region", { name: "Kept" })).findByRole("link", { name: /Keep the release checklist/ })).toBeTruthy();
  expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ view: "history", range: "quarter", state: "kept" }));
  const empty = await within(columns.getByRole("region", { name: "Applied" })).findByText("No proposals.");
  expect(empty.parentElement?.classList.contains("bg-muted/35")).toBe(false);
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
  expect(back.textContent).not.toContain("Back to board");
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
  await selectOption(screen.getByRole("combobox", { name: "Manager" }), "Release manager");
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({
    projectId, managerId, view: "history", range: "quarter",
  })));
  await selectOption(screen.getByRole("combobox", { name: "Range" }), "Last month");
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

it("explains automatic review runs and shows their outcomes separately from the proposal digest", async () => {
  const rpc = {
    ...fixture(),
    "run.list": vi.fn().mockReturnValueOnce({ items: [], nextOffset: null }).mockReturnValue({
      items: [{
        id: "run_example", projectId, managerId, skill: "process-journal", occurrence: "2026-11-27",
        createdAt: now, status: "completed", finishedAt: now + 1000, delayed: false,
        note: "Reviewed two open proposals.",
      }],
      nextOffset: null,
    }),
  };
  const screen = renderSlot(app.navPanels[0], { subPath: projectId }, { experimental_rpcContract: rpcContract, rpc });
  fireEvent.click(await screen.findByRole("button", { name: "Review runs" }));
  const runs = within(screen.getByRole("region", { name: "Review runs" }));
  expect(runs.getByText(/automatic proposal reviews/)).toBeTruthy();
  expect(await runs.findByText("No review runs to show.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Weekly digest" })).toBeNull();
  await selectOption(screen.getByRole("combobox", { name: "Manager" }), "Release manager");
  expect(await runs.findByText("Completed")).toBeTruthy();
  expect(runs.getByText("Reviewed two open proposals.")).toBeTruthy();
  expect(runs.getByText("run_example")).toBeTruthy();
  expect(rpc["run.list"]).toHaveBeenLastCalledWith(expect.objectContaining({ projectId, managerId }));
});

it("opens and pages a hidden Measuring column and returns to its list from detail", async () => {
  const columns = defaultColumns.map(column => column.id === "measuring"
    ? { ...column, name: "Collecting evidence", visible: false, icon: "Clock" as const, color: "steelblue" as const } : column);
  const rpc = fixture();
  rpc["config.get"].mockReturnValue({ revision: 1, columns });
  const screen = renderSlot(app.navPanels[0], { subPath: projectId }, { experimental_rpcContract: rpcContract, rpc });
  const hidden = await screen.findByRole("link", { name: "Hidden columns" });
  expect(screen.queryByRole("region", { name: "Collecting evidence" })).toBeNull();
  expect(hidden.getAttribute("href")).toBe(hiddenColumnsPath(projectId));
  const Journal = app.navPanels[0].component;
  screen.rerender(<Journal subPath={`${projectId}/board/hidden`} />);
  const measuring = within(await screen.findByRole("region", { name: "Collecting evidence" }));
  expect(await measuring.findByText("26 proposals")).toBeTruthy();
  expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ state: "measuring", view: "board", withTotal: true }));
  fireEvent.click(measuring.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(rpc.list).toHaveBeenCalledWith(expect.objectContaining({ withTotal: true, offset: 25 })));
  const card = await measuring.findByRole("link", { name: /Require approval/ });
  expect(card.getAttribute("href")).toBe(hiddenColumnsPath(projectId, proposal.id));
  screen.rerender(<Journal subPath={`${projectId}/board/hidden/${proposal.id}`} />);
  expect((await screen.findByRole("link", { name: "Back to hidden columns" })).getAttribute("href")).toBe(hiddenColumnsPath(projectId));
  expect(await screen.findByText("Collecting evidence")).toBeTruthy();
  screen.rerender(<Journal subPath={`${projectId}/board/hidden`} />);
  await waitFor(() => expect(rpc.list).toHaveBeenLastCalledWith(expect.objectContaining({ state: "measuring", offset: 25 })));
});

it("updates column order on the project event and falls back to defaults after a display read fails", async () => {
  const rpc = fixture();
  const screen = renderSlot(app.navPanels[0], { subPath: projectId }, { experimental_rpcContract: rpcContract, rpc });
  const board = within(await screen.findByRole("region", { name: "Status columns" }));
  expect(board.getAllByRole("heading")[0]?.textContent).toBe("Proposed");
  const first = { ...defaultColumns[4]!, name: "Rolled back", icon: "X" as const, color: "indianred" as const };
  rpc["config.get"].mockReturnValue({ revision: 1, columns: [first, ...defaultColumns.slice(0, -1)] });
  await screen.behavior.emitRealtime("journal:changed", { projectId });
  expect(await board.findByRole("heading", { name: "Rolled back" })).toBeTruthy();
  expect(board.getAllByRole("heading")[0]?.textContent).toBe("Rolled back");
  const mark = within(board.getByRole("region", { name: "Rolled back" })).getByRole("heading").previousElementSibling;
  expect(mark?.querySelector('[data-icon="X"]')).toBeTruthy();
  expect((mark as HTMLElement).style.color).toBe("indianred");
  rpc["config.get"].mockImplementationOnce(() => { throw new Error("Display unavailable"); });
  await screen.behavior.emitRealtime("journal:changed", { projectId });
  expect(await board.findByRole("heading", { name: "Reverted" })).toBeTruthy();
  expect(board.getAllByRole("heading")[0]?.textContent).toBe("Proposed");
});

it("keeps hidden closed statuses filterable in History even when all board columns are hidden", async () => {
  const rpc = fixture();
  rpc["config.get"].mockReturnValue({ revision: 1, columns: defaultColumns.map(column => ({
    ...column, visible: false, name: column.id === "kept" ? "Retained" : column.name,
  })) });
  const screen = renderSlot(app.navPanels[0], { subPath: projectId }, { experimental_rpcContract: rpcContract, rpc });
  expect(await screen.findByText("All board columns are hidden.")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open Process Journal settings" }).getAttribute("href"))
    .toBe("/settings/plugins/process-journal");
  expect(screen.getByRole("link", { name: "Hidden columns" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  const options = await openSelect(screen.getByRole("combobox", { name: "Status" }));
  expect(options.getByRole("option", { name: "Withdrawn" })).toBeTruthy();
  fireEvent.click(options.getByRole("option", { name: "Retained" }));
  await waitFor(() => expect(rpc.list).toHaveBeenLastCalledWith(expect.objectContaining({ view: "history", state: "kept" })));
});

it("autosaves ordered status edits and keeps a conflicting draft until reload", async () => {
  const rpc = fixture();
  let finishFirst!: (result: unknown) => void;
  const configSet = vi.fn().mockReturnValueOnce(new Promise(resolve => { finishFirst = resolve; })).mockReturnValueOnce({
    ok: false, code: "board_display_conflict", current: { revision: 2, columns: defaultColumns },
  }).mockReturnValueOnce({ ok: true, revision: 3, columns: null });
  const screen = renderSlot(app.settingsSections[0], {}, {
    experimental_rpcContract: rpcContract, rpc: { ...rpc, "config.set": configSet,
      "config.get": request => methods["config.get"].input.parse(request).key === "boardDisplay" ? rpc["config.get"]() : configSchema.parse({}) },
  });
  const name = await screen.findByRole("textbox", { name: "Measuring name" }) as HTMLInputElement;
  const statuses = within(screen.getByRole("region", { name: "Statuses" }));
  expect(statuses.queryByRole("button", { name: "Save" })).toBeNull();
  fireEvent.change(name, { target: { value: " " } });
  fireEvent.blur(name);
  expect((await statuses.findByRole("alert")).textContent).toContain("1–64 characters");
  expect(configSet).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "Collecting evidence" } });
  expect(configSet).not.toHaveBeenCalled();
  name.focus();
  fireEvent.keyDown(name, { key: "Enter" });
  const named = defaultColumns.map(column => column.id === "measuring" ? { ...column, name: "Collecting evidence" } : column);
  await waitFor(() => expect(configSet).toHaveBeenCalledExactlyOnceWith({
    projectId, key: "boardDisplay", value: { expectedRevision: 0, columns: named },
  }));
  const icon = statuses.getByRole("combobox", { name: "Measuring icon" });
  await selectOption(icon, "Clock");
  expect(icon.querySelector('[data-icon="Clock"]')).toBeTruthy();

  const color = statuses.getByRole("button", { name: "Measuring color" });
  fireEvent.click(color);
  const palette = within(await documentScreen.findByRole("dialog", { name: "Measuring color" }));
  expect(palette.getByRole("button", { name: "Default", pressed: true })).toBeTruthy();
  fireEvent.click(palette.getByRole("button", { name: "Blue" }));
  expect((color.querySelector("span") as HTMLElement).style.color).toBe("steelblue");
  fireEvent.click(screen.getByRole("checkbox", { name: "Show Measuring on board" }));
  const rows = within(screen.getByRole("region", { name: "Statuses" })).getByRole("list");
  rows.getBoundingClientRect = () => new DOMRect(0, 0, 640, 220);
  within(rows).getAllByRole("listitem").forEach((row, index) => {
    row.getBoundingClientRect = () => new DOMRect(0, index * 44, 640, 44);
  });
  const grip = screen.getByRole("button", { name: "Reorder Measuring" });
  grip.focus();
  fireEvent.keyDown(grip, { key: " ", code: "Space" });
  await act(() => new Promise(resolve => setTimeout(resolve, 0)));
  fireEvent.keyDown(grip, { key: "ArrowUp", code: "ArrowUp" });
  fireEvent.keyDown(grip, { key: " ", code: "Space" });
  expect(configSet).toHaveBeenCalledTimes(1);
  await act(async () => { finishFirst({ ok: true, revision: 1, columns: named }); });
  expect((await statuses.findByRole("alert")).textContent).toMatch(/another window/i);
  expect(name.value).toBe("Collecting evidence");
  expect(configSet).toHaveBeenLastCalledWith({ projectId, key: "boardDisplay", value: { expectedRevision: 1, columns: [
    defaultColumns[0], { ...defaultColumns[2], name: "Collecting evidence", visible: false, icon: "Clock", color: "steelblue" },
    defaultColumns[1], ...defaultColumns.slice(3),
  ] } });
  rpc["config.get"].mockReturnValue({ revision: 2, columns: defaultColumns });
  fireEvent.click(statuses.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(name.value).toBe("Measuring"));
  fireEvent.click(statuses.getByRole("button", { name: "Restore defaults" }));
  await waitFor(() => expect(configSet).toHaveBeenLastCalledWith({
    projectId, key: "boardDisplay", value: { expectedRevision: 2, columns: null },
  }));
});

it("shows the pinned review evidence and disables Keep while the verdict is pending", async () => {
  const rpc = fixture();
  const round: ReviewRound = {
    projectId, proposalId: proposal.id, version: 1, generation: 1, reviewerId: "thr_reviewer",
    submittedBy: managerId, submittedAt: now, hash: "example", status: "pending",
    feedback: null, verdict: null, decidedAt: null, delivery: "sent",
    snapshot: { stage: "result", hypothesisVersion: 1, hypothesisHash: "example-hash", experiment: { title: proposal.title, links: [],
      entry: { id: entry.id, title: entry.title, failure: entry.failure, gap: entry.gap, links: entry.links },
      hypothesis: proposal.hypothesis, metric: proposal.metric, rollbackCondition: proposal.rollbackCondition },
    conclusion: "The observed checklist improved", observations: [{ seq: 1, at: now,
      observation: { note: "The checklist was followed", evidence: ["https://example.com/report"] } }] },
  };
  const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/${proposal.id}` }, {
    experimental_rpcContract: rpcContract, rpc: { ...rpc, "proposal.detail": () => ({
      ...rpc["proposal.detail"](), review: { ...review, result: { version: 1, status: "pending" } }, reviewRounds: [round],
    }) },
  });
  const panel = within(await screen.findByRole("region", { name: "Independent review" }));
  expect(panel.getByText("@thread:thr_reviewer")).toBeTruthy();
  const trigger = panel.getByText("Result v1 · Awaiting reviewer").closest("summary")!;
  expect(trigger.parentElement?.hasAttribute("open")).toBe(false);
  fireEvent.click(trigger);
  expect(trigger.parentElement?.hasAttribute("open")).toBe(true);
  expect(panel.getByText(/@thread:thr_example submitted .* · Reviewer @thread:thr_reviewer/)).toBeTruthy();
  expect(panel.getByText("The observed checklist improved")).toBeTruthy();
  expect(panel.getByText("The checklist was followed")).toBeTruthy();
  expect(panel.getByText("https://example.com/report").getAttribute("href")).toBe("https://example.com/report");
  const button = within(screen.getByRole("region", { name: "Decision" })).getByRole("button", { name: "Keep" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
});

it.each(["proposed", "applied", "kept"] as const)("offers only the eligible date controls for %s", async state => {
  const rpc = fixture();
  const draft = { ...proposal, state, checkAt: null };
  rpc["proposal.detail"].mockImplementation(() => ({
    ...row, proposal: draft, nextBefore: null, links: [], managerReachable: true, measured: false, review, events: [],
  }));
  const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/${proposal.id}` }, { experimental_rpcContract: rpcContract, rpc });
  await screen.findByRole("heading", { name: proposal.title });
  if (state === "kept") {
    expect(screen.queryByRole("button", { name: "Edit deadline" })).toBeNull();
  } else {
    const trigger = screen.getByRole("button", { name: "Edit deadline" });
    expect(trigger.querySelector('[data-icon="Edit"]')).toBeTruthy();
    fireEvent.click(trigger);
    const editor = within(await documentScreen.findByRole("dialog", { name: "Deadline calendar" }));
    expect(editor.getByLabelText("Deadline time")).toBeTruthy();
    expect(editor.queryByRole("button", { name: "Measurement check" })).toBeNull();
    expect(editor.queryByRole("button", { name: "Save dates" })).toBeNull();
  }
});

it("saves gap and overlap times as epoch values in one revision-checked proposal edit", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-01T00:00:00Z"));
  try {
    const rpc = fixture();
    const local = { ...project, timeZone: "America/New_York" };
    const initial = { ...proposal, checkAt: Date.parse("2026-03-07T20:00:00.123Z"), deadlineAt: Date.parse("2026-11-02T15:00:00Z") };
    const linkedCard = { taskId: "task_example", key: "EXA-1", status: "Done", dueDate: "2026-03-07",
      deadlineSource: true, syncedCheckAt: initial.checkAt, syncedDueDate: "2026-03-07", conflict: false };
    const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/${proposal.id}` }, { experimental_rpcContract: rpcContract, rpc: {
      ...rpc, projects: () => [local], "proposal.detail": () => ({ ...rpc["proposal.detail"](), proposal: initial, links: [linkedCard] }),
    } });
    const trigger = await screen.findByRole("button", { name: "Edit deadline" });
    fireEvent.click(trigger);
    const editor = within(await documentScreen.findByRole("dialog", { name: "Deadline calendar" }));
    expect(editor.getByText(/America\/New_York/)).toBeTruthy();
    fireEvent.click(editor.getByRole("button", { name: "November 1, 2026" }));
    fireEvent.change(editor.getByLabelText("Deadline time"), { target: { value: "01:30" } });
    fireEvent.click(editor.getByRole("button", { name: "Measurement check" }));
    fireEvent.click(editor.getByRole("button", { name: "March 8, 2026" }));
    fireEvent.change(editor.getByLabelText("Measurement check time"), { target: { value: "02:30" } });
    expect(editor.getByText("Resolves to 2026-03-08 03:00.")).toBeTruthy();
    expect(editor.getByText(/next reconciliation/)).toBeTruthy();
    expect(rpc["proposal.update"]).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    await waitFor(() => expect(rpc["proposal.update"]).toHaveBeenCalledExactlyOnceWith({
      projectId, proposalId: proposal.id, revision: proposal.revision, patch: {
        checkAt: Date.parse("2026-03-08T07:00:00Z"), deadlineAt: Date.parse("2026-11-01T05:30:00Z"),
      },
    }));
  } finally { clock.mockRestore(); }
});

it("keeps invalid drafts, rejects stale revisions and preserves an untouched check", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-03-01T00:00:00Z"));
  try {
    const rpc = fixture();
    let current = { ...proposal, checkAt: Date.parse("2026-04-01T10:30:42.123Z"), deadlineAt: Date.parse("2026-04-05T13:30:55.123Z") };
    const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/${proposal.id}` }, { experimental_rpcContract: rpcContract, rpc: {
      ...rpc, "proposal.detail": () => ({ ...rpc["proposal.detail"](), proposal: current }),
    } });
    const trigger = await screen.findByRole("button", { name: "Edit deadline" });
    fireEvent.click(trigger);
    const getEditor = async () => within(await documentScreen.findByRole("dialog", { name: "Deadline calendar" }));
    let editor = await getEditor();
    fireEvent.click(editor.getByRole("button", { name: "April 1, 2026" }));
    fireEvent.change(editor.getByLabelText("Deadline time"), { target: { value: "10:00" } });
    fireEvent.click(trigger);
    expect((await screen.findByRole("alert")).textContent).toContain("must be before");
    expect(rpc["proposal.update"]).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    editor = await getEditor();
    expect(editor.getByRole("button", { name: "April 1, 2026", pressed: true })).toBeTruthy();
    fireEvent.click(editor.getByRole("button", { name: "April 6, 2026" }));
    current = { ...current, revision: current.revision + 1, deadlineAt: Date.parse("2026-04-07T13:30:55.123Z") };
    await screen.behavior.emitRealtime("journal:changed", { projectId });
    fireEvent.click(trigger);
    expect((await screen.findByRole("alert")).textContent).toContain("Proposal dates changed");
    expect(rpc["proposal.update"]).not.toHaveBeenCalled();
    fireEvent.click(trigger);
    editor = await getEditor();
    expect(editor.getByRole("button", { name: "April 7, 2026", pressed: true })).toBeTruthy();
    fireEvent.click(editor.getByRole("button", { name: "April 8, 2026" }));
    fireEvent.change(editor.getByLabelText("Deadline time"), { target: { value: "10:00" } });
    fireEvent.click(trigger);
    await waitFor(() => expect(rpc["proposal.update"]).toHaveBeenCalledExactlyOnceWith({
      projectId, proposalId: proposal.id, revision: current.revision, patch: { deadlineAt: Date.parse("2026-04-08T10:00:00Z") },
    }));
  } finally { clock.mockRestore(); }
});

it("uses existing config writes for schedule time, skill, and the enabled flag", async () => {
  const configSet = vi.fn((request: unknown) => methods["config.set"].input.parse(request).value);
  const screen = renderSlot(app.settingsSections[0], {}, { experimental_rpcContract: rpcContract, rpc: {
    projects: () => [project],
    "config.get": request => methods["config.get"].input.parse(request).key === "boardDisplay" ? { revision: 0, columns: null } : configSchema.parse({
      enabled: true, defaultManager: managerId, managers: [managerId], scheduleTime: "02:00",
    }),
    "config.set": configSet,
  } });
  const section = within(await screen.findByRole("region", { name: "Self-compound" }));
  const enable = await section.findByRole("button", { name: "Enable scheduled runs" }) as HTMLButtonElement;
  expect(enable.disabled).toBe(true);
  expect(section.getByText("Release manager")).toBeTruthy();
  expect(section.getByRole("link", { name: "Review runs" }).getAttribute("href")).toBe(reviewRunsPath(projectId));
  fireEvent.change(section.getByLabelText("Daily local time"), { target: { value: "03:30" } });
  fireEvent.click(section.getByRole("button", { name: "Save time" }));
  await waitFor(() => expect(configSet).toHaveBeenCalledWith({ projectId, key: "scheduleTime", value: "03:30" }));
  fireEvent.change(section.getByLabelText("Project skill"), { target: { value: "example-compound" } });
  fireEvent.click(section.getByRole("button", { name: "Save skill" }));
  await waitFor(() => expect(enable.disabled).toBe(false));
  expect(section.getByText(/queue the latest eligible run immediately/)).toBeTruthy();
  fireEvent.click(enable);
  const disable = await section.findByRole("button", { name: "Disable scheduled runs" }) as HTMLButtonElement;
  await waitFor(() => expect(disable.disabled).toBe(false));
  fireEvent.click(disable);
  expect((await section.findByRole("status")).textContent).toBe("Self-compound disabled.");
  expect(configSet.mock.calls.map(([call]) => call)).toEqual([
    { projectId, key: "scheduleTime", value: "03:30" }, { projectId, key: "scheduleSkill", value: "example-compound" },
    { projectId, key: "scheduleEnabled", value: true }, { projectId, key: "scheduleEnabled", value: false },
  ]);
});

it("ignores a late schedule read from another project and explains the missing run manager", async () => {
  const second = { ...project, id: "proj_other", name: "Other example", managers: [] };
  let resolveFirst!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveFirst = resolve; });
  const screen = renderSlot(app.settingsSections[0], {}, { experimental_rpcContract: rpcContract, rpc: {
    projects: () => [project, second],
    "config.get": request => methods["config.get"].input.parse(request).key === "boardDisplay" ? { revision: 0, columns: null }
      : methods["config.get"].input.parse(request).projectId === projectId ? pending : configSchema.parse({ scheduleTime: "05:00", scheduleSkill: "example-compound" }),
  } });
  await selectOption(await screen.findByRole("combobox", { name: "Project" }), second.name);
  expect(await screen.findByDisplayValue("05:00")).toBeTruthy();
  await act(async () => { resolveFirst(configSchema.parse({ scheduleTime: "08:00", defaultManager: managerId })); });
  expect(screen.queryByDisplayValue("08:00")).toBeNull();
  expect((screen.getByRole("button", { name: "Enable scheduled runs" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText("Unassigned")).toBeTruthy();
});

it("opens Review runs directly for the configured project", async () => {
  const rpc = { ...fixture(), "run.list": vi.fn(() => ({ items: [], nextOffset: null })) };
  const screen = renderSlot(app.navPanels[0], { subPath: `${projectId}/review/runs` }, { experimental_rpcContract: rpcContract, rpc });
  expect(await screen.findByText("No review runs to show.")).toBeTruthy();
  expect(rpc["run.list"]).toHaveBeenCalledWith(expect.objectContaining({ projectId }));
});
