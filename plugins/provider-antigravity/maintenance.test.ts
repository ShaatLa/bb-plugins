import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUsage, readUsage, installationStatus, installationRun } from './maintenance.ts';

const quota = (remaining: unknown = .731234) => JSON.stringify({ event: 'command_result', command: { name: 'usage', data: { groups: [{ name: 'Gemini Models', buckets: [{ id: 'gemini-5h', name: 'Five Hour Limit Remaining', window: '5h', remaining_fraction: remaining, reset_time: '2026-10-24T00:00:00Z' }] }] } } });
test('preserves measured quota precision, model group and reset time', () => {
  const usage = parseUsage(quota()); assert.equal(usage.status,'ok');
  if (usage.status !== 'ok') return;
  assert.ok(Math.abs(usage.windows[0].usedPercent - 26.8766) < 1e-8);
  assert.equal(usage.windows[0].resetsAt,'2026-10-24T00:00:00Z');
  assert.equal(usage.windows[0].kind,'five-hour'); assert.equal(usage.accountEmail,null);
  for (const remaining of [0,1]) {
    const value = parseUsage(quota(remaining));
    if (value.status === 'ok') assert.equal(value.windows[0].usedPercent,(1-remaining)*100);
  }
});
test('shows compact Google quota windows and excludes Claude/GPT buckets', () => {
  const bucket = (id: string, window: string) => ({id, name:'Long CLI quota name', window, remaining_fraction:.75});
  const usage = parseUsage(JSON.stringify({event:'command_result', command:{name:'usage', data:{groups:[
    {name:'Gemini Models', buckets:[bucket('gemini-weekly','weekly'), bucket('gemini-5h','5h')]},
    {name:'Claude and GPT models', buckets:[bucket('3p-weekly','weekly'), bucket('3p-5h','5h')]},
    {name:'Gemini 4 Argon', buckets:[bucket('gemini-argon-wtu-weekly','weekly')]},
  ]}}}));
  assert.equal(usage.status,'ok');
  if (usage.status !== 'ok') return;
  assert.deepEqual(usage.windows.map(({label, kind, usedPercent}) => ({label, kind, usedPercent})), [
    {label:'5h', kind:'five-hour', usedPercent:25},
    {label:'7d', kind:'weekly', usedPercent:25},
    {label:'7d · Argon', kind:'weekly', usedPercent:25},
  ]);
});
test('rejects empty, malformed or invented quota values', () => {
  for (const value of ['', 'not json', quota(-1),quota(1.1),quota(null),quota('0.2')]) assert.throws(()=>parseUsage(value));
  assert.throws(()=>parseUsage(JSON.stringify({event:'command_result',command:{name:'usage',data:{groups:[]}}})));
});
test('uses only the current authenticated email and removes temporary identity logs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(),'agy-identity-test-'));
  const command = path.join(dir,'agy');
  const record = path.join(dir,'log-path');
  try {
    for (const email of ['person@example.com', 'invalid-email', null]) {
      const log = email === null ? '' : 'OAuth: authenticated successfully as old@example.com\nOAuth: authenticated successfully as '+email+'\nSECRET_TOKEN';
      await writeFile(command, '#!/usr/bin/env node\nconst fs=require("node:fs"); const log=process.argv[process.argv.indexOf("--log-file")+1]; fs.writeFileSync('+JSON.stringify(record)+',log); fs.writeFileSync(log,'+JSON.stringify(log)+'); console.log('+JSON.stringify(quota())+');\n', {mode:0o700});
      const usage = await readUsage(command);
      assert.equal(usage.status,'ok');
      if (usage.status !== 'ok') continue;
      assert.equal(usage.accountEmail, email === 'person@example.com' ? email : null);
      assert.ok(!JSON.stringify(usage).includes('SECRET_TOKEN'));
      const logPath = await readFile(record,'utf8');
      await assert.rejects(access(path.dirname(logPath)));
    }
    await writeFile(command,'#!/usr/bin/env node\nconsole.error("SECRET_TOKEN");process.exit(1);\n',{mode:0o700});
    assert.equal((await readUsage(command)).status,'error');
  } finally { await rm(dir,{recursive:true,force:true}); }
});
test('uses only an existing CLI and exposes native verified update plans', async () => {
  const dir=await mkdtemp(path.join(tmpdir(),'agy-maintenance-test-'));
  const command=path.join(dir,'agy');
  const originalFetch=globalThis.fetch;
  let calls=0;
  try {
    await writeFile(command,'#!/usr/bin/env node\nif(process.argv.includes("--version"))console.log("1.0.0");else console.log('+JSON.stringify(quota())+');\n',{mode:0o700});
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({tag_name:'1.4.6'})); }) as typeof fetch;
    const local=await installationStatus(command,false);
    assert.equal(calls,0);assert.equal(local.latestVersion,null);assert.equal(local.installAction,null);
    const status=await installationStatus(command);assert.equal(status.needsUpdate,true);assert.equal(status.installAction?.label,'Update');
    const plan=await installationRun(command,'update');assert.equal(plan.available,true);
    if(plan.available){assert.deepEqual(plan.command.args,['update']);assert.equal(plan.command.command,command);assert.deepEqual(plan.verification,{kind:'version_at_least',version:'1.4.6'});}
    assert.equal((await installationRun(command,'install')).available,false);
    assert.equal((await readUsage(command)).status,'ok');
    globalThis.fetch = (async () => {throw Error('offline');}) as typeof fetch;
    assert.equal((await installationStatus(command)).needsUpdate,false);
    assert.equal((await readUsage(path.join(dir,'missing'))).status,'not_installed');
    await writeFile(command,'#!/usr/bin/env node\nconsole.error("You are not logged into Antigravity. SECRET_TOKEN");process.exit(1);\n',{mode:0o700});
    const failed=await readUsage(command);assert.equal(failed.status,'unauthenticated');assert.ok(!JSON.stringify(failed).includes('SECRET_TOKEN'));
  } finally {globalThis.fetch=originalFetch;await rm(dir,{recursive:true,force:true});}
});
