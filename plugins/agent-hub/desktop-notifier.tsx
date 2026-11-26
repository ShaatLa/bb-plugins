import { useEffect, useRef } from 'react';
import { experimental_useSidebarThreads, useBbContext, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { desktopNotificationSchema, NOTIFICATIONS_CHANNEL, type AgentHubRpcContract } from './contract';
import { isChatOpen, selectContact } from './open-chat';
import { openAppRoute } from './lib/app-route';
import { usePreferences } from './use-preferences';

// A notification nobody references can be garbage-collected with its click handler, so a click then does nothing; bb's own pushes keep theirs the same way.
const shown = new Map<string, Notification>();

export function DesktopNotifier() {
  const rpc = useRpc<AgentHubRpcContract>(), holder = useRef(false), { threadId: bbThreadId } = useBbContext(), attention = useRef(0), lastInput = useRef(0);
  // A click on a push lands in bb's thread view; the owner works in Agent Hub, so a landing right after the window regained attention continues there.
  useEffect(() => {
    // A click that itself brings the window forward is the owner's own navigation, whichever of pointerdown and focus fires first.
    const regained = () => { if (Date.now() - lastInput.current > 500) attention.current = Date.now(); }, input = () => { attention.current = 0; lastInput.current = Date.now(); };
    const visible = () => { if (document.visibilityState === 'visible') regained(); };
    window.addEventListener('focus', regained); document.addEventListener('visibilitychange', visible);
    window.addEventListener('pointerdown', input, true); window.addEventListener('keydown', input, true);
    return () => { window.removeEventListener('focus', regained); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pointerdown', input, true); window.removeEventListener('keydown', input, true); };
  }, []);
  // A push click opens bb's thread route and leaves no marker, so with Chat set to Agent Hub any landing on a thread that no
  // input inside the window caused (a push, a cold start, a restored route, an outside link) opens the Agent Hub chat instead.
  // Exceptions the owner accepted: a landing within 500 ms of input, a thread created in the last 30 s, a link to one message.
  const chatMode = usePreferences().data?.chatMode, { threads, status } = experimental_useSidebarThreads();
  const first = useRef(true), here = useRef(bbThreadId), retry = useRef<ReturnType<typeof setTimeout>>(undefined), landing = useRef<{ threadId: string; at: number; cold: boolean; regained: boolean; input: boolean; msg: boolean } | null>(null);
  here.current = bbThreadId;
  const decide = () => {
    const l = landing.current;
    if (!l || chatMode === undefined || status === 'loading') return;
    // The owner moved on while preferences or threads loaded: the old landing no longer applies.
    if (here.current !== l.threadId || location.pathname.startsWith('/plugins/')) { landing.current = null; return; }
    // A thread bb has just created may reach the sidebar a moment after its route; wait for it briefly.
    const thread = threads.find(t => t.id === l.threadId);
    if (!thread && Date.now() - l.at < 2000) { clearTimeout(retry.current); retry.current = setTimeout(decide, 2000 - (Date.now() - l.at)); return; }
    landing.current = null;
    const created = thread?.createdAt;
    const reason = chatMode === 'bb' ? 'chat-mode-bb' : l.msg ? 'message-link' : l.input ? 'user-input' : created !== undefined && l.at - created < 30000 ? 'new-thread' : l.cold ? 'cold-start' : l.regained ? 'regained-attention' : 'no-input-navigation';
    const go = reason === 'cold-start' || reason === 'regained-attention' || reason === 'no-input-navigation';
    void rpc.call('pushLanding', { threadId: l.threadId, redirected: go, reason }).catch(() => {});
    if (!go) return;
    attention.current = 0;
    const selected = selectContact(l.threadId);
    openAppRoute(`/plugins/agent-hub/agent-hub${selected ? '' : `?thread=${encodeURIComponent(l.threadId)}`}`);
  };
  useEffect(() => {
    const cold = first.current; first.current = false;
    if (!bbThreadId || location.pathname.startsWith('/plugins/')) { landing.current = null; return; }
    const now = Date.now();
    landing.current = { threadId: bbThreadId, at: now, cold, regained: now - attention.current <= 3000, input: now - lastInput.current < 500, msg: new URL(location.href).searchParams.has('msg') };
    decide();
  }, [bbThreadId]);
  // Preferences and the sidebar's threads may arrive after the landing; the decision waits for them.
  useEffect(decide, [chatMode, status, threads]);
  useEffect(() => () => clearTimeout(retry.current), []);
  useRealtime(NOTIFICATIONS_CHANNEL, payload => {
    const event = desktopNotificationSchema.safeParse(payload);
    if (!holder.current || !event.success || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const { id, title, body, threadId } = event.data;
    if (threadId && document.hasFocus() && isChatOpen(threadId)) return;
    // No tag: Electron on macOS can drop the click of a notification that reuses an earlier tag, so the thread's previous one is closed here instead.
    const key = `agent-hub-${threadId ?? id}`;
    shown.get(key)?.close();
    const notification = new Notification(title, { body });
    shown.set(key, notification);
    notification.onclose = () => { if (shown.get(key) === notification) shown.delete(key); };
    notification.onclick = () => {
      window.focus();
      (window as Window & {bbDesktop?:{focusWindow:()=>void}}).bbDesktop?.focusWindow();
      const selected = threadId ? selectContact(threadId) : false;
      openAppRoute(`/plugins/agent-hub/agent-hub${threadId && !selected ? `?thread=${encodeURIComponent(threadId)}` : ''}`);
      notification.close(); shown.delete(key);
    };
  });
  useEffect(() => {
    if (!navigator.locks || typeof Notification === 'undefined') return;
    const controller = new AbortController(), clientId = crypto.randomUUID();
    let release: (() => void) | undefined;
    void navigator.locks.request('agent-hub:notifier', {signal:controller.signal}, async () => {
      holder.current = true;
      const beat = () => void rpc.call('notifier.beat', {clientId,canNotify:Notification.permission === 'granted'}).catch(() => {});
      beat();
      const timer = setInterval(beat, 20000);
      await new Promise<void>(resolve => { release = resolve; });
      clearInterval(timer); holder.current = false;
      await rpc.call('notifier.beat', {clientId,canNotify:false}).catch(() => {});
    }).catch(() => {});
    return () => { holder.current = false; controller.abort(); release?.(); };
  }, [rpc]);
  return null;
}
