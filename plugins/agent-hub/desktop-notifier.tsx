import { useEffect, useRef } from 'react';
import { useBbContext, useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { desktopNotificationSchema, NOTIFICATIONS_CHANNEL, type AgentHubRpcContract } from './contract';
import { isChatOpen, selectContact } from './open-chat';
import { openAppRoute } from './lib/app-route';

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
  useEffect(() => {
    if (!bbThreadId || location.pathname.startsWith('/plugins/') || Date.now() - attention.current > 3000) return;
    attention.current = 0;
    const selected = selectContact(bbThreadId);
    openAppRoute(`/plugins/agent-hub/agent-hub${selected ? '' : `?thread=${encodeURIComponent(bbThreadId)}`}`);
  }, [bbThreadId]);
  useRealtime(NOTIFICATIONS_CHANNEL, payload => {
    const event = desktopNotificationSchema.safeParse(payload);
    if (!holder.current || !event.success || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const { id, title, body, threadId } = event.data;
    if (threadId && document.hasFocus() && isChatOpen(threadId)) return;
    const tag = `agent-hub-${threadId ?? id}`, notification = new Notification(title, { body, tag });
    shown.set(tag, notification);
    notification.onclose = () => { if (shown.get(tag) === notification) shown.delete(tag); };
    notification.onclick = () => {
      window.focus();
      (window as Window & {bbDesktop?:{focusWindow:()=>void}}).bbDesktop?.focusWindow();
      const selected = threadId ? selectContact(threadId) : false;
      openAppRoute(`/plugins/agent-hub/agent-hub${threadId && !selected ? `?thread=${encodeURIComponent(threadId)}` : ''}`);
      notification.close(); shown.delete(tag);
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
