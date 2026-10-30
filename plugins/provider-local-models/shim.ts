// ACP agent that runs each turn through `codex exec` against a local OpenAI-compatible server.
// Materialized on each execution host so the host artifact is self-contained.
export const shimSource = String.raw`
import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,renameSync,mkdtempSync,rmSync,readdirSync,openSync,fstatSync,readSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import http from 'node:http';
import https from 'node:https';

const codex=process.env.CODEX_BIN,baseUrl=process.env.LM_BASE_URL;
if(!codex||!baseUrl){process.stderr.write('Codex CLI or local model server is not configured.\n');process.exit(1);}
const dataDir=process.env.LM_BB_DATA_DIR||join(tmpdir(),'local-models-bb');
const tempDir=process.env.LM_BB_TEMP_DIR||tmpdir();
const permissionMode=process.argv.slice(2).find(arg=>arg.startsWith('--bb-permission-mode='))?.split('=')[1];
if(!['full','accept-edits'].includes(permissionMode))throw Error('Unsupported or missing permission mode.');
const EFFORTS=['low','medium','high'];
mkdirSync(join(dataDir,'sessions'),{recursive:true,mode:0o700});
const sessions=new Map(),pendingRoots=new Set();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const fail=(id,message,code=-32602)=>send({id,error:{code,message}});
const update=(sessionId,value)=>send({method:'session/update',params:{sessionId,update:value}});
// JSON strings and string arrays are valid TOML values for codex -c overrides.
const toml=value=>JSON.stringify(value);
const label=id=>{const [name,quant]=(id.split('/').at(-1)||id).split(':');return name.replace(/-GGUF$/i,'')+(quant?' ('+quant+')':'');};
function contextOf(model){
  const args=model.status?.args,index=Array.isArray(args)?args.indexOf('--ctx-size'):-1;
  const size=Number(index>=0?args[index+1]:model.meta?.n_ctx);
  return Number.isInteger(size)&&size>0?size:null;
}
const models=await fetch(baseUrl.replace(/\/+$/,'')+'/models',{signal:AbortSignal.timeout(10000)})
  .then(response=>response.ok?response.json():{data:[]})
  .then(body=>(Array.isArray(body?.data)?body.data:[]).filter(model=>typeof model?.id==='string'&&model.id).map(model=>({value:model.id,name:label(model.id),ctx:contextOf(model)})))
  .catch(()=>[]);
// Codex sends developer messages and namespaced MCP tools; strict chat templates (Qwen, Gemma)
// reject non-leading system messages and llama.cpp drops namespace tools, so rewrite before forwarding.
function adapt(body,flat){
  const notes=[],input=[];
  for(const item of Array.isArray(body.input)?body.input:[]){
    if((item?.type==='message'||!item?.type)&&(item?.role==='developer'||item?.role==='system'))
      notes.push(...(typeof item.content==='string'?[item.content]:(Array.isArray(item.content)?item.content:[]).map(part=>part?.text).filter(text=>typeof text==='string')));
    else input.push(item);
  }
  const instructions=[body.instructions,...notes].filter(Boolean).join('\n\n');
  // MCP namespaces become flat mcp__server__tool functions; other namespaces (built-in sub-agents) only cost local context.
  const tools=Array.isArray(body.tools)?body.tools.flatMap(tool=>tool?.type!=='namespace'?[tool]
    :String(tool.name).startsWith('mcp__')&&Array.isArray(tool.tools)?tool.tools.map(inner=>{
      flat.set(tool.name+'__'+inner.name,{namespace:tool.name,name:inner.name});return {...inner,name:tool.name+'__'+inner.name};
    }):[]):body.tools;
  return {...body,input,tools,...(instructions?{instructions}:{})};
}
// Codex only accepts calls to namespaced tools as {namespace, name}, so split flat names back in the reply.
function restore(value,flat){
  if(Array.isArray(value)){for(const entry of value)restore(entry,flat);return;}
  if(!value||typeof value!=='object')return;
  if(value.type==='function_call'&&flat.has(value.name))Object.assign(value,flat.get(value.name));
  for(const key in value)restore(value[key],flat);
}
const upstream=new URL(baseUrl);
const proxy=http.createServer((req,res)=>{
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));
  req.on('end',()=>{
    let body=Buffer.concat(chunks);const flat=new Map();
    if(req.method==='POST'&&/\/responses$/.test(req.url.split('?')[0])&&!req.headers['content-encoding'])
      try{body=Buffer.from(JSON.stringify(adapt(JSON.parse(body.toString('utf8')),flat)));}catch{ /* Forward unparseable bodies unchanged. */ }
    const headers={...req.headers,host:upstream.host,'content-length':String(body.length)};delete headers['transfer-encoding'];
    const out=(upstream.protocol==='https:'?https:http).request(new URL(req.url,upstream.origin),{method:req.method,headers},reply=>{
      if(!flat.size||reply.headers['content-encoding']||!String(reply.headers['content-type']).includes('event-stream')){res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);return;}
      const replyHeaders={...reply.headers};delete replyHeaders['content-length'];res.writeHead(reply.statusCode,replyHeaders);
      const fix=line=>{if(!line.startsWith('data:'))return line;try{const event=JSON.parse(line.slice(5));restore(event,flat);return 'data: '+JSON.stringify(event);}catch{return line;}};
      let pending='';reply.setEncoding('utf8');
      reply.on('data',chunk=>{const lines=(pending+chunk).split('\n');pending=lines.pop();if(lines.length)res.write(lines.map(fix).join('\n')+'\n');});
      reply.on('end',()=>res.end(fix(pending)));
    });
    out.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
    out.end(body);
  });
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const proxyBase='http://127.0.0.1:'+proxy.address().port+upstream.pathname.replace(/\/+$/,'');
function sessionFile(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid session ID.');return join(dataDir,'sessions',id+'.json');}
// Codex logs per-request token counts only in its session rollout file.
function rolloutFile(session){
  if(session.rollout)return session.rollout;
  const base=join(process.env.CODEX_HOME||join(homedir(),'.codex'),'sessions');
  // UUIDv7 thread ids start with the creation time in ms; Codex names date folders in local time.
  const created=parseInt(session.threadId.replace(/-/g,'').slice(0,12),16);
  for(const offset of [0,-86400000,86400000]){
    const day=new Date(created+offset),pad=n=>String(n).padStart(2,'0');
    const dir=join(base,String(day.getFullYear()),pad(day.getMonth()+1),pad(day.getDate()));
    let name;try{name=readdirSync(dir).find(f=>f.endsWith('-'+session.threadId+'.jsonl'));}catch{}
    if(name)return session.rollout=join(dir,name);
  }
  return null;
}
function emitUsage(session){
  try{
    const file=session.threadId&&rolloutFile(session);if(!file)return;
    // shortcut: only the last 1 MB is scanned, enough for the latest token_count; read more if Codex ever logs huge items after it.
    const fd=openSync(file,'r'),size=fstatSync(fd).size,length=Math.min(size,1048576),buffer=Buffer.alloc(length);
    try{readSync(fd,buffer,0,length,size-length);}finally{closeSync(fd);}
    let usage=null;
    for(const line of buffer.toString('utf8').split('\n')){
      if(!line.includes('"token_count"'))continue;
      let info;try{info=JSON.parse(line).payload?.info;}catch{continue;}
      const last=info?.last_token_usage;
      if(Number.isInteger(last?.input_tokens)&&Number.isInteger(last?.output_tokens)&&Number.isInteger(info.model_context_window))
        usage={used:last.input_tokens+last.output_tokens,size:info.model_context_window};
    }
    if(!usage||(session.usage?.used===usage.used&&session.usage?.size===usage.size))return;
    session.usage=usage;update(session.id,{sessionUpdate:'usage_update',...usage});
  }catch{ /* The rollout log is Codex-internal: a missing file or new format only hides the indicator. */ }
}
function save(session){
  const file=sessionFile(session.id),temporary=file+'.'+process.pid+'.tmp';
  const {id,cwd,threadId,selected,effort}=session;
  writeFileSync(temporary,JSON.stringify({id,cwd,threadId,selected,effort}),{mode:0o600});renameSync(temporary,file);
}
function config(session){
  return {configOptions:[
    {id:'model',name:'Model',category:'model',type:'select',currentValue:session.selected,options:models.map(m=>({value:m.value,name:m.name}))},
    {id:'thought_level',name:'Reasoning effort',category:'thought_level',type:'select',currentValue:session.effort,options:EFFORTS.map(value=>({value,name:value[0].toUpperCase()+value.slice(1)}))},
  ]};
}
function attachMcp(session,servers=[]){
  if(session.root){rmSync(session.root,{recursive:true,force:true});pendingRoots.delete(session.root);}
  const root=mkdtempSync(join(tempDir,'local-models-bb-session-'));session.root=root;pendingRoots.add(root);
  session.mcpArgs=[];session.mcpEnv={};
  servers.forEach((server,index)=>{
    if(typeof server.command!=='string'||!Array.isArray(server.args)||!Array.isArray(server.env))throw Error('Only stdio MCP is supported.');
    const key='mcp_servers.'+(String(server.name??'').replace(/[^A-Za-z0-9_-]/g,'_')||'bb_'+index);
    // Secrets travel through the child environment and env_vars, never argv.
    for(const entry of server.env){
      if(entry.name in session.mcpEnv&&session.mcpEnv[entry.name]!==entry.value)throw Error('Conflicting MCP environment.');
      session.mcpEnv[entry.name]=entry.value;
    }
    // Headless exec cannot show approval prompts, so BB's own tool servers are pre-approved like on other providers.
    session.mcpArgs.push('-c',key+'.command='+toml(server.command),'-c',key+'.args='+toml(server.args.map(String)),'-c',key+'.env_vars='+toml(server.env.map(entry=>entry.name)),'-c',key+'.default_tools_approval_mode="approve"');
  });
}
function getSession(id){const session=sessions.get(id);if(!session)throw Error('Unknown session.');return session;}
function promptText(session,parts,images){
  return parts.map(part=>{
    if(part.type==='text'&&typeof part.text==='string')return part.text;
    if(part.type==='image'&&typeof part.data==='string'){
      const extension=new Map([['image/png','png'],['image/jpeg','jpg'],['image/webp','webp'],['image/gif','gif']]).get(part.mimeType);
      if(!extension)throw Error('Unsupported image type.');
      const file=join(session.root,'image-'+randomUUID()+'.'+extension);writeFileSync(file,Buffer.from(part.data,'base64'),{mode:0o600});
      images.push(file);return '';
    }
    if(part.type==='resource'&&typeof part.resource?.text==='string')return part.resource.text;
    throw Error('Unsupported prompt content.');
  }).filter(Boolean).join('\n\n');
}
function describe(item){
  if(item.type==='command_execution')return {title:String(item.command),kind:'execute',rawInput:{command:item.command},text:item.aggregated_output};
  if(item.type==='file_change'){const changes=Array.isArray(item.changes)?item.changes:[];return {title:'Edit '+changes.map(c=>c.path).join(', '),kind:'edit',locations:changes.map(c=>({path:c.path}))};}
  if(item.type==='mcp_tool_call')return {title:item.server+'.'+item.tool,kind:'other',rawInput:item.arguments,text:item.error?.message??(item.result?JSON.stringify(item.result.content??item.result):'')};
  if(item.type==='web_search')return {title:'Search: '+item.query,kind:'fetch'};
  return {title:String(item.type||'Tool'),kind:'other'};
}
function runPrompt(id,session,prompt){
  if(session.child)throw Error('A prompt is already running.');
  const images=[],text=promptText(session,prompt,images),model=models.find(m=>m.value===session.selected);
  // The user's config.toml targets cloud models and its MCP servers bloat a local prompt; everything needed is passed with -c.
  const args=['exec',...(session.threadId?['resume']:[]),'--json','--skip-git-repo-check','--ignore-user-config','-m',session.selected,
    '-c','model_provider="bb_local"','-c','model_providers.bb_local.name="Local models"',
    '-c','model_providers.bb_local.base_url='+toml(proxyBase),'-c','model_providers.bb_local.wire_api="responses"',
    '-c','model_reasoning_effort='+toml(session.effort),
    // ChatGPT Apps connectors come from the account login, not config.toml, and add ~130k tokens of tool schemas.
    '-c','features.apps=false','-c','approval_policy="never"',
    '-c','sandbox_mode='+toml(permissionMode==='full'?'danger-full-access':'workspace-write'),...session.mcpArgs];
  if(model?.ctx)args.push('-c','model_context_window='+model.ctx);
  for(const image of images)args.push('-i',image);
  // --image takes several values; positionals must follow "--".
  args.push('--',...(session.threadId?[session.threadId]:[]),'-');
  const child=spawn(codex,args,{cwd:session.cwd,env:{...process.env,...session.mcpEnv},stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});
  session.child=child;session.cancelled=false;session.turn=(session.turn||0)+1;
  child.stdin.on('error',()=>{});child.stdin.end(text);child.stderr.resume();
  const open=new Set(),seen=new Set(),turn='t'+session.turn+'-';let hadText=false,completed=false,failure='',answered=false;
  const finish=code=>{
    if(answered)return;answered=true;if(session.cancelled)stopChild(child,'SIGKILL');clearTimeout(session.cancelTimer);session.child=null;
    for(const toolCallId of open)update(session.id,{sessionUpdate:'tool_call_update',toolCallId,status:'failed'});
    try{save(session);}catch{fail(id,'Local models session could not be saved.',-32603);return;}
    if(session.cancelled){send({id,result:{stopReason:'cancelled'}});return;}
    if(!completed||code!==0){fail(id,'Local model turn failed'+(failure?': '+failure.slice(0,300):'. Check that the local model server is running.'),-32603);return;}
    if(!hadText)update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'The local model finished without a text response. Review tool results; completion does not imply every requested action ran.'}});
    emitUsage(session);
    send({id,result:{stopReason:'end_turn'}});
  };
  createInterface({input:child.stdout}).on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return;}
    if(event.type==='thread.started'&&typeof event.thread_id==='string'){session.threadId=event.thread_id;return;}
    if(event.type==='turn.completed'){completed=true;return;}
    if(event.type==='turn.failed'||event.type==='error'){failure=String(event.error?.message??event.message??'');return;}
    const item=event.item;if(!event.type?.startsWith('item.')||!item)return;
    const done=event.type==='item.completed';
    if(item.type==='agent_message'){
      if(done&&item.text){update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:(hadText?'\n\n':'')+item.text}});hadText=true;}
      return;
    }
    if(item.type==='reasoning'){if(done&&item.text)update(session.id,{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:item.text}});return;}
    // Non-fatal Codex notices, e.g. missing metadata for a local model.
    if(item.type==='error')return;
    if(item.type==='todo_list'){
      update(session.id,{sessionUpdate:'plan',entries:(Array.isArray(item.items)?item.items:[]).map(entry=>({content:String(entry.text),status:entry.completed?'completed':'pending',priority:'medium'}))});
      return;
    }
    const toolCallId=turn+String(item.id),{text:output,...call}=describe(item);
    const status=item.status==='failed'||item.status==='declined'?'failed':done?'completed':'in_progress';
    const content=output?[{type:'content',content:{type:'text',text:String(output)}}]:[];
    if(!seen.has(toolCallId))update(session.id,{sessionUpdate:'tool_call',toolCallId,...call,status,content});
    else update(session.id,{sessionUpdate:'tool_call_update',toolCallId,status,content});
    if(done)emitUsage(session);
    seen.add(toolCallId);
    if(status==='in_progress')open.add(toolCallId);else open.delete(toolCallId);
  });
  child.on('error',()=>finish(1));child.on('close',finish);
}
async function handle(request){
  const {id,method,params:p={}}=request;
  if(method==='initialize')return send({id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{http:false,sse:false}},authMethods:[],agentInfo:{name:'bb-local-models',version:'0.1.0'}}});
  if(method==='authenticate')return send({id,result:{}});
  if(method==='session/new'){
    if(!models.length||typeof p.cwd!=='string')throw Error('No local models or workspace available.');
    const session={id:randomUUID(),cwd:p.cwd,threadId:null,selected:(models.find(m=>m.value===process.env.LM_DEFAULT_MODEL)||models[0]).value,effort:'medium',child:null};attachMcp(session,p.mcpServers);save(session);sessions.set(session.id,session);
    return send({id,result:{sessionId:session.id,...config(session)}});
  }
  if(method==='session/load'||method==='session/resume'){
    const stored=JSON.parse(readFileSync(sessionFile(p.sessionId),'utf8'));
    if(stored.id!==p.sessionId||typeof stored.cwd!=='string'||typeof stored.selected!=='string'||!(stored.threadId===null||typeof stored.threadId==='string'))throw Error('Invalid stored session.');
    const selected=models.find(model=>model.value===stored.selected)||models[0];
    if(!selected)throw Error('No local models available.');
    const session={...stored,selected:selected.value,effort:EFFORTS.includes(stored.effort)?stored.effort:'medium',cwd:p.cwd||stored.cwd,child:null};
    attachMcp(session,p.mcpServers);save(session);sessions.set(session.id,session);
    send({id,result:config(session)});
    // After the load reply, so BB already maps this session to its thread.
    return emitUsage(session);
  }
  if(method==='session/set_config_option'||method==='session/set_model'){
    const session=getSession(p.sessionId);if(session.child)throw Error('Cannot change a running session.');
    const option=p.configId||'model',value=p.value||p.modelId;
    if(option==='model'&&models.some(m=>m.value===value))session.selected=value;
    else if(option==='thought_level'&&EFFORTS.includes(value))session.effort=value;
    else throw Error('Unsupported model or effort.');
    save(session);return send({id,result:config(session)});
  }
  if(method==='session/prompt')return runPrompt(id,getSession(p.sessionId),p.prompt);
  if(method==='session/cancel'){
    const session=getSession(p.sessionId),child=session.child;
    if(!child)return;
    session.cancelled=true;stopChild(child,'SIGINT');
    // A hung CLI must not hold up a BB steer indefinitely.
    session.cancelTimer=setTimeout(()=>stopChild(child,'SIGKILL'),2000);session.cancelTimer.unref();
    return;
  }
  if(id!==undefined)fail(id,'Unsupported Local models ACP method.',-32601);
}
createInterface({input:process.stdin}).on('line',line=>{
  let request;try{request=JSON.parse(line);}catch{return;}
  if(!request||typeof request.method!=='string')return;
  Promise.resolve().then(()=>handle(request)).catch(()=>{if(request.id!==undefined)fail(request.id,'Invalid Local models request or unavailable session.');});
}).on('close',shutdown);
function stopChild(child,signal){
  if(!child?.pid)return;
  if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore'});
  else {
    // PTY commands can start their own process groups, outside the CLI's group.
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
  }
}
function shutdown(){for(const session of sessions.values())stopChild(session.child,'SIGTERM');for(const root of pendingRoots)rmSync(root,{recursive:true,force:true});process.exit(0);}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,shutdown);
`;
