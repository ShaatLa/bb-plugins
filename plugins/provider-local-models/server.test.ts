import test from 'node:test';
import assert from 'node:assert/strict';
import plugin from './server.ts';
import type { BbPluginApi } from '@get-bb/plugin-sdk';

test('registers the provider and publishes a single usage row listing the models', async()=>{
  let declaration:any;const contracts:any={},handlers:any={};
  const host={id:'machine-1',name:'Local',status:'connected'};
  const usage={status:'ok',accountEmail:null,planLabel:'Local',windows:[{label:'gpt-oss-20b\u2063',usedPercent:0,resetsAt:null}]};
  let env:any;const bb={agents:{registerTool:()=>{},configure:()=>{}},cli:{register:()=>{}},pluginId:'local-models',settings:{define:()=>({get:async()=>({baseUrl:'',defaultModel:'m'})})},providers:{register:(value:any)=>{declaration=value;},experimental_contributeEnv:(id:string,resolve:any)=>{assert.equal(id,'local-models');env=resolve;}},rpc:{register:(c:any,h:any)=>{Object.assign(contracts,c);Object.assign(handlers,h);}},sdk:{hosts:{list:async()=>[host],get:async()=>host},providers:{list:async()=>[{id:'local-models',pluginId:'local-models'}]},system:{usageLimits:async()=>({'local-models':usage})}}} as unknown as BbPluginApi;
  plugin(bb);
  assert.equal(declaration.id,'local-models');
  assert.deepEqual(declaration.maintenance,{health:true,usage:true,installation:false});
  assert.deepEqual(declaration.deriveProviderOptions({settings:{baseUrl:'',defaultModel:'m'}}),{baseUrl:'http://127.0.0.1:9931/v1',defaultModel:'m'});
  assert.deepEqual((await env({})).map((e:any)=>[e.name,e.value]),[['LM_BASE_URL','http://127.0.0.1:9931/v1'],['LM_DEFAULT_MODEL','m']]);
  const list='provider-usage.v1.listResources',fetch='provider-usage.v1.getResource';
  const inventory=contracts[list].output.parse(await handlers[list]({}));
  assert.equal(inventory.resources[0].label,'Local models');
  const value=contracts[fetch].output.parse(await handlers[fetch]({resourceId:inventory.resources[0].id,refresh:true}));
  assert.equal(value.usage.windows[0].label,'gpt-oss-20b\u2063');
  assert.equal(value.usage.windows[0].usedPercent,0);
});

test('registers CLI and native tool, queries fake router and excludes self',async()=>{
  const {startModelsServer}=await import('./test/models-server.ts');
  const server=await startModelsServer();let cli:any,tool:any,configure:any;
  let baseUrl=server.baseUrl;
  const bb={pluginId:'local-models',server:{experimental_dataDir:'/tmp'},settings:{define:()=>({get:async()=>({baseUrl,defaultModel:''})})},providers:{register:()=>{},experimental_contributeEnv:()=>{}},rpc:{register:()=>{}},agents:{registerTool:(v:any)=>tool=v,configure:(v:any)=>configure=v},cli:{register:(v:any)=>cli=v}} as unknown as BbPluginApi;
  plugin(bb);
  const ctx={signal:new AbortController().signal};
  try{
    assert.deepEqual(cli.commands.map((c:any)=>c.name),['status','ask','unload']);
    assert.equal(tool.name,'local_models_ask');assert.deepEqual(configure({provider:{id:'local-models'}}).tools,[]);
    assert.deepEqual(configure({provider:{id:'codex'}}).tools,['local_models_ask']);
    const result=await cli.run(['ask','hello','--effort','high','--json'],ctx);
    assert.equal(result.exitCode,0);assert.equal(JSON.parse(result.stdout).content,'one shot reply');
    assert.equal(server.chats.at(-1).reasoning_effort,'xhigh');
    assert.equal(await tool.execute({prompt:'hello'},ctx),'one shot reply');
    const status=await cli.run(['status','--json'],ctx);assert.equal(status.exitCode,0);assert.equal(JSON.parse(status.stdout).models[0].contextSize,65536);
    assert.equal((await cli.run(['unload','--all'],ctx)).exitCode,0);
    assert.equal((await cli.run(['ask','hi','--model','missing','--json'],ctx)).exitCode,1);
    baseUrl='http://127.0.0.1:1/v1';
    assert.equal((await tool.execute({prompt:'hello'},ctx)).isError,true);
  }finally{await server.close();}
});
