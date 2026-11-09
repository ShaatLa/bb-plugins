import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// Mimics the llama.cpp router's /v1/models answer.
export const routerModels={data:[{id:'ggml-org/gpt-oss-20b-GGUF:MXFP4',object:'model',context_length:131072,status:{value:'loaded',args:['serve','--ctx-size','65536']}}]};

const chunk=(delta:any,finish:string|null=null)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finish}]})+'\n\n';
const usage=(prompt:number,completion:number)=>'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:prompt,completion_tokens:completion}})+'\n\n';
const call=(index:number,name:string,args:unknown)=>({index,id:'call_'+index,type:'function',function:{name,arguments:JSON.stringify(args)}});
const text=(content:any)=>typeof content==='string'?content:Array.isArray(content)?content.map((part:any)=>part.text??'').join(''):'';

// Scripted /v1/chat/completions: the last user message picks the scenario, tool results advance it.
export async function startModelsServer(body:unknown=routerModels){
  const chats:any[]=[];const aborted:string[]=[];let loading=0;
  const server=createServer((request,response)=>{
    if(request.url?.startsWith('/props?')){
      const id=new URL(request.url,'http://fake').searchParams.get('model');
      if(id==='broken'){response.writeHead(500).end('{}');return;}
      const caps=id==='lfm'?{chat_template:''}:id==='muse'?{chat_template:'reasoning_strength'}:{chat_template:'enable_thinking',chat_template_caps:{supports_reasoning_effort:true,reasoning_effort_levels:['low','medium','xhigh']}};
      response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(caps));return;
    }
    if(request.url==='/models/unload'){response.writeHead(200).end('{}');return;}
    if(request.method==='POST' &&request.url==='/v1/chat/completions'){
      let raw='';request.on('data',part=>raw+=part);
      request.on('end',()=>{
        const chat=JSON.parse(raw);chats.push(chat);
        if(chat.stream===false){response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({choices:[{message:{content:'one shot reply',reasoning_content:'reasoning'}}],usage:{total_tokens:10}}));return;}
        const lastUser=chat.messages.map((m:any)=>m.role).lastIndexOf('user');
        const prompt=text(chat.messages[lastUser].content),toolResults=chat.messages.slice(lastUser).filter((m:any)=>m.role==='tool').length;
        if(prompt.includes('loading-fixture')&&loading++<2){response.writeHead(503,{'content-type':'application/json'}).end('{"error":{"message":"Loading model","code":503}}');return;}
        response.writeHead(200,{'content-type':'text/event-stream'});
        response.on('close',()=>{if(!response.writableEnded)aborted.push(prompt);});
        response.write(chunk({role:'assistant',content:null}));
        if(prompt.includes('wait-for-cancel')||prompt.includes('stall-fixture'))return;
        // A router restart: the stream dies mid-reply.
        if(prompt.includes('fail-fixture')){response.write(chunk({content:'partial'}));setTimeout(()=>response.destroy(),20);return;}
        if(prompt.includes('tool-fixture')&&toolResults===0){
          response.end(chunk({tool_calls:[call(0,'shell',{command:'printf hi > out.txt && ls'}),call(1,'mcp__bb_bridge__echo',{text:'ping'})]},'tool_calls')+usage(900,20)+'data: [DONE]\n\n');return;
        }
        if(prompt.includes('tool-fixture')&&toolResults===2){
          response.end(chunk({tool_calls:[call(0,'edit_file',{path:'out.txt',old_string:'hi',new_string:'bye'})]},'tool_calls')+usage(950,20)+'data: [DONE]\n\n');return;
        }
        // Same command with another call in between (re-running tests after an edit) must not trip the guard.
        if(prompt.includes('retest-fixture')&&toolResults<4){const cmd=toolResults===1?'true':'printf x >> retest.txt';response.end(chunk({tool_calls:[call(0,'shell',{command:cmd})]},'tool_calls')+'data: [DONE]\n\n');return;}
        if(prompt.includes('repeat-fixture')){response.end(chunk({tool_calls:[call(0,'shell',{command:'printf x >> repeats.txt'})]},'tool_calls')+'data: [DONE]\n\n');return;}
        if(prompt.includes('wait-row-fixture')){
          // Same prompt_progress shape as the llama.cpp router with return_progress.
          setTimeout(()=>response.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:null}],prompt_progress:{total:100,cache:0,processed:40,time_ms:5}})+'\n\n'),50);
          setTimeout(()=>response.end(chunk({content:'done'},'stop')+'data: [DONE]\n\n'),150);return;
        }
        response.end(chunk({reasoning_content:'thinking'})+chunk({content:'fixture '})+chunk({content:'reply'})+chunk({},'stop')+usage(4793,38)+'data: [DONE]\n\n');
      });
      return;
    }
    if(request.url!=='/v1/models'){response.writeHead(404).end();return;}
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(body));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {baseUrl:`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,chats,aborted,close:()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);})};
}
