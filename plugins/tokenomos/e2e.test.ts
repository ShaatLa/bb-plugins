import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import { expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import plugin from './server';

it('ingests events and transcripts, resumes after reload and reprices without new usage', async()=> {
  vi.useFakeTimers();vi.setSystemTime(1_800_000_000_000);
  const root=mkdtempSync(join(tmpdir(),'tokenomos-e2e-'));
  vi.stubEnv('TOKENOMOS_CLAUDE_ROOT',root);
  vi.stubEnv('TOKENOMOS_CODEX_ROOT',join(root,'codex'));
  vi.stubEnv('TOKENOMOS_CODEX_ARCHIVED_ROOT',join(root,'archive'));
  const cwd='/project';const dir=join(root,'-project');mkdirSync(dir);
  const thread=makeThreadResponse({id:'t',providerId:'claude-code',projectId:'p',environmentId:'env',createdAt:Date.now()-10000});
  const events: Array<{id:string;seq:number;createdAt:number;scope:{kind:'thread'};type:string;data:unknown}>=[];
  let seq=0;
  const append=(id:string)=> {
    events.push({id:`e${++seq}`,seq,createdAt:Date.now(),scope:{kind:'thread'},type:'thread/identity',data:{providerThreadId:'session'}});
    appendFileSync(join(dir,'session.jsonl'),JSON.stringify({type:'assistant',timestamp:new Date().toISOString(),requestId:id,message:{id,model:'claude-sonnet-5-5',usage:{input_tokens:100,output_tokens:20}}})+'\n');
  };
  const host=createFakePluginHost({pluginId:'tokenomos',sdk:{
    threads:{list:async()=>[],get:async()=>thread,events:{list:async(a)=>events.filter(e=>e.seq>Number(a.afterSeq)).slice(0,100)}},
    environments:{get:async()=>({path:cwd})},
    plugins:{callRpc:async()=>{throw Object.assign(new Error('not found'),{code:'unknown_method'});}},
  }});
  let harness=host.harness;
  const cost=async()=>await harness.behavior.callRpc('costs.sum',{threadIds:['t'],includeDescendants:false}) as {cost:{usd:number;tokens:{freshIn:number;output:number}}};
  try {
    plugin(host.bb);harness.behavior.runService('ingest');
    append('one');await harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:seq});await vi.advanceTimersByTimeAsync(5000);
    expect((await cost()).cost).toMatchObject({usd:0.0004,tokens:{freshIn:100,output:20}});
    const next=await harness.lifecycle.reload(plugin);harness=next.harness;harness.behavior.runService('ingest');
    append('two');await harness.behavior.emitThreadEvent('experimental_thread.events',{thread,sequence:seq});await vi.advanceTimersByTimeAsync(5000);
    expect((await cost()).cost).toMatchObject({usd:0.0008,tokens:{freshIn:200,output:40}});
    const before=harness.experimental_rpcInvalidations.length;
    await harness.behavior.setSettings({priceOverrides:JSON.stringify({'claude-sonnet-5-5':{input:6}})});await vi.advanceTimersByTimeAsync(5000);
    expect((await cost()).cost.usd).toBeCloseTo(0.0016);
    expect((await cost()).cost.tokens.freshIn).toBe(200);expect(harness.experimental_rpcInvalidations.length).toBeGreaterThan(before);
    expect(harness.logEntries.filter(e=>e.level==='warn')).toEqual([]);
  } finally {await harness.lifecycle.dispose();rmSync(root,{recursive:true,force:true});vi.unstubAllEnvs();vi.useRealTimers();}
});
