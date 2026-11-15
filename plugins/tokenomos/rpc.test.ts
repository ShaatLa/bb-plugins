import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { registerRpc } from './rpc.js';
import { registerCli } from './cli.js';
import { MIGRATIONS } from './store/schema.js';

function setup() {
  const usageLimits=vi.fn(async () => ({}));
  const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ system:{ usageLimits }, projects:{ list: async () => [] } } });
  const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
  const settings=bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' }, rollupRetentionDays:{ type:'number',default:200,label:'Rollups' }, referenceModel:{ type:'string',default:'claude-sonnet-5-5',label:'Reference' }, includeOutsideBb:{ type:'boolean',default:false,label:'Outside' }, priceOverrides:{ type:'string',default:'{}',label:'Overrides' } });
  const handlers=registerRpc(bb,db,settings); registerCli(bb,handlers);
  return { bb,harness,db,settings,usageLimits };
}
describe('RPC and CLI', () => {
  it('registers all contract methods, validates writes and rereads settings', async () => {
    const { harness,settings }=setup();
    try {
      for (const [method,input] of Object.entries({ 'costs.threads':{ threadIds:['missing'],includeDescendants:true }, 'costs.sum':{ threadIds:['missing'],includeDescendants:true },summary:{ range:'week',by:'provider' },topThreads:{ range:'week',offset:0,limit:50 },compactions:{ range:'week' },status:{},prices:{},prune:{} })) await expect(harness.behavior.callRpc(method,input)).resolves.toBeDefined();
      await harness.behavior.callRpc('setPriceOverride',{ model:'claude-sonnet-5-5',rates:{ input:7 } });
      expect(JSON.parse((await settings.get()).priceOverrides)['claude-sonnet-5-5'].input).toBe(7);
      await harness.behavior.callRpc('setPriceOverride',{ model:'claude-sonnet-5-5',rates:{ output:17 } });
      expect(JSON.parse((await settings.get()).priceOverrides)['claude-sonnet-5-5']).toEqual({ input:7,output:17 });
      const p=await harness.behavior.callRpc('prices',{}) as { entries:{ model:string; rates:{ input:number } }[] };
      expect(p.entries.find(p => p.model==='claude-sonnet-5-5')?.rates.input).toBe(7);
      await expect(harness.behavior.callRpc('setPriceOverride',{ model:'claude-sonnet-5-5',rates:{ input:100001 } })).rejects.toThrow();
      await harness.behavior.callRpc('setPriceOverride',{ model:'claude-sonnet-5-5',rates:null });
      expect((await settings.get()).priceOverrides).toBe('{}');
    } finally { await harness.lifecycle.dispose(); }
  });
  it('keeps reads available with invalid persisted overrides and reports and clears the error', async () => {
    const { harness,settings }=setup();
    try {
      for (const priceOverrides of ['not json','{"claude-sonnet-5-5":{"input":-1}}']) {
        await settings.experimental_set({ priceOverrides });
        for (const [method,input] of Object.entries({ 'costs.threads':{ threadIds:['missing'],includeDescendants:true }, 'costs.sum':{ threadIds:['missing'],includeDescendants:true },summary:{ range:'day',by:'provider' },topThreads:{ range:'day',offset:0,limit:50 },compactions:{ range:'day' },limits:{},prices:{},prune:{} })) await expect(harness.behavior.callRpc(method,input)).resolves.toBeDefined();
        const status=await harness.behavior.callRpc('status',{}) as { sources:{ id:string;lastError:string|null;state:string }[] };
        expect(status.sources.find(s => s.id==='priceOverrides')).toMatchObject({ state:'error',lastError:expect.stringContaining('Invalid priceOverrides:') });
        const prices=await harness.behavior.callRpc('prices',{}) as { entries:{ model:string;rates:{input:number};overridden:boolean }[] };
        expect(prices.entries.find(p => p.model==='claude-sonnet-5-5')).toMatchObject({ overridden:false,rates:{input:2} });
      }
      await settings.experimental_set({ priceOverrides:'{}' });
      const status=await harness.behavior.callRpc('status',{}) as { sources:{ id:string }[] };
      expect(status.sources.some(s => s.id==='priceOverrides')).toBe(false);
    } finally { await harness.lifecycle.dispose(); }
  });
  it('coalesces and caches limits requests for 60 seconds', async () => {
    vi.useFakeTimers(); const { harness,usageLimits }=setup();
    try {
      await Promise.all([harness.behavior.callRpc('limits',{}),harness.behavior.callRpc('limits',{})]);
      expect(usageLimits).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(59_999); await harness.behavior.callRpc('limits',{}); expect(usageLimits).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1); await harness.behavior.callRpc('limits',{}); expect(usageLimits).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); await harness.lifecycle.dispose(); }
  });
  it('runs status and summary with JSON and bounded text output', async () => {
    const { harness }=setup();
    try {
      for (const cmd of ['status','summary']) {
        const text=await harness.behavior.runCli([cmd]); expect(text.exitCode).toBe(0); expect(text.stdout.split('\n').length).toBeLessThanOrEqual(60);
        const json=await harness.behavior.runCli([cmd,'--json']); expect(json.exitCode).toBe(0); expect(() => JSON.parse(json.stdout)).not.toThrow();
      }
      expect((await harness.behavior.runCli(['summary','--range','invalid'])).exitCode).not.toBe(0);
    } finally { await harness.lifecycle.dispose(); }
  });
});

it('lists only retained usage projects, resolves names, and coalesces the five-minute name cache',async()=>{
  vi.useFakeTimers();
  const {harness,db}=setup();
  const list=vi.fn(async()=>[{id:'p',name:'Project P'}]);
  harness.sdk.stub('projects.list',list);
  const now=Date.now(), hour=Math.floor(now/3600000)*3600000;
  const insert=db.prepare("INSERT INTO usage_hourly(hour,project_id,calls) VALUES (?,?,1)");
  for(const id of ['p','unknown','~outside','~local-calls']) insert.run(hour,id);
  insert.run(hour-201*86400000,'expired');
  try {
    const [a,b]=await Promise.all([harness.behavior.callRpc('projects',{}),harness.behavior.callRpc('projects',{})]);
    expect(a).toEqual(b);
    expect(a).toEqual({items:[{projectId:'p',name:'Project P'},{projectId:'unknown',name:'unknown'},
      {projectId:'~local-calls',name:'Local calls'},{projectId:'~outside',name:'Outside bb'}]});
    expect(list).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledWith({includePersonal:true});
    vi.advanceTimersByTime(299999); await harness.behavior.callRpc('projects',{}); expect(list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1); await harness.behavior.callRpc('projects',{}); expect(list).toHaveBeenCalledTimes(2);
    db.exec("DELETE FROM usage_hourly WHERE project_id LIKE '~%'");
    expect((await harness.behavior.callRpc('projects',{}) as {items:{projectId:string}[]}).items.map(p=>p.projectId)).toEqual(['p','unknown']);
    // Verify optional filters survive the validated RPC boundary.
    for(const method of ['summary','topThreads','compactions']) {
      const input=method==='summary' ? {range:'day',by:'provider',projectId:'none'} : method==='topThreads' ? {range:'day',offset:0,limit:50,projectId:'none'} : {range:'day',projectId:'none'};
      const value=await harness.behavior.callRpc(method,input);
      expect(value).toMatchObject(method==='summary' ? {kpis:{calls:0}} : {items:[]});
    }
  } finally {vi.useRealTimers(); await harness.lifecycle.dispose();}
});
