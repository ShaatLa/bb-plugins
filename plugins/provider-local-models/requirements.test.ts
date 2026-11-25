import test from 'node:test';
import assert from 'node:assert/strict';
import { doctor, runCommand, type RunCommand } from './requirements.ts';

const signal = () => new AbortController().signal;
test('doctor uses verified arm64, macOS 26.4 and M3 requirements before install and never bootstraps brew', async () => {
  let os = '26.4', cpu = 'Apple M3 Max', architecture = 'arm64'; const commands: string[] = [];
  const run: RunCommand = async (binary, args) => { commands.push([binary, ...args].join(' ')); return { code: 0, output: binary.endsWith('sw_vers') ? os : cpu }; };
  const report = () => doctor({ binary:'/fake/splash',baseUrl:'http://fake/v1',run,exists:async()=>false,brew:null,platform:'darwin',arch:architecture,memoryBytes:64*1024**3,fetcher:async()=>new Response(null,{status:503}) },signal());
  assert.equal((await report()).supported,true);
  os='26.3'; assert.equal((await report()).supported,false);
  os='26.4';cpu='Apple M2 Ultra'; assert.equal((await report()).supported,false);
  cpu='Apple M4';architecture='x64'; assert.equal((await report()).supported,false);
  architecture='arm64';os='27.0'; const next=await report();assert.equal(next.supported,true);assert.equal(next.machine.memoryBytes,64*1024**3);
  assert.equal(next.llama.installed,false);assert.equal(next.llama.reachable,false);assert.equal(next.llama.downloadUrl,'https://llama.app/');
  assert.equal(next.brew.path,null);assert.match(next.brew.bootstrap,/raw.githubusercontent.com\/Homebrew\/install/);
  assert.ok(commands.every(command=>!command.includes('brew')&&!command.includes('curl')&&!command.includes('bash')));
});

test('doctor uses the installed engine device-check as authority and reports version, outdated status and Llama router', async () => {
  let deviceCode=1;const commands:string[]=[];
  const run:RunCommand=async(binary,args)=>{
    const command=[binary,...args].join(' ');commands.push(command);
    if(args[0]==='device-check')return {code:deviceCode,output:deviceCode?'Splash needs Apple GPU family 9 or newer (M3 or later)':'Device supported'};
    if(args[0]==='--prefix')return {code:0,output:'/fake/prefix'};
    if(args[0]==='outdated')return {code:1,output:'incoai/tap/splash'};
    if(args[0]==='--version')return {code:0,output:'Splash 1.6.0'};
    if(binary.endsWith('sw_vers'))return {code:0,output:'26.4'};
    if(binary.endsWith('sysctl'))return {code:0,output:'Apple M3'};
    return {code:0,output:'0.2.0'};
  };
  const report=()=>doctor({binary:'/fake/bin/splash',baseUrl:'http://llama/v1',run,brew:'/fake/brew',exists:async()=>true,platform:'darwin',arch:'arm64',fetcher:async url=>{assert.equal(url,'http://llama/v1/models');return Response.json({data:[]});}},signal());
  const rejected=await report();assert.equal(rejected.supported,false);assert.match(rejected.supportMessage,/GPU family 9/);
  deviceCode=0;const supported=await report();assert.equal(supported.supported,true);assert.equal(supported.splash.version,'Splash 1.6.0');assert.equal(supported.splash.outdated,true);assert.equal(supported.llama.version,'0.2.0');assert.equal(supported.llama.reachable,true);
  assert.ok(commands.includes('/fake/prefix/libexec/engine/splash device-check'));
  assert.ok(commands.every(command=>!command.includes(' install ')&&!command.includes('sudo')));
});

test('command output streams and cancellation reaps a fake command', async () => {
  const output:string[]=[];
  const resultOutput=await runCommand(process.execPath,['-e','process.stdout.write("fake output");process.stderr.write(" error")'],signal(),text=>output.push(text));
  assert.equal(resultOutput.code,0);assert.match(resultOutput.output,/fake output/);assert.match(resultOutput.output,/error/);
  assert.equal(output.join('').trim(),resultOutput.output);
  const abort=new AbortController();
  const result=runCommand(process.execPath,['-e','console.log("ready");setInterval(()=>{},1000)'],abort.signal,()=>abort.abort());
  await assert.rejects(()=>result,/abort/i);
});

test('doctor checks every configured server and counts its models', async () => {
  const run: RunCommand = async binary => ({ code: 0, output: binary.endsWith('sw_vers') ? '26.4' : 'Apple M3' });
  const report = await doctor({ binary: '/fake/splash', baseUrl: 'http://a/v1', servers: ['http://a/v1', 'http://b/v1', 'http://c/v1', 'http://d/v1'], run, brew: null, exists: async () => false, platform: 'darwin', arch: 'arm64',
    fetcher: async url => String(url).startsWith('http://a') ? Response.json({ data: [{}, {}] }) : String(url).startsWith('http://b') ? new Response(null, { status: 503 }) : String(url).startsWith('http://d') ? new Response('<html>', { status: 200 }) : Promise.reject(Error('EHOSTUNREACH')) }, signal());
  assert.deepEqual(report.servers, [{ url: 'http://a/v1', reachable: true, models: 2 }, { url: 'http://b/v1', reachable: false, models: null }, { url: 'http://c/v1', reachable: false, models: null }, { url: 'http://d/v1', reachable: false, models: null }]);
  assert.equal(report.llama.reachable, true);
});
