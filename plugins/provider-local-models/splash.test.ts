import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { parseModelsIni, splashFamily, splashModels, startSplash, setupSplash, verifiedDraft } from './splash.ts';
import { fakeGguf } from './test/gguf.ts';

const ids=['inco/Qwen3.6-35B-A3B-GGUF:Q4_K_M','inco/Flint-GGUF:Q8_0'];
async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),'splash-test-')),draftsDir=join(dir,'drafts'),modelsIni=join(dir,'models.ini'),binary=join(dir,'splash');
  for(const family of ['Qwen3.6-35B-A3B','Flint']){
    const draft=join(draftsDir,family+'-DFlash2');await mkdir(draft,{recursive:true});
    await writeFile(join(draft,'config.json'),'{}');await writeFile(join(draft,'model.safetensors'),'fake');
    await writeFile(join(draft,'.verified.json'),JSON.stringify({size:4,sha256:createHash('sha256').update('fake').digest('hex')}));
  }
  await writeFile(join(dir,'one.gguf'),fakeGguf());await writeFile(join(dir,'two.gguf'),fakeGguf());
  await writeFile(modelsIni,`# Llama.app\r\n[${ids[0]}]\r\nmodel = "${join(dir,'one.gguf')}"\r\nctx-size = 8192\r\nmmproj = ignored\r\n[${ids[1]}]\r\nmodel = ${join(dir,'two.gguf')}\r\nctx-size = 4096\r\n[other/Unsupported:Q4]\r\nmodel = ${join(dir,'one.gguf')}\r\n`);
  await writeFile(binary,'#!'+process.execPath+'\n'+await readFile(new URL('./test/fake-splash.mjs',import.meta.url),'utf8'),{mode:0o700});
  return {dir,modelsIni,draftsDir,binary,userIni:join(dir,'models.user.ini')};
}
async function freePort(){const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as AddressInfo).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function until(check:()=>boolean|Promise<boolean>){const deadline=Date.now()+5000;while(!await check()){assert.ok(Date.now()<deadline,'fake reached expected state');await delay(30);}}

test('parses Llama ini and lists only supported families with complete local drafts',async()=>{
  const f=await fixture();
  try{
    assert.equal(parseModelsIni(await readFile(f.modelsIni,'utf8'))[0].context_length,8192);
    assert.equal(splashFamily('splash/'+ids[0]),'Qwen3.6-35B-A3B');
    assert.equal(splashFamily('org/Qwen3.8-27B:Q4'),'Qwen3.8-27B');
    assert.equal(splashFamily('org/Qwen3.8-27B-Fake:Q4'),undefined);
    assert.deepEqual((await splashModels(f.modelsIni,f.draftsDir,f.userIni)).map(m=>[m.id,m.context_length]),[['splash/'+ids[0],8192],['splash/'+ids[1],4096]]);
    await writeFile(join(f.draftsDir,'Flint-DFlash2/model.safetensors'),'bad!');
    assert.deepEqual((await splashModels(f.modelsIni,f.draftsDir,f.userIni)).map(m=>m.id),['splash/'+ids[0]]);
    await rm(join(f.draftsDir,'Flint-DFlash2/model.safetensors'));
    assert.deepEqual((await splashModels(f.modelsIni,f.draftsDir,f.userIni)).map(m=>m.id),['splash/'+ids[0]]);
    assert.deepEqual(await splashModels(join(f.dir,'missing'),f.draftsDir,f.userIni),[]);
  }finally{await rm(f.dir,{recursive:true,force:true});}
});

test('proxy starts a fake on demand, streams, switches, stops on idle and disposes its child', {timeout:20000},async()=>{
  const f=await fixture(),unloaded:string[]=[];
  const llama=createServer(async(request,response)=>{
    if(request.url==='/v1/models'){response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:'loaded',status:{value:'loaded'}},{id:'not-loaded',status:{value:'unloaded'}}]}));return;}
    let raw='';for await(const chunk of request)raw+=chunk;unloaded.push(JSON.parse(raw).model);response.end('{}');
  });
  await new Promise<void>(resolve=>llama.listen(0,'127.0.0.1',resolve));
  const proxy=await startSplash({...f,port:await freePort(),proxyPort:0,idleMinutes:0.005,llamaUrl:`http://127.0.0.1:${(llama.address() as AddressInfo).port}/v1`,dataDir:f.dir});
  let disposed=false;
  const chat=(model:string,extra:Record<string,unknown>={})=>fetch(proxy.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model,stream:true,...extra})});
  const list=async()=>((await (await fetch(proxy.baseUrl+'/models')).json()) as any).data;
  try{
    assert.equal(proxy.status().pid,null);
    assert.equal((await list())[0].context_length,8192);
    assert.equal((await fetch(proxy.baseUrl.replace('/v1','')+'/props')).status,404);
    assert.equal((await chat('splash/missing')).status,404);
    assert.equal((await fetch(proxy.baseUrl+'/chat/completions',{method:'POST',body:'null'})).status,400);
    const first=await chat('splash/'+ids[0]);assert.equal(first.status,503);await first.text();
    await until(()=>proxy.status().ready);
    const pid=proxy.status().pid!;
    assert.equal((await list())[0].context_length,8192);
    assert.match(await readFile(join(f.dir,'splash.log'),'utf8'),/--max-context.*8192/);
    assert.equal((await list())[1].context_length,4096);
    const stream=await chat('splash/'+ids[0],{delay:450});assert.equal(stream.status,200);
    assert.match(stream.headers.get('content-type')! ,/text\/event-stream/);
    assert.equal((await chat('splash/'+ids[1])).status,503);
    const text=await stream.text();assert.match(text,/data: \[DONE\]/);assert.ok(text.includes(ids[0]));
    assert.equal(proxy.status().pid,pid,'an active stream survives switching and the idle timeout');
    assert.equal((await chat('splash/'+ids[1])).status,503);
    await until(()=>proxy.status().ready&&proxy.status().model==='splash/'+ids[1]);
    assert.notEqual(proxy.status().pid,pid);assert.throws(()=>process.kill(pid,0));
    const answer=await chat('splash/'+ids[1],{stream:false});assert.equal(answer.status,200);assert.equal((await answer.json() as any).choices[0].message.content,ids[1]);
    assert.deepEqual(unloaded,['loaded','loaded','loaded','loaded']);
    const secondPid=proxy.status().pid!;
    await until(()=>proxy.status().pid===null);assert.throws(()=>process.kill(secondPid,0));
    await chat('splash/'+ids[0]);await until(()=>proxy.status().ready);
    assert.deepEqual((await list()).map((m:any)=>m.status.value),['loaded','unloaded']);
    const unloadedPid=proxy.status().pid!;
    assert.equal((await fetch(proxy.baseUrl.replace('/v1','')+'/models/unload',{method:'POST',body:JSON.stringify({model:'splash/'+ids[0]})})).status,200);
    assert.equal(proxy.status().pid,null);assert.throws(()=>process.kill(unloadedPid,0));
    await chat('splash/'+ids[0]);await until(()=>proxy.status().ready);
    const finalPid=proxy.status().pid!;
    await proxy.dispose();disposed=true;assert.throws(()=>process.kill(finalPid,0));
    await assert.rejects(()=>fetch(proxy.baseUrl+'/models'));
  }finally{if(!disposed)await proxy.dispose();llama.closeAllConnections();await new Promise<void>(resolve=>llama.close(()=>resolve()));await rm(f.dir,{recursive:true,force:true});}
});

test('dispose cancels a fake during startup and failed readiness reaps the fake', {timeout:15000},async()=>{
  const f=await fixture();
  await writeFile(join(f.dir,'timeout.gguf'),'fake');
  await writeFile(f.modelsIni,`[${ids[0]}]\nmodel = ${join(f.dir,'timeout.gguf')}\n`);
  const llama=createServer((request,response)=>response.end('{"data":[]}'));
  await new Promise<void>(resolve=>llama.listen(0,'127.0.0.1',resolve));
  const options={...f,port:await freePort(),proxyPort:0,idleMinutes:10,llamaUrl:`http://127.0.0.1:${(llama.address() as AddressInfo).port}/v1`,dataDir:f.dir,readyTimeoutMs:350};
  let proxy=await startSplash(options);
  const load=()=>fetch(proxy.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model:'splash/'+ids[0]})}).then(response=>response.text());
  try{
    await load();await until(()=>!!proxy.status().error);
    assert.match(proxy.status().error!,/readiness timed out/);assert.equal(proxy.status().pid,null);
    const failed=await fetch(proxy.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model:'splash/'+ids[0]})});
    assert.equal(failed.status,502);assert.match(await failed.text(),/readiness timed out/);
    await proxy.dispose();proxy=await startSplash({...options,readyTimeoutMs:10000});
    await load();await until(()=>proxy.status().pid!==null);
    const pid=proxy.status().pid!;await proxy.dispose();assert.throws(()=>process.kill(pid,0));
  }finally{await proxy.dispose();llama.closeAllConnections();await new Promise<void>(resolve=>llama.close(()=>resolve()));await rm(f.dir,{recursive:true,force:true});}
});

test('draft setup resumes fake transfers, verifies size and sha256, and rejects corrupt or unknown drafts',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'splash-download-test-')),repo=join(dir,'Flint-DFlash2'),weights=Buffer.from('fake safetensors'),digest=createHash('sha256').update(weights).digest('hex');
  const printed:string[]=[],requests:{url:string;range:string|null}[]=[];
  let corrupt=false,ignoreRange=false,wrongSize=false;
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input),range=new Headers(init?.headers).get('range');requests.push({url,range});
    if(url.includes('/api/models/'))return Response.json({sha:'a'.repeat(40),siblings:[{rfilename:'config.json'},{rfilename:'model.safetensors',lfs:{sha256:digest,size:weights.length+(wrongSize?1:0)}},{rfilename:'README.md'},{rfilename:'LICENSE'}]});
    assert.ok(printed.some(line=>line.includes(url)),'file is printed before downloading');
    if(url.endsWith('/model.safetensors')){
      const offset=range&&!ignoreRange?Number(range.match(/\d+/)![0]):0;
      return new Response(corrupt?Buffer.alloc(weights.length):weights.subarray(offset),{status:offset?206:200,headers:offset?{'content-range':`bytes ${offset}-${weights.length-1}/${weights.length}`}:{}});
    }
    return new Response(url.endsWith('/config.json')?'{}':'fake documentation');
  };
  try{
    await mkdir(repo);await writeFile(join(repo,'model.safetensors.part'),weights.subarray(0,5));
    assert.equal(await setupSplash('org/Flint-GGUF:Q4',line=>printed.push(line),new AbortController().signal,dir,fetcher),repo);
    assert.equal(requests.find(r=>r.url.endsWith('/model.safetensors'))?.range,'bytes=5-');
    assert.deepEqual(await readFile(join(repo,'model.safetensors')),weights);
    assert.equal(JSON.parse(await readFile(join(repo,'.verified.json'),'utf8')).mtimeMs,(await stat(join(repo,'model.safetensors'))).mtimeMs);
    assert.equal(await readFile(join(repo,'LICENSE'),'utf8'),'fake documentation');
    const count=requests.length;await setupSplash('org/Flint',()=>{},new AbortController().signal,dir,fetcher);assert.equal(requests.length,count+1,'valid existing files need only metadata');
    await assert.rejects(()=>setupSplash('org/Unknown',()=>{},new AbortController().signal,dir,fetcher),/Unsupported/);
    assert.equal(requests.length,count+1);
    await rm(join(repo,'model.safetensors'));await writeFile(join(repo,'model.safetensors.part'),weights.subarray(0,5));ignoreRange=true;
    await setupSplash('org/Flint',line=>printed.push(line),new AbortController().signal,dir,fetcher);
    assert.deepEqual(await readFile(join(repo,'model.safetensors')),weights,'a server ignoring Range restarts the file');
    await rm(join(repo,'model.safetensors'));corrupt=true;
    await assert.rejects(()=>setupSplash('org/Flint',line=>printed.push(line),new AbortController().signal,dir,fetcher),/sha256 mismatch/);
    await assert.rejects(()=>stat(join(repo,'model.safetensors.part')),/ENOENT/);
    corrupt=false;wrongSize=true;
    await assert.rejects(()=>setupSplash('org/Flint',line=>printed.push(line),new AbortController().signal,dir,fetcher),/size or sha256 mismatch/);
    await assert.rejects(()=>stat(join(repo,'model.safetensors')),/ENOENT/);
    wrongSize=false;await writeFile(join(repo,'model.safetensors'),'corrupt');
    await assert.rejects(()=>setupSplash('org/Flint',()=>{},new AbortController().signal,dir,fetcher),/sha256 mismatch/);
    await assert.rejects(()=>stat(join(repo,'model.safetensors')),/ENOENT/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('proxy applies user context on restart and omits max-context above the Splash native limit',{timeout:15000},async()=>{
  const f=await fixture(),llama=createServer((_request,response)=>response.end('{"data":[]}'));
  await new Promise<void>(resolve=>llama.listen(0,'127.0.0.1',resolve));
  await writeFile(f.userIni,`[${ids[0]}]\nctx-size = 999999\n`);
  const proxy=await startSplash({...f,port:await freePort(),proxyPort:0,idleMinutes:10,llamaUrl:`http://127.0.0.1:${(llama.address() as AddressInfo).port}/v1`,dataDir:f.dir});
  try{
    const response=await fetch(proxy.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model:'splash/'+ids[0]})});assert.equal(response.status,503);await response.text();
    await until(()=>proxy.status().ready);
    assert.ok(!(await readFile(join(f.dir,'splash.log'),'utf8')).includes('--max-context'));
    assert.equal((await (await fetch(proxy.baseUrl+'/models')).json() as any).data[0].context_length,131072);
    const pid=proxy.status().pid;
    await writeFile(f.userIni,`# user\n[${ids[0]}]\nctx-size = 4096\n`);await proxy.restart('splash/'+ids[0]);
    assert.notEqual(proxy.status().pid,pid);assert.equal(proxy.status().ready,true);
    assert.equal((await (await fetch(proxy.baseUrl+'/models')).json() as any).data[0].context_length,4096);
    assert.match(await readFile(join(f.dir,'splash.log'),'utf8'),/--max-context.*4096/);
  }finally{await proxy.dispose();llama.closeAllConnections();await new Promise<void>(resolve=>llama.close(()=>resolve()));await rm(f.dir,{recursive:true,force:true});}
});

test('verifiedDraft trusts a matching size and mtime without hashing, rehashes changes and shares concurrent hashes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'splash-verify-test-')),good=createHash('sha256').update('fake').digest('hex');
  let reads=0;const original=fs.createReadStream;
  t.mock.method(fs,'createReadStream',(...args:any[])=>{reads++;return (original as any)(...args);});syncBuiltinESMExports();
  const draft=async(name:string,receipt:(mtimeMs:number)=>object)=>{
    const dir=join(root,name);await mkdir(dir);
    await writeFile(join(dir,'config.json'),'{}');await writeFile(join(dir,'model.safetensors'),'fake');
    await writeFile(join(dir,'.verified.json'),JSON.stringify(receipt((await stat(join(dir,'model.safetensors'))).mtimeMs)));return dir;
  };
  try{
    // A wrong sha256 proves the receipt alone vouched for the file.
    const trusted=await draft('trusted',mtimeMs=>({sha256:'a'.repeat(64),size:4,mtimeMs}));
    assert.equal(await verifiedDraft(trusted),true);assert.equal(reads,0);
    const when=new Date(Date.now()-60_000);await utimes(join(trusted,'model.safetensors'),when,when);
    assert.equal(await verifiedDraft(trusted),false,'a touched file is hashed and rejected');assert.equal(reads,1);
    // An old receipt hashes once, concurrent callers share that hash, and the receipt gains mtimeMs.
    reads=0;const old=await draft('old',()=>({sha256:good,size:4,revision:'r'}));
    assert.deepEqual(await Promise.all([verifiedDraft(old),verifiedDraft(old),verifiedDraft(old)]),[true,true,true]);assert.equal(reads,1);
    const receipt=JSON.parse(await readFile(join(old,'.verified.json'),'utf8'));
    assert.deepEqual(receipt,{sha256:good,size:4,revision:'r',mtimeMs:(await stat(join(old,'model.safetensors'))).mtimeMs});
    await assert.rejects(()=>stat(join(old,'.verified.json.tmp')),/ENOENT/);
    // Same size, new mtime and different content: rehashed and rejected.
    await writeFile(join(old,'model.safetensors'),'bad!');await utimes(join(old,'model.safetensors'),when,when);
    assert.equal(await verifiedDraft(old),false);
  }finally{t.mock.restoreAll();syncBuiltinESMExports();await rm(root,{recursive:true,force:true});}
});

test('splash.log over 5 MB is rotated to splash.log.1 before the engine starts',{timeout:15000},async()=>{
  const f=await fixture();await writeFile(join(f.dir,'splash.log'),Buffer.alloc(5_000_001,'x'));
  const proxy=await startSplash({...f,port:await freePort(),proxyPort:0,idleMinutes:10,llamaUrl:'http://127.0.0.1:1/v1',dataDir:f.dir});
  try{
    const response=await fetch(proxy.baseUrl+'/chat/completions',{method:'POST',body:JSON.stringify({model:'splash/'+ids[0]})});assert.equal(response.status,503);await response.text();
    await until(()=>proxy.status().ready);
    assert.equal((await stat(join(f.dir,'splash.log.1'))).size,5_000_001);
    assert.ok((await stat(join(f.dir,'splash.log'))).size<5000);
  }finally{await proxy.dispose();await rm(f.dir,{recursive:true,force:true});}
});
