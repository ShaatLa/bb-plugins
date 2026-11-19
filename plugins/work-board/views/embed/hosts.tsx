import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ThreadBoard } from "./index.js";

/**
 * Another plugin's UI asks for Work Board's board by rendering an empty
 * `<div data-work-board-host="board" data-thread-id="thr_…">`. Work Board fills it from its own app
 * overlay, so the board keeps Work Board's RPC, realtime and navigation, and sets
 * `data-work-board-ready="true"` on the node once it has rendered.
 */
export const HOST_ATTRIBUTE = "data-work-board-host";
export const HOST_THREAD_ATTRIBUTE = "data-thread-id";
export const HOST_READY_ATTRIBUTE = "data-work-board-ready";
/** Asks the host to open a web link in its own surface; the host calls preventDefault when it did. */
export const HOST_OPEN_URL_EVENT = "work-board:open-url";
const THREAD_ID = /^thr_[A-Za-z0-9_-]+$/;

type Host = { element: HTMLElement; threadId: string };

function findHosts(): Host[] {
  return [...document.querySelectorAll<HTMLElement>(`[${HOST_ATTRIBUTE}="board"]`)].flatMap((element) => {
    const threadId = element.getAttribute(HOST_THREAD_ATTRIBUTE) ?? "";
    return THREAD_ID.test(threadId) ? [{ element, threadId }] : [];
  });
}

const sameHosts = (a: Host[], b: Host[]) =>
  a.length === b.length && a.every((host, index) => host.element === b[index]!.element && host.threadId === b[index]!.threadId);

function HostedBoard({ host }: { host: Host }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    host.element.setAttribute(HOST_READY_ATTRIBUTE, "true");
    return () => host.element.removeAttribute(HOST_READY_ATTRIBUTE);
  }, [host.element]);
  // The overlay sits outside any bb surface, so bb's openUrl would fall back to the external browser;
  // every web link click, from Markdown, BbLink or the editor, goes to the host's surface instead.
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      const url = anchor && element.contains(anchor) ? anchor.getAttribute("href") ?? "" : "";
      if (!/^https?:\/\//i.test(url)) return;
      const request = new CustomEvent(HOST_OPEN_URL_EVENT, { bubbles: true, cancelable: true, detail: { url } });
      element.dispatchEvent(request);
      if (!request.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("click", onClick, true);
    return () => element.removeEventListener("click", onClick, true);
  }, []);
  // bb scopes Work Board's stylesheet to nodes marked with its plugin id; the host node belongs to another plugin.
  return <div ref={root} data-bb-plugin="work-board" className="h-full min-h-0"><ThreadBoard threadId={host.threadId} /></div>;
}

let nextHostKey = 0;
const hostKeys = new WeakMap<HTMLElement, number>();
const hostKey = (element: HTMLElement) => {
  if (!hostKeys.has(element)) hostKeys.set(element, nextHostKey++);
  return String(hostKeys.get(element));
};

export function WorkBoardHosts() {
  const [hosts, setHosts] = useState<Host[]>([]);
  useEffect(() => {
    let frame: number | null = null;
    const scan = () => {
      frame = null;
      const next = findHosts();
      setHosts((current) => (sameHosts(current, next) ? current : next));
    };
    scan();
    // Chat streaming mutates the page constantly: rescan at most once per frame.
    const observer = new MutationObserver(() => { frame ??= requestAnimationFrame(scan); });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [HOST_ATTRIBUTE, HOST_THREAD_ATTRIBUTE] });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return <>{hosts.map((host) => createPortal(<HostedBoard key={host.threadId} host={host} />, host.element, hostKey(host.element)))}</>;
}
