import test from 'node:test';
import assert from 'node:assert/strict';
import plugin, { createPlugin } from "./server.ts";
import type { BbPluginApi } from '@get-bb/plugin-sdk';

test('registers the provider without provider usage', async()=>{
  let declaration:any;const contracts:any={},handlers:any={};
  let env:any;const bb={log:{error:()=>{},info:()=>{}},onDispose:()=>{},agents:{registerTool:()=>{},configure:()=>{}},cli:{register:()=>{}},pluginId:'local-models',settings:{define:()=>({onChange:()=>{},get:async()=>({baseUrl:'',defaultModel:'m'})})},providers:{register:(value:any)=>{declaration=value;},experimental_contributeEnv:(id:string,resolve:any)=>{assert.equal(id,'local-models');env=resolve;}},rpc:{register:(c:any,h:any)=>{Object.assign(contracts,c);Object.assign(handlers,h);}}} as unknown as BbPluginApi;
  plugin(bb);
  assert.equal(declaration.id,'local-models');
  assert.deepEqual(declaration.maintenance,{health:true,usage:false,installation:false});
  assert.deepEqual(declaration.deriveProviderOptions({settings:{baseUrl:'',defaultModel:'m'}}),{baseUrl:'http://127.0.0.1:9931/v1',splash:false,defaultModel:'m'});
  assert.equal(declaration.deriveProviderOptions({settings:{baseUrl:'http://llama/v1',splash:true,splashProxyPort:8123}}).baseUrl,'http://llama/v1, http://127.0.0.1:8123/v1');
  assert.deepEqual((await env({})).map((e:any)=>[e.name,e.value]),[['LM_SPLASH','0'],['LM_BASE_URL','http://127.0.0.1:9931/v1'],['LM_DEFAULT_MODEL','m']]);
  for(const name of ['splashStatus','splashDownload','splashCancel','splashDelete','setContext','doctor','installSplash'])assert.ok(contracts[name]);
  assert.equal(contracts.installSplash.input.safeParse({confirmed:false,command:'brew install incoai/tap/splash'}).success,false);
  assert.equal(contracts['provider-usage.v1.listResources'],undefined);
});

test('registers CLI and native tool, queries fake router and excludes self',async()=>{
  const {startModelsServer}=await import('./test/models-server.ts');
  const server=await startModelsServer();let cli:any,tool:any,configure:any;
  let baseUrl=server.baseUrl;
  const bb={log:{error:()=>{},info:()=>{}},onDispose:()=>{},pluginId:'local-models',server:{experimental_dataDir:'/tmp'},settings:{define:()=>({onChange:()=>{},get:async()=>({baseUrl,defaultModel:'',modelGuidance:' Use org/Large for specs. '})})},providers:{register:()=>{},experimental_contributeEnv:()=>{}},rpc:{register:()=>{}},agents:{registerTool:(v:any)=>tool=v,configure:(v:any)=>configure=v},cli:{register:(v:any)=>cli=v}} as unknown as BbPluginApi;
  plugin(bb);
  const ctx={signal:new AbortController().signal};
  try{
    assert.deepEqual(cli.commands.map((c:any)=>c.name),['status','ask','splash-setup','splash-models','splash-delete','splash-status','context','doctor','install-splash','unload']);
    assert.equal((await cli.run(['splash-status','--json'],ctx)).exitCode,0);
    assert.equal((await cli.run(['splash-setup','org/Unknown'],ctx)).exitCode,1);
    assert.equal(tool.name,'local_models_ask');assert.deepEqual(configure({provider:{id:'local-models'}}).tools,[]);
    assert.deepEqual(configure({provider:{id:'codex'}}).tools,['local_models_ask']);
    assert.match(configure({provider:{id:'codex'}}).instructions,/\nUse org\/Large for specs\.$/);assert.equal(configure({provider:{id:'local-models'}}).instructions,undefined);
    const result=await cli.run(['ask','hello','--effort','high','--json'],ctx);
    assert.equal(result.exitCode,0);assert.equal(JSON.parse(result.stdout).content,'fixture reply');
    assert.equal(server.chats.at(-1).reasoning_effort,'xhigh');
    assert.equal(await tool.execute({prompt:'hello'},ctx),'fixture reply');
    const status=await cli.run(['status','--json'],ctx);assert.equal(status.exitCode,0);assert.equal(JSON.parse(status.stdout).models[0].contextSize,65536);
    assert.equal((await cli.run(['unload','--all'],ctx)).exitCode,0);
    assert.equal((await cli.run(['ask','hi','--model','missing','--json'],ctx)).exitCode,1);
    assert.equal((await cli.run(['unload','m','--all'],ctx)).exitCode,1);
    assert.match((await tool.execute({prompt:'hello',model:'missing'},ctx)).content[0].text,/Run bb local-models status/);
    baseUrl='http://127.0.0.1:1/v1';
    assert.equal((await tool.execute({prompt:'hello'},ctx)).isError,true);
  }finally{await server.close();}
});

test('a failed Splash start is remembered per settings key and retried only after a minute',async t=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{createServer}=await import('node:net');
  const dir=await mkdtemp(join(tmpdir(),'splash-fail-')),blocker=createServer();
  await new Promise<void>(resolve=>blocker.listen(0,'127.0.0.1',resolve));
  const proxyPort=(blocker.address() as import('node:net').AddressInfo).port,errors:string[]=[];
  let cli:any,dispose:any;const settings={splash:true,splashBinary:'/x/splash',splashPort:1,splashProxyPort:proxyPort,splashIdleMinutes:10,baseUrl:'http://127.0.0.1:1/v1',defaultModel:''};
  const bb={log:{error:(line:string)=>errors.push(line),info:()=>{}},onDispose:(fn:any)=>{dispose=fn;},pluginId:'local-models',server:{experimental_dataDir:dir},settings:{define:()=>({onChange:()=>{},get:async()=>settings})},providers:{register:()=>{},experimental_contributeEnv:()=>{}},rpc:{register:()=>{}},agents:{registerTool:()=>{},configure:()=>{}},cli:{register:(v:any)=>cli=v}} as unknown as BbPluginApi;
  // Report Splash as supported so syncSplash reaches startSplash without spawning real probes.
  createPlugin(bb,{doctorOptions:{run:async()=>({code:0,output:'ok'}),exists:async()=>true,brew:null,fetcher:async()=>new Response('{}')}});
  const ctx={signal:new AbortController().signal},status=async()=>JSON.parse((await cli.run(['splash-status','--json'],ctx)).stdout);
  t.mock.timers.enable({apis:['Date']});
  try{
    assert.match((await status()).error,/EADDRINUSE/);
    await new Promise(resolve=>blocker.close(resolve));
    // The port is free now, but the failure is remembered: no new attempt, no new log line, no rejection.
    assert.match((await status()).error,/EADDRINUSE/);assert.match((await status()).error,/EADDRINUSE/);
    assert.equal(errors.length,1);
    t.mock.timers.tick(61_000);
    assert.equal((await status()).error,null);
  }finally{await dispose?.();t.mock.timers.reset();await rm(dir,{recursive:true,force:true});}
});

test('install-splash re-reads requirements, so an update found after a cached check is installed',async()=>{
  let cli:any,dispose:any,outdated=false;const calls:string[][]=[];
  const settings={splash:false,splashBinary:'/x/splash',splashPort:1,splashProxyPort:2,splashIdleMinutes:10,baseUrl:'http://127.0.0.1:1/v1',defaultModel:''};
  const bb={log:{error:()=>{},info:()=>{}},onDispose:(fn:any)=>{dispose=fn;},pluginId:'local-models',server:{experimental_dataDir:'/nonexistent'},settings:{define:()=>({onChange:()=>{},get:async()=>settings})},providers:{register:()=>{},experimental_contributeEnv:()=>{}},rpc:{register:()=>{}},agents:{registerTool:()=>{},configure:()=>{}},cli:{register:(v:any)=>cli=v}} as unknown as BbPluginApi;
  const run=async(_bin:string,args:string[])=>{calls.push(args);return args[0]==='outdated'&&outdated?{code:1,output:'incoai/tap/splash'}:{code:0,output:args[0]==='outdated'?'':'ok'};};
  createPlugin(bb,{run,doctorOptions:{run,exists:async()=>true,brew:'/x/brew',platform:'darwin',arch:'arm64',memoryBytes:64*2**30,fetcher:async()=>new Response('{}')}});
  const ctx={signal:new AbortController().signal};
  try{
    assert.doesNotMatch((await cli.run(['doctor'],ctx)).stdout,/update available/);
    outdated=true;
    assert.match((await cli.run(['install-splash'],ctx)).stdout,/^brew upgrade incoai\/tap\/splash/);
    assert.ok(calls.some(a=>a[0]==='upgrade'));
  }finally{await dispose?.();}
});

test('ask runs on the device its id names; anyDevice lets Slots pick',async()=>{
  const {startModelsServer}=await import('./test/models-server.ts');
  const here=await startModelsServer({data:[{id:'org/Model-GGUF:Q4'},{id:'splash/org/Model-GGUF:Q4'}]});
  const m1=await startModelsServer({data:[{id:'box2/org/Model-GGUF:Q4'},{id:'box2/org/Missing-GGUF:Q4'}]});
  let cli:any,tool:any;const acquires:any[]=[];
  // Fake Machine Slots: grants the pinned device, or box2 (the first registered device) when none is pinned.
  const callRpc=async({method,input}:any)=>{if(method!=='acquire')return {ok:true,data:{}};acquires.push(input);return {ok:true,data:{kind:'leased',useId:'use-1',device:input.device??'box2'}};};
  const bb={log:{error:()=>{},info:()=>{}},onDispose:()=>{},pluginId:'local-models',server:{experimental_dataDir:'/tmp'},sdk:{plugins:{callRpc},system:{config:async()=>({primaryHostId:'host_example'})}},settings:{define:()=>({onChange:()=>{},get:async()=>({baseUrl:here.baseUrl+'\n'+m1.baseUrl,defaultModel:''})})},providers:{register:()=>{},experimental_contributeEnv:()=>{}},rpc:{register:()=>{}},agents:{registerTool:(v:any)=>tool=v,configure:()=>{}},cli:{register:(v:any)=>cli=v}} as unknown as BbPluginApi;
  plugin(bb);
  const ctx={signal:new AbortController().signal,threadId:'thr_example'};
  const check=async(ask:()=>Promise<unknown>,device:string|undefined,server:typeof here,model:string)=>{
    const before=[here.chats.length,m1.chats.length];await ask();
    assert.equal(acquires.at(-1).device,device);
    assert.equal(server.chats.length,(server===here?before[0]:before[1])+1);assert.equal(server.chats.at(-1).model,model);
    assert.equal((server===here?m1:here).chats.length,server===here?before[1]:before[0]);
  };
  const viaTool=(input:any)=>async()=>assert.equal(await tool.execute({prompt:'hello',...input},ctx),'fixture reply');
  const viaCli=(...args:string[])=>async()=>assert.equal((await cli.run(['ask','hello',...args],ctx)).exitCode,0);
  try{
    for(const id of ['org/Model-GGUF:Q4','splash/org/Model-GGUF:Q4']){
      await check(viaTool({model:id}),'local',here,id);await check(viaCli('--model',id),'local',here,id);
    }
    await check(viaTool({model:'box2/org/Model-GGUF:Q4'}),'box2',m1,'box2/org/Model-GGUF:Q4');
    await check(viaCli('--model','box2/org/Model-GGUF:Q4'),'box2',m1,'box2/org/Model-GGUF:Q4');
    await check(viaTool({model:'org/Model-GGUF:Q4',anyDevice:true}),undefined,m1,'box2/org/Model-GGUF:Q4');
    await check(viaCli('--model','org/Model-GGUF:Q4','--any-device'),undefined,m1,'box2/org/Model-GGUF:Q4');
    // A plain id this Mac does not list fails; it never falls back to another machine's copy.
    const chats=m1.chats.length;
    assert.match((await tool.execute({prompt:'hello',model:'org/Missing-GGUF:Q4'},ctx)).content[0].text,/Local model not found/);
    assert.equal((await cli.run(['ask','hello','--model','org/Missing-GGUF:Q4'],ctx)).exitCode,1);
    assert.equal(m1.chats.length,chats);
  }finally{await here.close();await m1.close();}
});
