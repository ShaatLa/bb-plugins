import test from 'node:test';
import assert from 'node:assert/strict';
import { parseModels, readModels, usageFor } from './models.ts';
import { startModelsServer } from './test/models-server.ts';

test('lists installed models with readable names and an unlimited usage window each', async()=>{
  const server=await startModelsServer();
  try {
    const models=await readModels(server.baseUrl+'/');
    assert.equal(models.length,1);
    assert.equal(models[0].id,'ggml-org/gpt-oss-20b-GGUF:MXFP4');
    assert.equal(models[0].displayName,'gpt-oss-20b (MXFP4)');
    assert.equal(models[0].isDefault,true);
    const usage=usageFor(models);
    assert.equal(usage.status,'ok');
    assert.deepEqual(usage.status==='ok'&&usage.windows,[{label:'gpt-oss-20b\u2063',usedPercent:0,resetsAt:null}]);
  } finally {await server.close();}
  const two={data:[{id:'a/Qwen-GGUF:Q4'},{id:'b/gpt-oss-GGUF:MXFP4'}]};
  assert.deepEqual(parseModels(two,'b/gpt-oss-GGUF:MXFP4').map(m=>m.isDefault),[false,true]);
  assert.deepEqual(parseModels(two,'missing').map(m=>m.isDefault),[true,false]);
  assert.throws(()=>parseModels({data:[]}),/no models/);
  await assert.rejects(()=>readModels(server.baseUrl));
});

test('reads per-model reasoning from the caps file',async()=>{
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
  const dir=await mkdtemp((await import('node:path')).join((await import('node:os')).tmpdir(),'local-caps-'));const server=await startModelsServer();
  try{
    await writeFile(dir+'/model-caps.json',JSON.stringify({'ggml-org/gpt-oss-20b-GGUF:MXFP4':{knob:'reasoning_effort',none:true,levels:['low','medium','xhigh'],checkedAt:1}}));
    const models=await readModels(server.baseUrl,'',dir);
    assert.deepEqual(models[0].supportedReasoningEfforts?.map(e=>e.reasoningEffort),['none','low','medium','xhigh']);
    assert.equal(models[0].defaultReasoningEffort,'medium');
  }finally{await server.close();await rm(dir,{recursive:true,force:true});}
});
