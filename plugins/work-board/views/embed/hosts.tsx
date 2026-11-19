import { useEffect, useState } from "react";
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
  useEffect(() => {
    host.element.setAttribute(HOST_READY_ATTRIBUTE, "true");
    return () => host.element.removeAttribute(HOST_READY_ATTRIBUTE);
  }, [host.element]);
  // bb scopes Work Board's stylesheet to nodes marked with its plugin id; the host node belongs to another plugin.
  return <div data-bb-plugin="work-board" className="h-full min-h-0"><ThreadBoard threadId={host.threadId} /></div>;
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
