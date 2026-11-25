import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModels, readModels, displayName, effectiveBaseUrl } from './models.ts';
import { startModelsServer } from './test/models-server.ts';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

const sse=(...events:unknown[])=>new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
const delta=(content:string)=>({choices:[{delta:{content},finish_reason:null}]});

test('lists installed models with readable names', async()=>{
  const server=await startModelsServer();
  try {
    const models=await readModels(server.baseUrl+'/');
    assert.equal(models.length,1);
    assert.equal(models[0].id,'ggml-org/gpt-oss-20b-GGUF:MXFP4');
    assert.equal(models[0].displayName,'gpt-oss-20b (MXFP4)');
    assert.equal(models[0].isDefault,true);
  } finally {await server.close();}
  const two={data:[{id:'a/Qwen-GGUF:Q4'},{id:'b/gpt-oss-GGUF:MXFP4'}]};
  assert.deepEqual(parseModels(two,'b/gpt-oss-GGUF:MXFP4').map(m=>m.isDefault),[false,true]);
  assert.deepEqual(parseModels(two,'missing').map(m=>m.isDefault),[true,false]);
  assert.throws(()=>parseModels({data:[]}),/no models/);
  await assert.rejects(()=>readModels(server.baseUrl));
});

test('reads per-model reasoning from the caps file',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const dir=await mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(),'local-caps-'));const server=await startModelsServer();
  try{
    await writeFile(dir+'/model-caps.json',JSON.stringify({'ggml-org/gpt-oss-20b-GGUF:MXFP4':{knob:'reasoning_effort',none:true,levels:['low','medium','xhigh'],checkedAt:1}}));
    const models=await readModels(server.baseUrl,'',dir);
    assert.deepEqual(models[0].supportedReasoningEfforts?.map(e=>e.reasoningEffort),['none','low','medium','xhigh']);
    assert.equal(models[0].defaultReasoningEffort,'medium');
  }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});

test('merges models from several servers and skips the ones that do not answer', async()=>{
  const server=await startModelsServer();
  try {
    const models=await readModels(`http://127.0.0.1:1/v1, ${server.baseUrl}/ ${server.baseUrl}`);
    assert.deepEqual(models.map(m=>m.id),['ggml-org/gpt-oss-20b-GGUF:MXFP4']);
  } finally {await server.close();}
});

test('Splash names and effective server URLs preserve the shared pool',()=>{
  assert.equal(displayName('splash/inco/Qwen3.6-35B-A3B-GGUF:Q4_K_M'),'Qwen3.6-35B-A3B (Q4_K_M) · Splash');
  assert.equal(displayName('M1/owner/Qwen3.6-35B-A3B-GGUF:Q4_K_M'),'Qwen3.6-35B-A3B (Q4_K_M) · M1');assert.equal(displayName('owner/Qwen3.6-35B-A3B-GGUF:Q4_K_M'),'Qwen3.6-35B-A3B (Q4_K_M)');
  assert.equal(effectiveBaseUrl({baseUrl:'http://one/v1/, http://two/v1',splash:true,splashProxyPort:8123}),'http://one/v1, http://two/v1, http://127.0.0.1:8123/v1');
  assert.equal(effectiveBaseUrl({splash:true}),'http://127.0.0.1:9931/v1, http://127.0.0.1:8011/v1');
  assert.equal(effectiveBaseUrl({baseUrl:'http://127.0.0.1:8011/v1',splash:true}),'http://127.0.0.1:8011/v1');
});

test('Splash preference hides only available variants and keeps Llama fallbacks in provider and usage lists',async()=>{
  const {preferSplash}=await import('./models.ts');
  const entries=[{id:'org/Flint:Q4'},{id:'org/Muse:Q4'},{id:'splash/org/Flint:Q4'}];
  assert.deepEqual(preferSplash(entries).map(m=>m.id),['org/Muse:Q4','splash/org/Flint:Q4']);
  assert.deepEqual(preferSplash(entries,false),entries);
  const llama=await startModelsServer({data:entries.slice(0,2)}),splash=await startModelsServer({data:entries.slice(2)});
  try{
    const models=await readModels(llama.baseUrl+','+splash.baseUrl,'org/Flint:Q4','',true);
    assert.deepEqual(models.map(m=>m.id),['org/Muse:Q4','splash/org/Flint:Q4']);
    assert.equal(models.find(m=>m.isDefault)?.id,'splash/org/Flint:Q4');
    assert.equal((await readModels(llama.baseUrl+','+splash.baseUrl)).length,3);
    const {router}=await import('./router.ts');const client=router(llama.baseUrl+','+splash.baseUrl,'org/Flint:Q4','',true),signal=AbortSignal.timeout(5000);
    assert.deepEqual((await client.status(signal)).models.map(m=>m.id),['org/Muse:Q4','splash/org/Flint:Q4']);
    await client.ask({prompt:'hello'},signal);assert.equal(splash.chats.at(-1).model,'splash/org/Flint:Q4');
    await client.ask({prompt:'hello',model:'org/Flint:Q4'},signal);assert.equal(llama.chats.at(-1).model,'org/Flint:Q4');
  }finally{await llama.close();await splash.close();}
});

test('preference does not hide a Llama id without its exact verified variant',async()=>{
  const {preferSplash}=await import('./models.ts');
  const entries=[{id:'org/Flint:Q4'},{id:'org/Flint:Q8'},{id:'splash/org/Flint:Q4'},{id:'Muse'}];
  assert.deepEqual(preferSplash(entries).map(m=>m.id),['org/Flint:Q8','splash/org/Flint:Q4','Muse']);
});

test('fake transports preserve routing for hidden Llama ids while lists and defaults prefer Splash',async t=>{
  const {router}=await import('./router.ts'),chats:{base:string;model:string}[]=[];
  const plain='org/Flint:Q4',variant='splash/'+plain;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/models')return Response.json({data:url.hostname==='llama'?[{id:plain,status:{value:'loaded'}},{id:'org/Muse:Q4'}]:[{id:variant,status:{value:'unloaded'}}]});
    if(url.pathname.startsWith('/props'))return new Response('{}',{status:404});
    const body=JSON.parse(String(init?.body));chats.push({base:url.hostname,model:body.model});
    return sse(delta('fake reply'),{choices:[{delta:{},finish_reason:'stop'}]},'[DONE]');
  };
  t.mock.method(globalThis,'fetch',fetcher);
  const bases='http://llama/v1,http://splash/v1',models=await readModels(bases,plain,'',true);
  assert.deepEqual(models.map(model=>model.id),['org/Muse:Q4',variant]);assert.equal(models.find(model=>model.isDefault)?.id,variant);
  assert.equal((await readModels(bases)).length,3);
  const client=router(bases,plain,'',true),signal=AbortSignal.timeout(1000);
  assert.deepEqual((await client.status(signal)).models.map(model=>model.id),['org/Muse:Q4',variant]);
  await client.ask({prompt:'hello'},signal);await client.ask({prompt:'hello',model:plain},signal);
  assert.deepEqual(chats,[{base:'splash',model:variant},{base:'llama',model:plain}]);
});

test('a model without reasoning control still has a default effort', () => {
  const [model] = parseModels({ data: [{ id: 'lfm' }] }, '', { lfm: { knob: null, levels: [], none: false, checkedAt: 1 } });
  assert.equal(model.defaultReasoningEffort, 'none');
  assert.deepEqual(model.supportedReasoningEfforts.map(e => e.reasoningEffort), ['none']);
});

test('ask waits while the Splash proxy starts the engine', async t => {
  const {router}=await import('./router.ts');let busy=2;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    const url=new URL(String(input));
    if(url.pathname==='/v1/models')return Response.json({data:[{id:'splash/org/Qwen:Q4',status:{value:'unloaded'}}]});
    return busy-->0?Response.json({error:{message:'Loading model'}},{status:503}):sse(delta('ready'),'[DONE]');
  });
  assert.equal((await router('http://splash/v1','','',true,1).ask({prompt:'hi'},AbortSignal.timeout(2000))).content,'ready');
  assert.equal(busy,-1);
});

test('listModels releases the body of a non-2xx answer',async t=>{
  let cancelled=0;
  t.mock.method(globalThis,'fetch',async()=>({ok:false,status:500,body:{cancel:async()=>{cancelled++;}}}) as unknown as Response);
  await assert.rejects(()=>readModels('http://broken/v1'),/answered 500/);
  assert.equal(cancelled,1);
});

test('ask assembles a slow SSE reply, so no response header waits for the whole generation',async()=>{
  const {router}=await import('./router.ts');
  let request:any;
  const server=createServer((req,res)=>{
    if(req.url==='/v1/models'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({data:[{id:'m'}]}));return;}
    let raw='';req.on('data',d=>raw+=d);req.on('end',()=>{
      request=JSON.parse(raw);
      res.writeHead(200,{'content-type':'text/event-stream'});
      const send=(o:unknown)=>res.write('data: '+(typeof o==='string'?o:JSON.stringify(o))+'\n\n');
      // A chunk split mid-line checks the buffering.
      setTimeout(()=>send({choices:[{delta:{reasoning_content:'think'}}]}),20);
      setTimeout(()=>send(delta('Hel')),60);
      setTimeout(()=>res.write('data: {"choices":[{"delta":{"con'),100);
      setTimeout(()=>{res.write('tent":"lo"}}]}\n\n');send({choices:[{delta:{},finish_reason:'stop'}]});send({choices:[],usage:{total_tokens:7}});send('[DONE]');res.end();},140);
    });
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const result=await router(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,'','').ask({prompt:'hi'},AbortSignal.timeout(5000));
    const {durationMs,ttftMs,...rest}=result;
    assert.deepEqual(rest,{model:'m',content:'Hello',usage:{total_tokens:7},reasoning:'think'});
    assert.ok(ttftMs!>=10&&ttftMs!<durationMs,`ttft ${ttftMs} duration ${durationMs}`);
    assert.equal(request.stream,true);
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test('ask surfaces stream errors and truncated streams as errors',async t=>{
  const {router}=await import('./router.ts');let reply:()=>Response;
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>new URL(String(input)).pathname==='/v1/models'?Response.json({data:[{id:'m'}]}):reply());
  const ask=()=>router('http://x/v1','','').ask({prompt:'hi'},AbortSignal.timeout(2000));
  reply=()=>sse(delta('part'),{error:{message:'out of memory'}});
  await assert.rejects(ask,/out of memory/);
  reply=()=>sse(delta('part'));
  await assert.rejects(ask,/ended the stream early/);
  reply=()=>sse('[DONE]');
  await assert.rejects(ask,/no message/);
  reply=()=>new Response('{"error":"bad"}',{status:400});
  await assert.rejects(ask,/answered 400/);
});

test('routes by the id; only anyDevice lets Slots pick among machines that serve the model', async (t) => {
  const lists:Record<string,string[]>={here:['splash/org/Qwen-GGUF:Q4','org/Qwen-GGUF:Q4','org/Only-GGUF:Q4'],m1:['box2/org/Qwen-GGUF:Q4','box2/org/Big-GGUF:Q4']};
  t.mock.method(globalThis,'fetch',async (input:any)=>Response.json({data:lists[new URL(String(input)).hostname].map(id=>({id}))}));
  const {router}=await import('./router.ts');const client=router('http://here/v1,http://m1/v1','org/Qwen-GGUF:Q4','',true),signal=AbortSignal.timeout(1000);
  assert.deepEqual(await client.devices(signal),['box2']);
  assert.deepEqual(await client.route(undefined,signal),{id:'splash/org/Qwen-GGUF:Q4',device:'local',variants:{'':'splash/org/Qwen-GGUF:Q4'}});
  assert.deepEqual(await client.route('org/Qwen-GGUF:Q4',signal),{id:'org/Qwen-GGUF:Q4',device:'local',variants:{'':'org/Qwen-GGUF:Q4'}});
  assert.deepEqual(await client.route('box2/org/Big-GGUF:Q4',signal),{id:'box2/org/Big-GGUF:Q4',device:'box2',variants:{box2:'box2/org/Big-GGUF:Q4'}});
  assert.equal((await client.route('org/Only-GGUF:Q4',signal)).device,'local');
  assert.deepEqual(await client.route(undefined,signal,true),{id:'splash/org/Qwen-GGUF:Q4',device:undefined,variants:{'':'splash/org/Qwen-GGUF:Q4',box2:'box2/org/Qwen-GGUF:Q4'}});
  lists.m2=['M2/org/Other-GGUF:Q4'];const three=router('http://here/v1,http://m1/v1,http://m2/v1','org/Qwen-GGUF:Q4','',true);
  assert.equal((await three.route(undefined,signal,true)).device,'box2');
  assert.equal((await three.route(undefined,signal)).device,'local');
});

test('asks again when a queued request gets no headers in time', async (t) => {
  let calls=0;
  t.mock.method(globalThis,'fetch',async (input:any)=>{
    if(String(input).endsWith('/models'))return Response.json({data:[{id:'org/Q-GGUF:Q4'}]});
    if(++calls===1)throw Object.assign(new TypeError('fetch failed'),{cause:{code:'UND_ERR_HEADERS_TIMEOUT'}});
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const {router}=await import('./router.ts');
  assert.equal((await router('http://q/v1','org/Q-GGUF:Q4','',false).ask({prompt:'hi'},AbortSignal.timeout(2000))).content,'ok');
  assert.equal(calls,2);
});
