// ACP agent that runs its own tool loop against a local OpenAI-compatible server (llama.cpp router).
// Materialized on each execution host so the host artifact is self-contained.
// Inside String.raw: no backticks and no dollar-brace sequences.
export const shimSource = String.raw`
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,renameSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute,dirname} from 'node:path';
import {tmpdir} from 'node:os';

const baseUrl=(process.env.LM_BASE_URL||'').replace(/\/+$/,'');
if(!baseUrl){process.stderr.write('The local model server is not configured.\n');process.exit(1);}
const dataDir=process.env.LM_BB_DATA_DIR||join(tmpdir(),'local-models-bb');
const permissionMode=process.argv.slice(2).find(arg=>arg.startsWith('--bb-permission-mode='))?.split('=')[1];
if(!['full','accept-edits'].includes(permissionMode))throw Error('Unsupported or missing permission mode.');
const EFFORTS=['none','low','medium','high','xhigh'];
const env=(name,fallback)=>{const value=Number(process.env[name]);return value>0?value:fallback;};
// A cold load of a dense 31B model plus prompt processing takes minutes on a laptop, so the
// time to the first byte is generous; once streaming, prompt_progress/tokens keep the idle timer alive.
const FIRST_BYTE_MS=env('LM_FIRST_BYTE_TIMEOUT_MS',20*60000),IDLE_MS=env('LM_IDLE_TIMEOUT_MS',10*60000);
const RETRY_MS=env('LM_RETRY_DELAY_MS',5000),MAX_STEPS=env('LM_MAX_STEPS',60),OUTPUT_LIMIT=30000;
mkdirSync(join(dataDir,'sessions'),{recursive:true,mode:0o700});
const sessions=new Map(),clientPending=new Map();let clientNext=0;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const fail=(id,message,code=-32602)=>send({id,error:{code,message}});
const update=(sessionId,value)=>send({method:'session/update',params:{sessionId,update:value}});
const minutes=ms=>ms<60000?Math.round(ms/1000)+' s':Math.round(ms/6000)/10+' min';
const clip=text=>text.length<=OUTPUT_LIMIT?text:text.slice(0,OUTPUT_LIMIT/2)+'\n[... '+(text.length-OUTPUT_LIMIT)+' characters omitted ...]\n'+text.slice(-OUTPUT_LIMIT/2);
const label=id=>{const [name,quant]=(id.split('/').at(-1)||id).split(':');return name.replace(/-GGUF$/i,'')+(quant?' ('+quant+')':'');};
function contextOf(model){
  const args=model.status?.args,index=Array.isArray(args)?args.indexOf('--ctx-size'):-1;
  // The --ctx-size the router loads with is the real limit; context_length is the trained one.
  const arg=index>=0?Number(args[index+1]):0,size=arg>0?arg:Number(model.context_length??model.meta?.n_ctx);
  return Number.isInteger(size)&&size>0?size:null;
}
let capsCache={};try{capsCache=JSON.parse(readFileSync(join(dataDir,'model-caps.json'),'utf8'));}catch{}
function deriveCaps(body) {
  const template = String(body.chat_template ?? ''), caps = body.chat_template_caps;
  const levels = caps?.supports_reasoning_effort && Array.isArray(caps.reasoning_effort_levels) ? caps.reasoning_effort_levels.filter((x) => ['low','medium','high','xhigh'].includes(String(x))) : [];
  return { knob: levels.length ? 'reasoning_effort' : template.includes('reasoning_strength') ? 'reasoning_strength' : null, levels: levels.length ? levels : template.includes('reasoning_strength') ? ['low','medium','high','xhigh'] : [], none: template.includes('enable_thinking'), checkedAt: Date.now() };
}
const ORDER=['low','medium','high','xhigh'];
// Nearest supported level, ties go up (high -> xhigh on Qwen3.8); 'none' falls to the lowest.
const nearest=(levels,effort)=>ORDER.filter(value=>levels.includes(value)).reduce((best,value)=>!best||Math.abs(ORDER.indexOf(value)-ORDER.indexOf(effort))<=Math.abs(ORDER.indexOf(best)-ORDER.indexOf(effort))?value:best,undefined);
function reasoningParams(caps, effort) {
  if (!caps || !effort) return {};
  if (effort === 'none' && caps.none) return { reasoning_effort: 'none' };
  const level = nearest(caps.levels, effort);
  return !level || !caps.knob ? {} : caps.knob === 'reasoning_effort' ? { reasoning_effort: level } : { chat_template_kwargs: { reasoning_strength: level } };
}

async function modelCaps(modelId,signal){
  if(capsCache[modelId])return capsCache[modelId];
  try{
    const response=await fetch(baseUrl.replace(/\/v1$/,'')+'/props?model='+encodeURIComponent(modelId),{signal});
    if(!response.ok)return;
    const caps=deriveCaps(await response.json());capsCache[modelId]=caps;
    try{const file=join(dataDir,'model-caps.json'),temp=file+'.'+process.pid+'.tmp';writeFileSync(temp,JSON.stringify(capsCache),{mode:0o600});renameSync(temp,file);}catch{}
    return caps;
  }catch{return;}
}
let models=[];
// Re-read while empty, so a router that was down when BB started this agent does not need a restart.
async function loadModels(){
  if(models.length)return models;
  models=await fetch(baseUrl+'/models',{signal:AbortSignal.timeout(10000)})
    .then(response=>response.ok?response.json():{data:[]})
    .then(body=>(Array.isArray(body?.data)?body.data:[]).filter(model=>typeof model?.id==='string'&&model.id).map(model=>({value:model.id,name:label(model.id),ctx:contextOf(model)})))
    .catch(()=>[]);
  return models;
}

const fn=(name,description,properties,required)=>({type:'function',function:{name,description,parameters:{type:'object',properties,required}}});
const BUILTIN_TOOLS=[
  fn('shell','Run a shell command in the workspace. Returns combined stdout/stderr and the exit code.',{command:{type:'string'},timeout_seconds:{type:'number',description:'Default 120, max 1800.'}},['command']),
  fn('read_file','Read a text file; returns numbered lines.',{path:{type:'string'},offset:{type:'number',description:'First line (1-based).'},limit:{type:'number',description:'Number of lines, default 400.'}},['path']),
  fn('write_file','Create or overwrite a file.',{path:{type:'string'},content:{type:'string'}},['path','content']),
  fn('edit_file','Replace an exact string in a file. old_string must be unique unless replace_all is true.',{path:{type:'string'},old_string:{type:'string'},new_string:{type:'string'},replace_all:{type:'boolean'}},['path','old_string','new_string']),
];
// Local prompt processing is slow, so the prompt stays small and stable (llama.cpp reuses the cached prefix).
function systemPrompt(cwd){
  const lines=['You are a coding agent. Workspace: '+cwd+' ('+process.platform+'). Today is '+new Date().toISOString().slice(0,10)+'.',
    'Use the tools to inspect files, run commands and make changes instead of guessing. Prefer read_file/edit_file for files; keep command output short (e.g. pipe to head). The task\'s files are in the workspace: start by listing it, never search the whole disk. Relative paths resolve against the workspace. When done, answer briefly.'];
  // shortcut: only the workspace AGENTS.md, capped at 8 KB; nested or user-level instruction files are not read.
  try{const text=readFileSync(join(cwd,'AGENTS.md'),'utf8').trim();if(text)lines.push('Project instructions (AGENTS.md):\n'+text.slice(0,8000));}catch{}
  return lines.join('\n\n');
}

function startMcp(server,index,cwd){
  const name=(String(server.name??'').replace(/[^A-Za-z0-9_-]/g,'_')||'bb_'+index);
  const child=spawn(server.command,server.args.map(String),{cwd,env:{...process.env,...Object.fromEntries(server.env.map(entry=>[entry.name,entry.value]))},stdio:['pipe','pipe','ignore']});
  const pending=new Map();let next=0,closed=false;
  const write=value=>{if(!closed)child.stdin.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');};
  const close=message=>{closed=true;for(const waiter of pending.values())waiter.reject(Error(message));pending.clear();};
  child.on('error',error=>close('MCP server '+name+' failed: '+error.message));child.on('exit',()=>close('MCP server '+name+' exited.'));child.stdin.on('error',()=>{});
  createInterface({input:child.stdout}).on('line',line=>{
    let message;try{message=JSON.parse(line);}catch{return;}
    if(message?.method&&message.id!==undefined){write({id:message.id,...(message.method==='ping'?{result:{}}:{error:{code:-32601,message:'Unsupported client method.'}})});return;}
    const waiter=pending.get(message?.id);if(!waiter)return;pending.delete(message.id);
    if(message.error)waiter.reject(Error(String(message.error.message||'MCP error')));else waiter.resolve(message.result);
  });
  const request=(method,params,signal,timeout)=>new Promise((resolve,reject)=>{
    if(closed)return reject(Error('MCP server '+name+' is not running.'));
    const id=++next;pending.set(id,{resolve,reject});write({id,method,params});
    const abort=reason=>{if(pending.delete(id)){write({method:'notifications/cancelled',params:{requestId:id}});reject(Error(reason));}};
    signal?.addEventListener('abort',()=>abort('Cancelled.'),{once:true});
    if(timeout)setTimeout(()=>abort('MCP server '+name+' did not answer '+method+'.'),timeout).unref();
  });
  const client={name,child,tools:[],request};
  client.ready=(async()=>{
    await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'bb-local-models',version:'0.2.0'}},null,30000);
    write({method:'notifications/initialized'});
    let cursor;
    do{const page=await request('tools/list',cursor?{cursor}:{},null,30000);client.tools.push(...(Array.isArray(page?.tools)?page.tools:[]));cursor=page?.nextCursor;}while(cursor);
  })().catch(()=>{client.tools=[];});
  return client;
}
function closeMcp(session){for(const client of session.mcp||[])stopChild(client.child,'SIGTERM');session.mcp=[];}
function attachMcp(session,servers=[]){
  for(const server of servers)if(typeof server.command!=='string'||!Array.isArray(server.args)||!Array.isArray(server.env))throw Error('Only stdio MCP is supported.');
  closeMcp(session);
  session.mcp=servers.map((server,index)=>startMcp(server,index,session.cwd));
  session.mcpTools=null;
}
// MCP tools become flat mcp__server__tool functions; BB's own tool servers are pre-approved like on other providers.
async function mcpTools(session){
  if(session.mcpTools)return session.mcpTools;
  await Promise.all(session.mcp.map(client=>client.ready));
  session.mcpRoutes=new Map();
  session.mcpTools=session.mcp.flatMap(client=>client.tools.filter(tool=>typeof tool?.name==='string').map(tool=>{
    const name=('mcp__'+client.name+'__'+tool.name).replace(/[^A-Za-z0-9_-]/g,'_');
    session.mcpRoutes.set(name,{client,tool:tool.name});
    return {type:'function',function:{name,description:String(tool.description??'').slice(0,1000),parameters:tool.inputSchema&&typeof tool.inputSchema==='object'?tool.inputSchema:{type:'object',properties:{}}}};
  }));
  return session.mcpTools;
}

function sessionFile(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid session ID.');return join(dataDir,'sessions',id+'.json');}
function save(session){
  const file=sessionFile(session.id),temporary=file+'.'+process.pid+'.tmp';
  const {id,cwd,selected,effort,messages,usage,instructions}=session;
  writeFileSync(temporary,JSON.stringify({version:2,id,cwd,selected,effort,messages,usage,instructions}),{mode:0o600});renameSync(temporary,file);
}
function config(session){
  const caps=capsCache[session.selected],levels=caps?[...(caps.none?['none']:[]),...caps.levels]:['low','medium','high'];
  return {configOptions:[
    {id:'model',name:'Model',category:'model',type:'select',currentValue:session.selected,options:models.map(m=>({value:m.value,name:m.name}))},
    {id:'thought_level',name:'Reasoning effort',category:'thought_level',type:'select',currentValue:levels.includes(session.effort)?session.effort:nearest(levels,session.effort)??levels[0],options:levels.map(value=>({value,name:value==='xhigh'?'Extra high':value[0].toUpperCase()+value.slice(1)}))},
  ]};
}
function emitUsage(session){if(session.usage)update(session.id,{sessionUpdate:'usage_update',...session.usage});}
function getSession(id){const session=sessions.get(id);if(!session)throw Error('Unknown session.');return session;}
function userContent(parts){
  const texts=[],images=[];
  for(const part of parts){
    if(part.type==='text'&&typeof part.text==='string')texts.push(part.text);
    else if(part.type==='image'&&typeof part.data==='string'){
      if(!['image/png','image/jpeg','image/webp','image/gif'].includes(part.mimeType))throw Error('Unsupported image type.');
      images.push({type:'image_url',image_url:{url:'data:'+part.mimeType+';base64,'+part.data}});
    }
    else if(part.type==='resource'&&typeof part.resource?.text==='string')texts.push(part.resource.text);
    else throw Error('Unsupported prompt content.');
  }
  const text=texts.filter(Boolean).join('\n\n');
  return images.length?[{type:'text',text},...images]:text;
}

// BB prepends its plugin instructions (~5k tokens) to the first prompt of every attach. In the user turn they bury the
// task: LFM2.5 repeated finished tool calls 2 of 3 times, 0 of 5 with the block in the system prompt. The newest copy wins.
function takeInstructions(session,content){
  const end=typeof content==='string'&&content.startsWith('<system_instructions>')?content.indexOf('</system_instructions>'):-1;
  if(end<0)return content;
  session.instructions=content.slice(0,end+22);
  return content.slice(end+22).trimStart();
}
const sleep=(ms,signal)=>new Promise(done=>{const timer=setTimeout(done,ms);signal.addEventListener('abort',()=>{clearTimeout(timer);done();},{once:true});});
const reasonOf=error=>String(error?.cause?.code||error?.cause?.message||error?.message||error);
// One streamed chat completion. Every failure mode ends in a thrown Error with a readable reason.
async function streamCompletion(body,signal,onChunk,deadline){
  for(;;){
    const controller=new AbortController();let reason='',timer;
    const stop=why=>{reason=why;controller.abort();};
    const arm=(ms,why)=>{clearTimeout(timer);timer=setTimeout(()=>stop(why),ms);};
    const onCancel=()=>stop('Cancelled.');signal.addEventListener('abort',onCancel,{once:true});
    arm(Math.max(0,deadline-Date.now()),'the model server sent nothing for '+minutes(FIRST_BYTE_MS)+' (model load or prompt processing took too long)');
    try{
      let response;
      try{response=await fetch(baseUrl+'/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});}
      catch(error){const code=reasonOf(error);throw Error(reason||(/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/.test(code)?'cannot reach the model server at '+baseUrl:'the model server dropped the connection')+' ('+code+')');}
      // The router answers 503 while a model is still loading; wait for it within the first-byte budget.
      if(response.status===503&&Date.now()+RETRY_MS<deadline){await response.body?.cancel().catch(()=>{});await sleep(RETRY_MS,signal);if(signal.aborted)throw Error('Cancelled.');continue;}
      if(!response.ok){
        const text=await response.text().catch(()=>'');let message=text;
        try{message=JSON.parse(text).error?.message||text;}catch{}
        throw Error('the model server answered '+response.status+(message?': '+String(message).slice(0,300):''));
      }
      const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',finished=false;
      for(;;){
        let chunk;
        try{chunk=await reader.read();}catch(error){throw Error(reason||'the model server closed the stream ('+reasonOf(error)+')');}
        if(chunk.done)break;
        arm(IDLE_MS,'the model server stopped streaming for '+minutes(IDLE_MS));
        buffer+=decoder.decode(chunk.value,{stream:true});
        const lines=buffer.split('\n');buffer=lines.pop();
        for(const line of lines){
          if(!line.startsWith('data:'))continue;
          const data=line.slice(5).trim();
          if(data==='[DONE]'){finished=true;continue;}
          let event;try{event=JSON.parse(data);}catch{continue;}
          if(event.error)throw Error(String(event.error.message||JSON.stringify(event.error)).slice(0,300));
          if(event.choices?.[0]?.finish_reason)finished=true;
          onChunk(event);
        }
      }
      if(reason)throw Error(reason);
      if(!finished)throw Error('the model server ended the stream before the reply was complete');
      return;
    }finally{clearTimeout(timer);signal.removeEventListener('abort',onCancel);}
  }
}

function inside(cwd,file){const path=relative(cwd,file);return path===''||(!path.startsWith('..')&&!isAbsolute(path));}
function describe(session,name,args){
  const path=typeof args?.path==='string'?resolve(session.cwd,args.path):null;
  if(name==='shell')return {title:String(args?.command??'shell'),kind:'execute',rawInput:{command:args?.command}};
  if(name==='read_file')return {title:'Read '+(path??''),kind:'read',locations:path?[{path,line:args.offset??null}]:[],rawInput:args};
  if(name==='write_file'||name==='edit_file')return {title:'Edit '+(path??''),kind:'edit',locations:path?[{path}]:[],rawInput:{path}};
  const route=session.mcpRoutes?.get(name);
  return {title:route?route.client.name+'.'+route.tool:name,kind:'other',rawInput:args};
}
function askPermission(session,toolCall,signal,allowAllLabel){
  return new Promise(done=>{
    const id='lm-'+(++clientNext);clientPending.set(id,done);
    signal.addEventListener('abort',()=>{if(clientPending.delete(id))done({result:{outcome:{outcome:'cancelled'}}});},{once:true});
    send({id,method:'session/request_permission',params:{sessionId:session.id,toolCall,options:[
      {optionId:'allow',name:'Allow',kind:'allow_once'},
      ...(allowAllLabel?[{optionId:'always',name:allowAllLabel,kind:'allow_always'}]:[]),
      {optionId:'deny',name:'Deny',kind:'reject_once'}]}});
  }).then(reply=>reply.error?'error: '+String(reply.error.message||'unknown'):reply.result?.outcome?.outcome==='selected'?reply.result.outcome.optionId:'cancelled');
}
function runShell(session,command,seconds,signal){
  return new Promise(done=>{
    const child=spawn(command,{shell:true,cwd:session.cwd,env:process.env,stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});
    session.children.add(child);let output='',timedOut=false;
    const collect=chunk=>{output+=chunk;if(output.length>4*OUTPUT_LIMIT)output=output.slice(0,OUTPUT_LIMIT)+output.slice(-2*OUTPUT_LIMIT);};
    child.stdout.setEncoding('utf8').on('data',collect);child.stderr.setEncoding('utf8').on('data',collect);
    const timer=setTimeout(()=>{timedOut=true;stopChild(child,'SIGKILL');},Math.min(Math.max(Number(seconds)||120,1),1800)*1000);
    const finish=(code,error)=>{clearTimeout(timer);session.children.delete(child);
      const note=signal.aborted?'[cancelled by the user; the command was killed]':timedOut?'[timed out]':error?'[failed to start: '+error.message+']':'[exit code '+code+']';
      done({ok:!error&&code===0&&!timedOut&&!signal.aborted,text:clip(output)+(output.endsWith('\n')||!output?'':'\n')+note});};
    child.on('error',error=>finish(null,error));child.on('close',code=>finish(code));
  });
}
async function execute(session,name,args,signal){
  const path=typeof args.path==='string'&&args.path?resolve(session.cwd,args.path):null;
  if(name==='shell'){if(typeof args.command!=='string'||!args.command.trim())throw Error('command is required.');return runShell(session,args.command,args.timeout_seconds,signal);}
  if(name==='read_file'){
    if(!path)throw Error('path is required.');
    const lines=(await readFile(path,'utf8')).split('\n'),start=Math.max(1,Math.floor(Number(args.offset)||1)),count=Math.max(1,Math.floor(Number(args.limit)||400));
    const shown=lines.slice(start-1,start-1+count).map((line,index)=>(start+index)+'\t'+line).join('\n');
    return {ok:true,text:clip(shown)+(start-1+count<lines.length?'\n[file has '+lines.length+' lines; continue with offset '+(start+count)+']':'')};
  }
  if(name==='write_file'){
    if(!path||typeof args.content!=='string')throw Error('path and content are required.');
    const old=await readFile(path,'utf8').catch(()=>null);
    await mkdir(dirname(path),{recursive:true});await writeFile(path,args.content);
    return {ok:true,text:(old===null?'Created ':'Wrote ')+path,content:[{type:'diff',path,oldText:old,newText:args.content}]};
  }
  if(name==='edit_file'){
    if(!path||typeof args.old_string!=='string'||typeof args.new_string!=='string'||!args.old_string)throw Error('path, old_string and new_string are required.');
    const text=await readFile(path,'utf8'),count=text.split(args.old_string).length-1;
    if(!count)throw Error('old_string was not found in '+path+'.');
    if(count>1&&!args.replace_all)throw Error('old_string occurs '+count+' times in '+path+'; include more context or set replace_all.');
    const index=text.indexOf(args.old_string);
    const next=args.replace_all?text.split(args.old_string).join(args.new_string):text.slice(0,index)+args.new_string+text.slice(index+args.old_string.length);
    await writeFile(path,next);
    return {ok:true,text:'Edited '+path+(count>1?' ('+count+' replacements)':''),content:[{type:'diff',path,oldText:args.old_string,newText:args.new_string}]};
  }
  const route=session.mcpRoutes?.get(name);
  if(!route)throw Error('Unknown tool '+name+'.');
  const result=await route.client.request('tools/call',{name:route.tool,arguments:args},signal);
  const text=(Array.isArray(result?.content)?result.content:[]).map(part=>part?.type==='text'?part.text:JSON.stringify(part)).join('\n')||JSON.stringify(result?.structuredContent??result??null);
  return {ok:!result?.isError,text:clip(String(text))};
}
async function runTool(session,call,signal){
  const toolCallId='lm-'+randomUUID(),name=call.function.name;
  let args=null;try{args=JSON.parse(call.function.arguments||'{}');}catch{}
  const info=describe(session,name,args);
  update(session.id,{sessionUpdate:'tool_call',toolCallId,...info,status:'in_progress'});
  const done=(status,text,content)=>{update(session.id,{sessionUpdate:'tool_call_update',toolCallId,status,content:content??(text?[{type:'content',content:{type:'text',text}}]:[])});return text;};
  if(!args||typeof args!=='object'||Array.isArray(args))return done('failed','Error: the tool arguments are not a JSON object.');
  const path=typeof args.path==='string'?resolve(session.cwd,args.path):null;
  // accept-edits: edits inside the workspace and all reads run freely; commands and outside writes need the user.
  const gated=permissionMode!=='full'&&((name==='shell'&&!session.allowShell)||((name==='write_file'||name==='edit_file')&&path&&!inside(session.cwd,path)));
  if(gated){
    const choice=await askPermission(session,{toolCallId,...info},signal,name==='shell'?'Allow all commands this session':null);
    if(signal.aborted)return done('failed','Cancelled by the user.');
    if(choice==='always')session.allowShell=true;
    else if(choice==='cancelled')return done('failed','The approval request was cancelled before the user answered; the tool did not run.');
    else if(choice.startsWith('error: '))return done('failed','The approval request failed ('+choice.slice(7)+'); the tool did not run.');
    else if(choice!=='allow')return done('failed','The user denied this tool call. Do not retry it; continue without it or tell the user what you need.');
  }
  try{
    const result=await execute(session,name,args,signal);
    done(result.ok?'completed':'failed',result.text,result.content&&[...result.content,{type:'content',content:{type:'text',text:result.text}}]);
    return result.text;
  }catch(error){return done('failed','Error: '+(signal.aborted?'Cancelled.':reasonOf(error)));}
}
async function runTurn(session,signal,progress){
  const tools=[...BUILTIN_TOOLS,...await mcpTools(session)],model=models.find(m=>m.value===session.selected);
  // Only back-to-back identical calls count: re-running a test after an edit is legitimate.
  let lastKey='',repeats=0,lastResult='';
  for(let step=0;step<MAX_STEPS;step++){
    if(session.usage && session.usage.used>0.7*session.usage.size){
      const users=session.messages.map((m,i)=>m.role==='user'?i:-1).filter(i=>i>=0),cut=users.at(-2)??0;
      for(let i=0;i<cut;i++)if(session.messages[i].role==='tool'&&session.messages[i].content?.length>200)session.messages[i].content='[old tool output removed to save context]';
      save(session);
    }
    const reply={content:'',calls:[],finish:null,usage:null};progress.reply=reply;
    const deadline=Date.now()+FIRST_BYTE_MS,waitingId='lm-'+randomUUID();let waiting=false,real=false,lastProgress=0;
    const waitTimer=setTimeout(()=>{if(!real){waiting=true;update(session.id,{sessionUpdate:'tool_call',toolCallId:waitingId,kind:'other',status:'in_progress',title:'Waiting for '+label(session.selected)});}},env('LM_WAIT_ROW_MS',3000));
    const finishWait=status=>{clearTimeout(waitTimer);if(waiting){update(session.id,{sessionUpdate:'tool_call_update',toolCallId:waitingId,status});waiting=false;}};
    try{
    const caps=await modelCaps(session.selected,AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,deadline-Date.now()))]));
    if(signal.aborted)throw Error('Cancelled.');
    const body={model:session.selected,stream:true,stream_options:{include_usage:true},return_progress:true,
      // The BB block lists ~34 absolute SKILL.md paths; without this trailing reminder LFM2.5 opened them first in 5 of 20 runs (0 of 20 with it).
      messages:[{role:'system',content:session.system+(session.instructions?'\n\n'+session.instructions+'\n\nReminder: the task is in the workspace '+session.cwd+'. The SKILL.md paths above are reference docs; open one only if the task needs it.':'')},...session.messages],tools,...reasoningParams(caps,session.effort)};
    await streamCompletion(body,signal,event=>{
      const d=event.choices?.[0]?.delta;
      if(d&&(d.content||d.reasoning_content||d.tool_calls?.length)){real=true;finishWait('completed');}
      if(waiting&&event.prompt_progress&&Date.now()-lastProgress>=2000){
        lastProgress=Date.now();const p=event.prompt_progress;
        const percent=Math.round(100*(p.processed??0)/(p.total||1));
        update(session.id,{sessionUpdate:'tool_call_update',toolCallId:waitingId,title:'Waiting for '+label(session.selected)+': processing prompt '+percent+'%'});
      }
      if(event.usage)reply.usage=event.usage;
      const choice=event.choices?.[0];if(!choice)return;
      const delta=choice.delta||{};
      if(typeof delta.reasoning_content==='string'&&delta.reasoning_content)update(session.id,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:delta.reasoning_content}});
      if(typeof delta.content==='string'&&delta.content){
        const text=(progress.hadText&&!reply.content?'\n\n':'')+delta.content;
        reply.content+=delta.content;progress.hadText=true;
        update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text}});
      }
      for(const part of Array.isArray(delta.tool_calls)?delta.tool_calls:[]){
        const slot=reply.calls[part.index??0]??={id:'',name:'',arguments:''};
        if(part.id)slot.id=part.id;
        if(part.function?.name&&!slot.name)slot.name=part.function.name;
        if(typeof part.function?.arguments==='string')slot.arguments+=part.function.arguments;
      }
      if(choice.finish_reason)reply.finish=choice.finish_reason;
    },deadline);finishWait('completed');
    }catch(error){finishWait('failed');throw error;}
    progress.reply=null;
    if(reply.usage&&model?.ctx){
      session.usage={used:(reply.usage.prompt_tokens||0)+(reply.usage.completion_tokens||0),size:model.ctx};emitUsage(session);
    }
    const calls=reply.calls.filter(call=>call?.name).map(call=>({id:call.id||'call_'+randomUUID().slice(0,8),type:'function',function:{name:call.name,arguments:call.arguments||'{}'}}));
    session.messages.push({role:'assistant',content:reply.content,...(calls.length?{tool_calls:calls}:{})});
    if(!calls.length)return reply.finish==='length'?'max_tokens':'end_turn';
    let stopped=false;
    for(const call of calls){
      const key=call.function.name+'\n'+call.function.arguments;repeats=key===lastKey?repeats+1:1;lastKey=key;
      let result;
      if(stopped||repeats>=4){stopped=true;result='Stopped: the model kept repeating the same tool call.';}
      else if(repeats===3)result='You already made this exact call 2 times in a row. Last result:\n'+lastResult.slice(0,2000)+'\nDo not repeat it; use the result or answer.';
      else {result=signal.aborted?'Cancelled by the user.':await runTool(session,call,signal);lastResult=result;}
      session.messages.push({role:'tool',tool_call_id:call.id,content:result});
    }
    if(stopped){progress.hadText=true;update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Stopped: the model kept repeating the same tool call.'}});return 'end_turn';}
    save(session);
    if(signal.aborted)return 'cancelled';
  }
  progress.hadText=true;update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Stopped after '+MAX_STEPS+' tool steps without a final answer.'}});
  return 'max_turn_requests';
}
function runPrompt(id,session,prompt){
  if(session.running)throw Error('A prompt is already running.');
  const content=takeInstructions(session,userContent(prompt)),controller=new AbortController(),progress={hadText:false,reply:null};
  session.running=true;session.cancelled=false;session.abort=controller;
  session.messages.push({role:'user',content});
  (async()=>{
    let stopReason,failure=null;
    try{stopReason=await runTurn(session,controller.signal,progress);}
    catch(error){failure=error;}
    // Keep user/assistant alternation for strict chat templates when a reply was cut short.
    if(session.messages.at(-1)?.role==='user')session.messages.push({role:'assistant',content:progress.reply?.content||'(interrupted)'});
    for(const child of session.children)stopChild(child,'SIGKILL');
    session.running=false;session.abort=null;
    try{save(session);}catch{return fail(id,'Local models session could not be saved.',-32603);}
    if(session.cancelled)return send({id,result:{stopReason:'cancelled'}});
    if(failure)return fail(id,'Local model turn failed: '+reasonOf(failure),-32603);
    if(!progress.hadText)update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The local model finished without a text response.'}});
    send({id,result:{stopReason}});
  })();
}
async function openSession(params,stored){
  await loadModels();
  if(!models.length)throw Error('No local models available. Start the local model server at '+baseUrl+'.');
  const selected=models.find(m=>m.value===stored?.selected)||models.find(m=>m.value===process.env.LM_DEFAULT_MODEL)||models[0];
  const cwd=params.cwd||stored?.cwd;if(typeof cwd!=='string')throw Error('No workspace available.');
  const session={id:stored?.id??randomUUID(),cwd,selected:selected.value,effort:EFFORTS.includes(stored?.effort)?stored.effort:'medium',
    // Sessions stored by the Codex-based version carry no transcript; they continue without earlier context.
    messages:Array.isArray(stored?.messages)?stored.messages:[],usage:stored?.usage??null,instructions:typeof stored?.instructions==='string'?stored.instructions:null,
    system:systemPrompt(cwd),children:new Set(),running:false,allowShell:false};
  const previous=sessions.get(session.id);if(previous){previous.abort?.abort();closeMcp(previous);}
  attachMcp(session,params.mcpServers);save(session);sessions.set(session.id,session);
  return session;
}
async function handle(request){
  const {id,method,params:p={}}=request;
  if(method==='initialize')return send({id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{http:false,sse:false}},authMethods:[],agentInfo:{name:'bb-local-models',version:'0.2.0'}}});
  if(method==='authenticate')return send({id,result:{}});
  if(method==='session/new'){const session=await openSession(p,null);return send({id,result:{sessionId:session.id,...config(session)}});}
  if(method==='session/load'||method==='session/resume'){
    const stored=JSON.parse(readFileSync(sessionFile(p.sessionId),'utf8'));
    if(stored.id!==p.sessionId||typeof stored.cwd!=='string'||typeof stored.selected!=='string')throw Error('Invalid stored session.');
    const session=await openSession(p,stored);
    send({id,result:config(session)});
    // After the load reply, so BB already maps this session to its thread.
    return emitUsage(session);
  }
  if(method==='session/set_config_option'||method==='session/set_model'){
    const session=getSession(p.sessionId);if(session.running)throw Error('Cannot change a running session.');
    const option=p.configId||'model',value=p.value||p.modelId;
    if(option==='model'&&models.some(m=>m.value===value))session.selected=value;
    else if(option==='thought_level'&&EFFORTS.includes(value))session.effort=value;
    else throw Error('Unsupported model or effort.');
    save(session);return send({id,result:config(session)});
  }
  if(method==='session/prompt')return runPrompt(id,getSession(p.sessionId),p.prompt);
  if(method==='session/cancel'){
    const session=getSession(p.sessionId);if(!session.running)return;
    session.cancelled=true;session.abort?.abort();
    for(const child of session.children)stopChild(child,'SIGKILL');
    return;
  }
  if(id!==undefined)fail(id,'Unsupported Local models ACP method.',-32601);
}
createInterface({input:process.stdin}).on('line',line=>{
  let request;try{request=JSON.parse(line);}catch{return;}
  if(request&&request.method===undefined&&clientPending.has(request.id)){const done=clientPending.get(request.id);clientPending.delete(request.id);done(request);return;}
  if(!request||typeof request.method!=='string')return;
  Promise.resolve().then(()=>handle(request)).catch(error=>{if(request.id!==undefined)fail(request.id,error instanceof Error&&error.message?error.message:'Invalid Local models request or unavailable session.');});
}).on('close',shutdown);
function stopChild(child,signal){
  if(!child?.pid)return;
  if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
  else {
    // Commands can start their own process groups, outside the shell's group.
    try {
      const rows=execFileSync('ps',['-axo','pid=,ppid=,lstart='],{encoding:'utf8',timeout:1000,maxBuffer:2097152})
        .trim().split('\n').map(line=>line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/)).filter(Boolean)
        .map(row=>({pid:Number(row[1]),parent:Number(row[2]),started:row[3]}));
      const owned=new Set([child.pid]);let previous;
      do {previous=owned.size;for(const row of rows)if(owned.has(row.parent))owned.add(row.pid);}while(previous!==owned.size);
      child.descendants??=new Map();
      for(const row of rows)if(owned.has(row.pid)&&row.pid!==child.pid)child.descendants.set(row.pid,row.started);
      for(const row of rows.reverse())if(child.descendants.get(row.pid)===row.started)try{process.kill(row.pid,signal);}catch{}
    }catch{ /* Process groups remain the fallback when ps is unavailable. */ }
    try{process.kill(-child.pid,signal);}catch{}
    try{child.kill(signal);}catch{}
  }
}
function shutdown(){for(const session of sessions.values()){session.abort?.abort();for(const child of session.children)stopChild(child,'SIGKILL');closeMcp(session);}process.exit(0);}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,shutdown);
`;
