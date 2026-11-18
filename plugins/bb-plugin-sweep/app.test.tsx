// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const app = await loadPluginApp(() => import('./app'));
afterEach(cleanup);
HTMLElement.prototype.scrollIntoView = vi.fn();
it('uses BB controls and automatically saves only the selected project without replacing the input', async () => {
 const config={enabled:false,remote:'git@example.com:repo.git',branch:'main',script:'checks/sweep.py',args:['--root','{manager}'],manager:'thr_manager',intervalMinutes:10,timeoutSeconds:300,snapshots:false};
 const configure=vi.fn(async()=>({})), environment=vi.fn(async()=>({}));
 const slot=renderSlot(app.settingsSections[0],{}, {rpc:{'settings.read':()=>({projects:[{id:'proj_first',name:'First',config},{id:'proj_second',name:'Second',config:{...config,script:'second.py'}}],threads:[{id:'thr_manager',title:'Project manager',projectId:'proj_first'}],environment:{bbCli:'/long/bb',runtimePath:'/one:/two'}}),configure,'environment.write':environment}});
 await slot.findByLabelText('Check script');
 expect(slot.getByRole('combobox',{name:'Project'}).tagName).toBe('BUTTON');
 expect(slot.getByLabelText('Check script').closest('[data-control-placement]')?.getAttribute('data-control-placement')).toBe('inline');
 expect(slot.getByLabelText('Executable search directories').closest('details')?.open).toBe(false);
 expect(slot.queryByRole('button',{name:'Save project settings'})).toBeNull();
 expect(configure).not.toHaveBeenCalled();
 fireEvent.keyDown(slot.getByRole('combobox',{name:'Project'}),{key:'Enter'});
 const option=await slot.findByRole('option',{name:'Second'});
 await act(async()=>{fireEvent.keyDown(option,{key:'Enter'});});
 await waitFor(()=>expect(document.activeElement).toBe(slot.getByRole('combobox',{name:'Project'})));
 const input=slot.getByLabelText('Check script') as HTMLInputElement;input.focus();
 await act(async()=>{fireEvent.change(input,{target:{value:'changed.py'}});});
 expect(configure).toHaveBeenCalledWith(expect.objectContaining({projectId:'proj_second',config:expect.objectContaining({script:'changed.py',enabled:false})}));
 expect(slot.getByLabelText('Check script')).toBe(input);expect(document.activeElement).toBe(input);
 expect(environment).not.toHaveBeenCalled();slot.unmount();
});
it('hides and restores the host raw configuration without changing its values',async()=>{
 const host=document.createElement('div');host.innerHTML='<input aria-label="Script PATH (empty inherits server)" value="/one:/two"><input aria-label="BB CLI absolute path" value="/bb"><textarea aria-label="Project sweeps (JSON)">{}</textarea>';document.body.append(host);
 const slot=renderSlot(app.settingsSections[0],{}, {rpc:{'settings.read':()=>({projects:[{id:'proj_first',name:'First',config:null}],threads:[],environment:{bbCli:'/bb',runtimePath:'/one:/two'}})}});
 await slot.findByLabelText('Check script');await waitFor(()=>expect(host.hidden).toBe(true));expect(host.querySelector('input')!.value).toBe('/one:/two');
 slot.unmount();expect(host.hidden).toBe(false);host.remove();
});
