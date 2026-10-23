import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { experimental_providerBridge as bridge } from './host.ts';
import { experimental_captureBridgeJsonRpcOutput as capture, experimental_runBridgeConformance as conformance, experimental_formatConformanceReport as format } from '@get-bb/plugin-sdk/provider-bridge/testing';

test('passes the public BB provider bridge conformance suite', {timeout:30000}, async () => {
  const root=await mkdtemp(path.join(tmpdir(),'agy-bridge-test-'));
  const output=capture();
  try {
    bridge.start?.({pluginId:'antigravity',dataDir:root,tempDir:root});
    const report=await conformance({providerId:'antigravity',transport:{send:bridge.handleLine,takeMessages:output.takeMessages},session:{cwd:root,promptInput:[{type:'text',text:'hello',mentions:[]}],interruptiblePromptInput:[{type:'text',text:'wait-for-cancel',mentions:[]}],zeroWorkPromptInput:[{type:'text',text:'/noop',mentions:[]}],options:{envVars:{BB_INTEGRATION_FIXTURE:'1'},permissionMode:'full',permissionScope:'full',approvalReviewer:null,permissionEscalation:null,providerOptions:{agyCommand:fileURLToPath(new URL('./test/fake-agy.mjs',import.meta.url))}}},timeoutMs:5000});
    assert.equal(report.passed,true,format(report));
  } finally {output.restore();await rm(root,{recursive:true,force:true});}
});
