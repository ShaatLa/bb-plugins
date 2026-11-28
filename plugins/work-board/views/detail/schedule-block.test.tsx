// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ScheduleBlock } from "./schedule-block";

const calls: [string, unknown][] = [];
let handlers: Record<string, (input: any) => unknown> = {};
const rpc = { call: async (method: string, input: unknown) => { calls.push([method, input]); const handler = handlers[method]; if (!handler) throw new Error(`no handler ${method}`); return handler(input); } };
const opened: string[] = [];
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_Icon: () => null,
  experimental_useProviders: () => ({ status: "ready", providers: [{ id: "codex", logoUrl: "/logo/codex" }] }),
  experimental_ProviderIcon: ({ provider }: { provider: { id: string; logoUrl?: string } }) => <span data-testid="provider-icon" data-provider={provider.id} data-logo={provider.logoUrl ?? ""} />,
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

const TIME = new Date(AT).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

it("shows a Spawn Gate start as its time and Spawn Gate only, with the setter in the tooltip, and cancels it", async () => {
  block({ at: AT, mode: "spawn_gate", state: "scheduled", setter: "thr_setter" });
  const section = await screen.findByRole("region", { name: "Start" });
  await screen.findByText("Spawn Gate");
  expect(screen.getByText(TIME)).toBeTruthy();
  // Neither the builder's args nor the setter are on the card; the row's tooltip carries who set it.
  expect(section.textContent).not.toContain("--card");
  expect(section.textContent).not.toContain("set by");
  expect(screen.getByTitle("set by Name of thr_setter")).toBeTruthy();
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
  expect(screen.queryByLabelText("Brief")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "+ Brief" }));
  fireEvent.change(screen.getByLabelText("Brief"), { target: { value: "Run the checks." } });
  fireEvent.click(screen.getByRole("button", { name: "Schedule" }));
  await waitFor(() => expect(calls.find(([method]) => method === "scheduleStart")?.[1]).toMatchObject({ taskId: "t1", actor: "owner", launch: { kind: "agent", providerId: "codex", model: "gpt-5", reasoningLevel: "high", permissionMode: "full", brief: "Run the checks." } }));
});

it("shows an agent start in two lines: the time, then the provider icon, model and reasoning, with no brief, setter or permissions", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ mode: "preset", builderArgs: undefined, brief: "Night run\nsecond line", agent: { providerId: "codex", model: "gpt-5", reasoningLevel: "high", permissionMode: "full" } }) });
  block();
  const section = await screen.findByRole("region", { name: "Start" });
  await screen.findByText("gpt-5 · high");
  expect(screen.getByText(TIME)).toBeTruthy();
  const icon = screen.getByTestId("provider-icon");
  expect(icon.getAttribute("data-provider")).toBe("codex");
  expect(icon.getAttribute("data-logo")).toBe("/logo/codex");
  expect(section.textContent).not.toMatch(/Night run|set by|full|Full/);
  expect(screen.getByTitle("set by Name of thr_setter · Night run")).toBeTruthy();
  expect(section.querySelectorAll("[data-schedule-block] > div:nth-child(2) > div > div")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Change scheduled start" }));
  expect(await screen.findByLabelText("Launch arguments")).toBeTruthy();
  expect(screen.queryByTestId("picker")).toBeNull();
});

it("falls back to the provider id for its icon when the host does not list the provider", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ mode: "preset", builderArgs: undefined, agent: { providerId: "other", model: "m1" } }) });
  block();
  await screen.findByText("m1");
  expect(screen.getByTestId("provider-icon").getAttribute("data-provider")).toBe("other");
  expect(screen.getByTestId("provider-icon").getAttribute("data-logo")).toBe("");
});

it("shows a legacy preset start as Preset <name>", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: info({ mode: "preset", builderArgs: undefined, presetId: "p1", presetName: "Night worker" }) });
  block();
  expect(await screen.findByText("Preset Night worker")).toBeTruthy();
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

it("shows the empty Start section with its add icon, and a form without hint texts that fits a narrow card", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  block();
  const section = await screen.findByRole("region", { name: "Start" });
  expect(within(section).getByText("None")).toBeTruthy();
  const add = screen.getByRole("button", { name: "Schedule a start" });
  expect(add.title).toBe("Schedule a start");
  fireEvent.click(add);
  const form = await screen.findByLabelText("Start time").then((field) => field.closest("[data-start-later]")!);
  // One field per line, none with a fixed width.
  expect(form.className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  for (const field of [screen.getByLabelText("Start time"), screen.getByLabelText("Launch arguments")]) expect(field.className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  expect(form.querySelector("label")).toBeNull();
  for (const hint of [/your time zone/, /Nothing is sent to the session/, /Launch arguments \(/, /builder checks these arguments/, /default environment/, /Agent: provider/]) expect(screen.queryByText(hint)).toBeNull();
  expect(screen.getByLabelText("Launch arguments").title).toBe("{key} is the card key");
  expect((screen.getByLabelText("Launch arguments") as HTMLInputElement).placeholder).toBe("--card {key} --role impl");
  expect(screen.getByRole("button", { name: "Check" })).toBeTruthy();
});

it("keeps the agent form to the picker, the permissions and a brief behind + Brief, and opens it when the start has a brief", async () => {
  handlers.getScheduledStart = () => ({ scheduledStart: null });
  handlers.scheduleOptions = () => ({ mode: "preset", defaultArgs: "", presets: [] });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Schedule a start" }));
  const form = await screen.findByLabelText("Start time").then((field) => field.closest("[data-start-later]")!);
  expect(form.querySelector("label")).toBeNull();
  expect(within(form as HTMLElement).getByTestId("picker").className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  expect(screen.getByLabelText("Permission mode").className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  for (const hint of [/Agent: provider/, /default environment/, /Nothing is sent/, /your time zone/]) expect(screen.queryByText(hint)).toBeNull();
  expect(screen.queryByLabelText("Brief")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "+ Brief" }));
  expect(screen.getByLabelText("Brief").className).toMatch(/\bw-full\b.*\bmin-w-0\b/);
  expect(screen.queryByRole("button", { name: "+ Brief" })).toBeNull();
  cleanup();
  handlers.getScheduledStart = () => ({ scheduledStart: info({ mode: "preset", builderArgs: undefined, brief: "Old brief", agent: { providerId: "codex", model: "gpt-5" } }) });
  block();
  fireEvent.click(await screen.findByRole("button", { name: "Change scheduled start" }));
  expect((await screen.findByLabelText("Brief") as HTMLTextAreaElement).value).toBe("Old brief");
  expect(screen.queryByRole("button", { name: "+ Brief" })).toBeNull();
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
  expect(await screen.findByTitle("set by the owner")).toBeTruthy();
});
