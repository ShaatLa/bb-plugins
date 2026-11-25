import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { experimental_providerBridge as bridge, launchSpec } from './host.ts';
import { shimSource } from './shim.ts';
import { startModelsServer } from './test/models-server.ts';
import { experimental_captureBridgeJsonRpcOutput as capture } from '@get-bb/plugin-sdk/provider-bridge/testing';
import { experimental_acpProviderBridge as acp } from '@get-bb/plugin-sdk/provider-bridge/acp';

const DAY = 24 * 60 * 60 * 1000;

test('writes the shim once and prunes stale copies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-models-host-'));
  try {
    bridge.start?.({ pluginId: 'local-models', dataDir: root, tempDir: root });
    const options = { baseUrl: 'http://127.0.0.1:9/v1', defaultModel: '', splash: false };
    const shim = (await launchSpec(options)).args[0];
    assert.equal(await readFile(shim, 'utf8'), shimSource);

    // Same name means same content, so an existing file must not be rewritten.
    await writeFile(shim, 'sentinel');
    await launchSpec(options);
    assert.equal(await readFile(shim, 'utf8'), 'sentinel');

    // Stale copies go, fresh copies, the legacy name-only file and unrelated files stay.
    const stale = ['adapter-shim-000000000000.mjs', 'adapter-shim.mjs'];
    const fresh = 'adapter-shim-111111111111.mjs';
    for (const name of [...stale, fresh]) await writeFile(path.join(root, name), 'x');
    for (const name of stale) await utimes(path.join(root, name), (Date.now() - 8 * DAY) / 1000, (Date.now() - 8 * DAY) / 1000);
    await utimes(path.join(root, fresh), (Date.now() - DAY) / 1000, (Date.now() - DAY) / 1000);
    await writeFile(path.join(root, 'unrelated.json'), '{}');
    await launchSpec(options);
    assert.deepEqual((await readdir(root)).sort(), [path.basename(shim), fresh, 'unrelated.json'].sort());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('provider/usage answers unsupported', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-models-usage-'));
  const server = await startModelsServer();
  const output = capture();
  try {
    bridge.start?.({ pluginId: 'local-models', dataDir: root, tempDir: root });
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'provider/usage', params: { providerId: 'local-models', providerOptions: { baseUrl: server.baseUrl } } }));
    let response: any;
    for (let attempt = 0; attempt < 100 && !response; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      response = output.takeMessages().find((message: any) => message.id === 7);
    }
    assert.ok(response?.result, JSON.stringify(response));
    assert.deepEqual(response.result, { supported: false });
  } finally {
    output.restore();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('turn requests hand the BB thread id to the shim env', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'local-models-thread-env-'));
  const forwarded: string[] = [], original = acp.handleLine;
  acp.handleLine = (line: string) => { forwarded.push(line); };
  try {
    bridge.start?.({ pluginId: 'local-models', dataDir: root, tempDir: root });
    bridge.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'turn/start', params: { threadId: 'thr_example', providerThreadId: 'p1', input: [], clientRequestId: 'creq_abcdefghij',
      options: { permissionMode: 'full', permissionScope: 'full', approvalReviewer: null, permissionEscalation: null, providerOptions: { baseUrl: 'http://127.0.0.1:9/v1' } } } }));
    for (let attempt = 0; attempt < 100 && !forwarded.length; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    const spec = JSON.parse(forwarded[0]).params.options.providerOptions.acpLaunchSpec;
    assert.equal(spec.env.LM_THREAD_ID, 'thr_example');
    assert.equal(spec.env.LM_BASE_URL, 'http://127.0.0.1:9/v1');
  } finally {
    acp.handleLine = original;
    await rm(root, { recursive: true, force: true });
  }
});
