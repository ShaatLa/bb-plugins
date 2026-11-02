import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,mkdir,symlink,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {reviewMcpSource} from './review-mcp.ts';

test('review MCP reads exact head, memory and allowed artifacts and rejects writes and escapes',{timeout:15000},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'bb-review-'));
 const cwd=path.join(dir,'repo'),parent=path.join(dir,'parent'),outside=path.join(dir,'outside');
 await Promise.all([mkdir(cwd),mkdir(parent),mkdir(outside)]);
 const git=(...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
 git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
 await writeFile(path.join(cwd,'file.txt'),'review content');git('add','.');git('commit','-qm','fixture');const head=git('rev-parse','HEAD');
 await writeFile(path.join(parent,'diff.txt'),'parent artifact');await writeFile(path.join(outside,'private.txt'),'outside');
 await symlink(outside,path.join(cwd,'escape'));
 const bb=path.join(dir,'bb.mjs');await writeFile(bb,`#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));`,{mode:0o700});
 const script=path.join(dir,'review.mjs');await writeFile(script,reviewMcpSource);
 const child=spawn(process.execPath,[script,JSON.stringify([cwd,parent])],{env:{...process.env,BB_CLI:bb},stdio:['pipe','pipe','pipe']});
 let id=0;const pending=new Map<number,(v:any)=>void>();
 createInterface({input:child.stdout}).on('line',line=>{const r=JSON.parse(line);pending.get(r.id)?.(r.result);pending.delete(r.id);});
 const request=(method:string,params:any={})=>new Promise<any>(resolve=>{const next=++id;pending.set(next,resolve);child.stdin.write(JSON.stringify({id:next,method,params})+'\n');});
 const call=(name:string,args:any)=>request('tools/call',{name,arguments:args});
 try{
  assert.ok((await request('initialize')).capabilities.tools);
  assert.equal((await request('tools/list')).tools.length,3);
  const result=await call('git',{command:'rev-parse',args:['HEAD']});assert.equal(result.content[0].text.trim(),head);
  for(const [command,args] of Object.entries({log:['--oneline','--max-count=1'],show:['--stat','HEAD'],diff:['HEAD'],status:['--short'],'ls-tree':['--name-only','HEAD'],'cat-file':['-t','HEAD'],'merge-base':['HEAD','HEAD'],branch:['--show-current']}))assert.ok(!(await call('git',{command,args})).isError,String(command));
  for(const [command,args] of [['checkout',['HEAD']],['branch',['evil']],['diff',['--output=oops']],['show',['--ext-diff']],['rev-parse',['--git-path','config']],['log',['--format=%x00']],['diff',['--no-index','/etc/passwd','file.txt']],['rev-parse',['HEAD;touch hacked']],['status',['-c','core.fsmonitor=touch hacked']]])assert.ok((await call('git',{command,args})).isError,String(command));
  assert.equal(git('rev-parse','HEAD'),head);assert.equal(git('status','--porcelain'),'?? escape');
  for(const [operation,key,value] of [['search','query','review $(touch nope)'],['get','id','mem_example'],['catalog','','']]){
   const r=await call('memory',{operation,...(key?{[key]:value}:{})});assert.ok(!r.isError);const args=JSON.parse(r.content[0].text);assert.deepEqual(args.slice(0,2),['memory',operation]);if(key)assert.equal(args[2],value);
  }
  for(const args of [{operation:'forget',id:'mem_x'},{operation:'get',id:'--help'},{operation:'catalog',scope:'invalid'}])assert.ok((await call('memory',args)).isError);
  assert.equal(JSON.parse((await call('read_file',{path:path.join(parent,'diff.txt')})).content[0].text).text,'parent artifact');
  assert.equal(JSON.parse((await call('read_file',{path:'file.txt',offset:7})).content[0].text).text,'content');
  for(const file of [path.join(outside,'private.txt'),'escape/private.txt','../outside/private.txt'])assert.ok((await call('read_file',{path:file})).isError);
  assert.ok((await call('read_file',{path:'file.txt',offset:-1})).isError);
  await writeFile(path.join(cwd,'large.txt'),'x'.repeat(300000));assert.ok(JSON.parse((await call('read_file',{path:'large.txt'})).content[0].text).truncated);
  assert.equal(await readFile(path.join(parent,'diff.txt'),'utf8'),'parent artifact');
 }finally{child.kill();await rm(dir,{recursive:true,force:true});}
});
