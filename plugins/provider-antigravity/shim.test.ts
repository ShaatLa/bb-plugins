import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,access,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {shimSource} from './shim.ts';

test('isolates MCP configs, preserves credentials privately, selects live model variants and cleans up', {timeout:15000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'agy-shim-test-'));
  const file=path.join(dir,'shim.mjs');await writeFile(file,shimSource);
  const child=spawn(process.execPath,[file,'--bb-permission-mode=full'],{env:{...process.env,AGY_BB_TEMP_DIR:dir,AGY_BB_DATA_DIR:dir,AGY_TEST_ARGS:path.join(dir,'args.json'),AGY_TEST_INPUT:path.join(dir,'input.txt'),AGY_TEST_CALLS:path.join(dir,'calls.jsonl'),AGY_TEST_DESCENDANT_PID:path.join(dir,'descendant.pid'),AGY_BIN:fileURLToPath(new URL('./test/fake-agy.mjs',import.meta.url))},stdio:['pipe','pipe','pipe']});
  let onToolStart: (()=>void)|undefined;
  const updates:any[]=[];
  const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void}>();let id=0;
  createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);if(value.method==='session/update')updates.push(value.params.update);if(value.params?.update?.title==='waiting_fixture')onToolStart?.();const waiter=pending.get(value.id);if(waiter){pending.delete(value.id);if(value.error)waiter.reject(Error(value.error.message));else waiter.resolve(value.result);}});
  const request=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  try {
    const mcpServers=[{name:'bb-bridge',command:process.execPath,args:['mcp.mjs'],env:[{name:'PRIVATE_TOKEN',value:'secret'}]}];
    const first=await request('session/new',{cwd:dir,mcpServers});
    const second=await request('session/new',{cwd:dir,mcpServers});
    const [a,b]=(await readdir(dir)).filter(name=>name.startsWith('agy-bb-session-')).map(name=>path.join(dir,name));assert.ok(a&&b);assert.notEqual(a,b);
    const config=JSON.parse(await readFile(path.join(a,'.agents','mcp_config.json'),'utf8'));
    assert.equal(config.mcpServers['bb-bridge'].env.PRIVATE_TOKEN,'secret');
    const models=first.configOptions.find((o:any)=>o.category==='model');
    assert.deepEqual(models.options.map((o:any)=>o.value),['gemini-new','gemini-4-argon']);
    const changed=await request('session/set_config_option',{sessionId:first.sessionId,configId:'thought_level',value:'high'});
    assert.equal(changed.configOptions.find((o:any)=>o.category==='thought_level').currentValue,'high');
    const other=await request('session/set_config_option',{sessionId:second.sessionId,configId:'model',value:'gemini-4-argon'});
    assert.equal(other.configOptions.find((o:any)=>o.category==='model').currentValue,'gemini-4-argon');
    for(const value of ['claude-next','gpt-oss'])await assert.rejects(()=>request('session/set_config_option',{sessionId:second.sessionId,configId:'model',value}));
    await assert.rejects(()=>request('session/set_config_option',{sessionId:first.sessionId,configId:'model',value:'missing'}));
    const persisted=JSON.parse(await readFile(path.join(dir,'sessions',first.sessionId+'.json'),'utf8'));assert.equal(persisted.selected,'gemini-new-high');
    await request('session/prompt',{sessionId:first.sessionId,prompt:[{type:'text',text:'BB role instruction sentinel'}]});
    const args=JSON.parse(await readFile(path.join(dir,'args.json'),'utf8'));
    assert.ok(args.includes('--dangerously-skip-permissions'));
    const body=await readFile(path.join(dir,'input.txt'),'utf8');
    assert.ok(body.includes('AGENTS.md'));
    assert.ok(body.includes('BB role instruction sentinel'));
    assert.equal(args[args.indexOf('--input-format')+1],'stream-json');
    const large='Long role instruction: '+('x'.repeat(140000));
    await request('session/prompt',{sessionId:first.sessionId,prompt:[{type:'text',text:large}]});
    assert.ok((await readFile(path.join(dir,'input.txt'),'utf8')).includes(large));
    const beforeDenial=updates.length;
    const callsBefore=(await readFile(path.join(dir,'calls.jsonl'),'utf8')).trim().split('\n').length;
    await request('session/prompt',{sessionId:first.sessionId,prompt:[{type:'text',text:'permission-denied-fixture'}]});
    const denied=updates.slice(beforeDenial);
    assert.ok(denied.some(update=>update.status==='failed'&&update.rawInput?.path==='outside.txt'));
    assert.ok(denied.some(update=>update.content?.text?.includes('Reading was denied; the review is blocked')));
    const recoveryCalls=(await readFile(path.join(dir,'calls.jsonl'),'utf8')).trim().split('\n').slice(callsBefore).map(line=>JSON.parse(line));
    assert.equal(recoveryCalls.length,2);
    const recovery=recoveryCalls[1];
    assert.equal(recovery.args[recovery.args.indexOf('--conversation')+1],'native-conversation');
    assert.ok(recovery.prompt.includes('do not retry the action, re-read a denied file'));
    assert.ok(!denied.some(update=>update.content?.text?.includes('No final response followed')));
    assert.ok(!JSON.stringify(denied).includes('SECRET_TOKEN'));
    const resumed=JSON.parse(await readFile(path.join(dir,'sessions',first.sessionId+'.json'),'utf8'));assert.equal(resumed.conversationId,'native-conversation');
    await request('session/load',{sessionId:first.sessionId,cwd:dir,mcpServers});
    await writeFile(path.join(dir,'sessions',second.sessionId+'.json'),JSON.stringify({...resumed,id:second.sessionId,selected:'claude-next-high'}));
    const migrated=await request('session/load',{sessionId:second.sessionId,cwd:dir,mcpServers});
    assert.equal(migrated.configOptions.find((o:any)=>o.category==='model').currentValue,'gemini-new');
    const toolStarted=new Promise<void>(resolve=>{onToolStart=resolve;});
    const waiting=request('session/prompt',{sessionId:first.sessionId,prompt:[{type:'text',text:'wait-for-cancel'}]});
    await toolStarted;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:first.sessionId}})+'\n');
    assert.equal((await waiting).stopReason,'cancelled');
    const descendant=Number(await readFile(path.join(dir,'descendant.pid'),'utf8'));
    await new Promise(resolve=>setTimeout(resolve,200));
    assert.throws(()=>process.kill(descendant,0),{code:'ESRCH'});
    assert.equal((await request('session/prompt',{sessionId:first.sessionId,prompt:[{type:'text',text:'steered follow-up'}]})).stopReason,'end_turn');
    const followUpArgs=JSON.parse(await readFile(path.join(dir,'args.json'),'utf8'));
    assert.equal(followUpArgs[followUpArgs.indexOf('--conversation')+1],'native-conversation');
    const exit=once(child,'exit');child.stdin.end();await exit;
    await assert.rejects(()=>access(a));await assert.rejects(()=>access(b));
  }finally{child.kill();await rm(dir,{recursive:true,force:true});}
});

test('restricted launch keeps sandbox on and never passes the full-permissions flag', {timeout:10000}, async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'agy-restricted-test-'));
  const file=path.join(dir,'shim.mjs');await writeFile(file,shimSource);
  const record=path.join(dir,'args.json');
  const child=spawn(process.execPath,[file,'--bb-permission-mode=accept-edits'],{env:{...process.env,AGY_BB_TEMP_DIR:dir,AGY_BB_DATA_DIR:dir,AGY_TEST_ARGS:record,AGY_TEST_DENY_RECOVERY:'1',AGY_TEST_CALLS:path.join(dir,'calls.jsonl'),AGY_BIN:fileURLToPath(new URL('./test/fake-agy.mjs',import.meta.url))},stdio:['pipe','pipe','pipe']});
  const lines=createInterface({input:child.stdout});
  try {
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'session/new',params:{cwd:dir}})+'\n');
    const [line]=await once(lines,'line');const sessionId=JSON.parse(line).result.sessionId;
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,method:'session/prompt',params:{sessionId,prompt:[{type:'text',text:'hello'}]}})+'\n');
    const updates:any[]=[];
    for await (const line of lines){const event=JSON.parse(line);if(event.params?.update)updates.push(event.params.update);if(event.id===2)break;}
    const calls=(await readFile(path.join(dir,'calls.jsonl'),'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(calls.length,2,'a second denial must not start a retry loop');
    assert.ok(updates.some(update=>update.content?.text?.includes('No final response followed the denial')));
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==='tool_call').map(update=>update.toolCallId),['1','recovery-1']);
    assert.ok(!JSON.stringify(updates).includes('SECRET_TOKEN'));
    for(const call of calls){assert.ok(call.args.includes('--sandbox'));assert.ok(!call.args.includes('--dangerously-skip-permissions'));}
    const args=JSON.parse(await readFile(record,'utf8'));
    assert.ok(args.includes('--sandbox'));
    assert.equal(args[args.indexOf('--mode')+1],'accept-edits');
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  } finally {child.kill();await rm(dir,{recursive:true,force:true});}
});

test('missing or unsupported permission modes fail closed', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'agy-invalid-mode-'));
  const file=path.join(dir,'shim.mjs');await writeFile(file,shimSource);
  try {
    for(const args of [[],['--bb-permission-mode='],['--bb-permission-mode=auto']]){
      const child=spawn(process.execPath,[file,...args],{env:{...process.env,AGY_BIN:'unused'},stdio:'ignore'});
      const [code]=await once(child,'exit');assert.notEqual(code,0);
    }
  } finally {await rm(dir,{recursive:true,force:true});}
});
