// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const app = await loadPluginApp(() => import('./app'));
afterEach(cleanup);
it('shows project fields, keeps execution paths collapsed, and saves only the selected project', async () => {
 const config={enabled:false,remote:'git@example.com:repo.git',branch:'main',script:'checks/sweep.py',args:['--root','{manager}'],manager:'thr_manager',intervalMinutes:10,timeoutSeconds:300,snapshots:false};
 const configure=vi.fn(async()=>({})), environment=vi.fn(async()=>({}));
 const slot=renderSlot(app.settingsSections[0],{}, {rpc:{'settings.read':()=>({projects:[{id:'proj_first',name:'First',config},{id:'proj_second',name:'Second',config:{...config,script:'second.py'}}],threads:[{id:'thr_manager',title:'Project manager',projectId:'proj_first'}],environment:{bbCli:'/long/bb',runtimePath:'/one:/two'}}),configure,'environment.write':environment}});
 await slot.findByLabelText('Check script');
 expect(slot.getByLabelText('Check script')).toHaveProperty('value','checks/sweep.py');
 expect(slot.getByLabelText('Executable search directories').closest('details')?.open).toBe(false);
 expect(slot.queryByLabelText('Project sweeps (JSON)')).toBeNull();
 fireEvent.change(slot.getByLabelText('Project'),{target:{value:'proj_second'}});
 fireEvent.change(slot.getByLabelText('Check script'),{target:{value:'changed.py'}});
 await act(async()=>{fireEvent.submit(slot.getByText('Save project settings').closest('form')!);});
 expect(configure).toHaveBeenCalledWith(expect.objectContaining({projectId:'proj_second',config:expect.objectContaining({script:'changed.py',enabled:false})}));
 expect(environment).not.toHaveBeenCalled();slot.unmount();
});
it('hides and restores the host raw configuration without changing its values',async()=>{
 const host=document.createElement('div');host.innerHTML='<input aria-label="Script PATH (empty inherits server)" value="/one:/two"><input aria-label="BB CLI absolute path" value="/bb"><textarea aria-label="Project sweeps (JSON)">{}</textarea>';document.body.append(host);
 const slot=renderSlot(app.settingsSections[0],{}, {rpc:{'settings.read':()=>({projects:[{id:'proj_first',name:'First',config:null}],threads:[],environment:{bbCli:'/bb',runtimePath:'/one:/two'}})}});
 await slot.findByLabelText('Check script');await waitFor(()=>expect(host.hidden).toBe(true));expect(host.querySelector('input')!.value).toBe('/one:/two');
 slot.unmount();expect(host.hidden).toBe(false);host.remove();
});
