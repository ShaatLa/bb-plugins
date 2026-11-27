import { createFakePluginHost } from '@get-bb/plugin-sdk/testing';
import { describe, expect, it, vi } from 'vitest';
import { registerRpc } from './rpc.js';
import { registerCli } from './cli.js';
import { MIGRATIONS } from './store/schema.js';
import type { z } from 'zod';
import type { limitsGetSchema } from './contract.js';

function setup() {
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] } } });
  const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
  const settings=bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' }, rollupRetentionDays:{ type:'number',default:200,label:'Rollups' }, referenceModel:{ type:'string',default:'claude-sonnet-5-5',label:'Reference' }, includeOutsideBb:{ type:'boolean',default:false,label:'Outside' }, priceOverrides:{ type:'string',default:'{}',label:'Overrides' } });
  const handlers=registerRpc(bb,db,settings); registerCli(bb,handlers);
  return { bb,harness,db,settings };
}
describe('RPC and CLI', () => {
  it('registers all contract methods, validates writes and rereads settings', async () => {
    const { harness,settings }=setup();
    try {
      for (const [method,input] of Object.entries({ 'costs.threads':{ threadIds:['missing'],includeDescendants:true }, 'costs.sum':{ threadIds:['missing'],includeDescendants:true },summary:{ range:'week',by:'provider' },topThreads:{ range:'week',offset:0,limit:50 },compactions:{ range:'week' },status:{},prices:{},prune:{} })) await expect(harness.behavior.callRpc(method,input)).resolves.toBeDefined();
      await expect(harness.behavior.callRpc('costs.sum',{ spans:[{ threadId:'missing',from:0,to:null }],includeDescendants:true })).resolves.toMatchObject({ threadCount:0,cost:{ partial:true } });
      await expect(harness.behavior.callRpc('costs.sum',{ spans:[{ threadId:'x',from:5,to:1 }],includeDescendants:false })).rejects.toThrow();
      // Other plugins get the public methods only; the refusal names them.
      const asPlugin={ experimental_caller:{ kind:'plugin' as const,pluginId:'example-plugin' } };
      await expect(harness.behavior.callRpc('costs.threads',{ threadIds:['missing'],includeDescendants:true },asPlugin)).resolves.toBeDefined();
      for (const [method,input] of Object.entries({ prune:{},'config.set':{ key:'language',value:'en' },summary:{ range:'week',by:'provider' } }))
        await expect(harness.behavior.callRpc(method,input,asPlugin)).rejects.toThrow(/internal to its page and CLI.*costs\.sum.*limits\.get/);
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
        for (const [method,input] of Object.entries({ 'costs.threads':{ threadIds:['missing'],includeDescendants:true }, 'costs.sum':{ threadIds:['missing'],includeDescendants:true },summary:{ range:'day',by:'provider' },topThreads:{ range:'day',offset:0,limit:50 },compactions:{ range:'day' },prices:{},prune:{} })) await expect(harness.behavior.callRpc(method,input)).resolves.toBeDefined();
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
  it('joins provider limit windows with the window spend and prints them', async () => {
    const resetsAt=new Date(Date.now()+6*86_400_000).toISOString();
    const rpc=vi.fn(async ({ method }: { method:string }) => method.endsWith('listResources')
      ? { resources:[{ id:'r',providerId:'claude-code',label:'Claude Code',accountKey:'acct' }] }
      : { accountKey:'acct',observedAt:Date.now(),usage:{ status:'ok',planLabel:'Max',windows:[{ kind:'weekly',id:'w',label:'Weekly limit',usedPercent:50,resetsAt,model:null }] } });
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] },
      plugins:{ experimental_discoverRpc: async () => [{ pluginId:'provider-claude-code' }],callRpc: rpc } } as never });
    const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
    const settings=bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' },rollupRetentionDays:{ type:'number',default:200,label:'Rollups' },referenceModel:{ type:'string',default:'claude-sonnet-5-5',label:'Reference' },includeOutsideBb:{ type:'boolean',default:false,label:'Outside' },priceOverrides:{ type:'string',default:'{}',label:'Overrides' },heavyTargetPercent:{ type:'number',default:50,label:'Target' } });
    registerCli(bb,registerRpc(bb,db,settings));
    try {
      const r=await harness.behavior.callRpc('limits',{}) as { heavyModels:string[];accounts:{ windows:{ elapsedShare:number;runsOutAt:number|null;usage:unknown }[] }[] };
      expect(r.heavyModels).toContain('opus');
      expect((r as unknown as { heavyTarget:number|null }).heavyTarget).toBe(0.5);
      expect(r.accounts[0]!.windows[0]).toMatchObject({ runsOutAt:expect.any(Number),usage:{ heavy:{ usd:0,calls:0 },heavyShare:null } });
      expect(r.accounts[0]!.windows[0]!.elapsedShare).toBeCloseTo(1/7);
      await harness.behavior.callRpc('limits',{});
      expect(rpc).toHaveBeenCalledTimes(2); // cached for a minute: one list and one get
      const text=(await harness.behavior.runCli(['limits'])).stdout;
      expect(text).toContain('Weekly limit: 50% used'); expect(text).toContain('runs out');
      expect(text).toContain('target: under 50% of cost');
      await settings.experimental_set({ heavyTargetPercent: 0 });
      expect(await harness.behavior.callRpc('limits',{})).toMatchObject({ heavyTarget:null });
    } finally { await harness.lifecycle.dispose(); }
  });
  it('shows only this machine\'s accounts and shared ones, not another machine\'s login', async () => {
    const scope=(hostId:string) => ({ kind:'host',hostId,hostName:'Mac' });
    const rpc=async ({ method,input }: { method:string;input:{ resourceId?:string } }) => method.endsWith('listResources')
      ? { resources:[{ id:'here',providerId:'codex',label:'Codex',accountKey:'acct',scope:scope('host_a') },{ id:'there',providerId:'codex',label:'Codex',accountKey:null,scope:scope('host_b') },{ id:'pool',providerId:'codex',label:'Pooled',accountKey:'pool',scope:{ kind:'shared' } }] }
      : input.resourceId==='there' ? { accountKey:null,observedAt:null,usage:{ status:'expired' } } : { accountKey:input.resourceId,observedAt:1,usage:{ status:'ok',planLabel:'Pro',windows:[] } };
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] },
      system:{ config: async () => ({ primaryHostId:'host_a' }) },
      plugins:{ experimental_discoverRpc: async () => [{ pluginId:'provider-codex' }],callRpc: rpc } } as never });
    const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
    registerRpc(bb,db,bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' } }) as never);
    try {
      const r=await harness.behavior.callRpc('limits',{}) as { accounts:{ label:string;status:string }[] };
      expect(r.accounts.map(a => [a.label,a.status])).toEqual([['Codex','ok'],['Pooled','ok']]);
      expect(r.accounts[0]).not.toHaveProperty('host');
    } finally { await harness.lifecycle.dispose(); }
  });
  it('offers the priced models of bb providers as reference models, with the built-in list as fallback', async () => {
    const models: Record<string,string[]> = { 'claude-code':['claude-opus-5-5','claude-sonnet-5-5','mystery-model'], codex:['gpt-6.2-sol'], 'local-models':['qwen-local'] };
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] },
      providers:{ list: async () => Object.keys(models).map(id => ({ id })),models: async ({ providerId }: { providerId:string }) => ({ models:models[providerId]!.map(model => ({ model,displayName:model.toUpperCase() })),modelLoadError:null }) } } as never });
    const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
    const settings=bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' },rollupRetentionDays:{ type:'number',default:200,label:'Rollups' },referenceModel:{ type:'string',default:'claude-sonnet-5-5',label:'Reference' },includeOutsideBb:{ type:'boolean',default:false,label:'Outside' },priceOverrides:{ type:'string',default:'{}',label:'Overrides' } });
    registerRpc(bb,db,settings);
    try {
      const r=await harness.behavior.callRpc('config.options',{}) as { referenceModels:{ model:string;provider:string|null }[] };
      // Unpriced and local models are left out: they cannot price a saving.
      expect(r.referenceModels.map(m => [m.provider,m.model])).toEqual([['claude-code','claude-opus-5-5'],['claude-code','claude-sonnet-5-5'],['codex','gpt-6.2-sol']]);
      await harness.behavior.callRpc('config.set',{ key:'referenceModel',value:'gpt-6.2-sol' });
      expect((await settings.get()).referenceModel).toBe('gpt-6.2-sol');
      await expect(harness.behavior.callRpc('config.set',{ key:'referenceModel',value:'mystery-model' })).rejects.toThrow();
      // Providers gone: the last list they gave is offered, not the built-in one.
      for (const k of Object.keys(models)) models[k]=[];
      expect(((await harness.behavior.callRpc('config.options',{})) as { referenceModels:{ model:string }[] }).referenceModels.map(m => m.model)).toEqual(['claude-opus-5-5','claude-sonnet-5-5','gpt-6.2-sol']);
    } finally { await harness.lifecycle.dispose(); }
    const fallback=setup();
    try { expect(((await fallback.harness.behavior.callRpc('config.options',{})) as { referenceModels:{ model:string }[] }).referenceModels.map(m => m.model)).toContain('claude-sonnet-5-5'); }
    finally { await fallback.harness.lifecycle.dispose(); }
  });
  it('reads and sets one global setting at a time, validated by that setting', async () => {
    const { harness,settings }=setup();
    try {
      await harness.behavior.callRpc('config.set',{ key:'rawRetentionDays',value:45 });
      expect((await settings.get()).rawRetentionDays).toBe(45);
      expect((await harness.behavior.callRpc('config.get',{}) as { values:Record<string,unknown> }).values.rawRetentionDays).toBe(45);
      await expect(harness.behavior.callRpc('config.set',{ key:'rawRetentionDays',value:3 })).rejects.toThrow();
      await expect(harness.behavior.callRpc('config.set',{ key:'priceOverrides',value:'not json' })).rejects.toThrow();
      await expect(harness.behavior.callRpc('config.set',{ key:'nope',value:1 })).rejects.toThrow();
      expect((await settings.get()).rawRetentionDays).toBe(45);
    } finally { await harness.lifecycle.dispose(); }
  });
  it('answers limits at once from the last known accounts while providers are slow, and marks them stale', async () => {
    const never=new Promise<never>(() => {});
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] },
      plugins:{ experimental_discoverRpc: async () => [{ pluginId:'provider-claude-code' }],callRpc: () => never } } as never });
    const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
    const account={ providerId:'claude-code',label:'Claude Code',plan:null,status:'ok',message:null,observedAt:1,windows:[] };
    // A window whose reset has passed belongs to a period that is over: dropped, not shown with old numbers.
    const over={ id:'w',label:'5h',kind:'session',usedPercent:80,resetsAt:1000,model:null };
    db.prepare("INSERT INTO cursor(name,value) VALUES ('limits-last',?)").run(JSON.stringify({ at:1,accounts:[{ ...account,windows:[over] }] }));
    const settings=bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' },rollupRetentionDays:{ type:'number',default:200,label:'Rollups' },referenceModel:{ type:'string',default:'claude-sonnet-5-5',label:'Reference' },includeOutsideBb:{ type:'boolean',default:false,label:'Outside' },priceOverrides:{ type:'string',default:'{}',label:'Overrides' } });
    registerRpc(bb,db,settings);
    try { expect((await harness.behavior.callRpc('limits',{}) as { accounts:unknown[] }).accounts).toEqual([{ ...account,message:'reset, no fresh report yet',stale:true }]); }
    finally { await harness.lifecycle.dispose(); }
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
it('exposes wakeCost unknown/not_found, CLI, and a 30 second watchlist memo',async()=>{
 vi.useFakeTimers();vi.setSystemTime(10000000);const {harness,db}=setup();
 try{
  db.prepare("INSERT INTO threads(id,provider_id,title) VALUES ('ctx','codex','Context')").run();
  const unknown=await harness.behavior.callRpc('wakeCost',{threadId:'ctx'});expect(unknown).toMatchObject({contextTokens:null,coldCostUsd:null});
  await expect(harness.behavior.callRpc('wakeCost',{threadId:'absent'})).rejects.toMatchObject({code:'not_found'});
  db.prepare("INSERT INTO usage_raw(key,thread_id,provider,model,ts,prompt_tokens,fresh_in) VALUES ('call','ctx','codex','gpt-6.1-sol',?,300000,300000)").run(Date.now());
  expect(await harness.behavior.callRpc('watchlist',{})).toMatchObject({items:[{threadId:'ctx',contextTokens:300000}]});
  const cli=await harness.behavior.runCli(['wake-cost','ctx','--json']);expect(cli.exitCode).toBe(0);expect(JSON.parse(cli.stdout)).toMatchObject({threadId:'ctx',contextTokens:300000});
  expect((await harness.behavior.runCli(['wake-cost','ctx'])).stdout).toContain('estimate');
  db.prepare('UPDATE usage_raw SET prompt_tokens=10').run();
  await vi.advanceTimersByTimeAsync(29999);expect((await harness.behavior.callRpc('watchlist',{}) as {items:unknown[]}).items).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);expect(await harness.behavior.callRpc('watchlist',{})).toEqual({items:[]});
 }finally{await harness.lifecycle.dispose();vi.useRealTimers();}
});

describe('public limits.get', () => {
  const NOW=1700002400000, L=604800000, RESET=1700600000000, START=RESET-L, H=3_600_000, M=60_000;
  const asPlugin={ experimental_caller:{ kind:'plugin' as const,pluginId:'example-plugin' } };
  type Win={ kind:string;id:string;label:string;usedPercent:number;resetsAt:string;model:string|null };
  const weekly=(usedPercent:number,resetsAt=RESET,label='Weekly limit'): Win => ({ kind:'weekly',id:label==='Weekly limit'?'secondary':label,label,usedPercent,resetsAt:new Date(resetsAt).toISOString(),model:null });
  const provider={ pluginId:'provider-claude-code',resourceId:'res-example' }, pool={ pluginId:'account-pool',resourceId:'pool-acct-example' };
  type Opts={ windows?:(call:number) => Win[]; claudeAccounts?:number; codex?:boolean; observedAt?:number; outside?:boolean };
  async function open(o:Opts={}) {
    vi.useFakeTimers({ toFake:['Date'] }); vi.setSystemTime(NOW);
    let calls=0;
    const rpc=async ({ pluginId,method,input }: { pluginId:string;method:string;input:{ resourceId?:string } }) => {
      if (method==='account.list') return [];
      if (method.endsWith('listResources')) return pluginId==='provider-claude-code'
        ? { resources:Array.from({ length:o.claudeAccounts ?? 1 },(_,i) => ({ id:i ? `res-${i}` : 'res-example',providerId:'claude-code',label:'Claude Code',accountKey:i ? `acct-${i}` : 'acct-example' })) }
        : { resources:[{ id:'pool-acct-example',providerId:'claude-code',label:'Claude Code',accountKey:'acct-example' },
          ...(o.codex ? [{ id:'pool-acct-example-2',providerId:'codex',label:'Codex',accountKey:'acct-example',scope:{ kind:'host',hostId:'host_example',hostName:'Example Mac' } }] : [])] };
      if (input.resourceId==='pool-acct-example-2') return { accountKey:'acct-example',observedAt:null,usage:{ status:'unauthenticated',message:'sign in again' } };
      if (input.resourceId==='res-example') calls++;
      const key=input.resourceId==='res-example' || input.resourceId==='pool-acct-example' ? 'acct-example' : `acct-${input.resourceId!.slice(4)}`;
      return { accountKey:key,observedAt:o.observedAt ?? NOW-M,usage:{ status:'ok',planLabel:'Max 5x',windows:o.windows?.(calls) ?? [weekly(1)] } };
    };
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] },system:{ config: async () => ({ primaryHostId:'host_example' }) },
      plugins:{ experimental_discoverRpc: async () => [{ pluginId:'account-pool' },{ pluginId:'provider-claude-code' }],callRpc: rpc } } as never });
    const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
    const settings=bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' },rollupRetentionDays:{ type:'number',default:200,label:'Rollups' },referenceModel:{ type:'string',default:'claude-sonnet-5-5',label:'Reference' },includeOutsideBb:{ type:'boolean',default:o.outside ?? false,label:'Outside' },priceOverrides:{ type:'string',default:'{}',label:'Overrides' } });
    registerRpc(bb,db,settings);
    const get=async (input:{ hostId?:string }={}) => await harness.behavior.callRpc('limits.get',input,asPlugin) as z.infer<typeof limitsGetSchema>;
    return { db,harness,get,settings,close: async () => { await harness.lifecycle.dispose(); vi.useRealTimers(); } };
  }
  const seedPrevious=(db:{ prepare(sql:string):{ run(...a:unknown[]):unknown } }) => db.prepare("INSERT INTO cursor(name,value) VALUES ('limits-windows',?)")
    .run(JSON.stringify({ 'claude-code\u0000acct-example\u0000Weekly limit':{ last:{ startsAt:START-L,resetsAt:START,observedAt:START-H,usedPercent:40 } } }));

  it('gives other plugins every account with its windows; early in a week it projects the previous window\'s pace (shared fixture)', async () => {
    const t=await open({ codex:true });
    try {
      seedPrevious(t.db);
      // The previous pace (40% over that window) weighs as two days of observed time against 1% in the 2 h since the reset.
      const asOf=NOW-M, prevPace=40/((START-H)-(START-L)), PRIOR=2*24*H, forecastPercent=1+(1+prevPace*PRIOR)/(asOf-START+PRIOR)*(RESET-asOf);
      expect(await t.get()).toEqual({ version:1,now:NOW,accounts:[
        { accountId:'claude-code\u0000acct-example',providerId:'claude-code',label:'Claude Code',plan:'Max 5x',host:null,source:provider,sources:[provider,pool],
          status:'ok',message:null,observedAt:asOf,stale:false,
          windows:[{ key:'Weekly limit',id:'secondary',label:'Weekly limit',kind:'weekly',model:null,usedPercent:1,resetsAt:RESET,startsAt:START,lengthMs:L,
            elapsedShare:(asOf-START)/L,forecastPercent,pace:forecastPercent/100,runsOutAt:null,room:true,
            forecast:{ method:'previous-window',reason:null,usdPerHour:null,usdPerPercent:null },asOf,stale:false,seenAt:null }] },
        { accountId:'codex\u0000acct-example',providerId:'codex',label:'Codex',plan:null,host:{ id:'host_example',name:'Example Mac' },
          source:{ pluginId:'account-pool',resourceId:'pool-acct-example-2' },sources:[{ pluginId:'account-pool',resourceId:'pool-acct-example-2' }],
          status:'unauthenticated',message:'sign in again',observedAt:null,stale:false,windows:[] },
      ] });
      expect(forecastPercent).toBeCloseTo(42.5,1);
      // Another machine's account is left out unless that machine is asked for; shared ones always come.
      expect((await t.get({ hostId:'host_other' })).accounts.map(a => a.providerId)).toEqual(['claude-code']);
    } finally { await t.close(); }
  });

  describe('weighs a fresh burst against the previous window\'s pace (10% a day)', () => {
    // A previous week at 70%, read 1 h before its reset: 70% over 7 days less an hour.
    const seed=(db:Parameters<typeof seedPrevious>[0]) => db.prepare("INSERT INTO cursor(name,value) VALUES ('limits-windows',?)")
      .run(JSON.stringify({ 'claude-code\u0000acct-example\u0000Weekly limit':{ last:{ startsAt:START-L,resetsAt:START,observedAt:START-H,usedPercent:70 } } }));
    const read=async (used:number,hoursIn:number,o:Opts={},extra?:(db:Parameters<typeof seedPrevious>[0]) => void) => {
      const t=await open({ observedAt:START+hoursIn*H,windows:() => [weekly(used)],...o });
      try { seed(t.db); extra?.(t.db); vi.setSystemTime(START+hoursIn*H+M); return (await t.get()).accounts[0]!.windows[0]!; }
      finally { await t.close(); }
    };
    it('5% at 1% elapsed stays near the previous pace, not 500%', async () => {
      const w=await read(5,0.01*24*7); // 1.68 h
      expect(w.forecast.method).toBe('previous-window');
      expect(w.forecastPercent!).toBeGreaterThan(74); expect(w.forecastPercent!).toBeLessThan(95);
      expect(w).toMatchObject({ room:true,runsOutAt:null });
    });
    it('a sustained heavy burst still raises it and runs out', async () => {
      const w=await read(60,24);
      expect(w.forecast.method).toBe('previous-window');
      expect(w.forecastPercent!).toBeGreaterThan(150);
      expect(w).toMatchObject({ room:false,runsOutAt:expect.any(Number) });
    });
    it('leaves windows shorter than a week as they are', async () => {
      const fiveHour={ kind:'five-hour',id:'primary',label:'Five-hour limit',usedPercent:5,resetsAt:new Date(NOW+5*H-10*M).toISOString(),model:null };
      const t=await open({ windows:() => [fiveHour] });
      try { expect((await t.get()).accounts[0]!.windows[0]).toMatchObject({ forecast:{ method:'window-average' },forecastPercent:expect.any(Number) }); }
      finally { await t.close(); }
    });
    it('does not switch method or jump at 5% used, even with attributable recent spend', async () => {
      const spend=(db:Parameters<typeof seedPrevious>[0]) => {
        const insert=db.prepare("INSERT INTO usage_hourly(hour,provider,model,tier,band,project_id,thread_id,calls,fresh_in) VALUES (?,'claude-code','claude-sonnet-5-5','standard',0,'p','a',1,1000000)");
        for (let ts=START-8*24*H; ts<START+2*H; ts+=6*H) insert.run(Math.floor(ts/H)*H);
        db.prepare("INSERT INTO usage_raw(key,ts,provider,model,fresh_in) VALUES ('r',?,'claude-code','claude-sonnet-5-5',1000000)").run(START+30*M);
        db.prepare("INSERT INTO cursor(name,value) VALUES ('backfill-progress','{\"done\":true}')").run();
        db.prepare("INSERT INTO source_status(source,state) VALUES ('claude-file','ok'),('bb-events','ok')").run();
      };
      const [four,six]=[await read(4,2,{ outside:true },spend),await read(6,2,{ outside:true },spend)];
      expect([four.forecast.method,six.forecast.method]).toEqual(['previous-window','previous-window']);
      // The two extra points count once and with the weight of their 2 hours: the blend's own step, not a switch of method.
      const asOf=START+2*H, step=2+2/(2*H+2*24*H)*(RESET-asOf);
      expect(six.forecastPercent!-four.forecastPercent!).toBeCloseTo(step,6);
      expect(six.pace!).toBeLessThan(1);
    });
  });

  it('says there is no previous window when it has not watched a reset, and claims no room', async () => {
    const t=await open();
    try {
      expect((await t.get()).accounts[0]!.windows[0]).toMatchObject({ forecastPercent:null,pace:null,runsOutAt:null,room:null,
        forecast:{ method:null,reason:'no-previous-window',usdPerHour:null,usdPerPercent:null } });
    } finally { await t.close(); }
  });

  describe('converts the last week\'s spend to percent only when it is the account\'s alone and complete', () => {
    // A priced call every 6 hours for 8 days, and two in the first two hours of the week.
    const history=(db:Parameters<typeof seedPrevious>[0],extra:{ from?:number;model?:string }={}) => {
      const rows=[]; for (let ts=extra.from ?? NOW-8*24*H; ts<NOW-H; ts+=6*H) rows.push(ts);
      rows.push(START+30*M,START+90*M);
      const insert=db.prepare(`INSERT INTO usage_hourly(hour,provider,model,tier,band,project_id,thread_id,calls,fresh_in) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT DO UPDATE SET calls=calls+1,fresh_in=fresh_in+excluded.fresh_in`);
      const raw=db.prepare("INSERT INTO usage_raw(key,ts,provider,model,fresh_in) VALUES (?,?,?,?,?)");
      for (const ts of rows) { insert.run(Math.floor(ts/H)*H,'claude-code',extra.model ?? 'claude-sonnet-5-5','standard',0,'p','a',1,1_000_000); raw.run(`r${ts}`,ts,'claude-code',extra.model ?? 'claude-sonnet-5-5',1_000_000); }
      db.prepare("INSERT INTO cursor(name,value) VALUES ('backfill-progress','{\"done\":true}')").run();
      db.prepare("INSERT INTO source_status(source,state) VALUES ('claude-file','ok'),('bb-events','ok')").run();
    };
    const early=(used:number) => () => [weekly(used)];
    const steady=() => [weekly(10,NOW+5*24*H)];
    const method=async (o:Opts,seed:(db:Parameters<typeof seedPrevious>[0]) => void=history) => {
      const t=await open({ outside:true,...o });
      try { seed(t.db); return (await t.get()).accounts.find(a => a.accountId==='claude-code\u0000acct-example')!.windows[0]!.forecast; }
      finally { await t.close(); }
    };
    it('early from 3% used without a previous reading, steady with full history', async () => {
      expect(await method({ windows:early(3) })).toMatchObject({ method:'recent-spend',reason:null,usdPerHour:expect.any(Number),usdPerPercent:expect.any(Number) });
      expect(await method({ windows:early(2) })).toMatchObject({ method:null,reason:'no-previous-window' });
      expect(await method({ windows:steady })).toMatchObject({ method:'recent-spend' });
    });
    it('falls back to the window average otherwise', async () => {
      expect(await method({ windows:steady,claudeAccounts:2 })).toMatchObject({ method:'window-average',usdPerHour:null });
      expect(await method({ windows:steady,outside:false })).toMatchObject({ method:'window-average' });
      expect(await method({ windows:steady },db => history(db,{ from:NOW-3*24*H }))).toMatchObject({ method:'window-average' });
      expect(await method({ windows:steady },db => history(db,{ model:'mystery-model' }))).toMatchObject({ method:'window-average' });
      expect(await method({ windows:steady },db => { history(db); db.prepare("UPDATE source_status SET state='degraded' WHERE source='claude-file'").run(); })).toMatchObject({ method:'window-average' });
      expect(await method({ windows:steady },db => { history(db); db.prepare("UPDATE cursor SET value='{\"done\":false}' WHERE name='backfill-progress'").run(); })).toMatchObject({ method:'window-average' });
      expect(await method({ windows:steady },db => { history(db); db.prepare("DELETE FROM source_status WHERE source='bb-events'").run(); })).toMatchObject({ method:'window-average' });
    });
  });

  it('computes as of the measurement and never reports room without evidence', async () => {
    const t=await open({ observedAt:NOW-40*M,windows:() => [weekly(50,NOW+5*24*H),weekly(100,NOW+5*24*H,'Weekly · Fable')] });
    try {
      const [half,out]=(await t.get()).accounts[0]!.windows;
      expect(half).toMatchObject({ asOf:NOW-40*M,elapsedShare:(NOW-40*M-(NOW+5*24*H-L))/L,room:false,forecast:{ method:'window-average' } });
      expect(half!.pace).toBeCloseTo(0.5/half!.elapsedShare!);
      expect(out).toMatchObject({ key:'Weekly · Fable',room:false,forecast:{ reason:'exhausted' } });
    } finally { await t.close(); }
  });

  it('reports a window or an account it no longer hears about as stale, with no room', async () => {
    const t=await open({ windows:call => call<2 ? [weekly(10,NOW+5*24*H),weekly(20,NOW+5*24*H,'Weekly · Fable')] : [weekly(10,NOW+5*24*H)] });
    try {
      expect((await t.get()).accounts[0]!.windows.map(w => w.room)).toEqual([true,true]);
      vi.setSystemTime(NOW+61_000); await t.get();
      await vi.waitFor(async () => expect((await t.get()).accounts[0]!.windows[1]).toMatchObject({ stale:true,seenAt:NOW,asOf:NOW,room:null }));
      expect((await t.get()).accounts[0]!.windows[0]).toMatchObject({ stale:false,room:true });
    } finally { await t.close(); }
    const never=new Promise<never>(() => {});
    vi.useFakeTimers({ toFake:['Date'] }); vi.setSystemTime(NOW);
    const { bb,harness }=createFakePluginHost({ pluginId:'tokenomos',sdk:{ projects:{ list: async () => [] },plugins:{ experimental_discoverRpc: async () => [{ pluginId:'provider-claude-code' }],callRpc: () => never } } as never });
    const db=bb.storage.database(); bb.storage.migrate(db,MIGRATIONS);
    db.prepare("INSERT INTO cursor(name,value) VALUES ('limits-last',?)").run(JSON.stringify({ at:NOW-H,accounts:[{ providerId:'claude-code',label:'Claude Code',plan:null,status:'ok',message:null,observedAt:NOW-H,
      windows:[{ id:'w',label:'Weekly limit',kind:'weekly',usedPercent:10,resetsAt:NOW+5*24*H,model:null }] }] }));
    registerRpc(bb,db,bb.settings.define({ rawRetentionDays:{ type:'number',default:30,label:'Raw' } }) as never);
    try { expect((await harness.behavior.callRpc('limits.get',{},asPlugin) as z.infer<typeof limitsGetSchema>).accounts[0]).toMatchObject({ stale:true,windows:[{ room:null }] }); }
    finally { await harness.lifecycle.dispose(); vi.useRealTimers(); }
  });
});
