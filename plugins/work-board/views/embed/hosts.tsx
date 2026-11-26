import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TASK_TAB, ThreadBoard, type OpenTaskRequest } from "./index.js";
import { TASK_LINK } from "../../components/task-link-interceptor.js";

/**
 * Another plugin's UI asks for Work Board's board by rendering an empty
 * `<div data-work-board-host="board" data-thread-id="thr_…">`. Work Board fills it from its own app
 * overlay, so the board keeps Work Board's RPC, realtime and navigation, and sets
 * `data-work-board-ready="true"` on the node once it has rendered.
 *
 * The host may ask for one task with `data-task-key="EXA-1"` and a counter it bumps on every request,
 * `data-task-request="<n>"`; `data-task-view="plan"` asks for that task's plan instead. Work Board shows it when a
 * host mounts with a request and whenever the request changes; removing the attributes is no request, never a
 * navigation. Work Board never writes them.
 */
export const HOST_ATTRIBUTE = "data-work-board-host";
export const HOST_THREAD_ATTRIBUTE = "data-thread-id";
export const HOST_READY_ATTRIBUTE = "data-work-board-ready";
/** Asks the host to open a web link in its own surface; the host calls preventDefault when it did. */
export const HOST_OPEN_URL_EVENT = "work-board:open-url";
export const HOST_TASK_ATTRIBUTE = "data-task-key";
export const HOST_REQUEST_ATTRIBUTE = "data-task-request";
export const HOST_VIEW_ATTRIBUTE = "data-task-view";
const THREAD_ID = /^thr_[A-Za-z0-9_-]+$/;

type HostRequest = { taskKey: string; request: string; view: "plan" | undefined };
type Host = { element: HTMLElement; threadId: string; request: HostRequest | null };

function readRequest(element: HTMLElement): HostRequest | null {
  const taskKey = element.getAttribute(HOST_TASK_ATTRIBUTE) ?? "";
  if (!TASK_TAB.experimental_target.validate({ taskKey })) return null;
  return { taskKey, request: element.getAttribute(HOST_REQUEST_ATTRIBUTE) ?? "", view: element.getAttribute(HOST_VIEW_ATTRIBUTE) === "plan" ? "plan" : undefined };
}

function findHosts(): Host[] {
  return [...document.querySelectorAll<HTMLElement>(`[${HOST_ATTRIBUTE}="board"]`)].flatMap((element) => {
    const threadId = element.getAttribute(HOST_THREAD_ATTRIBUTE) ?? "";
    return THREAD_ID.test(threadId) ? [{ element, threadId, request: readRequest(element) }] : [];
  });
}

const sameRequest = (a: HostRequest | null, b: HostRequest | null) =>
  a === b || (!!a && !!b && a.taskKey === b.taskKey && a.request === b.request && a.view === b.view);
const sameHosts = (a: Host[], b: Host[]) =>
  a.length === b.length && a.every((host, index) => host.element === b[index]!.element && host.threadId === b[index]!.threadId && sameRequest(host.request, b[index]!.request));

function HostedBoard({ host }: { host: Host }) {
  const root = useRef<HTMLDivElement>(null);
  // Requests are one-shot: one from the host attributes when it changes, or one from a task link clicked in the board.
  // The sequence lives in this instance only, so a remount never replays an earlier request from memory.
  const [open, setOpen] = useState<{ taskKey: string; view: "plan" | undefined; sequence: number } | null>(null);
  const sequence = useRef(0);
  const request = host.request;
  useEffect(() => {
    if (request) setOpen({ taskKey: request.taskKey, view: request.view, sequence: ++sequence.current });
  }, [request?.taskKey, request?.request, request?.view]);
  const target = useMemo<OpenTaskRequest>(() => open && {
    target: { taskKey: open.taskKey }, ...(open.view ? { view: open.view } : {}), sequence: open.sequence, clear: () => setOpen(null),
  }, [open]);
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
      // A task or plan link of this app opens here: bb's navigation would leave the host's page for the main view.
      const task = taskLink(url);
      if (task) {
        event.preventDefault();
        setOpen({ ...task, sequence: ++sequence.current });
        return;
      }
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
  return <div ref={root} data-bb-plugin="work-board" className="h-full min-h-0"><ThreadBoard threadId={host.threadId} target={target} /></div>;
}

function taskLink(href: string): { taskKey: string; view: "plan" | undefined } | null {
  if (!href) return null;
  let url: URL;
  try { url = new URL(href, document.baseURI); } catch { return null; }
  if (url.origin !== new URL(document.baseURI).origin) return null;
  const match = url.pathname.match(TASK_LINK);
  if (!match) return null;
  let taskKey: string;
  try { taskKey = decodeURIComponent(match[1]!); } catch { return null; }
  return TASK_TAB.experimental_target.validate({ taskKey }) ? { taskKey, view: match[2] ? "plan" : undefined } : null;
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
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: [HOST_ATTRIBUTE, HOST_THREAD_ATTRIBUTE, HOST_TASK_ATTRIBUTE, HOST_REQUEST_ATTRIBUTE, HOST_VIEW_ATTRIBUTE] });
    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
  return <>{hosts.map((host) => createPortal(<HostedBoard key={host.threadId} host={host} />, host.element, hostKey(host.element)))}</>;
}
