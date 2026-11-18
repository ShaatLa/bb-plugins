import { useEffect, useRef } from 'react';
import { useRealtime, useRpc } from '@get-bb/plugin-sdk/app';
import { desktopNotificationSchema, NOTIFICATIONS_CHANNEL, type AgentHubRpcContract } from './contract';
import { isChatOpen, selectContact } from './open-chat';
import { openAppRoute } from './lib/app-route';

export function DesktopNotifier() {
  const rpc = useRpc<AgentHubRpcContract>(), holder = useRef(false);
  useRealtime(NOTIFICATIONS_CHANNEL, payload => {
    const event = desktopNotificationSchema.safeParse(payload);
    if (!holder.current || !event.success || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const { id, title, body, threadId } = event.data;
    if (threadId && document.hasFocus() && isChatOpen(threadId)) return;
    const notification = new Notification(title, { body, tag: `agent-hub-${threadId ?? id}` });
    notification.onclick = () => {
      window.focus();
      (window as Window & {bbDesktop?:{focusWindow:()=>void}}).bbDesktop?.focusWindow();
      const selected = threadId ? selectContact(threadId) : false;
      openAppRoute(`/plugins/agent-hub/agent-hub${threadId && !selected ? `?thread=${encodeURIComponent(threadId)}` : ''}`);
      notification.close();
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
