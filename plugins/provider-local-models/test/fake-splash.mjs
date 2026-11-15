import {createServer} from 'node:http';
import {basename} from 'node:path';
const arg=name=>process.argv[process.argv.indexOf(name)+1];
console.log(JSON.stringify(process.argv.slice(2)));
const context=process.argv.includes('--max-context')?Number(arg('--max-context')):131072;
if(context>131072)process.exit(2);
const model=arg('--model'),started=Date.now(),neverReady=basename(arg('--model-dir'))==='timeout.gguf';
const server=createServer(async(request,response)=>{
  if(request.url==='/ready'){response.writeHead(!neverReady&&Date.now()-started>=150?200:503).end();return;}
  if(request.url==='/v1/models'){response.setHeader('content-type','application/json');response.end(JSON.stringify({data:[{id:model,context_length:context}]}));return;}
  if(request.url==='/v1/chat/completions'){
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw);
    if(body.model!==model){response.writeHead(400).end('wrong served name');return;}
    if(body.stream===false){response.setHeader('content-type','application/json');response.end(JSON.stringify({choices:[{message:{content:model}}]}));return;}
    response.writeHead(200,{'content-type':'text/event-stream'});
    response.write('data: '+JSON.stringify({choices:[{delta:{content:model}}]})+'\n\n');
    const timer=setTimeout(()=>response.end('data: [DONE]\n\n'),body.delay??20);
    response.on('close',()=>clearTimeout(timer));return;
  }
  response.writeHead(404).end();
});
server.listen(Number(arg('--port')),'127.0.0.1');
process.on('SIGTERM',()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
