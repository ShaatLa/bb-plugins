// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScheduleBlock } from "./schedule-block";

const calls: [string, unknown][] = [];
let handlers: Record<string, (input: any) => unknown> = {};
const rpc = { call: async (method: string, input: unknown) => { calls.push([method, input]); const handler = handlers[method]; if (!handler) throw new Error(`no handler ${method}`); return handler(input); } };
const opened: string[] = [];
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_Icon: () => null,
  experimental_ProviderModelPicker: ({ value, onChange, className }: { value: { providerId: string; model: string; reasoningLevel: string }; onChange: (value: unknown) => void; className?: string }) => (
    <div data-testid="picker" className={className}>
      <button type="button" onClick={() => onChange({ ...value, providerId: "codex", model: "gpt-5", reasoningLevel: "high" })}>Pick codex gpt-5</button>
      <span>{value.providerId}/{value.model}</span>
    </div>
  ),
}));
vi.mock("../../components/open-thread", () => ({ useOpenThread: () => (id: string) => { opened.push(id); } }));
vi.mock("../../components/queue-chip", () => ({ useThreadName: (id: string) => `Name of ${id}` }));
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
    scheduleOptions: () => ({ mode: "spawn_gate", defaultArgs: "--card {key} --role impl", presets: [] }),
  };
});
afterEach(cleanup);
const block = (start?: Record<string, unknown>) => render(<ScheduleBlock taskId="t1" projectId="proj_t" taskKey="EXA-1" start={start as never} />);

it("shows the scheduled start with its mode, args and setter, and cancels it", async () => {
  block({ at: AT, mode: "spawn_gate", state: "scheduled", setter: "thr_setter" });
  expect((await screen.findByText(/· Spawn Gate$/)).textContent).toContain("Spawn Gate");
  expect(screen.getByText(/--card EXA-1 --role impl · set by/)).toBeTruthy();
  expect(screen.getByText("Name of thr_setter").getAttribute("title")).toBe("thr_setter");
  expect(screen.getByText(/set by/).textContent).toMatch(/set by Name of thr_setter$/);
  const cancel = screen.getByRole("button", { name: "Cancel scheduled start" });
  expect(cancel.title).toBe("Cancel scheduled start");
  fireEvent.click(cancel);
  await waitFor(() => expect(calls).toContainEqual(["cancelScheduledStart", { taskId: "t1", actor: "owner" }]));
});

it("changes the time and the launch in one request, and shows a refusal inline without closing the form", async () => {
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
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
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
  handlers.checkScheduledStart = () => ({ ok: false, error: "no scope section", reasonCode: "missing_required_sections" });
  fireEvent.click(await screen.findByRole("button", { name: "Check" }));
  expect((await screen.findByRole("alert")).textContent).toContain("missing_required_sections: no scope section");
});

it("cannot be saved when the launch policy could not be read", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  handlers.scheduleOptions = () => ({ mode: null, error: "could not read the Spawn Gate launch policy (timeout); try again", defaultArgs: "", presets: [] });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Schedule a start" }));
  expect((await screen.findByRole("alert")).textContent).toContain("could not read the Spawn Gate launch policy");
  fireEvent.change(screen.getByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  expect((screen.getByRole("button", { name: "Schedule" }) as HTMLButtonElement).disabled).toBe(true);
});

it("needs a provider and model in a project without Spawn Gate, and sends the agent with the brief", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  handlers.scheduleOptions = () => ({ mode: "preset", defaultArgs: "", presets: [] });
  handlers.scheduleStart = () => ({ scheduledStart: info({ mode: "preset", agent: { providerId: "codex", model: "gpt-5" } }) });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Schedule a start" }));
  fireEvent.change(await screen.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  expect(screen.queryByLabelText("Preset")).toBeNull();
  expect(screen.queryByLabelText("Launch arguments")).toBeNull();
  expect((screen.getByRole("button", { name: "Schedule" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Pick codex gpt-5" }));
  fireEvent.change(screen.getByLabelText("Permission mode"), { target: { value: "full" } });
  fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Run the checks." } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(calls.find(([method]) => method === "scheduleStart")?.[1]).toMatchObject({ taskId: "t1", actor: "owner", launch: { kind: "agent", providerId: "codex", model: "gpt-5", reasoningLevel: "high", permissionMode: "full", brief: "Run the checks." } }));
});

it("shows an agent start as provider, model and reasoning on one line, and keeps Spawn Gate's form for a gate project", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ mode: "preset", builderArgs: undefined, brief: "Night run", agent: { providerId: "codex", model: "gpt-5", reasoningLevel: "high" } }) });
  block();
  expect((await screen.findByText(/· codex · gpt-5 · high$/)).textContent).toContain("codex · gpt-5 · high");
  expect(screen.getByText(/Night run · set by/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Change scheduled start" }));
  expect(await screen.findByLabelText("Launch arguments")).toBeTruthy();
  expect(screen.queryByTestId("picker")).toBeNull();
});

it("keeps a legacy preset start when only its time is changed, and replaces it only by choosing an agent", async () => {
  const legacy = info({ mode: "preset", builderArgs: undefined, presetId: "p1", presetName: "Night worker", brief: "Old brief" });
  handlers.getScheduledStart = () => ({ scheduledStart: legacy });
  handlers.scheduleOptions = () => ({ mode: "preset", defaultArgs: "", presets: [] });
  handlers.changeScheduledStart = () => ({ scheduledStart: legacy });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
  expect(await screen.findByText("Preset Night worker, kept")).toBeTruthy();
  expect(screen.queryByTestId("picker")).toBeNull();
  fireEvent.change(await screen.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.find(([method]) => method === "changeScheduledStart")).toBeTruthy());
  const [, sent] = calls.find(([method]) => method === "changeScheduledStart")!;
  expect(sent).toMatchObject({ launch: { kind: "preset", presetId: "p1", brief: "Old brief" } });
  expect(JSON.stringify(sent)).not.toContain("agent");
  // Choosing an agent instead replaces the preset.
  calls.length = 0;
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
  fireEvent.click(await screen.findByRole("button", { name: "Use an agent instead" }));
  expect(screen.getByTestId("picker")).toBeTruthy();
  expect(screen.queryByText("Preset Night worker, kept")).toBeNull();
  fireEvent.change(await screen.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  expect((screen.getByRole("button", { name: "Save change" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Pick codex gpt-5" }));
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.find(([method]) => method === "changeScheduledStart")?.[1]).toMatchObject({ launch: { kind: "agent", providerId: "codex", model: "gpt-5" } }));
});

it("shows the empty Start row with its add icon, and fits its form inside a narrow card", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  block();
  expect(await screen.findByText("None")).toBeTruthy();
  const add = screen.getByRole("button", { name: "Schedule a start" });
  expect(add.title).toBe("Schedule a start");
  fireEvent.click(add);
  const form = await screen.findByLabelText("Start time").then((field) => field.closest("[data-start-later]")!);
  // Nothing keeps a fixed width: every field fills the card and may shrink, labels wrap with their fields, hints break anywhere.
  expect(form.className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  expect(screen.getByLabelText("Start time").className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  expect(screen.getByLabelText("Start time").closest("label")!.className).toContain("flex-wrap");
  expect(screen.getByText("your time zone").className).toContain("[overflow-wrap:anywhere]");
  expect(screen.getByText(/Nothing is sent to the session before it starts/).className).toContain("[overflow-wrap:anywhere]");
  expect(screen.getByLabelText("Launch arguments").className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
});

it("shows a launched session, and a refused or unknown start with its error and the resolve command", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ state: "launched", threadId: "thr_launched" }) });
  const first = block();
  const link = await screen.findByText("Name of thr_launched");
  expect(link.getAttribute("title")).toBe("thr_launched");
  fireEvent.click(link);
  expect(opened).toEqual(["thr_launched"]);
  expect(screen.queryByText("thr_launched")).toBeNull();
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
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
  fireEvent.change(await screen.findByLabelText("Start time"), { target: { value: "2099-01-01T02:00" } });
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.find(([method]) => method === "changeScheduledStart")).toBeTruthy());
  expect(calls.find(([method]) => method === "changeScheduledStart")![1]).toMatchObject({ launch: { kind: "gate", args } });
});

it("parses an edited args field, keeping quoted arguments whole", async () => {
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
  fireEvent.change(await screen.findByLabelText("Launch arguments"), { target: { value: "--reason 'night run' --card EXA-1" } });
  handlers.changeScheduledStart = () => ({ scheduledStart: info() });
  fireEvent.click(screen.getByRole("button", { name: "Save change" }));
  await waitFor(() => expect(calls.find(([method]) => method === "changeScheduledStart")?.[1]).toMatchObject({ launch: { kind: "gate", args: ["--reason", "night run", "--card", "EXA-1"] } }));
});

it("reads the owner as the owner, not as an id", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ setter: "owner" }) });
  block();
  expect((await screen.findByText(/set by the owner/)).textContent).toContain("set by the owner");
});
