import { useEffect, type RefObject } from "react";
import { GLOBAL_SETTING_LABELS } from "../shared/global-settings";

export const SETTINGS_MARKER = "data-work-board-settings";
const LABELS = Object.values(GLOBAL_SETTING_LABELS);
const HEADING = 'h2, h3, [role="heading"]';
// The host titles this plugin's settings page with the plugin's name (package.json bb.name) in an h1. Only the h1
// bounds the search: the host also heads the plugin's own settings block with the same name in an h3, below the list.
const PAGE_TITLE = "Work Board";
const TITLES = "h1";

/**
 * What bb's own flat list of Work Board's native fields occupies next to `root`: the list (with the wrappers that hold
 * nothing else) and its heading. The search never leaves this page's host section: the nearest ancestor of `root` that
 * holds the page title. Inside it, the nearest ancestor holding any of these labels owns a list only when every Work
 * Board label is in it exactly once. Otherwise (no title found, the list not rendered yet, another page sharing labels,
 * two copies) nothing is hidden.
 */
function nativeList(root: HTMLElement): HTMLElement[] {
  if (!root.isConnected) return [];
  const foreign = (element: Element) => root.contains(element) || element.closest(`[${SETTINGS_MARKER}]`) !== null;
  const title = (element: Element) => !foreign(element) && element.textContent?.trim() === PAGE_TITLE;
  let section: HTMLElement | null = root.parentElement;
  while (section && section !== document.body && !Array.from(section.querySelectorAll(TITLES)).some(title)) section = section.parentElement;
  if (!section || section === document.body) return [];
  const labelled = Array.from(section.querySelectorAll<HTMLElement>("[aria-label]"))
    .filter((element) => LABELS.includes(element.getAttribute("aria-label")!) && !foreign(element));
  for (let scope = root.parentElement; scope && section.contains(scope); scope = scope.parentElement) {
    const inside = labelled.filter((element) => scope!.contains(element));
    const matches = LABELS.map((label) => inside.filter((element) => element.getAttribute("aria-label") === label));
    if (!matches.some((found) => found.length)) continue;
    if (matches.some((found) => found.length !== 1)) return [];
    const fields = matches.flat();
    let list: HTMLElement | null = fields[0]!.parentElement;
    while (list && !fields.every((field) => list!.contains(field))) list = list.parentElement;
    if (!list || list === scope || list.contains(root) || list.querySelector(`[${SETTINGS_MARKER}]`)) return [];
    // The host card around the list (its border and fill) goes too: only wrappers that hold nothing else.
    while (list.parentElement && list.parentElement !== scope && list.parentElement.children.length === 1) list = list.parentElement;
    // The section heading sits just before the list or its wrapper; found by place, so a localized heading is hidden too.
    let heading: HTMLElement | undefined;
    for (let node: HTMLElement | null = list, level = 0; node && node !== scope && !heading && level < 2; node = node.parentElement, level++) {
      const previous = node.previousElementSibling;
      const found = previous instanceof HTMLElement ? (previous.matches(HEADING) ? previous : previous.querySelector<HTMLElement>(HEADING)) : null;
      if (found && !foreign(found) && !title(found)) heading = found;
    }
    return heading ? [list, heading] : [list];
  }
  return [];
}

/**
 * Hides bb's flat "Configuration" list of Work Board's native fields while the grouped page is shown; the native fields
 * stay, so `bb plugin config work-board` keeps working. Each element gets back its exact `hidden` and inline `display`
 * once it is no longer the list, and on unmount.
 */
export function useHideNativeSettings(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const previous = new Map<HTMLElement, { hidden: boolean; display: string }>();
    const restore = (target: HTMLElement) => {
      const saved = previous.get(target)!;
      target.hidden = saved.hidden;
      target.style.display = saved.display;
      previous.delete(target);
    };
    const sync = () => {
      const targets = nativeList(element);
      for (const target of [...previous.keys()]) if (!targets.includes(target)) restore(target);
      for (const target of targets) {
        if (previous.has(target)) continue;
        previous.set(target, { hidden: target.hidden, display: target.style.display });
        target.hidden = true;
        target.style.display = "none";
      }
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const target of [...previous.keys()]) restore(target);
    };
  }, [root]);
}
