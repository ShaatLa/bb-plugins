import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { registerRpc } from './rpc.js';
import { registerCli } from './cli.js';
import { MIGRATIONS } from './store/schema.js';

function setup() {
  const usageLimits=vi.fn(async () => ({}));
  const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ system:{ usageLimits } } });
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
      const p=await harness.behavior.callRpc('prices',{}) as { entries:{ model:string; rates:{ input:number } }[] };
      expect(p.entries.find(p => p.model==='claude-sonnet-5-5')?.rates.input).toBe(7);
      await expect(harness.behavior.callRpc('setPriceOverride',{ model:'claude-sonnet-5-5',rates:{ input:100001 } })).rejects.toThrow();
      await harness.behavior.callRpc('setPriceOverride',{ model:'claude-sonnet-5-5',rates:null });
      expect((await settings.get()).priceOverrides).toBe('{}');
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
