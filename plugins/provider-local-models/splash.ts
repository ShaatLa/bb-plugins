import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, createReadStream, createWriteStream, openSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { llamaModels, ggufInfo, MODELS_INI, USER_INI } from './llama-config.ts';
export { parseModelsIni } from './llama-config.ts';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

export const DRAFTS_DIR = join(homedir(), 'models/incoai');
const families = ['Qwen3.6-35B-A3B', 'Qwen3.8-27B', 'Flint', 'Inkling-2-Mini'];
// GGUFs pulled for Splash outside Llama.app live in <models dir>/<owner>/<repo>/, next to the drafts directory.
export const modelsDirFor = (draftsDir: string) => join(dirname(draftsDir), 'splash');
export function parseUpstream(id: string) {
  const match = /^([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*-GGUF):([A-Za-z0-9][\w.-]*)$/i.exec(id);
  if (!match || id.includes('..')) return null;
  return { owner: match[1], repo: match[2], variant: match[3], file: match[2].replace(/-GGUF$/i, '') + '-' + match[3] + '.gguf' };
}
// suffix '.gguf.part' finds interrupted pulls instead of complete ones.
export async function managedModels(modelsDir: string, suffix = '.gguf') {
  const found: { id: string; model: string }[] = [], list = (dir: string) => readdir(dir).catch(() => [] as string[]);
  for (const owner of await list(modelsDir)) for (const repo of await list(join(modelsDir, owner))) for (const file of await list(join(modelsDir, owner, repo))) {
    const prefix = repo.replace(/-GGUF$/i, '') + '-', id = owner + '/' + repo + ':' + file.slice(prefix.length, -suffix.length);
    if (file.startsWith(prefix) && file.endsWith(suffix) && parseUpstream(id)?.file + suffix.slice(5) === file) found.push({ id, model: join(modelsDir, owner, repo, file) });
  }
  return found;
}
export function splashFamily(id: string) {
  const name = id.replace(/^splash\//, '').split('/').at(-1)!.split(':')[0].replace(/-GGUF$/i, '');
  return families.find(family => name.toLowerCase() === family.toLowerCase());
}
const verified = new Map<string, string>(), inflight = new Map<string, Promise<boolean>>();
// Concurrent callers (Settings poll, proxy /models) share one check and so one hash.
export function verifiedDraft(dir: string) {
  let pending = inflight.get(dir);
  if (!pending) inflight.set(dir, pending = checkDraft(dir).finally(() => inflight.delete(dir)));
  return pending;
}
async function checkDraft(dir: string) {
  try {
    const file = join(dir, 'model.safetensors'), config = join(dir, 'config.json'), receiptFile = join(dir, '.verified.json');
    const [weights, receipt, configText] = await Promise.all([stat(file), readFile(receiptFile, 'utf8'), readFile(config, 'utf8')]);
    JSON.parse(configText);
    const proof = JSON.parse(receipt) as { sha256: string; size: number; mtimeMs?: number };
    if (!/^[a-f0-9]{64}$/.test(proof.sha256) || proof.size !== weights.size) return false;
    // The receipt vouches for the file as it was when hashed; an unchanged size and mtime skips the multi-GB rehash after a restart.
    if (proof.mtimeMs === weights.mtimeMs) return true;
    const key = [weights.size, weights.mtimeMs, weights.ctimeMs, receipt, configText].join(':');
    if (verified.get(dir) === key) return true;
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest('hex') !== proof.sha256) return false;
    // mtime comes from the stat taken before hashing, so a file changed meanwhile mismatches next time.
    const upgraded = JSON.stringify({ ...proof, mtimeMs: weights.mtimeMs });
    await writeFile(receiptFile + '.tmp', upgraded, { mode: 0o600 }).then(() => rename(receiptFile + '.tmp', receiptFile)).catch(() => {});
    verified.set(dir, [weights.size, weights.mtimeMs, weights.ctimeMs, upgraded, configText].join(':')); return true;
  } catch { return false; }
}
export async function draftMetadata(id: string, signal: AbortSignal, fetcher = fetch) {
  const family = splashFamily(id);
  if (!family) throw Error('Unsupported Splash family: ' + id);
  const repo = family + '-DFlash2', base = 'https://huggingface.co/incoai/' + repo;
  const metadata = await fetcher('https://huggingface.co/api/models/incoai/' + repo + '?blobs=true', { signal });
  if (!metadata.ok) throw Error('Cannot read draft metadata: HTTP ' + metadata.status);
  const info = await metadata.json() as { sha?: string; siblings?: { rfilename: string; size?: number; lfs?: { sha256?: string; oid?: string; size: number } }[] };
  const weights = info.siblings?.find(file => file.rfilename === 'model.safetensors');
  // The model API names the LFS hash `sha256`; the tree API calls it `oid`.
  const sha256 = weights?.lfs?.sha256 ?? weights?.lfs?.oid ?? '';
  if (!weights?.lfs || !/^[a-f0-9]{64}$/i.test(sha256) || !Number.isSafeInteger(weights.lfs.size) || weights.lfs.size <= 0 || !/^[a-f0-9]{40}$/i.test(info.sha ?? '') || !info.siblings?.some(file => file.rfilename === 'config.json')) throw Error('Draft metadata lacks a revision, config or verified weights.');
  return { repo, base, revision: info.sha!, files: info.siblings, sha256: sha256.toLowerCase(), size: weights.lfs.size };
}
async function exists(file: string) { return stat(file).then(value => value.isFile(), () => false); }
export async function splashModels(modelsIni = MODELS_INI, draftsDir = DRAFTS_DIR, userIni = USER_INI, modelsDir = modelsDirFor(draftsDir)) {
  const llama = await llamaModels(modelsIni, userIni), ids = new Set(llama.map(model => model.id));
  const managed = (await managedModels(modelsDir)).filter(model => !ids.has(model.id)).map(model => ({ ...model, context_length: undefined as number | undefined, contextSource: 'Splash default' }));
  const entries = await Promise.all([...llama, ...managed].map(async model => {
    const family = splashFamily(model.id), draft = family ? join(draftsDir, family + '-DFlash2') : '';
    if (!family || !isAbsolute(model.model) || !await exists(model.model) || !await verifiedDraft(draft)) return [];
    return [{ ...model, id: 'splash/' + model.id, draft }];
  }));
  return entries.flat();
}

type SplashOptions = { binary: string; port: number; proxyPort: number; idleMinutes: number; llamaUrl: string; dataDir: string; modelsIni?: string; userIni?: string; draftsDir?: string; modelsDir?: string; readyTimeoutMs?: number };
export async function startSplash(options: SplashOptions) {
  const engine = `http://127.0.0.1:${options.port}`, lifetime = new AbortController();
  let current: { id: string; child: ChildProcess; closed: Promise<void>; ready: boolean; context?: number } | undefined;
  const nativeLimits = new Map<string, number>(), list = () => splashModels(options.modelsIni, options.draftsDir, options.userIni, options.modelsDir);
  let starting: Promise<void> | undefined, disposal: Promise<void> | undefined, lastError = '', lastRequest = Date.now(), active = 0, disposed = false;
  async function stop() {
    const running = current;
    if (!running) return;
    running.ready = false;
    if (running.child.exitCode === null && running.child.signalCode === null) {
      running.child.kill('SIGTERM');
      const timer = setTimeout(() => running.child.kill('SIGKILL'), 10_000);
      try { await running.closed; } finally { clearTimeout(timer); }
    }
    if (current === running) current = undefined;
  }
  async function unloadLlama() {
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]);
      const response = await fetch(options.llamaUrl + '/models', { signal });
      if (!response.ok) return;
      const body = await response.json() as { data?: { id: string; status?: { value?: string } }[] };
      for (const model of body.data ?? []) if (model.status?.value === 'loaded') {
        await fetch(options.llamaUrl.replace(/\/v1\/?$/, '') + '/models/unload', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.id }), signal }).then(response => response.body?.cancel());
      }
    } catch { /* Llama.app may be offline. */ }
  }
  async function ensure(model: Awaited<ReturnType<typeof list>>[number], context?: number) {
    await stop();
    lifetime.signal.throwIfAborted();
    // Refuse an occupied engine port rather than proxying an unsupervised process.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(options.port, '127.0.0.1', resolve); });
    await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
    await unloadLlama();
    lifetime.signal.throwIfAborted();
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    lifetime.signal.throwIfAborted();
    const logFile = join(options.dataDir, 'splash.log');
    if (((await stat(logFile).catch(() => null))?.size ?? 0) > 5e6) await rename(logFile, logFile + '.1');
    const log = openSync(logFile, 'a', 0o600);
    let child: ChildProcess;
    try { child = spawn(options.binary, ['serve', '--model', model.id.slice(7), '--model-dir', model.model, '--draft-model', model.draft, '--language-only', '--port', String(options.port), ...(context ? ['--max-context', String(context)] : [])], { detached: false, stdio: ['ignore', log, log] }); }
    finally { closeSync(log); }
    let spawnError: Error | undefined;
    const running = { id: model.id, child, ready: false, context: undefined as number | undefined, closed: new Promise<void>(resolve => child.once('close', () => resolve())) };
    child.once('error', error => { spawnError = error; });
    current = running;
    child.once('close', () => { if (current === running) current = undefined; });
    try {
      const deadline = Date.now() + (options.readyTimeoutMs ?? 10 * 60000);
      while (true) {
        lifetime.signal.throwIfAborted();
        if (spawnError) throw spawnError;
        if (child.exitCode !== null || child.signalCode !== null) throw Error('Splash exited before becoming ready. Check splash.log.');
        if (Date.now() >= deadline) throw Error('Splash readiness timed out. Check splash.log.');
        const ready = await fetch(engine + '/ready', { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(1000)]) }).then(async response => { await response.body?.cancel(); return response.ok; }, () => false);
        if (ready && child.exitCode === null && child.signalCode === null) break;
        await delay(100, undefined, { signal: lifetime.signal });
      }
      try {
        const response = await fetch(engine + '/v1/models', { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(5000)]) });
        if (response.ok) {
          const body = await response.json() as { data?: { id: string; context_length?: number }[] };
          const reported = body.data?.find(entry => entry.id === model.id.slice(7))?.context_length;
          running.context = reported;
          if (!context && Number.isSafeInteger(reported) && reported! > 0) nativeLimits.set(model.id, reported!);
        } else await response.body?.cancel();
      } catch { /* The ini context is the fallback. */ }
      lifetime.signal.throwIfAborted();
      const limit = nativeLimits.get(model.id), requested = model.context_length;
      // First start discovers Splash's own limit before accepting a configured window.
      if (!context && requested && limit && requested <= limit && requested !== running.context) {
        const gguf = await ggufInfo(model.model).catch(() => null);
        if (!gguf?.nativeContext || requested <= gguf.nativeContext) { await ensure(model, requested); return; }
      }
      running.ready = true;
      lastRequest = Date.now();
    } catch (error) { await stop(); throw error; }
  }
  const proxy = createServer(async (request, response) => {
    const json = (status: number, value: unknown) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
    try {
      if (disposed) return void json(503, { error: { message: 'Splash is stopping.' } });
      if (request.method === 'GET' && request.url === '/v1/models') {
        const models = await list();
        return void json(200, { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', status: { value: current?.ready && current.id === model.id ? 'loaded' : 'unloaded' }, context_length: current?.ready && current.id === model.id ? current.context ?? model.context_length : model.context_length })) });
      }
      // Router-style unload, so `bb local-models unload` also stops Splash.
      if (request.method === 'POST' && request.url === '/models/unload') {
        let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 4096) return void json(413, { error: { message: 'Request too large.' } }); }
        let model; try { model = JSON.parse(raw)?.model; } catch { return void json(400, { error: { message: 'Invalid JSON.' } }); }
        if (current && current.id === model && !active) { await (starting ?? Promise.resolve()); await stop(); }
        return void json(200, { success: true });
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return void json(404, { error: { message: 'Not found.' } });
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 16 * 1024 * 1024) return void json(413, { error: { message: 'Request too large.' } }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { return void json(400, { error: { message: 'Invalid JSON.' } }); }
      if (!body || typeof body !== 'object' || typeof body.model !== 'string') return void json(400, { error: { message: 'A model is required.' } });
      const model = (await list()).find(model => model.id === body.model);
      if (!model) return void json(404, { error: { message: 'Splash model not found or draft missing.' } });
      lastRequest = Date.now();
      if (starting || !current?.ready || current.id !== model.id || current.child.exitCode !== null || current.child.signalCode !== null) {
        // A failed start is reported once, so the client sees why instead of waiting on 503s; the next request retries.
        if (lastError && !starting) { const message = lastError; lastError = ''; return void json(502, { error: { message } }); }
        if (!starting && !active) {
          starting = (async () => {
            const known = nativeLimits.get(model.id), gguf = await ggufInfo(model.model).catch(() => null);
            const context = model.context_length && known && model.context_length <= known && (!gguf?.nativeContext || model.context_length <= gguf.nativeContext) ? model.context_length : undefined;
            await ensure(model, context);
          })().catch(error => { lastError = String(error); }).finally(() => { starting = undefined; });
        }
        return void json(503, { error: { message: lastError || 'Loading model', code: 503 } });
      }
      active++;
      const abort = new AbortController(), onClose = () => abort.abort();
      response.once('close', onClose);
      try {
        const upstream = await fetch(engine + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, model: model.id.slice(7) }), signal: AbortSignal.any([lifetime.signal, abort.signal]) });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
        if (upstream.body) await pipeline(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream), response);
        else response.end();
      } finally { response.off('close', onClose); active--; lastRequest = Date.now(); }
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(502, { error: { message: String(error) } });
      else response.destroy();
    }
  });
  await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(options.proxyPort, '127.0.0.1', resolve); });
  const idleMs = options.idleMinutes * 60000;
  const idle = setInterval(() => {
    if (current && !starting && !active && Date.now() - lastRequest >= idleMs) {
      starting = stop().finally(() => { starting = undefined; });
    }
  }, Math.max(10, Math.min(1000, idleMs / 2)));
  idle.unref();
  return {
    baseUrl: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1`,
    status: () => ({ model: current?.id ?? null, pid: current?.child.pid ?? null, port: options.port, ready: current?.ready ?? false, idleLeftMs: current ? Math.max(0, idleMs - (Date.now() - lastRequest)) : 0, error: lastError || null }),
    async restart(id: string) {
      if (disposed) throw Error('Splash is stopping.');
      if (starting || active) throw Error('Splash is busy; retry when the current request finishes.');
      const model = (await list()).find(model => model.id === id);
      if (!model) throw Error('Splash model not available');
      if (starting || active || disposed) throw Error('Splash is busy or stopping.');
      starting = ensure(model).catch(error => { lastError = String(error); throw error; }).finally(() => { starting = undefined; });
      await starting;
    },
    dispose() {
      disposal ??= (async () => {
        disposed = true; clearInterval(idle); lifetime.abort();
        const closed = new Promise<void>(resolve => proxy.close(() => resolve()));
        proxy.closeAllConnections();
        await starting;
        await stop();
        await closed;
      })();
      return disposal;
    },
  };
}

async function verifyFile(file: string, expected: { sha256: string; size: number }, signal: AbortSignal) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) { signal.throwIfAborted(); hash.update(chunk); }
  return (await stat(file)).size === expected.size && hash.digest('hex') === expected.sha256;
}
// Resumes `<file>.part`; with `expected`, verifies size and sha256 before the final rename.
async function transfer(url: string, file: string, label: string, signal: AbortSignal, fetcher: typeof fetch, expected?: { sha256: string; size: number }, progress: (done: number, total: number) => void = () => {}) {
  const partial = file + '.part', name = file.split('/').at(-1)!;
  const offset = await stat(partial).then(value => value.size, () => 0);
  if (expected && offset > expected.size) {
    await rm(partial, { force: true });
    throw Error(label + ' size mismatch; deleted ' + partial);
  }
  if (!(expected && offset === expected.size)) {
    const response = await fetcher(url, { signal, headers: offset ? { Range: 'bytes=' + offset + '-' } : {} });
    if (!response.ok || !response.body) throw Error(label + ' download failed: ' + name + ' HTTP ' + response.status);
    if (response.status === 206 && (!offset || !response.headers.get('content-range')?.startsWith('bytes ' + offset + '-'))) { await response.body.cancel(); throw Error('Invalid resume range for ' + name); }
    let done = response.status === 206 ? offset : 0;
    const meter = new Transform({ transform(chunk, _encoding, callback) { done += chunk.length; if (expected) progress(done, expected.size); callback(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), meter, createWriteStream(partial, { flags: response.status === 206 ? 'a' : 'w', mode: 0o600 }), { signal });
  }
  if (expected && !await verifyFile(partial, expected, signal)) {
    await rm(partial, { force: true });
    throw Error(label + ' size or sha256 mismatch; deleted ' + partial);
  }
  await rename(partial, file);
}

// The SDK buffers CLI output; log each file before its transfer and return the transcript too.
export async function setupSplash(id: string, print: (line: string) => void, signal: AbortSignal, draftsDir = DRAFTS_DIR, fetcher = fetch, progress: (done: number, total: number) => void = () => {}) {
  const { repo, base, revision, files, sha256, size } = await draftMetadata(id, signal, fetcher);
  const dir = join(draftsDir, repo);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of ['model.safetensors', 'config.json', 'README.md', 'LICENSE']) {
    if (!files.some(file => file.rfilename === name)) continue;
    const file = join(dir, name), expected = name === 'model.safetensors' ? { sha256, size } : undefined;
    if (await exists(file)) {
      if (!expected) continue;
      if (await verifyFile(file, expected, signal)) { progress(size, size); continue; }
      await rm(file, { force: true });
      throw Error('Draft size or sha256 mismatch; deleted ' + file);
    }
    print('Downloading ' + base + '/resolve/' + revision + '/' + name + ' -> ' + file);
    await transfer(base + '/resolve/' + revision + '/' + name, file, 'Draft', signal, fetcher, expected, progress);
  }
  JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
  // mtime is read after the final rename so it matches the file verifiedDraft will stat.
  await writeFile(join(dir, '.verified.json'), JSON.stringify({ sha256, size, revision, mtimeMs: (await stat(join(dir, 'model.safetensors'))).mtimeMs }), { mode: 0o600 });
  progress(size, size);
  return dir;
}

// Pulls one single-file GGUF from Hugging Face; the file appears only after its size and LFS sha256 match.
export async function pullModel(id: string, print: (line: string) => void, signal: AbortSignal, modelsDir: string, fetcher = fetch, progress: (done: number, total: number) => void = () => {}) {
  const source = parseUpstream(id);
  if (!source) throw Error('Use an upstream GGUF id such as owner/Model-GGUF:Q4_K_M.');
  const file = join(modelsDir, source.owner, source.repo, source.file);
  const response = await fetcher('https://huggingface.co/api/models/' + source.owner + '/' + source.repo + '?blobs=true', { signal });
  if (!response.ok) throw Error('Cannot read model metadata: HTTP ' + response.status);
  const info = await response.json() as { sha?: string; siblings?: { rfilename: string; lfs?: { sha256?: string; oid?: string; size: number } }[] };
  const entry = info.siblings?.find(item => item.rfilename === source.file), sha256 = entry?.lfs?.sha256 ?? entry?.lfs?.oid ?? '';
  // shortcut: split GGUFs (-00001-of-0000N) are not pulled; add multi-file support when a supported quant needs it.
  if (!entry) throw Error('No single-file ' + source.file + ' in ' + source.owner + '/' + source.repo + '.');
  if (!entry.lfs || !/^[a-f0-9]{64}$/i.test(sha256) || !Number.isSafeInteger(entry.lfs.size) || entry.lfs.size <= 0 || !/^[a-f0-9]{40}$/i.test(info.sha ?? '')) throw Error('Model metadata lacks a revision or verified weights.');
  const expected = { sha256: sha256.toLowerCase(), size: entry.lfs.size };
  if (await exists(file)) { progress(expected.size, expected.size); return file; }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const url = 'https://huggingface.co/' + source.owner + '/' + source.repo + '/resolve/' + info.sha + '/' + source.file;
  print('Downloading ' + url + ' -> ' + file);
  await transfer(url, file, 'Model', signal, fetcher, expected, progress);
  return file;
}
