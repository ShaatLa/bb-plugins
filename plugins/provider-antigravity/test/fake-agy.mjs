#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
if(process.env.AGY_TEST_ARGS)writeFileSync(process.env.AGY_TEST_ARGS,JSON.stringify(process.argv.slice(2)));
const prompt=process.argv.includes('--input-format')?JSON.parse(readFileSync(0,'utf8')).message.content:process.argv.at(-1);
if(process.env.AGY_TEST_INPUT&&process.argv.includes('--input-format'))writeFileSync(process.env.AGY_TEST_INPUT,prompt);
if(process.env.AGY_TEST_CALLS&&process.argv.includes('--input-format')){const fs=await import('node:fs');fs.appendFileSync(process.env.AGY_TEST_CALLS,JSON.stringify({prompt,args:process.argv.slice(2)})+'\n');}
if(process.argv.includes('--version'))console.log('1.4.6');
else if(process.argv.includes('models'))console.log('gemini-new-low\tGemini New (Low)\ngemini-new-high\tGemini New (High)\nclaude-next-high\tClaude Next (High)\ngemini-4-argon-high\tGemini 4 Argon (High)\ngpt-oss-medium\tGPT OSS (Medium)');
else if(prompt?.includes('wait-for-cancel')){
 process.on('SIGINT',()=>{});
 if(process.env.AGY_TEST_DESCENDANT_PID){
  const nested=spawn(process.execPath,['-e','process.on("SIGINT",()=>{});setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  writeFileSync(process.env.AGY_TEST_DESCENDANT_PID,String(nested.pid));
 }
 console.log(JSON.stringify({event:'init',conversation_id:'native-conversation'}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'ACTIVE',tool_name:'waiting_fixture'}}));
 setInterval(()=>{},1000);
}
else if(prompt?.includes('A native action was denied by the permission policy')&&!process.env.AGY_TEST_DENY_RECOVERY){
 console.log(JSON.stringify({event:'init',conversation_id:'native-conversation'}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'Reading was denied; the review is blocked without the diff.'}}));
 console.log(JSON.stringify({event:'result',result:{conversation_id:'native-conversation',status:'SUCCESS',response:'Reading was denied; the review is blocked without the diff.'}}));
}
else if(prompt?.includes('permission-denied-fixture')||process.env.AGY_TEST_DENY_RECOVERY){
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'I will read the diff.'}}));
 console.log(JSON.stringify({event:'init',conversation_id:'native-conversation'}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'DONE',tool_name:'write_file',tool_info:{parameters:{path:'outside.txt'},error:{type:'PERMISSION_DENIED',message:'SECRET_TOKEN'}}}}));
 console.log(JSON.stringify({event:'result',result:{conversation_id:'native-conversation',status:'SUCCESS',response:''}}));
}
else {
 console.log(JSON.stringify({event:'init',conversation_id:'native-conversation'}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'ACTIVE',tool_name:'fixture_tool'}}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'tool',step_index:1,state:'DONE',tool_name:'fixture_tool',tool_info:{output:'fixture tool result'}}}));
 console.log(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:'fixture reply'}}));
 console.log(JSON.stringify({event:'result',result:{conversation_id:'native-conversation',status:'SUCCESS',response:'fixture reply'}}));
}
