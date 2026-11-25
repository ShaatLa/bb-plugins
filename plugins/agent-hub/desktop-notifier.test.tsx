// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { DesktopNotifier } from './desktop-notifier';
import { ContactPageProvider, selectContact } from './open-chat';
const ctx = vi.hoisted(() => ({ threadId: null as string | null }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...(await importOriginal<object>()), useBbContext: () => ({ projectId: 'proj_example', threadId: ctx.threadId }) }));
const notifications: any[] = [];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); notifications.length = 0; localStorage.clear(); });
function setup(locked = true, page = false) {
 vi.stubGlobal('Notification', class { static permission = 'granted'; onclick: any; close = vi.fn(); constructor(public title: string, public options: any) { notifications.push(this); } });
 Object.defineProperty(navigator, 'locks', {configurable:true,value:{request:vi.fn((_name: unknown, _options: unknown, callback: () => Promise<void>) => locked ? callback() : Promise.resolve())}});
 vi.spyOn(window, 'focus').mockImplementation(() => {});
 return renderSlot({component:page ? () => <ContactPageProvider><DesktopNotifier /></ContactPageProvider> : DesktopNotifier}, {}, {rpc:{'notifier.beat':()=>({ok:true})}});
}
it.each([true,false])('shows notifications only with the notifier lock: %s', async locked => {
 const slot=setup(locked); await slot.behavior.emitRealtime('agent-hub:notifications',{id:'example',title:'Agent Hub',body:'Question',threadId:'thr_example'});
 expect(notifications).toHaveLength(locked?1:0);
 if(locked) { expect(notifications[0].options.tag).toBeUndefined(); act(()=>notifications[0].onclick()); expect(location.pathname+location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example'); }
});
it('closes the thread\'s previous notification before showing the next', async()=>{
 const slot=setup(),event={id:'example',title:'Agent Hub',body:'Question',threadId:'thr_example'};
 await slot.behavior.emitRealtime('agent-hub:notifications',event);await slot.behavior.emitRealtime('agent-hub:notifications',{...event,id:'example2'});
 expect(notifications).toHaveLength(2);expect(notifications[0].close).toHaveBeenCalled();expect(notifications[1].close).not.toHaveBeenCalled();
});
it('opens the page for a summary', async()=>{
 const slot=setup();await slot.behavior.emitRealtime('agent-hub:notifications',{id:'example',title:'Agent Hub',body:'Summary'});act(()=>notifications[0].onclick());expect(location.pathname+location.search).toBe('/plugins/agent-hub/agent-hub');
});
it('skips the focused open conversation',async()=>{
 const slot=setup(true,true);act(()=>selectContact('thr_example'));vi.spyOn(document,'hasFocus').mockReturnValue(true);
 await slot.behavior.emitRealtime('agent-hub:notifications',{id:'example',title:'Agent Hub',body:'Question',threadId:'thr_example'});expect(notifications).toHaveLength(0);
});
describe('landing in bb thread view', () => {
 const mount = (path = '/threads/x') => { history.replaceState(null, '', path); vi.useFakeTimers(); ctx.threadId = null; return setup(false); };
 const land = (slot: ReturnType<typeof setup>) => { ctx.threadId = 'thr_example'; act(() => slot.rerender(<DesktopNotifier />)); };
 afterEach(() => { vi.useRealTimers(); history.replaceState(null, '', '/'); });
 it('redirects after a recent focus', () => {
  const slot = mount(); act(() => { window.dispatchEvent(new Event('focus')); }); land(slot);
  expect(location.pathname + location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example');
 });
 it('ignores a landing after user input', () => {
  const slot = mount(); act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pointerdown')); }); land(slot);
  expect(location.pathname).toBe('/threads/x');
 });
 it('keeps a click that brings the window forward', () => {
  const slot = mount(); act(() => { window.dispatchEvent(new Event('pointerdown')); window.dispatchEvent(new Event('focus')); }); land(slot);
  expect(location.pathname).toBe('/threads/x');
 });
 it('ignores a landing without recent focus', () => {
  const slot = mount(); act(() => { window.dispatchEvent(new Event('focus')); vi.advanceTimersByTime(3500); }); land(slot);
  expect(location.pathname).toBe('/threads/x');
 });
 it('ignores plugin pages', () => {
  const slot = mount('/plugins/other/page'); act(() => { window.dispatchEvent(new Event('focus')); }); land(slot);
  expect(location.pathname).toBe('/plugins/other/page');
 });
});
