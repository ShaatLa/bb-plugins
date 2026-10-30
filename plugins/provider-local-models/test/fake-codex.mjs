#!/usr/bin/env node
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
const args=process.argv.slice(2);
const prompt=args.at(-1)==='-'?readFileSync(0,'utf8'):'';
if(process.env.LM_TEST_CALLS)appendFileSync(process.env.LM_TEST_CALLS,JSON.stringify({prompt,args,secret:process.env.PRIVATE_TOKEN??null})+'\n');
const out=value=>console.log(JSON.stringify(value));
const threadId='0199a000-0000-7000-8000-000000000001';
// Like Codex: token counts go only to the rollout log, in the local-time date folder of the UUIDv7 thread id.
function logTokens(input,output){
  if(!process.env.CODEX_HOME)return;
  const day=new Date(parseInt(threadId.replace(/-/g,'').slice(0,12),16)),pad=n=>String(n).padStart(2,'0');
  const dir=join(process.env.CODEX_HOME,'sessions',String(day.getFullYear()),pad(day.getMonth()+1),pad(day.getDate()));
  mkdirSync(dir,{recursive:true});
  appendFileSync(join(dir,'rollout-2025-10-01T00-00-00-'+threadId+'.jsonl'),
    JSON.stringify({type:'event_msg',payload:{type:'token_count',info:null}})+'\n'+
    JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input*3,output_tokens:output*3},last_token_usage:{input_tokens:input,cached_input_tokens:0,output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output},model_context_window:124518}}})+'\n');
}
// Like Codex: one Responses request with developer messages and a namespaced MCP tool, sent to the configured base_url.
const baseUrl=JSON.parse(args.find(arg=>arg.startsWith('model_providers.bb_local.base_url='))?.split('=').slice(1).join('=')??'""');
if(baseUrl&&!prompt.includes('wait-for-cancel')){
  const reply=await fetch(baseUrl+'/responses',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'m',stream:true,
    input:[{type:'message',role:'developer',content:[{type:'input_text',text:'Sandbox rules.'}]},{type:'message',role:'developer',content:[{type:'input_text',text:'Skills list.'}]},{type:'message',role:'user',content:[{type:'input_text',text:prompt}]}],
    tools:[{type:'function',name:'exec_command'},{type:'namespace',name:'mcp__bb',description:'bb tools',tools:[{type:'function',name:'antigravity_limits'}]},{type:'namespace',name:'multi_agent_v1',tools:[{type:'function',name:'spawn_agent'}]}]})});
  const events=await reply.text();
  // The shim must hand namespaced calls back the way Codex expects them.
  if(!events.includes('response.completed')||!events.includes('"name":"antigravity_limits","arguments":"{}","namespace":"mcp__bb"'))process.exit(3);
}
out({type:'thread.started',thread_id:threadId});
out({type:'item.completed',item:{id:'item_0',type:'error',message:'Model metadata for `local` not found.'}});
out({type:'turn.started'});
if(prompt.includes('wait-for-cancel')){
 process.on('SIGINT',()=>{});
 out({type:'item.started',item:{id:'item_1',type:'command_execution',command:'sleep 100',aggregated_output:'',exit_code:null,status:'in_progress'}});
 setInterval(()=>{},1000);
}
else if(prompt.includes('fail-fixture')){out({type:'turn.failed',error:{message:'context overflow'}});process.exit(1);}
else {
 const resumed=args[1]==='resume';
 logTokens(resumed?4969:4793,resumed?63:38);
 out({type:'item.started',item:{id:'item_1',type:'command_execution',command:'ls',aggregated_output:'',exit_code:null,status:'in_progress'}});
 out({type:'item.completed',item:{id:'item_1',type:'command_execution',command:'ls',aggregated_output:'a.txt\n',exit_code:0,status:'completed'}});
 out({type:'item.completed',item:{id:'item_2',type:'agent_message',text:'fixture reply'}});
 out({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
}
