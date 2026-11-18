// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { DesktopNotifier } from './desktop-notifier';
import { ContactPageProvider, selectContact } from './open-chat';
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
 if(locked) { expect(notifications[0].options.tag).toBe('agent-hub-thr_example'); act(()=>notifications[0].onclick()); expect(location.pathname+location.search).toBe('/plugins/agent-hub/agent-hub?thread=thr_example'); }
});
it('opens the page for a summary', async()=>{
 const slot=setup();await slot.behavior.emitRealtime('agent-hub:notifications',{id:'example',title:'Agent Hub',body:'Summary'});act(()=>notifications[0].onclick());expect(location.pathname+location.search).toBe('/plugins/agent-hub/agent-hub');
});
it('skips the focused open conversation',async()=>{
 const slot=setup(true,true);act(()=>selectContact('thr_example'));vi.spyOn(document,'hasFocus').mockReturnValue(true);
 await slot.behavior.emitRealtime('agent-hub:notifications',{id:'example',title:'Agent Hub',body:'Question',threadId:'thr_example'});expect(notifications).toHaveLength(0);
});
