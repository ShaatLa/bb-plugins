// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot, loadPluginApp } from '@get-bb/plugin-sdk/testing/app';
import { AgentHubSettings } from './settings-section';
import { preferencesSchema } from './preferences';
afterEach(cleanup);
Element.prototype.scrollIntoView=()=>{};
Element.prototype.hasPointerCapture=()=>false;
Element.prototype.setPointerCapture=()=>{};
Element.prototype.releasePointerCapture=()=>{};
it('registers Answers and renders preferences with validated time fields and reset',async()=>{
 const app=await loadPluginApp(()=>import('./app'));
 expect(app.settingsSections.find(s=>s.title==='Agent Hub')?.component).toBe(AgentHubSettings);
 let prefs=preferencesSchema.parse({quietHours:'22:00-08:00',groupByProject:true,projectOrder:'proj_example',remindHours:7});
 const update=vi.fn((patch:unknown)=>prefs={...prefs,...patch as object});
 const slot=renderSlot({component:AgentHubSettings},{},{rpc:{getPreferences:()=>prefs,updatePreferences:update}});
 await slot.findByText('Notifications');
 for(const name of ['Chat','Contacts']) expect(slot.getByText(name)).toBeTruthy(); expect(slot.queryByText('Agents')).toBeNull();
 expect(slot.queryByText('proj_example')).toBeNull();
 expect(slot.getByRole('combobox',{name:'Blocking question reminders'}).textContent).toContain('Every 7 hours');
 fireEvent.keyDown(slot.getByRole('combobox',{name:'Push notifications'}),{key:'Enter'});
 await slot.findByRole('option',{name:'Everything'});
 fireEvent.click(slot.getByRole('option',{name:'Everything'}));
 await waitFor(()=>expect(update).toHaveBeenCalledWith({notify:'all'}));
 await waitFor(()=>expect(slot.getByLabelText('From').hasAttribute('disabled')).toBe(false));
 fireEvent.change(slot.getByLabelText('From'),{target:{value:'21:00'}});
 await waitFor(()=>expect(update).toHaveBeenCalledWith({quietHours:'21:00-08:00'}));
 await waitFor(()=>expect(slot.getByRole('button',{name:'Reset project order'}).hasAttribute('disabled')).toBe(false));
 fireEvent.click(slot.getByRole('button',{name:'Reset project order'}));
 await waitFor(()=>expect(update).toHaveBeenCalledWith({projectOrder:''}));
});
it('stores the five chat preferences from their controls',async()=>{
 const prefs=preferencesSchema.parse({});const update=vi.fn((patch:unknown)=>({...prefs,...patch as object}));
 const slot=renderSlot({component:AgentHubSettings},{},{rpc:{getPreferences:()=>prefs,updatePreferences:update}});
 await slot.findByText('Chat');
 for(const [label,key,value] of [['Show "Mark all read"','showMarkAllRead',true],['Group background updates','groupBackgroundUpdates',false],['Actions on selected text','selectionActions',false]] as const){
 const control=slot.getByRole('switch',{name:label});
 await waitFor(()=>expect(control.hasAttribute('disabled')).toBe(false));fireEvent.click(control);
 await waitFor(()=>expect(update).toHaveBeenCalledWith({[key]:value}));
 }
 for(const [label,option,key,value] of [['Working animation','Off','workingAnimation','off'],['Enter on touch screens','Send','touchEnter','send']] as const){
 const control=slot.getByRole('combobox',{name:label});
 await waitFor(()=>expect(control.hasAttribute('disabled')).toBe(false));fireEvent.keyDown(control,{key:'Enter'});
 fireEvent.click(await slot.findByRole('option',{name:option}));await waitFor(()=>expect(update).toHaveBeenCalledWith({[key]:value}));
 }
});
