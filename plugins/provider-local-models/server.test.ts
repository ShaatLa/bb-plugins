import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './server.ts';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

test('registers the provider and publishes unlimited usage per model', async()=>{
  let declaration:any;const contracts:any={},handlers:any={};
  const host={id:'machine-1',name:'Local',status:'connected'};
  const usage={status:'ok',accountEmail:null,planLabel:'Local',windows:[{label:'gpt-oss-20b\u2063',usedPercent:0,resetsAt:null}]};
  let env:any;const bb={pluginId:'local-models',settings:{define:()=>({get:async()=>({baseUrl:'',defaultModel:'m'})})},providers:{register:(value:any)=>{declaration=value;},experimental_contributeEnv:(id:string,resolve:any)=>{assert.equal(id,'local-models');env=resolve;}},rpc:{register:(c:any,h:any)=>{Object.assign(contracts,c);Object.assign(handlers,h);}},sdk:{hosts:{list:async()=>[host],get:async()=>host},providers:{list:async()=>[{id:'local-models',pluginId:'local-models'}]},system:{usageLimits:async()=>({'local-models':usage})}}} as unknown as BbPluginApi;
  plugin(bb);
  assert.equal(declaration.id,'local-models');
  assert.deepEqual(declaration.maintenance,{health:true,usage:true,installation:false});
  assert.deepEqual(declaration.deriveProviderOptions({settings:{baseUrl:'',codexCommand:'/bin/codex',defaultModel:'m'}}),{baseUrl:'http://127.0.0.1:9931/v1',codexCommand:'/bin/codex',defaultModel:'m'});
  assert.deepEqual((await env({})).map((e:any)=>[e.name,e.value]),[['LM_BASE_URL','http://127.0.0.1:9931/v1'],['LM_DEFAULT_MODEL','m']]);
  const list='provider-usage.v1.listResources',fetch='provider-usage.v1.getResource';
  const inventory=contracts[list].output.parse(await handlers[list]({}));
  assert.equal(inventory.resources[0].label,'Local models');
  const value=contracts[fetch].output.parse(await handlers[fetch]({resourceId:inventory.resources[0].id,refresh:true}));
  assert.equal(value.usage.windows[0].label,'gpt-oss-20b\u2063');
  assert.equal(value.usage.windows[0].usedPercent,0);
});
