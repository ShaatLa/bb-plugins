// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { PluginBrowserBbSdk } from '@get-bb/plugin-sdk/app';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
const app = await loadPluginApp(() => import('./app'));
afterEach(cleanup);
HTMLElement.prototype.scrollIntoView = vi.fn();
it('uses BB controls and automatically saves only the selected project without replacing the input', async () => {
 const config={enabled:false,branch:'main',script:'checks/sweep.py',args:['--root','{manager}'],manager:'thr_manager',intervalMinutes:10,timeoutSeconds:300,snapshots:false};
 const configure=vi.fn(async()=>({})), set=vi.fn(async()=>({})), environment=vi.fn(async()=>({}));
 const slot=renderSlot(app.settingsSections[0],{}, {rpc:{'settings.read':()=>({projects:[{id:'proj_first',name:'First',hasRepository:false,config},{id:'proj_second',name:'Second',hasRepository:true,config:{...config,script:'second.py'}}],threads:[{id:'thr_manager',title:'Project manager',projectId:'proj_first'}],environment:{bbCli:'/long/bb',runtimePath:'/one:/two'}}),configure,'config.set':set,'environment.write':environment}});
 await slot.findByLabelText('Check script');
 expect(slot.queryByLabelText('Repository URL')).toBeNull();
 expect(slot.getByText(/Set a Git remote URL/)).toBeTruthy();
 expect(slot.getByRole('combobox',{name:'Project'}).tagName).toBe('BUTTON');
 expect(slot.getByLabelText('Check script').closest('[data-control-placement]')?.getAttribute('data-control-placement')).toBe('inline');
 expect(slot.getByLabelText('Executable search directories').closest('details')?.open).toBe(false);
 expect(slot.queryByRole('button',{name:'Save project settings'})).toBeNull();
 expect(configure).not.toHaveBeenCalled();
 expect(set).not.toHaveBeenCalled();
 fireEvent.keyDown(slot.getByRole('combobox',{name:'Project'}),{key:'Enter'});
 const option=await slot.findByRole('option',{name:'Second'});
 await act(async()=>{fireEvent.keyDown(option,{key:'Enter'});});
 await waitFor(()=>expect(document.activeElement).toBe(slot.getByRole('combobox',{name:'Project'})));
 expect(slot.queryByText(/Set a Git remote URL/)).toBeNull();
 const input=slot.getByLabelText('Check script') as HTMLInputElement;input.focus();
 await act(async()=>{fireEvent.change(input,{target:{value:'changed.py'}});});
 expect(set).toHaveBeenCalledExactlyOnceWith({projectId:'proj_second',key:'script',value:'changed.py'});
 expect(configure).not.toHaveBeenCalled();
 expect(slot.getByLabelText('Check script')).toBe(input);expect(document.activeElement).toBe(input);
 expect(environment).not.toHaveBeenCalled();slot.unmount();
});

it('retries an unsaved field on the next edit without rewriting fields already saved', async () => {
  const set = vi.fn<(_: unknown) => Promise<object>>()
    .mockResolvedValue({})
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error('Offline'));
  const slot = renderSlot(app.settingsSections[0], {}, { rpc: {
    'settings.read': () => ({
      projects: [{ id: 'proj_first', name: 'First', hasRepository: true, config: null }],
      threads: [], environment: { bbCli: '', runtimePath: '' },
    }),
    'config.set': set,
  } });

  fireEvent.change(await slot.findByLabelText('Check script'), { target: { value: 'checks/sweep.py' } });
  await slot.findByText(/Could not save settings/);
  fireEvent.change(slot.getByLabelText('Arguments'), { target: { value: '--brief' } });
  await waitFor(() => expect(set.mock.calls.map(([input]) => input)).toEqual([
    { projectId: 'proj_first', key: 'script', value: 'checks/sweep.py' },
    { projectId: 'proj_first', key: 'branch', value: 'main' },
    { projectId: 'proj_first', key: 'branch', value: 'main' },
    { projectId: 'proj_first', key: 'args', value: ['--brief'] },
  ]));
  expect(slot.queryByText(/Could not save settings/)).toBeNull();
});

const projects = () => [{ id: 'proj_first', name: 'First', enabled: true }, { id: 'proj_second', name: 'Second', enabled: false }];
type ListedThread = Awaited<ReturnType<PluginBrowserBbSdk['threads']['list']>>[number];
it('shows the selected project’s analytics and changes the reporting window', async () => {
  const stats = vi.fn(({ projectId, days }) => ({ projectId, days, since: 1,
    ticks: 5, executed: 5, deliveries: 2, manager: 1, answers: 1, repeats: 3, suppressedReports: 2,
    reminderReports: 1, refreshFailures: 0, scriptFailures: 1, deliveryFailures: 0, newItems: { 'ACTION stale-status': 2 },
  }));
  const slot = renderSlot(app.navPanels[0], { subPath: 'proj_second' }, {
    rpc: { 'overview.projects': projects, stats, manager: () => ({ manager: null }) },
    sdk: { threads: { list: async () => [] } },
  });
  expect((await slot.findByRole('combobox', { name: 'Project' })).textContent).toContain('Second');
  expect(await slot.findByText('Action · stale status')).toBeTruthy();
  expect(stats).toHaveBeenCalledWith({ projectId: 'proj_second', days: 1 });
  expect(slot.getByRole('button', { name: '24 hours', pressed: true })).toBeTruthy();
  fireEvent.click(slot.getByRole('button', { name: '7 days', pressed: false }));
  expect(slot.getByRole('button', { name: '7 days', pressed: true })).toBeTruthy();
  await waitFor(() => expect(stats).toHaveBeenLastCalledWith({ projectId: 'proj_second', days: 7 }));
});

it('changes only the selected project’s manager from the main panel', async () => {
  const panel = app.navPanels[0];
  expect(panel.experimental_sidebar).toBeUndefined();
  const set = vi.fn(async () => ({ manager: 'thr_second' }));
  const list = vi.fn(async () => [{ id: 'thr_second', title: 'New session', projectId: 'proj_second', archivedAt: null, deletedAt: null } as ListedThread]);
  const slot = renderSlot(panel, { subPath: 'proj_second' }, {
    rpc: { 'overview.projects': projects, stats: () => ({ ticks: 0 }), manager: () => ({ manager: 'thr_first' }), 'config.set': set },
    sdk: { threads: { list } },
  });
  const select = await slot.findByRole('combobox', { name: 'Notification session' });
  expect(select.textContent).toContain('thr_first');
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj_second', archived: false }));
  fireEvent.keyDown(select, { key: 'Enter' });
  const option = await slot.findByRole('option', { name: 'New session' });
  await act(async () => { fireEvent.keyDown(option, { key: 'Enter' }); });
  expect(set).toHaveBeenCalledExactlyOnceWith({ projectId: 'proj_second', key: 'manager', value: 'thr_second' });
  await waitFor(() => expect(select.textContent).toContain('New session'));
  fireEvent.keyDown(slot.getByRole('combobox', { name: 'Project' }), { key: 'Enter' });
  const project = await slot.findByRole('option', { name: 'First' });
  await act(async () => { fireEvent.keyDown(project, { key: 'Enter' }); });
  expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: 'toPluginPanel', path: 'overview', options: { subPath: 'proj_first' } });
});
it('hides and restores the host raw configuration without changing its values',async()=>{
 const host=document.createElement('div');host.innerHTML='<input aria-label="Script PATH (empty inherits server)" value="/one:/two"><input aria-label="BB CLI absolute path" value="/bb"><textarea aria-label="Project sweeps (JSON)">{}</textarea>';document.body.append(host);
 const slot=renderSlot(app.settingsSections[0],{}, {rpc:{'settings.read':()=>({projects:[{id:'proj_first',name:'First',hasRepository:true,config:null}],threads:[],environment:{bbCli:'/bb',runtimePath:'/one:/two'}})}});
 await slot.findByLabelText('Check script');await waitFor(()=>expect(host.hidden).toBe(true));expect(host.querySelector('input')!.value).toBe('/one:/two');
 slot.unmount();expect(host.hidden).toBe(false);host.remove();
});
