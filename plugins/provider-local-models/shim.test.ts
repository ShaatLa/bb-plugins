import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {shimSource} from './shim.ts';
import {startModelsServer} from './test/models-server.ts';

test('runs turns through codex exec, resumes the thread, keeps MCP secrets out of argv and reports failures', {timeout:15000},async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'local-models-shim-test-'));
  const server=await startModelsServer();
  const file=path.join(dir,'shim.mjs');await writeFile(file,shimSource);
  const calls=path.join(dir,'calls.jsonl');
const child=spawn(process.execPath,[file,'--bb-permission-mode=accept-edits'],{env:{...process.env,LM_BB_TEMP_DIR:dir,LM_BB_DATA_DIR:dir,LM_TEST_CALLS:calls,LM_BASE_URL:server.baseUrl,CODEX_HOME:dir,CODEX_BIN:fileURLToPath(new URL('./test/fake-codex.mjs',import.meta.url))},stdio:['pipe','pipe','pipe']});
  const updates:any[]=[];
  const pending=new Map<number,{resolve:(value:any)=>void,reject:(error:Error)=>void}>();let id=0;
  createInterface({input:child.stdout}).on('line',line=>{const value=JSON.parse(line);if(value.method==='session/update')updates.push(value.params.update);const waiter=pending.get(value.id);if(waiter){pending.delete(value.id);if(value.error)waiter.reject(Error(value.error.message));else waiter.resolve(value.result);}});
  const request=(method:string,params:any)=>new Promise<any>((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:next,method,params})+'\n');});
  try {
    const mcpServers=[{name:'bb bridge',command:process.execPath,args:['mcp.mjs'],env:[{name:'PRIVATE_TOKEN',value:'secret'}]}];
    const session=await request('session/new',{cwd:dir,mcpServers});
    const model=session.configOptions.find((o:any)=>o.category==='model');
    assert.deepEqual(model.options,[{value:'ggml-org/gpt-oss-20b-GGUF:MXFP4',name:'gpt-oss-20b (MXFP4)'}]);
    const changed=await request('session/set_config_option',{sessionId:session.sessionId,configId:'thought_level',value:'high'});
    assert.equal(changed.configOptions.find((o:any)=>o.id==='thought_level').currentValue,'high');
    await assert.rejects(()=>request('session/set_config_option',{sessionId:session.sessionId,configId:'model',value:'missing'}));

    assert.deepEqual(await request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'hello'}]}),{stopReason:'end_turn'});
    assert.deepEqual(await request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'again'}]}),{stopReason:'end_turn'});
    const [first,second]=(await readFile(calls,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
    assert.equal(first.prompt,'hello');assert.equal(first.secret,'secret');
    assert.ok(!JSON.stringify(first.args).includes('secret'));
    assert.deepEqual(first.args.slice(0,6),['exec','--json','--skip-git-repo-check','--ignore-user-config','-m','ggml-org/gpt-oss-20b-GGUF:MXFP4']);
    // Codex talks to the shim's proxy, which forwards adapted requests to the local server.
    assert.match(first.args.find((arg:string)=>arg.startsWith('model_providers.bb_local.base_url=')),/^model_providers\.bb_local\.base_url="http:\/\/127\.0\.0\.1:\d+\/v1"$/);
    assert.deepEqual(server.responses[0].input.map((item:any)=>item.role),['user']);
    assert.equal(server.responses[0].instructions,'Sandbox rules.\n\nSkills list.');
    assert.deepEqual(server.responses[0].tools.map((tool:any)=>[tool.type,tool.name]),[['function','exec_command'],['function','mcp__bb__antigravity_limits']]);
    for(const expected of ['model_reasoning_effort="high"','features.apps=false','sandbox_mode="workspace-write"','model_context_window=131072','mcp_servers.bb_bridge.env_vars=["PRIVATE_TOKEN"]','mcp_servers.bb_bridge.default_tools_approval_mode="approve"'])
      assert.ok(first.args.includes(expected),expected);
    assert.deepEqual(first.args.slice(-2),['--','-']);
    assert.deepEqual(second.args.slice(0,2),['exec','resume']);
    assert.deepEqual(second.args.slice(-3),['--','0199a000-0000-7000-8000-000000000001','-']);

    // One update per changed value: last request's input + output against Codex's context window.
    assert.deepEqual(updates.filter(u=>u.sessionUpdate==='usage_update').map(({used,size})=>({used,size})),[{used:4831,size:124518},{used:5032,size:124518}]);
    const tools=updates.filter(u=>u.sessionUpdate==='tool_call');
    assert.deepEqual(tools.map(u=>[u.toolCallId,u.title,u.kind]),[['t1-item_1','ls','execute'],['t2-item_1','ls','execute']]);
    assert.ok(updates.some(u=>u.sessionUpdate==='tool_call_update'&&u.status==='completed'&&u.content[0].content.text==='a.txt\n'));
    const text=updates.filter(u=>u.sessionUpdate==='agent_message_chunk').map(u=>u.content.text).join('|');
    assert.equal(text,'fixture reply|fixture reply');

    await assert.rejects(()=>request('session/prompt',{sessionId:session.sessionId,prompt:[{type:'text',text:'fail-fixture'}]}),/context overflow/);
  } finally {child.kill();await server.close();await rm(dir,{recursive:true,force:true});}
});
