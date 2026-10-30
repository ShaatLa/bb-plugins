import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mimics the llama.cpp router's /v1/models answer.
export const routerModels={data:[{id:'ggml-org/gpt-oss-20b-GGUF:MXFP4',object:'model',status:{value:'loaded',args:['serve','--ctx-size','131072']}}]};

export async function startModelsServer(body:unknown=routerModels){
  const responses:any[]=[];
  const server=createServer((request,response)=>{
    if(request.method==='POST'&&request.url==='/v1/responses'){
      let raw='';request.on('data',chunk=>raw+=chunk);
      request.on('end',()=>{responses.push(JSON.parse(raw));response.writeHead(200,{'content-type':'text/event-stream'}).end('event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","name":"mcp__bb__antigravity_limits","arguments":"{}"}}\n\ndata: {"type":"response.completed"}\n\n');});
      return;
    }
    if(request.url!=='/v1/models'){response.writeHead(404).end();return;}
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,responses,close:()=>new Promise(resolve=>server.close(resolve))};
}
