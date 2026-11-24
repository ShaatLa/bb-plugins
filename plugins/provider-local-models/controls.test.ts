import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { splashControls } from './splash-controls.ts';
import { splashModels } from './splash.ts';
import { fakeGguf } from './test/gguf.ts';
import type { RunCommand } from './requirements.ts';

const id='org/Flint-GGUF:Q4';
test('shared controls expose metadata, progress, cancellation, verification, delete, context and restart with fakes',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'splash-controls-')),modelsIni=join(dir,'models.ini'),userIni=join(dir,'user.ini'),draftsDir=join(dir,'drafts'),gguf=join(dir,'a.gguf');
  const weights=Buffer.from('fake safetensors'),logs:string[]=[];let slow=true,start:()=>void=()=>{},began=new Promise<void>(resolve=>start=resolve),restarts:string[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    const url=String(input);
    if(url.includes('/api/models/'))return Response.json({sha:'a'.repeat(40),siblings:[{rfilename:'model.safetensors',lfs:{sha256:createHash('sha256').update(weights).digest('hex'),size:weights.length}},{rfilename:'config.json'}]});
    if(url.endsWith('/model.safetensors')){
      if(slow)return new Response(new ReadableStream({start(controller){controller.enqueue(weights.subarray(0,4));start();init?.signal?.addEventListener('abort',()=>controller.error(init.signal!.reason),{once:true});}}));
      return new Response(weights);
    }
    return new Response('{}');
  };
  const process={model:null as string|null,pid:null,port:8010,ready:false,idleLeftMs:0,error:null};
  const controls=splashControls({modelsIni,userIni,draftsDir,fetcher,settings:async()=>({splashBinary:'/fake',baseUrl:'http://fake/v1',splashPort:8010}),process:()=>process,restart:async id=>{restarts.push(id);},log:line=>logs.push(line)});
  try{
    await writeFile(gguf,fakeGguf());await writeFile(modelsIni,`[${id}]\nmodel = ${gguf}\nctx-size = 4096\n[other/Muse:Q4]\nmodel = ${gguf}\n`);
    let status=await controls.status();assert.equal(status.models[0].draft?.state,'missing');assert.equal(status.models[0].draft?.total,weights.length);assert.equal(status.models[1].supported,false);
    const pending=controls.download(id);const rejection=assert.rejects(()=>pending,/abort/i);await began;
    status=await controls.status();assert.equal(status.models[0].draft?.state,'downloading');
    await controls.cancel(id);await rejection;
    assert.deepEqual(await splashModels(modelsIni,draftsDir,userIni),[]);
    slow=false;await controls.download(id);status=await controls.status();assert.equal(status.models[0].draft?.state,'ready');assert.equal(status.models[0].draft?.done,weights.length);
    assert.equal((await splashModels(modelsIni,draftsDir,userIni))[0].id,'splash/'+id);
    await controls.context(id,8192);assert.match(await readFile(userIni,'utf8'),/ctx-size = 8192/);
    process.model='splash/'+id;assert.equal((await controls.context(id,4096)).restartAvailable,true);await controls.restart(id);assert.deepEqual(restarts,['splash/'+id]);
    await assert.rejects(()=>controls.remove(id),/active draft/);process.model=null;
    await controls.remove(id);assert.equal((await controls.status()).models[0].draft?.state,'missing');
    await assert.rejects(()=>controls.context(id,131073),/native window/);
    await assert.rejects(()=>controls.download('unknown/Model'),/Unsupported/);
    await assert.rejects(()=>controls.install('sudo brew install splash',true),/Confirm/);
    assert.ok(logs.some(line=>line.startsWith('Downloading https://huggingface.co/')));
  }finally{await controls.dispose();await rm(dir,{recursive:true,force:true});}
});

test('explicit installation shares detection and streaming logs, validates confirmation and redetects',async()=>{
  let installed=false,checks=0;const commands:string[]=[],logs:string[]=[];
  const run:RunCommand=async(binary,args,_signal,print)=>{
    commands.push([binary,...args].join(' '));
    if(args[0]==='install'){assert.ok(logs.includes('brew install incoai/tap/splash'));print?.('x'.repeat(25000)+'fake install output\n');installed=true;return {code:0,output:'done'};}
    if(args[0]==='--prefix')return {code:0,output:'/fake/prefix'};
    if(args[0]==='device-check'){checks++;return {code:0,output:'Supported'};}
    if(args[0]==='outdated')return {code:0,output:''};
    return {code:0,output:binary.endsWith('sw_vers')?'26.4':binary.endsWith('sysctl')?'Apple M3':'1.6.0'};
  };
  const controls=splashControls({settings:async()=>({splashBinary:'/fake/splash',baseUrl:'http://fake/v1',splashPort:8010}),process:()=>({model:null,pid:null,port:8010,ready:false,idleLeftMs:0,error:null}),restart:async()=>{},log:line=>logs.push(line),run,modelsIni:'/nonexistent/models.ini',userIni:'/nonexistent/user.ini',fetcher:async()=>Response.json({data:[]}),doctorOptions:{brew:'/fake/brew',platform:'darwin',arch:'arm64',exists:async file=>file==='/fake/splash'?installed:false}});
  try{
    await assert.rejects(()=>controls.install('brew install incoai/tap/splash',false),/Confirm/);assert.equal(commands.length,0);
    await controls.install('brew install incoai/tap/splash',true);assert.equal(checks,1);assert.equal((await controls.detect()).splash.installed,true);
    assert.equal((await controls.status()).installation.output.length,20000);assert.ok((await controls.status()).installation.output.endsWith('fake install output\n'));
    await assert.rejects(()=>controls.install('brew install incoai/tap/splash',true),/already installed/);
    assert.ok(commands.every(command=>!command.includes('sudo')&&!command.includes('curl')));
  }finally{await controls.dispose();}
});

test('failed draft metadata is cached across status polls without blocking download',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'splash-metadata-')),modelsIni=join(dir,'models.ini');let calls=0;
  const controls=splashControls({modelsIni,userIni:join(dir,'user.ini'),draftsDir:join(dir,'drafts'),fetcher:async()=>{calls++;throw Error('offline');},settings:async()=>({splashBinary:'/fake',baseUrl:'http://fake',splashPort:8010}),process:()=>({model:null,pid:null,port:8010,ready:false,idleLeftMs:0,error:null}),restart:async()=>{},log:()=>{}});
  try{await writeFile(modelsIni,`[${id}]\nmodel = /missing.gguf\n[org/Qwen3.8-27B-GGUF:Q4]\nmodel = /missing.gguf\n`);for(let i=0;i<3;i++)assert.ok((await controls.status()).models.every(model=>model.draft?.state==='error'));assert.equal(calls,2);await assert.rejects(()=>controls.download(id),/offline/);assert.equal(calls,3);}
  finally{await controls.dispose();await rm(dir,{recursive:true,force:true});}
});

test('detection shares in-flight and cached results, while force reruns',async()=>{
  let checks=0;const controls=splashControls({settings:async()=>({splashBinary:'/fake',baseUrl:'http://fake',splashPort:8010}),process:()=>({model:null,pid:null,port:8010,ready:false,idleLeftMs:0,error:null}),restart:async()=>{},log:()=>{},modelsIni:'/nonexistent/models.ini',userIni:'/nonexistent/user.ini',fetcher:async()=>new Response(null,{status:503}),run:async(binary)=>{if(binary.endsWith('sw_vers'))checks++;return {code:0,output:'26.4'};},doctorOptions:{brew:null,exists:async()=>false,platform:'darwin',arch:'arm64'}});
  try{await Promise.all([controls.detect(),controls.detect()]);await controls.detect();assert.equal(checks,1);await controls.detect(true);assert.equal(checks,2);}
  finally{await controls.dispose();}
});

test('models outside Llama.app are pulled with their draft, listed with partials, served by Splash and deleted with their unused draft',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'splash-managed-')),draftsDir=join(dir,'drafts'),modelsDir=join(dir,'splash'),gguf=fakeGguf(),weights=Buffer.from('draft'),logs:string[]=[];
  const lfs=(data:Buffer)=>({sha256:createHash('sha256').update(data).digest('hex'),size:data.length}),pulled='org/Inkling-2-Mini-GGUF:Q4',partial='org/Inkling-2-Mini-GGUF:Q8';
  const fetcher:typeof fetch=async input=>{
    const url=String(input);
    if(url.includes('/api/models/org/'))return Response.json({sha:'b'.repeat(40),siblings:[{rfilename:'Inkling-2-Mini-Q4.gguf',lfs:lfs(gguf)}]});
    if(url.includes('/api/models/incoai/'))return Response.json({sha:'a'.repeat(40),siblings:[{rfilename:'model.safetensors',lfs:lfs(weights)},{rfilename:'config.json'}]});
    if(url.endsWith('/Inkling-2-Mini-Q4.gguf'))return new Response(gguf);
    return new Response(url.endsWith('/model.safetensors')?weights:'{}');
  };
  const process={model:null as string|null,pid:null,port:8010,ready:false,idleLeftMs:0,error:null};
  const controls=splashControls({modelsIni:join(dir,'models.ini'),userIni:join(dir,'user.ini'),draftsDir,fetcher,settings:async()=>({splashBinary:'/fake',baseUrl:'http://fake/v1',splashPort:8010}),process:()=>process,restart:async()=>{},log:line=>logs.push(line)});
  try{
    await assert.rejects(()=>controls.validate('not an id'),/Unsupported model id/);
    await assert.rejects(()=>controls.validate('org/Gemma-GGUF:Q4'),/Unsupported Splash family/);
    const file=await controls.download(pulled);assert.equal(file,join(modelsDir,'org/Inkling-2-Mini-GGUF/Inkling-2-Mini-Q4.gguf'));
    await mkdir(join(modelsDir,'org/Inkling-2-Mini-GGUF'),{recursive:true});await writeFile(join(modelsDir,'org/Inkling-2-Mini-GGUF/Inkling-2-Mini-Q8.gguf.part'),'12345');
    let status=await controls.status();
    assert.deepEqual(status.managed.map(model=>[model.id,model.gguf.state,model.gguf.done,model.draft?.state]),[[pulled,'ready',gguf.length,'ready'],[partial,'missing',5,'ready']]);
    assert.deepEqual((await splashModels(join(dir,'models.ini'),draftsDir,join(dir,'user.ini'))).map(model=>[model.id,model.model]),[['splash/'+pulled,file]]);
    process.model='splash/'+pulled;await assert.rejects(()=>controls.remove(pulled),/running model/);process.model=null;
    await controls.remove(pulled);status=await controls.status();
    assert.deepEqual(status.managed.map(model=>[model.id,model.draft?.state]),[[partial,'missing']]);
    await controls.remove(partial);assert.deepEqual((await controls.status()).managed,[]);
    await assert.rejects(()=>stat(join(modelsDir,'org')),/ENOENT/);
    assert.ok(logs.some(line=>line.startsWith('Deleted Splash draft incoai/Inkling-2-Mini-DFlash2')));
  }finally{await controls.dispose();await rm(dir,{recursive:true,force:true});}
});
