import { reviewMcpSource } from "./review-mcp.ts";
import { GOOGLE_MODEL_PREFIX } from "./models.ts";

// Materialized on each execution host so the host artifact is self-contained.
export const shimSource = String.raw`
import {spawn,execFile,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,renameSync,mkdtempSync,rmSync} from 'node:fs';
import {join,dirname,basename,isAbsolute} from 'node:path';
import {tmpdir,homedir} from 'node:os';

const agy=process.env.AGY_BIN;
if(!agy){process.stderr.write('Antigravity CLI is not configured.\n');process.exit(1);}
const dataDir=process.env.AGY_BB_DATA_DIR||join(tmpdir(),'agy-bb');
const tempDir=process.env.AGY_BB_TEMP_DIR||tmpdir();
const permissionMode=process.argv.slice(2).find(arg=>arg.startsWith('--bb-permission-mode='))?.split('=')[1];
if(!['full','accept-edits'].includes(permissionMode))throw Error('Unsupported or missing permission mode.');
mkdirSync(join(dataDir,'sessions'),{recursive:true,mode:0o700});
const sessions=new Map(),pendingRoots=new Set();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\n');
const fail=(id,message,code=-32602)=>send({id,error:{code,message}});
const update=(sessionId,value)=>send({method:'session/update',params:{sessionId,update:value}});
const family=id=>id.replace(/-(low|medium|high|xhigh|max)$/,'');
const effort=id=>id.match(/-(low|medium|high|xhigh|max)$/)?.[1];
const models=await new Promise(resolve=>execFile(agy,['models'],{timeout:30000,maxBuffer:2097152},(error,output)=>{
  resolve(error?[]:output.trim().split(/\r?\n/).map(line=>{const [value,name]=line.split('\t');return {value,name};}).filter(model=>model.value?.startsWith(${JSON.stringify(GOOGLE_MODEL_PREFIX)})&&model.name));
}));
function sessionFile(id){if(!/^[a-f0-9-]{36}$/.test(id))throw Error('Invalid session ID.');return join(dataDir,'sessions',id+'.json');}
// BB sends <system_instructions> only in the first prompt of a new session; keep them for resume and compression.
// As a native workspace rule agy lists the file every turn (large rules appear as a pointer, not inline).
const instructionsFile=session=>join(session.root,'.agents','rules','bb-instructions.md');
function save(session){
  const file=sessionFile(session.id),temporary=file+'.'+process.pid+'.tmp';
  const {id,cwd,conversationId,selected,instructions}=session;
  writeFileSync(temporary,JSON.stringify({id,cwd,conversationId,selected,instructions}),{mode:0o600});renameSync(temporary,file);
}
function config(session){
  const seen=new Set();
  const choices=models.filter(m=>{const id=family(m.value);if(seen.has(id))return false;seen.add(id);return true;})
    .map(m=>({value:family(m.value),name:m.name.replace(/\s+\((Low|Medium|High|Xhigh|Max)\)$/i,'')}));
  const efforts=models.filter(m=>family(m.value)===family(session.selected)).map(m=>effort(m.value)).filter(Boolean);
  const options=[{id:'model',name:'Model',category:'model',type:'select',currentValue:family(session.selected),options:choices}];
  if(efforts.length)options.push({id:'thought_level',name:'Reasoning effort',category:'thought_level',type:'select',currentValue:effort(session.selected),options:efforts.map(value=>({value,name:value[0].toUpperCase()+value.slice(1)}))});
  return {configOptions:options};
}
function attachMcp(session,servers=[]){
  if(session.root){rmSync(session.root,{recursive:true,force:true});pendingRoots.delete(session.root);}
  const root=mkdtempSync(join(tempDir,'agy-bb-session-'));session.root=root;pendingRoots.add(root);
  mkdirSync(join(root,'.agents','rules'),{recursive:true,mode:0o700});
  if(session.instructions)writeFileSync(instructionsFile(session),session.instructions,{mode:0o600});
  const mcpServers=Object.fromEntries(servers.map(server=>{
    if(typeof server.command!=='string'||!Array.isArray(server.args)||!Array.isArray(server.env))throw Error('Only stdio MCP is supported.');
    return [server.name,{command:server.command,args:server.args,env:Object.fromEntries(server.env.map(e=>[e.name,e.value]))}];
  }));
  if(permissionMode==='accept-edits'){
    const roots=[session.cwd],storage=process.env.BB_THREAD_STORAGE;
    if(storage&&isAbsolute(storage)){
      roots.push(storage);
      // Trust BB metadata, never paths extracted from model-authored prompts.
      try{
        const {thread}=JSON.parse(execFileSync(process.env.BB_CLI||'bb',['thread','get','--self','--json'],{encoding:'utf8',timeout:10000,maxBuffer:1048576,stdio:['ignore','pipe','pipe']}));
        if(thread.id===process.env.BB_THREAD_ID&&basename(storage)===thread.id&&/^thr_[a-z0-9]+$/.test(thread.parentThreadId))roots.push(join(dirname(storage),thread.parentThreadId));
      }catch{ /* Unavailable metadata grants no parent access. */ }
    }
    const review=join(root,'review-mcp.mjs');
    writeFileSync(review,${JSON.stringify(reviewMcpSource)},{mode:0o600});
    if(Object.hasOwn(mcpServers,'bb_review'))throw Error('Reserved MCP server name.');
    mcpServers.bb_review={command:process.execPath,args:[review,JSON.stringify([...new Set(roots)])],env:{ELECTRON_RUN_AS_NODE:'1'}};
    let permissions={};
    try{permissions=JSON.parse(readFileSync(join(homedir(),'.gemini','antigravity-cli','settings.json'),'utf8')).permissions||{};}catch(error){if(error.code!=='ENOENT')throw error;}
    session.settings=join(root,'settings.json');
    writeFileSync(session.settings,JSON.stringify({permissions:{...permissions,allow:[...(permissions.allow||[]),'mcp(bb_review/memory)','mcp(bb_review/git)','mcp(bb_review/read_file)']}}),{mode:0o600});
  }
  writeFileSync(join(root,'.agents','mcp_config.json'),JSON.stringify({mcpServers}),{mode:0o600});
}
function getSession(id){const session=sessions.get(id);if(!session)throw Error('Unknown session.');return session;}
function promptText(session,parts){
  const block=parts.find(part=>part.type==='text'&&typeof part.text==='string'&&/^<system_instructions>[\s\S]*<\/system_instructions>$/.test(part.text.trim()));
  if(block){session.instructions=block.text.trim();writeFileSync(instructionsFile(session),session.instructions,{mode:0o600});}
  const text=(session.instructions?'BB thread instructions are saved in full at '+instructionsFile(session)+'. If they are no longer in your context, for example after context compression or a resumed session, read that file in full and follow it.\n\n':'')+(permissionMode==='accept-edits'?'For read-only review use bb_review MCP tools first: memory (search/get/catalog), git (worktree inspection), read_file (worktree and BB current/parent storage). These grant no shell or write access. Other actions keep the native policy.\n\n':'')+'Before using tools, if present, read and follow the applicable AGENTS.md at the workspace root and in the current directory, plus any nested AGENTS.md for files you touch. Read files in full if the native rules index only gives a pointer. GEMINI.md is not required. If a tool action is denied, respect the denial: never retry it or bypass it through another tool. Continue with permitted alternatives, or explicitly report what was denied and which requested work remains blocked. Do not silently stop or claim completion. Follow the BB instructions below.\n\n'+parts.map((part,index)=>{
    if(part.type==='text'&&typeof part.text==='string')return part.text;
    if(part.type==='image'&&typeof part.data==='string'){
      const extension=new Map([['image/png','png'],['image/jpeg','jpg'],['image/webp','webp'],['image/gif','gif']]).get(part.mimeType);
      if(!extension)throw Error('Unsupported image type.');
      const file=join(session.root,'image-'+randomUUID()+'.'+extension);writeFileSync(file,Buffer.from(part.data,'base64'),{mode:0o600});
      return 'Read the attached image at '+file;
    }
    if(part.type==='resource'&&typeof part.resource?.text==='string')return part.resource.text;
    throw Error('Unsupported prompt content.');
  }).join('\n\n');
  return text;
}
function runPrompt(id,session,prompt,denialRecovery=false){
  if(session.child)throw Error('A prompt is already running.');
  const text=promptText(session,prompt);
  const args=['--input-format','stream-json','--output-format','stream-json','--disable-slash-commands','--model',session.selected,'--add-dir',session.cwd,'--add-dir',session.root];
  if(permissionMode==='full')args.push('--dangerously-skip-permissions');
  else args.push('--mode','accept-edits','--sandbox','--settings',session.settings);
  if(session.conversationId)args.push('--conversation',session.conversationId);
  const child=spawn(agy,args,{cwd:session.cwd,stdio:['pipe','pipe','pipe'],detached:process.platform!=='win32'});session.child=child;session.cancelled=false;
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({event:'user',message:{content:text}})+'\n');
  const tools=new Map(),seenTools=new Set();let hadText=false,final,answered=false,permissionDenied=false;
  createInterface({input:child.stderr}).on('line',line=>{
    if(/soft.denied|requires approval|permission.{0,40}denied|not allowed in headless/i.test(line))permissionDenied=true;
  });
  const finish=code=>{
    if(answered)return;answered=true;if(session.cancelled)stopChild(child,'SIGKILL');clearTimeout(session.cancelTimer);session.child=null;
    for(const [toolCallId] of tools)update(session.id,{sessionUpdate:'tool_call_update',toolCallId,status:'failed'});
    if(final?.conversation_id)session.conversationId=final.conversation_id;
    try{save(session);}catch{fail(id,'Antigravity session could not be saved.',-32603);return;}
    if(session.cancelled){send({id,result:{stopReason:'cancelled'}});return;}
    if(code!==0||!final||final.status!=='SUCCESS'){fail(id,'Antigravity CLI did not complete the turn. Check agy login and quota.',-32603);return;}
    if(permissionDenied&&!final.response&&!denialRecovery&&session.conversationId){
      // Resume once so a headless soft denial reaches a model response, never an action retry loop.
      runPrompt(id,session,[{type:'text',text:'A native action was denied by the permission policy during your previous attempt. Its tool result remains in this conversation. Respect that denial: do not retry the action, re-read a denied file, change permissions, or use shell, MCP, or another tool to bypass it. Continue only with permitted alternatives already available. If the required data cannot be accessed, explicitly tell the user what was denied and which parts of the task remain blocked. Provide a text response; do not claim that blocked work was completed.'}],true);return;
    }
    if(!hadText&&final.response)update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:final.response}});
    if(permissionDenied&&!final.response)update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'\n\nAntigravity: a native action was denied by the permission policy. No final response followed the denial. The requested work may remain blocked; review failed tool results. Headless mode cannot display native approval prompts.'}});
    else if(!hadText&&!final.response)update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Antigravity finished without a text response. Review tool results; completion does not imply every requested action ran.'}});
    send({id,result:{stopReason:'end_turn'}});
  };
  createInterface({input:child.stdout}).on('line',line=>{
    let event;try{event=JSON.parse(line);}catch{return;}
    if(event.event==='init'&&event.conversation_id)session.conversationId=event.conversation_id;
    if(event.event==='result'){final=event.result;return;}
    const step=event.step_update;if(event.event!=='step_update'||!step)return;
    if(step.step_type==='agent_response'&&typeof step.text_delta==='string'){
      hadText=true;update(session.id,{sessionUpdate:'agent_message_chunk',content:{type:'text',text:step.text_delta}});
    }
    if(step.step_type==='tool'){
      const toolCallId=(denialRecovery?'recovery-':'')+String(step.step_index),name=step.tool_name||step.tool_info?.name||'Tool';
      const error=step.tool_info?.error;
      const denied=!!error&&/permission|approval|denied/i.test(JSON.stringify(error));
      if(denied)permissionDenied=true;
      const status=error||step.state==='ERROR'?'failed':step.state==='DONE'?'completed':'in_progress';
      const content=step.tool_info?.output?[{type:'content',content:{type:'text',text:String(step.tool_info.output)}}]:[];
      if(error&&!content.length)content.push({type:'content',content:{type:'text',text:denied?'Native permission policy denied this action.':'Native tool failed.'}});
      if(!seenTools.has(toolCallId))update(session.id,{sessionUpdate:'tool_call',toolCallId,title:name,kind:'other',status,rawInput:step.tool_info?.parameters??step.tool_info?.input,content});
      else update(session.id,{sessionUpdate:'tool_call_update',toolCallId,status,rawInput:step.tool_info?.parameters??step.tool_info?.input,content});
      seenTools.add(toolCallId);
      if(status==='in_progress')tools.set(toolCallId,true);else tools.delete(toolCallId);
    }
  });
  child.on('error',()=>finish(1));child.on('close',finish);
}
async function handle(request){
  const {id,method,params:p={}}=request;
  if(method==='initialize')return send({id,result:{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{http:false,sse:false}},authMethods:[],agentInfo:{name:'bb-antigravity',version:'0.3.0'}}});
  if(method==='authenticate')return send({id,result:{}});
  if(method==='session/new'){
    if(!models.length||typeof p.cwd!=='string')throw Error('No CLI models or workspace available.');
    const session={id:randomUUID(),cwd:p.cwd,conversationId:null,selected:models[0].value,child:null};attachMcp(session,p.mcpServers);save(session);sessions.set(session.id,session);
    return send({id,result:{sessionId:session.id,...config(session)}});
  }
  if(method==='session/load'||method==='session/resume'){
    const stored=JSON.parse(readFileSync(sessionFile(p.sessionId),'utf8'));
    if(stored.id!==p.sessionId||typeof stored.cwd!=='string'||typeof stored.selected!=='string'||!(stored.conversationId===null||typeof stored.conversationId==='string')||!(stored.instructions===undefined||typeof stored.instructions==='string'))throw Error('Invalid stored session.');
    const selected=models.find(model=>model.value===stored.selected)||models[0];
    if(!selected)throw Error('No Google models available.');
    const session={...stored,selected:selected.value,cwd:p.cwd||stored.cwd,child:null};attachMcp(session,p.mcpServers);save(session);sessions.set(session.id,session);
    return send({id,result:config(session)});
  }
  if(method==='session/set_config_option'||method==='session/set_model'){
    const session=getSession(p.sessionId);if(session.child)throw Error('Cannot change a running session.');
    const option=p.configId||'model',value=p.value||p.modelId;
    const modelId=option==='thought_level'?family(session.selected):value;
    const selectedEffort=option==='thought_level'?value:effort(session.selected);
    const choices=models.filter(m=>family(m.value)===modelId||m.value===modelId);
    const chosen=choices.find(m=>effort(m.value)===selectedEffort)||choices[0];
    if(!chosen||!['model','thought_level'].includes(option))throw Error('Unsupported model or effort.');
    session.selected=chosen.value;save(session);return send({id,result:config(session)});
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
  if(id!==undefined)fail(id,'Unsupported Antigravity ACP method.',-32601);
}
createInterface({input:process.stdin}).on('line',line=>{
  let request;try{request=JSON.parse(line);}catch{return;}
  if(!request||typeof request.method!=='string')return;
  Promise.resolve().then(()=>handle(request)).catch(()=>{if(request.id!==undefined)fail(request.id,'Invalid Antigravity request or unavailable session.');});
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
