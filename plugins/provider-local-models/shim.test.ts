import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {shimSource} from './shim.ts';
import {startModelsServer} from './test/models-server.ts';

function startShim(file:string,env:Record<string,string>){
  const child=spawn(process.execPath,[file,'--bb-permission-mode=accept-edits'],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  const updates:any[]=[],permissions:any[]=[];
  const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void}>();let id=0;
  const write=(value:any)=>child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
  createInterface({input:child.stdout}).on('line',line=>{
    const value=JSON.parse(line);
    if(value.method==='session/update')updates.push(value.params.update);
    // Plays the BB user: approve the first command once and every later one for the session.
    if(value.method==='session/request_permission'){permissions.push(value.params);write({id:value.id,result:{outcome:{outcome:'selected',optionId:permissions.length===1?'allow':'always'}}});return;}
    const waiter=pending.get(value.id);if(waiter){pending.delete(value.id);if(value.error)waiter.reject(Error(value.error.message));else waiter.resolve(value.result);}
  });
  const request=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});write({id:next,method,params});});
  return {child,updates,permissions,request,notify:(method:string,params:any)=>write({method,params})};
}

test('runs a native tool loop against chat completions, persists sessions and fails or cancels cleanly', {timeout:20000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'local-models-shim-test-'));
  const server=await startModelsServer();
  const file=path.join(dir,'shim.mjs');await writeFile(file,shimSource);
  await writeFile(path.join(dir,'AGENTS.md'),'Always be terse.');
  const env={LM_BB_DATA_DIR:dir,LM_BASE_URL:server.baseUrl,LM_RETRY_DELAY_MS:'50'};
  const shim=startShim(file,env);let second:ReturnType<typeof startShim>|undefined;
  try {
    const mcpServers=[{name:'bb bridge',command:process.execPath,args:[fileURLToPath(new URL('./test/fake-mcp.mjs',import.meta.url))],env:[{name:'PRIVATE_TOKEN',value:'secret'}]}];
    const session=await shim.request('session/new',{cwd:dir,mcpServers});
    const model=session.configOptions.find((o:any)=>o.category==='model');
    assert.deepEqual(model.options,[{value:'ggml-org/gpt-oss-20b-GGUF:MXFP4',name:'gpt-oss-20b (MXFP4)'}]);
    const changed=await shim.request('session/set_config_option',{sessionId:session.sessionId,configId:'thought_level',value:'high'});
    assert.equal(changed.configOptions.find((o:any)=>o.id==='thought_level').currentValue,'high');
    await assert.rejects(()=>shim.request('session/set_config_option',{sessionId:session.sessionId,configId:'model',value:'missing'}));

    assert.deepEqual(await shim.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'<system_instructions>rules</system_instructions>\n\nhello'}]}),{stopReason:'end_turn'});
    const first=server.chats[0];
    assert.equal(first.model,'ggml-org/gpt-oss-20b-GGUF:MXFP4');assert.equal(first.reasoning_effort,'xhigh');assert.equal(first.chat_template_kwargs,undefined);assert.equal(first.stream,true);assert.equal(first.return_progress,true);
    assert.equal(first.messages[0].role,'system');assert.equal(first.messages[1].content,'hello');assert.match(first.messages[0].content,/Always be terse\./);
    assert.ok(first.messages[0].content.length<3000,'system prompt stays small');
    assert.deepEqual(first.tools.map((t:any)=>t.function.name),['shell','read_file','write_file','edit_file','mcp__bb_bridge__echo']);
    assert.ok(!JSON.stringify(first).includes('secret'));
    assert.equal(shim.updates.filter(u=>u.sessionUpdate==='agent_message_chunk').map(u=>u.content.text).join(''),'fixture reply');
    assert.ok(shim.updates.some(u=>u.sessionUpdate==='agent_thought_chunk'&&u.content.text==='thinking'));
    assert.deepEqual(shim.updates.filter(u=>u.sessionUpdate==='usage_update').map(({used,size})=>({used,size})),[{used:4831,size:65536}]);

    // Shell needs approval in accept-edits; the workspace edit and the pre-approved MCP tool do not.
    assert.deepEqual(await shim.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'tool-fixture'}]}),{stopReason:'end_turn'});
    assert.equal(await readFile(path.join(dir,'out.txt'),'utf8'),'bye');
    assert.deepEqual(shim.permissions.map(p=>[p.toolCall.kind,p.toolCall.rawInput.command]),[['execute','printf hi > out.txt && ls']]);
    const results=server.chats.at(-1).messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content);
    assert.match(results[0],/out\.txt[\s\S]*\[exit code 0\]/);assert.equal(results[1],'echo:ping token:secret');assert.match(results[2],/^Edited /);
    const tools=shim.updates.filter(u=>u.sessionUpdate==='tool_call');
    assert.deepEqual(tools.map(u=>[u.title,u.kind]),[['printf hi > out.txt && ls','execute'],['bb_bridge.echo','other'],['Edit '+path.join(dir,'out.txt'),'edit']]);
    assert.ok(shim.updates.some(u=>u.sessionUpdate==='tool_call_update'&&u.content.some((c:any)=>c.type==='diff'&&c.newText==='bye')));

    // A router restart mid-stream fails the turn instead of hanging.
    await assert.rejects(()=>shim.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'fail-fixture'}]}),/^Error: Local model turn failed: the model server (closed|ended) the stream|the model server dropped the connection/);
    // 503 "Loading model" is retried.
    assert.deepEqual(await shim.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'loading-fixture'}]}),{stopReason:'end_turn'});
    // Cancel aborts the in-flight request.
    const waiting=shim.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'wait-for-cancel'}]});
    while(!server.chats.some(c=>JSON.stringify(c.messages.at(-1)).includes('wait-for-cancel')))await new Promise(r=>setTimeout(r,20));
    shim.notify('session/cancel',{sessionId:session.sessionId});
    assert.deepEqual(await waiting,{stopReason:'cancelled'});
    while(!server.aborted.includes('wait-for-cancel'))await new Promise(r=>setTimeout(r,20));
    shim.child.kill();

    // A fresh agent loads the stored transcript; a stalled stream hits the idle timeout.
    second=startShim(file,{...env,LM_IDLE_TIMEOUT_MS:'300'});
    const loaded=await second.request('session/load',{sessionId:session.sessionId,cwd:dir,mcpServers:[]});
    // Stored 'high' shows as the nearest level the (Qwen-like) model supports once its caps are known.
    assert.equal(loaded.configOptions.find((o:any)=>o.id==='thought_level').currentValue,'xhigh');
    await assert.rejects(()=>second!.request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'<system_instructions>rules</system_instructions>\n\nstall-fixture'}]}),/Local model turn failed: the model server stopped streaming/);
    const history=server.chats.at(-1).messages.map((m:any)=>m.role+':'+(typeof m.content==='string'?m.content:'')).join('|');
    assert.match(history,/^system:[\s\S]*<system_instructions>rules<\/system_instructions>\n\nReminder: the task is in the workspace [^|]*\|user:hello\|assistant:fixture reply\|user:tool-fixture/);
    assert.match(history,/user:fail-fixture\|assistant:partial\|user:loading-fixture/);
    assert.match(history,/user:wait-for-cancel\|assistant:\(interrupted\)\|user:stall-fixture$/);
  } finally {shim.child.kill();second?.child.kill();await server.close();await rm(dir,{recursive:true,force:true});}
});

test('maps discovered caps, guards repeated tools, trims context and reports waiting', {timeout:20000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'local-models-caps-'));
  const server=await startModelsServer({data:['qwen','lfm','muse','broken'].map(id=>({id,context_length:100}))});
  const file=path.join(dir,'shim.mjs');await writeFile(file,shimSource);
  const shim=startShim(file,{LM_BB_DATA_DIR:dir,LM_BASE_URL:server.baseUrl,LM_WAIT_ROW_MS:'10'});
  try{
    const session=await shim.request('session/new',{cwd:dir,mcpServers:[]}),id=session.sessionId;
    const set=(configId:string,value:string)=>shim.request('session/set_config_option',{sessionId:id,configId,value});
    const prompt=(text:string)=>shim.request('session/prompt',{sessionId:id,prompt:[{type:'text',text}]});
    await set('thought_level','high');await prompt('hello');
    assert.equal(server.chats.at(-1).reasoning_effort,'xhigh');
    assert.equal((await set('thought_level','high')).configOptions[1].currentValue,'xhigh');
    const config=await set('thought_level','none');
    assert.deepEqual(config.configOptions[1].options.map((o:any)=>o.value),['none','low','medium','xhigh']);
    await prompt('hello');assert.equal(server.chats.at(-1).reasoning_effort,'none');
    for(const model of ['lfm','muse','broken']){
      await set('model',model);await set('thought_level','high');await prompt('hello');
      const chat=server.chats.at(-1);assert.equal(chat.reasoning_effort,undefined);
      assert.deepEqual(chat.chat_template_kwargs,model==='muse'?{reasoning_strength:'high'}:undefined);
    }
    const caps=JSON.parse(await readFile(path.join(dir,'model-caps.json'),'utf8'));
    assert.deepEqual(Object.keys(caps).sort(),['lfm','muse','qwen']);
    await prompt('retest-fixture');
    assert.equal(await readFile(path.join(dir,'retest.txt'),'utf8'),'xxx');
    await prompt('repeat-fixture');
    assert.equal(await readFile(path.join(dir,'repeats.txt'),'utf8'),'xx');
    assert.match(server.chats.at(-1).messages.at(-1).content,/already made this exact call 2 times/);
    assert.ok(shim.updates.some(u=>u.content?.text==='Stopped: the model kept repeating the same tool call.'));
    await prompt('wait-row-fixture');
    assert.ok(shim.updates.some(u=>u.sessionUpdate==='tool_call'&&u.title.startsWith('Waiting for')));
    assert.ok(shim.updates.some(u=>u.sessionUpdate==='tool_call_update'&&/processing prompt 40%$/.test(u.title??'')));
    assert.ok(shim.updates.some(u=>u.sessionUpdate==='tool_call_update'&&u.status==='completed'));
    // Resume a real saved session with old large output and high usage.
    const storedPath=path.join(dir,'sessions',id+'.json'),stored=JSON.parse(await readFile(storedPath,'utf8'));
    stored.messages=[{role:'user',content:'old'},{role:'assistant',content:'',tool_calls:[{id:'old',type:'function',function:{name:'shell',arguments:'{}'}}]},{role:'tool',tool_call_id:'old',content:'x'.repeat(500)},{role:'user',content:'recent'},{role:'assistant',content:'ok'}];stored.usage={used:90,size:100};
    await writeFile(storedPath,JSON.stringify(stored));
    await shim.request('session/load',{sessionId:id,cwd:dir,mcpServers:[]});await prompt('hello');
    assert.equal(server.chats.at(-1).messages[3].content,'[old tool output removed to save context]');
  }finally{shim.child.kill();await server.close();await rm(dir,{recursive:true,force:true});}
});
