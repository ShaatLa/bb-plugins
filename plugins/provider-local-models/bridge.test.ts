import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_providerBridge as bridge } from './host.ts';
import { startModelsServer } from './test/models-server.ts';
import { experimental_captureBridgeJsonRpcOutput as capture, experimental_runBridgeConformance as conformance, experimental_formatConformanceReport as format } from '@get-bb/plugin-sdk/provider-bridge/testing';

test('passes the public BB provider bridge conformance suite', {timeout:30000}, async () => {
  const root=await mkdtemp(path.join(tmpdir(),'local-models-bridge-test-'));
  const server=await startModelsServer();
  const output=capture();
  try {
    bridge.start?.({pluginId:'local-models',dataDir:root,tempDir:root});
    const report=await conformance({providerId:'local-models',transport:{send:bridge.handleLine,takeMessages:output.takeMessages},session:{cwd:root,promptInput:[{type:'text',text:'hello',mentions:[]}],interruptiblePromptInput:[{type:'text',text:'wait-for-cancel',mentions:[]}],zeroWorkPromptInput:[{type:'text',text:'/noop',mentions:[]}],options:{envVars:{BB_INTEGRATION_FIXTURE:'1'},permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,providerOptions:{baseUrl:server.baseUrl,codexCommand:fileURLToPath(new URL('./test/fake-codex.mjs',import.meta.url))}}},timeoutMs:5000});
    assert.equal(report.passed,true,format(report));
  } finally {output.restore();await server.close();await rm(root,{recursive:true,force:true});}
});
