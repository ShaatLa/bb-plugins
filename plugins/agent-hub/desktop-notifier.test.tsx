// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { DesktopNotifier } from './desktop-notifier';
import { ContactPageProvider, selectContact } from './open-chat';
const ctx = vi.hoisted(() => ({ threadId: null as string | null }));
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...(await importOriginal<object>()), useBbContext: () => ({ projectId: 'proj_example', threadId: ctx.threadId }) }));
const notifications: any[] = [];
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); notifications.length = 0; localStorage.clear(); prefs.chatMode = 'answers'; prefs.created = {}; prefs.absent = false; prefs.landings.length = 0; prefs.release = undefined; });
const prefs = vi.hoisted(() => ({ chatMode: 'answers' as 'answers' | 'bb' | null, created: {} as Record<string, number>, absent: false, landings: [] as unknown[], release: undefined as undefined | ((v: object) => void) }));
function setup(locked = true, page = false) {
 vi.stubGlobal('Notification', class { static permission = 'granted'; onclick: any; close = vi.fn(); constructor(public title: string, public options: any) { notifications.push(this); } });
 Object.defineProperty(navigator, 'locks', {configurable:true,value:{request:vi.fn((_name: unknown, _options: unknown, callback: () => Promise<void>) => locked ? callback() : Promise.resolve())}});
 vi.spyOn(window, 'focus').mockImplementation(() => {});
 return renderSlot({component:page ? () => <ContactPageProvider><DesktopNotifier /></ContactPageProvider> : DesktopNotifier}, {}, {rpc:{'notifier.beat':()=>({ok:true}),getPreferences:()=>prefs.chatMode === null ? new Promise(done => { prefs.release = done; }) : ({chatMode:prefs.chatMode}),pushLanding:(input:unknown)=>{prefs.landings.push(input); return {ok:true};}},sidebarThreads:{get threads(){ return Object.entries(prefs.absent ? prefs.created : { thr_example: 1, ...prefs.created }).map(([id,createdAt])=>({id,createdAt,title:id})); },projects:[]}} as any);
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
 // Preferences load asynchronously; let them settle before the landing.
 const ready = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
 afterEach(() => { vi.useRealTimers(); history.replaceState(null, '', '/'); });
 it('redirects after a recent focus', async () => {
  const slot = mount(); await ready(); act(() => { window.dispatchEvent(new Event('focus')); }); land(slot);
  expect(location.pathname + location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example');
 });
 it('ignores a landing right after user input, and logs why', async () => {
  const slot = mount(); await ready(); act(() => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('pointerdown')); }); land(slot);
  expect(location.pathname).toBe('/threads/x');
  await ready(); expect(prefs.landings).toContainEqual({ threadId:'thr_example', redirected:false, reason:'user-input' });
 });
 it('keeps a click that brings the window forward', async () => {
  const slot = mount(); await ready(); act(() => { window.dispatchEvent(new Event('pointerdown')); window.dispatchEvent(new Event('focus')); }); land(slot);
  expect(location.pathname).toBe('/threads/x');
 });
 it('redirects a landing without input on a focused window, 600 ms after the last input', async () => {
  const slot = mount(); await ready(); act(() => { window.dispatchEvent(new Event('pointerdown')); vi.advanceTimersByTime(600); }); land(slot);
  expect(location.pathname + location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example');
  await ready(); expect(prefs.landings).toContainEqual({ threadId:'thr_example', redirected:true, reason:'no-input-navigation' });
 });
 it('redirects a cold start on a thread', async () => {
  history.replaceState(null, '', '/projects/p/threads/thr_example'); vi.useFakeTimers(); ctx.threadId = 'thr_example';
  setup(false); await ready();
  expect(location.pathname + location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example');
  expect(prefs.landings).toContainEqual({ threadId:'thr_example', redirected:true, reason:'cold-start' });
 });
 it('keeps a link to one message in bb chat', async () => {
  const slot = mount('/threads/x?msg=5'); await ready(); land(slot);
  expect(location.pathname + location.search).toBe('/threads/x?msg=5');
 });
 it('keeps bb chat when Chat is set to bb chat', async () => {
  prefs.chatMode = 'bb'; const slot = mount(); await ready(); land(slot);
  expect(location.pathname).toBe('/threads/x');
 });
 it('waits for preferences before deciding', async () => {
  prefs.chatMode = null; const slot = mount(); land(slot); await ready();
  expect(location.pathname).toBe('/threads/x');
 });
 it('keeps a thread created seconds ago in bb chat', async () => {
  prefs.created = { thr_example: Date.now() - 5000 }; const slot = mount(); await ready(); land(slot);
  expect(location.pathname).toBe('/threads/x');
  await ready(); expect(prefs.landings).toContainEqual({ threadId:'thr_example', redirected:false, reason:'new-thread' });
 });
 it('drops a landing the owner left while preferences loaded', async () => {
  prefs.chatMode = null; const slot = mount(); land(slot);
  history.replaceState(null, '', '/plugins/other/page'); ctx.threadId = null; act(() => slot.rerender(<DesktopNotifier />));
  await act(async () => { prefs.release?.({ chatMode:'answers' }); await vi.advanceTimersByTimeAsync(0); });
  expect(location.pathname).toBe('/plugins/other/page');
 });
 it('does not decide while a landed thread is still missing from the sidebar', async () => {
  prefs.absent = true; const slot = mount(); await ready(); land(slot);
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(location.pathname).toBe('/threads/x'); expect(prefs.landings).toEqual([]);
 });
 it('decides after 2 s when the thread never shows up in the sidebar', async () => {
  prefs.absent = true; const slot = mount(); await ready(); land(slot);
  await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
  expect(location.pathname + location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example');
 });
 it('ignores plugin pages', async () => {
  const slot = mount('/plugins/other/page'); await ready(); act(() => { window.dispatchEvent(new Event('focus')); }); land(slot);
  expect(location.pathname).toBe('/plugins/other/page');
 });
});
