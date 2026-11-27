// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScheduleBlock } from "./schedule-block";

const calls: [string, unknown][] = [];
let handlers: Record<string, (input: any) => unknown> = {};
const rpc = { call: async (method: string, input: unknown) => { calls.push([method, input]); const handler = handlers[method]; if (!handler) throw new Error(`no handler ${method}`); return handler(input); } };
vi.mock("../../components/open-thread", () => ({ useOpenThread: () => vi.fn() }));
vi.mock("../../shell/data", async () => {
  const React = await import("react");
  return {
    useTasksRpc: () => rpc,
    useTasksQuery: (fetcher: (client: typeof rpc) => Promise<unknown>, _channels: unknown, deps: unknown[] = []) => {
      const [state, setState] = React.useState<{ data?: unknown; error: string | null }>({ error: null });
      const run = React.useCallback(async () => { try { setState({ data: await fetcher(rpc), error: null }); } catch (cause) { setState({ error: String(cause) }); } }, deps);
      React.useEffect(() => { void run(); }, [run]);
      return { data: state.data, isLoading: state.data === undefined && !state.error, isFetching: false, error: state.error, refresh: run };
    },
  };
});

const AT = new Date(Date.now() + 3 * 3_600_000).toISOString();
const info = (extra: Record<string, unknown> = {}) => ({ id: "s1", taskId: "t1", at: AT, mode: "spawn_gate", state: "scheduled", setter: "thr_setter", builderArgs: ["--card", "EXA-1", "--role", "impl"], ...extra });
beforeEach(() => {
  calls.length = 0;
  handlers = {
    getScheduledStart: () => ({ scheduledStart: info() }),
    scheduleOptions: () => ({ mode: "spawn_gate", defaultArgs: "--card {key} --role impl", presets: [{ id: "p1", name: "Night worker" }] }),
  };
});
afterEach(cleanup);
const block = (start?: Record<string, unknown>) => render(<ScheduleBlock taskId="t1" projectId="proj_t" taskKey="EXA-1" start={start as never} />);

it("shows the scheduled start with its mode, args and setter, and cancels it", async () => {
  block({ at: AT, mode: "spawn_gate", state: "scheduled", setter: "thr_setter" });
  expect(await screen.findByText(/Spawn Gate: --card EXA-1 --role impl/)).toBeTruthy();
  expect(screen.getByText(/set by thr_setter/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(calls).toContainEqual(["cancelScheduledStart", { taskId: "t1", actor: "owner" }]));
});

it("changes the time and the launch in one request, and shows a refusal inline without closing the form", async () => {
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  fireEvent.change(await screen.findByLabelText("Launch arguments"), { target: { value: "--card EXA-1 --role check" } });
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  handlers.changeScheduledStart = () => { throw new Error("The builder refuses these arguments (no_scope)"); };
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  expect((await screen.findByRole("alert")).textContent).toContain("no_scope");
  expect(screen.getByLabelText("Launch arguments")).toBeTruthy();
  handlers.changeScheduledStart = () => ({ scheduledStart: info() });
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.filter(([method]) => method === "changeScheduledStart")).toHaveLength(2));
  const [, input] = calls.filter(([method]) => method === "changeScheduledStart").at(-1)!;
  expect(input).toMatchObject({ taskId: "t1", actor: "owner", launch: { kind: "gate", args: ["--card", "EXA-1", "--role", "check"] } });
  expect((input as { at: string }).at).toBe(new Date("2099-01-01T02:00").toISOString());
});

it("checks the builder's arguments and shows its refusal inline", async () => {
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  handlers.checkScheduledStart = () => ({ ok: false, error: "no scope section", reasonCode: "missing_required_sections" });
  fireEvent.click(await screen.findByRole("button", { name: "Check" }));
  expect((await screen.findByRole("alert")).textContent).toContain("missing_required_sections: no scope section");
});

it("cannot be saved when the launch policy could not be read", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  handlers.scheduleOptions = () => ({ mode: null, error: "could not read the Spawn Gate launch policy (timeout); try again", defaultArgs: "", presets: [] });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Schedule a start…" }));
  expect((await screen.findByRole("alert")).textContent).toContain("could not read the Spawn Gate launch policy");
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  expect((screen.getByRole("button", { name: "Schedule" }) as HTMLButtonElement).disabled).toBe(true);
});

it("needs a preset in a project without Spawn Gate, and sends it with the brief", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  handlers.scheduleOptions = () => ({ mode: "preset", defaultArgs: "", presets: [{ id: "p1", name: "Night worker" }] });
  handlers.scheduleStart = () => ({ scheduledStart: info({ mode: "preset", presetId: "p1" }) });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Schedule a start…" }));
  fireEvent.change(await screen.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  expect((screen.getByRole("button", { name: "Schedule" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "p1" } });
  fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Run the checks." } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(calls.find(([method]) => method === "scheduleStart")?.[1]).toMatchObject({ taskId: "t1", actor: "owner", launch: { kind: "preset", presetId: "p1", brief: "Run the checks." } }));
});

it("shows a launched session, and a refused or unknown start with its error and the resolve command", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ state: "launched", threadId: "thr_launched" }) });
  const first = block();
  expect(await screen.findByText("thr_launched")).toBeTruthy();
  first.unmount();
  handlers.getScheduledStart = () => ({ scheduledStart: info({ state: "unknown", error: "request timed out" }) });
  block();
  expect((await screen.findByRole("status")).textContent).toContain("Start outcome unknown: request timed out");
  expect(screen.getByText(/schedule resolve EXA-1/)).toBeTruthy();
});

it("keeps stored args byte for byte when only the time is changed", async () => {
  const args = ["--reason", "night run", "", 'a"b', "c\\d", "it's", "--card", "EXA-1"];
  handlers.getScheduledStart = () => ({ scheduledStart: info({ builderArgs: args }) });
  handlers.changeScheduledStart = () => ({ scheduledStart: info({ builderArgs: args }) });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  fireEvent.change(await screen.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.find(([method]) => method === "changeScheduledStart")).toBeTruthy());
  expect(calls.find(([method]) => method === "changeScheduledStart")![1]).toMatchObject({ launch: { kind: "gate", args } });
});

it("parses an edited args field, keeping quoted arguments whole", async () => {
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change" }));
  fireEvent.change(await screen.findByLabelText("Launch arguments"), { target: { value: "--reason 'night run' --card EXA-1" } });
  handlers.changeScheduledStart = () => ({ scheduledStart: info() });
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.find(([method]) => method === "changeScheduledStart")?.[1]).toMatchObject({ launch: { kind: "gate", args: ["--reason", "night run", "--card", "EXA-1"] } }));
});
