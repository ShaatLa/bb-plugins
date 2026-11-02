// Self-contained stdio MCP server materialized in the private session directory.
export const reviewMcpSource = String.raw`
import {execFileSync} from 'node:child_process';
import {openSync,closeSync,readSync,fstatSync,realpathSync,statSync,constants} from 'node:fs';
import {resolve,relative,isAbsolute,sep} from 'node:path';
import {createInterface} from 'node:readline';
import {devNull} from 'node:os';
const paths=JSON.parse(process.argv[2]);
const cwd=realpathSync(paths[0]),roots=paths.slice(1).flatMap(p=>{try{return [realpathSync(p)];}catch{return [];}});
const max=262144,bb=process.env.BB_CLI||'bb';
const object=properties=>({type:'object',properties,additionalProperties:false}),str={type:'string'};
const tools=[
 {name:'memory',description:'Read BB memory: search, get or catalog only.',inputSchema:{...object({operation:{enum:['search','get','catalog']},query:str,id:str,scope:{enum:['all','project','global']}}),required:['operation']}},
 {name:'git',description:'Read-only git inspection in this worktree. args accepts refs and common display flags; no arbitrary options, shell text or output files.',inputSchema:{...object({command:{enum:['rev-parse','log','show','diff','status','ls-tree','cat-file','merge-base','branch']},args:{type:'array',items:str,maxItems:20}}),required:['command']}},
 {name:'read_file',description:'Read UTF-8 in the worktree or BB current/parent thread storage. Bounded to 256 KiB; offset in bytes.',inputSchema:{...object({path:str,offset:{type:'integer',minimum:0}}),required:['path']}}
];
function run(command,args,env=process.env){return execFileSync(command,args,{cwd,env,encoding:'utf8',timeout:15000,maxBuffer:max,stdio:['ignore','pipe','pipe']});}
function keys(a,allowed){if(!a||typeof a!=='object'||Array.isArray(a)||Object.keys(a).some(k=>!allowed.includes(k)))throw Error('Invalid arguments.');}
function text(s){if(typeof s!=='string'||!s.length||s.length>4096||s.includes('\0'))throw Error('Invalid string.');return s;}
function gitArgs(command,args=[]){
 const flags={
  'rev-parse':['--verify','--short','--abbrev-ref','--show-toplevel','--is-inside-work-tree'],
  log:['--oneline','--stat','--name-only','--name-status','--all','--decorate','--no-decorate','-p'],
  show:['--oneline','--stat','--name-only','--name-status','--format=fuller','--format=short','--format=','-p'],
  diff:['--stat','--name-only','--name-status','--cached','--staged','--check'],
  status:['--short','--branch','--porcelain','--porcelain=v1','--porcelain=v2'],
  'ls-tree':['-r','--name-only','--long'],'cat-file':['-p','-t','-s','-e'],'merge-base':['--is-ancestor','--all'],branch:['--show-current']
 };
 if(!Object.hasOwn(flags,command)||!Array.isArray(args)||args.length>20)throw Error('Invalid git command.');
 if(command==='branch'&&(args.length!==1||args[0]!=='--show-current'))throw Error('Only branch --show-current is allowed.');
 for(const arg of args){
  text(arg);if(flags[command].includes(arg))continue;
  if(['log','show'].includes(command)&&/^--max-count=([1-9][0-9]?|100)$/.test(arg))continue;
  if(['log','diff','show'].includes(command)&&/^--unified=[0-9]{1,3}$/.test(arg))continue;
  if(['status','branch'].includes(command)||! /^[A-Za-z0-9_][A-Za-z0-9_./~^:@{}+\-]*$/.test(arg)||arg.split('/').includes('..'))throw Error('Unsupported git argument.');
 }
 return [command,...args];
}
function call(name,a){
 if(name==='memory'){
  keys(a,['operation','query','id','scope']);
  if(!['search','get','catalog'].includes(a.operation)||a.scope&&!['all','project','global'].includes(a.scope))throw Error('Invalid memory operation.');
  const args=['memory',a.operation];
  if(a.operation!=='catalog'){const value=text(a.operation==='get'?a.id:a.query);if(value.startsWith('-'))throw Error('Invalid memory value.');args.push(value);}
  args.push('--scope',a.scope||'all','--json');if(a.operation!=='get')args.push('--limit','20');
  return run(bb,args);
 }
 if(name==='git'){
  keys(a,['command','args']);const args=gitArgs(a.command,a.args);
  // Prevent optional index writes, external diff/textconv, fsmonitor, pagers and lazy fetch.
  const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  Object.assign(env,{GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_NO_LAZY_FETCH:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:devNull});
  return run('git',['--no-pager','--no-optional-locks','-c','core.fsmonitor=false','-c','log.showSignature=false','-c','diff.external=','-c','core.attributesFile='+devNull,args[0],...(['diff','show','log'].includes(a.command)?['--no-ext-diff','--no-textconv']:[]),...args.slice(1)],env);
 }
 if(name==='read_file'){
  keys(a,['path','offset']);const file=realpathSync(resolve(cwd,text(a.path)));
  if(![cwd,...roots].some(root=>{const r=relative(root,file);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep);}))throw Error('Path outside session read roots.');
  const offset=a.offset??0;if(!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid offset.');
  const before=statSync(file);
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=fstatSync(fd);if(stat.dev!==before.dev||stat.ino!==before.ino||!stat.isFile())throw Error('Only regular files.');const buffer=Buffer.alloc(max),n=readSync(fd,buffer,0,max,offset);return JSON.stringify({text:buffer.subarray(0,n).toString('utf8'),nextOffset:offset+n,truncated:stat.size>offset+n});}finally{closeSync(fd);}
 }
 throw Error('Unknown tool.');
}
createInterface({input:process.stdin}).on('line',line=>{
 let r;try{r=JSON.parse(line);}catch{return;}if(!r||typeof r!=='object'||r.id===undefined)return;
 let result;
 if(r.method==='initialize')result={protocolVersion:r.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'bb_review',version:'1.0.0'}};
 else if(r.method==='tools/list')result={tools};
 else if(r.method==='tools/call'){
  try{result={content:[{type:'text',text:call(r.params.name,r.params.arguments)}]};}
  catch{result={isError:true,content:[{type:'text',text:'Read-only review request rejected or unavailable. Check schema, read roots and command limits.'}]};}
 }else{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,error:{code:-32601,message:'Unknown method'}})+'\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\n');
});
`;
