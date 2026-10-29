import { draftSettingLabels } from "./draft-deferrals";

// Decorate host-owned settings without moving their React-owned field nodes.
export function mountDraftSettingsDisclosure(signal: AbortSignal) {
  let cleanup: (() => void) | undefined;
  let control: HTMLButtonElement | undefined;
  function sync() {
    if (signal.aborted || control?.isConnected) return;
    cleanup?.();
    const inputs = Object.values(draftSettingLabels).map((label) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`));
    if (inputs.some((input) => !input)) return;
    let parent = inputs[0]!.parentElement;
    while (parent && !inputs.every((input) => parent!.contains(input))) parent = parent.parentElement;
    if (!parent || parent === document.body) return;
    const rows = inputs.map((input) => {
      let row: HTMLElement = input!;
      while (row.parentElement !== parent) row = row.parentElement!;
      return row;
    });
    if (new Set(rows).size !== 3) return;
    const previous = rows.map((row) => ({ display: row.style.display, cssText: row.style.cssText, id: row.id }));
    control = document.createElement("button");
    const button = control;
    button.type = "button";
    button.className = "flex w-full items-center gap-2 rounded-md py-2 text-left text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
    Object.assign(button.style, { border: "1px solid var(--border)", padding: "12px 16px" });
    rows.forEach((row, index) => {
      row.id ||= `ci-dashboard-draft-setting-${index}`;
      Object.assign(row.style, {
        padding: "12px 16px", marginBlockStart: "0", marginBlockEnd: "0",
        borderInlineStart: "1px solid var(--border)", borderInlineEnd: "1px solid var(--border)",
        borderBlockStart: "1px solid var(--border)",
        ...(index === rows.length - 1 ? { borderBlockEnd: "1px solid var(--border)", borderRadius: "0 0 8px 8px", marginBlockEnd: "16px" } : {}),
      });
    });
    button.setAttribute("aria-controls", rows.map((row) => row.id).join(" "));
    function show(open: boolean) {
      button.setAttribute("aria-expanded", String(open));
      button.textContent = `${open ? "▾" : "▸"} Draft deferral`;
      button.style.borderRadius = open ? "8px 8px 0 0" : "8px";
      button.style.borderBottomWidth = open ? "0" : "1px";
      button.style.marginBlockEnd = open ? "0" : "";
      rows.forEach((row, index) => { row.style.display = open ? previous[index].display : "none"; });
    }
    const toggle = () => show(button.getAttribute("aria-expanded") !== "true");
    button.addEventListener("click", toggle);
    parent.insertBefore(button, rows[0]);
    show(false);
    cleanup = () => {
      button.removeEventListener("click", toggle);
      button.remove();
      rows.forEach((row, index) => { row.style.cssText = previous[index].cssText; row.id = previous[index].id; });
      control = undefined;
      cleanup = undefined;
    };
  }
  const observer = new MutationObserver(sync);
  observer.observe(document.body, { childList: true, subtree: true });
  sync();
  const dispose = () => { observer.disconnect(); cleanup?.(); signal.removeEventListener("abort", dispose); };
  signal.addEventListener("abort", dispose, { once: true });
  return dispose;
}
