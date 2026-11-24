// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { tasksRpcContract } from "../shared/contract";
import { GLOBAL_SETTING_LABELS } from "../shared/global-settings";
import { SETTINGS_MARKER, useHideNativeSettings } from "./native-settings";

window.matchMedia ??= (media: string) => ({ matches: false, media, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView ??= () => {};
window.PointerEvent ??= window.MouseEvent as typeof PointerEvent;
Element.prototype.setPointerCapture ??= () => {};

const app = await loadPluginApp(() => import("../app"));
// jsdom has no activation behaviour: a focused native button turns Enter (on keydown) and Space (on keyup) into a click
// unless a handler cancelled the key event, as browsers do.
const press = (element: HTMLElement, key: "Enter" | " ") => {
  // Only a native button has that default action; anything else would pass here and fail in a browser.
  expect(element).toBeInstanceOf(HTMLButtonElement);
  expect(element.getAttribute("type")).toBe("button");
  expect(document.activeElement).toBe(element);
  const down = fireEvent.keyDown(element, { key });
  if (key === "Enter" && down) fireEvent.click(element);
  const up = fireEvent.keyUp(element, { key });
  if (key === " " && down && up) fireEvent.click(element);
};
afterEach(() => { cleanup(); document.body.innerHTML = ""; });

it("shows the three General cards with no project, and saves selects and switches through globalSettings.set with a save status", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    registerTasksApi(bb, createStore(bb));
    const settings = renderSlot(app.settingsSections[0]!, {}, {
      rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])),
      settings: { startScreen: "last-project-board", openThreadsIn: "bb", badgeOpen: true, badgeWaitingOnOwner: true, badgeInReview: false },
    });
    await settings.findByText("Create a project to configure its workflow.");
    // Groups are h2, cards h3; every General card is its own named region.
    expect(settings.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["General", "Project"]);
    const general = settings.getByRole("region", { name: "General" });
    expect(within(general).getAllByRole("region").map((node) => within(node).getAllByRole("heading", { level: 3 })[0]!.textContent))
      .toEqual(["Start and links", "Navigation badges", "Storage"]);
    for (const name of ["Start and links", "Navigation badges", "Storage"]) expect(within(general).getByRole("region", { name })).toBeTruthy();
    // Six labelled switches without the repeated prefix, read from the native values; what they count is said once.
    const badgeCard = within(general).getByRole("region", { name: "Navigation badges" });
    const badges = within(badgeCard).getAllByRole("switch");
    expect(badges.map((node) => node.getAttribute("aria-label"))).toEqual([
      "Open tasks", "Tasks waiting on you", "Tasks in review", "Tasks with unanswered questions", "Tasks with a failed thread", "Tasks with an idle thread and no update",
    ]);
    expect(badges.map((node) => node.getAttribute("aria-checked"))).toEqual(["true", "true", "false", "false", "false", "false"]);
    for (const node of badges) expect(node.hasAttribute("aria-describedby")).toBe(false);
    expect(badgeCard.textContent!.match(/counted in the Work Board navigation badge/g)).toHaveLength(1);
    // The focused switch toggles from the keyboard: Space, then Enter, one write each.
    const review = settings.getByRole("switch", { name: "Tasks in review" });
    const writes = () => settings.rpcCalls.filter((call) => call.method === "globalSettings.set").map((call) => call.input);
    review.focus();
    press(review, " ");
    await waitFor(() => expect(review.getAttribute("aria-checked")).toBe("true"));
    expect(writes()).toEqual([{ values: { badgeInReview: true } }]);
    await waitFor(() => expect(within(badgeCard).getByTestId("save-status").textContent).toBe("Saved"));
    await waitFor(() => expect(review.hasAttribute("disabled")).toBe(false));
    review.focus();
    press(review, "Enter");
    await waitFor(() => expect(review.getAttribute("aria-checked")).toBe("false"));
    expect(writes()).toEqual([{ values: { badgeInReview: true } }, { values: { badgeInReview: false } }]);
    fireEvent.click(settings.getByRole("combobox", { name: "Start screen" }));
    fireEvent.click(await settings.findByRole("option", { name: "All tasks" }));
    await waitFor(() => expect(settings.getByRole("combobox", { name: "Start screen" }).textContent).toContain("All tasks"));
    expect(settings.rpcCalls).toContainEqual({ method: "globalSettings.set", input: { values: { startScreen: "all" } } });
    await waitFor(() => expect(within(general.querySelector("section")!).getByTestId("save-status").textContent).toBe("Saved"));
    // The runner paths moved into Repository checks, so Storage ends General.
    expect(within(general).queryByLabelText("BB CLI absolute path")).toBeNull();
  } finally { cleanup(); await harness.dispose(); }
});

it("keeps the General write controls disabled until the native values have loaded", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
  try {
    registerTasksApi(bb, createStore(bb));
    // No values: the host is still loading them.
    const settings = renderSlot(app.settingsSections[0]!, {}, { rpc: Object.fromEntries(Object.keys(tasksRpcContract).map((method) => [method, (input: unknown) => harness.callRpc(method, input)])) });
    const general = within(await settings.findByRole("region", { name: "General" }));
    expect(general.getByRole("switch", { name: "Open tasks" }).hasAttribute("disabled")).toBe(true);
    expect(general.getByRole("combobox", { name: "Start screen" }).hasAttribute("disabled")).toBe(true);
    expect(settings.rpcCalls.some((call) => call.method === "globalSettings.set")).toBe(false);
  } finally { cleanup(); await harness.dispose(); }
});

// A stand-in for bb's flat list of native fields: one control per label, under a heading.
function nativeList(labels: string[] = Object.values(GLOBAL_SETTING_LABELS)) {
  const wrapper = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = "Configuration";
  const list = document.createElement("div");
  list.style.display = "flex";
  for (const label of labels) {
    const field = document.createElement("button");
    field.setAttribute("aria-label", label);
    list.appendChild(field);
  }
  wrapper.append(heading, list);
  return { wrapper, heading, list };
}
function Page() {
  const root = useRef<HTMLDivElement>(null);
  useHideNativeSettings(root);
  return <div ref={root} {...{ [SETTINGS_MARKER]: "" }}><button aria-label="Start screen" /></div>;
}
// A host settings page: the plugin's title, then (once rendered) the native list, then the plugin's own page.
const page = (name = "Work Board") => {
  const section = document.body.appendChild(document.createElement("section"));
  const title = section.appendChild(document.createElement("h1"));
  title.textContent = name;
  const mount = section.appendChild(document.createElement("div"));
  return { section, mount, title };
};
const shown = (element: HTMLElement) => !element.hidden && element.style.display !== "none";

it("hides only Work Board's native list in its own settings section, including one rendered later", async () => {
  // Another plugin's page shares six of the ten labels; it is never hidden, before or after Work Board's list appears.
  const other = page("Example Plugin");
  const foreign = nativeList([...Object.values(GLOBAL_SETTING_LABELS).slice(0, 6), "Language"]);
  other.section.appendChild(foreign.wrapper);
  const own = page();
  render(<Page />, { container: own.mount });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(shown(foreign.list)).toBe(true);
  const native = nativeList();
  own.section.insertBefore(native.wrapper, own.mount);
  await waitFor(() => expect(shown(native.list)).toBe(false));
  expect(shown(native.heading)).toBe(false);
  expect(shown(foreign.list)).toBe(true);
  expect(shown(foreign.heading)).toBe(true);
  expect(shown(own.title)).toBe(true);
});

it("hides the list when the host also heads the plugin's own block with the plugin name in an h3", async () => {
  // The host page: h1 title, the native list, then a block headed by an h3 with the same name around the plugin view.
  const own = page();
  const native = nativeList();
  own.section.insertBefore(native.wrapper, own.mount);
  const block = own.mount.appendChild(document.createElement("div"));
  block.appendChild(document.createElement("h3")).textContent = "Work Board";
  render(<Page />, { container: block.appendChild(document.createElement("div")) });
  await waitFor(() => expect(shown(native.list)).toBe(false));
  expect(shown(native.heading)).toBe(false);
  expect(shown(own.title)).toBe(true);
});

it("never leaves its own host section: a complete list in a sibling page stays visible, and without the page title nothing is hidden", async () => {
  const sibling = page("Example Plugin");
  const complete = nativeList();
  sibling.section.appendChild(complete.wrapper);
  const own = page();
  render(<Page />, { container: own.mount });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(shown(complete.list)).toBe(true);
  expect(shown(complete.heading)).toBe(true);
  cleanup();
  document.body.innerHTML = "";
  // No title to bound the search: even its own complete list stays visible.
  const untitled = document.body.appendChild(document.createElement("section"));
  const list = nativeList();
  untitled.appendChild(list.wrapper);
  render(<Page />, { container: untitled.appendChild(document.createElement("div")) });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(shown(list.list)).toBe(true);
});

it("leaves an ambiguous list visible, follows a host rerender, and restores the exact prior state on unmount", async () => {
  const own = page();
  const first = nativeList();
  const second = nativeList();
  own.section.append(first.wrapper, second.wrapper);
  const view = render(<Page />, { container: own.mount });
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Every label is found twice: nothing is hidden.
  expect(shown(first.list) && shown(second.list)).toBe(true);
  // The host rerenders to a single list: it is hidden; a replaced list is restored and its successor hidden.
  second.wrapper.remove();
  await waitFor(() => expect(shown(first.list)).toBe(false));
  const replacement = nativeList();
  first.wrapper.replaceWith(replacement.wrapper);
  await waitFor(() => expect(shown(replacement.list)).toBe(false));
  expect(first.list.hidden).toBe(false);
  expect(first.list.style.display).toBe("flex");
  view.unmount();
  expect(replacement.list.hidden).toBe(false);
  expect(replacement.list.style.display).toBe("flex");
  expect(shown(replacement.heading)).toBe(true);
});
