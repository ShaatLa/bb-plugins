#!/usr/bin/env node
// Stdio MCP server that lists one tool and never answers tools/call.
import {createInterface} from 'node:readline';
const out=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
createInterface({input:process.stdin}).on('line',line=>{
  const {id,method}=JSON.parse(line);
  if(method==='initialize')out({id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'hang',version:'1'}}});
  else if(method==='tools/list')out({id,result:{tools:[{name:'echo',description:'Never answers.',inputSchema:{type:'object',properties:{}}}]}});
});
