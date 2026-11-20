// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useOpenThread } from "./open-thread";

const { toThread, list, settings } = vi.hoisted(() => ({ toThread: vi.fn(), list: vi.fn(), settings: { current: {} as Record<string, string> } }));
vi.mock("@get-bb/plugin-sdk/app", () => ({
  useBbNavigate: () => ({ toThread }),
  useSdk: () => ({ plugins: { list } }),
  useSettings: () => ({ values: settings.current, isLoading: false }),
}));
let clock = Date.now();
// Each test starts past the one-minute cache so it reads its own plugin list.
beforeEach(() => { clock += 120_000; vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(clock); });
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

function Open() {
  const openThread = useOpenThread();
  return <button type="button" onClick={() => openThread("thr_example")}>Open</button>;
}
function mount() {
  const clicked: string[] = [];
  render(<div data-bb-plugin-root="" data-bb-plugin="work-board" onClick={(event) => {
    const link = (event.target as Element).closest("a");
    if (link) { event.preventDefault(); clicked.push(link.getAttribute("href")!); }
  }}><Open /></div>);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  return clicked;
}

it.each<Record<string, string>>([{}, { openThreadsIn: "answers" }])("opens bb chat by default and for a value no longer offered (%j)", (values) => {
  settings.current = values;
  expect(mount()).toEqual([]);
  expect(toThread).toHaveBeenCalledWith("thr_example");
  expect(list).not.toHaveBeenCalled();
});

it("opens the conversation in Agent Hub through a link bb routes, and falls back to bb chat without it", async () => {
  settings.current = { openThreadsIn: "agent-hub" };
  list.mockResolvedValue({ plugins: [{ id: "agent-hub", enabled: true }] });
  const clicked = mount();
  await waitFor(() => expect(clicked).toEqual(["/plugins/agent-hub/agent-hub?thread=thr_example"]));
  expect(toThread).not.toHaveBeenCalled();
  expect(document.querySelector("a")).toBeNull();

  vi.setSystemTime(clock += 120_000);
  cleanup();
  list.mockResolvedValue({ plugins: [{ id: "agent-hub", enabled: false }] });
  expect(mount()).toEqual([]);
  await waitFor(() => expect(toThread).toHaveBeenCalledWith("thr_example"));
});
