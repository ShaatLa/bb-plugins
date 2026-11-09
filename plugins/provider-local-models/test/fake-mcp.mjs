#!/usr/bin/env node
// Minimal stdio MCP server: one echo tool that also reports a secret passed through the environment.
import {createInterface} from 'node:readline';
const out=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const {id,method,params}=JSON.parse(line);
  if(method==='initialize')out({id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}}});
  else if(method==='tools/list')out({id,result:{tools:[{name:'echo',description:'Echo text.',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}});
  else if(method==='tools/call')out({id,result:{content:[{type:'text',text:'echo:'+params.arguments.text+' token:'+process.env.PRIVATE_TOKEN}]}});
  else if(id!==undefined)out({id,error:{code:-32601,message:'nope'}});
});
