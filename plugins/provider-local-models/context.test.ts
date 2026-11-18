import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editContext, ggufInfo, llamaModels, memoryWarning, setContext } from './llama-config.ts';
import { fakeGguf } from './test/gguf.ts';

test('context edits preserve other keys, sections, comments and CRLF, and default removes only ctx-size', () => {
  const before = '# header\r\n[a] ; keep\r\n  ctx-size = 4096 # reason\r\nmodel = /a\r\n; comment\r\n[b]\r\nctx-size=12\r\n';
  const after = '# header\r\n[a] ; keep\r\n  ctx-size = 8192 # reason\r\nmodel = /a\r\n; comment\r\n[b]\r\nctx-size=12\r\n';
  assert.equal(editContext(before, 'a', 8192), after);
  assert.equal(editContext(before, 'a', null), '# header\r\n[a] ; keep\r\n# reason\r\nmodel = /a\r\n; comment\r\n[b]\r\nctx-size=12\r\n');
  assert.equal(editContext('[a]\nfoo = yes\n[b]\nx=1', 'a', 10), '[a]\nfoo = yes\nctx-size = 10\n[b]\nx=1');
  assert.equal(editContext('# hi', 'new/model:Q4', 4), '# hi\n[new/model:Q4]\nctx-size = 4\n');
  assert.equal(editContext(editContext('# hi\n[b]\nx=1\n', 'new/model:Q4', 4), 'new/model:Q4', null), '# hi\n[b]\nx=1\n');
  assert.equal(editContext('[new/model:Q4]\nctx-size = 4\n[b]\nx=1\n', 'new/model:Q4', null), '[b]\nx=1\n');
  assert.equal(editContext('', 'a', null), '');
  assert.equal(editContext('', 'a', 10), '[a]\nctx-size = 10\n');
  assert.equal(editContext('[a]\nctx-size=1\nctx-size=2', 'a', 3), '[a]\nctx-size=3\nctx-size=3');
  assert.throws(() => editContext('', 'a\n[bad]', 4), /Invalid/);
});

test('native GGUF metadata, user precedence and atomic context writes share the same source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'local-context-')), modelsIni = join(dir, 'models.ini'), userIni = join(dir, 'user.ini'), gguf = join(dir, 'model.gguf');
  try {
    await writeFile(gguf, fakeGguf(32768));
    await writeFile(modelsIni, '[a]\nmodel = ' + gguf + '\nctx-size = 2048\n');
    await writeFile(userIni, '# user\n[a]\nctx-size = 4096\nother = untouched\n');
    assert.equal((await llamaModels(modelsIni, userIni))[0].context_length, 4096);
    assert.equal((await llamaModels(modelsIni, userIni))[0].contextSource, 'user file');
    const info = await ggufInfo(gguf); assert.equal(info.nativeContext, 32768); assert.equal(info.kvBytesPerToken, 131072);
    await setContext('a', 16384, modelsIni, userIni);
    assert.equal(await readFile(userIni, 'utf8'), '# user\n[a]\nctx-size = 16384\nother = untouched\n');
    await assert.rejects(() => setContext('a', 32769, modelsIni, userIni), /native window/);
    await assert.rejects(() => setContext('a', 1.5, modelsIni, userIni), /positive integer/);
    await assert.rejects(() => setContext('missing', 10, modelsIni, userIni), /not found/);
    await setContext('a', null, modelsIni, userIni);
    assert.equal((await llamaModels(modelsIni, userIni))[0].context_length, 2048);
    assert.equal((await llamaModels(modelsIni, userIni))[0].contextSource, 'Llama.app default');
    assert.equal(await readFile(userIni, 'utf8'), '# user\n[a]\nother = untouched\n');
    await Promise.all([setContext('a', 4096, modelsIni, userIni), setContext('a', 8192, modelsIni, userIni)]);
    assert.equal((await llamaModels(modelsIni, userIni))[0].context_length, 8192);
    assert.match(memoryWarning(1000, info.kvBytesPerToken, 32768, 4 * 1024 ** 3)!, /may not fit/);
    assert.equal(memoryWarning(1000, info.kvBytesPerToken, 32768, 128 * 1024 ** 3), null);
    await writeFile(gguf, 'bad'); await assert.rejects(() => ggufInfo(gguf), /GGUF/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
