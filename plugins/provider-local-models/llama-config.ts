import { open, readFile, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MODELS_INI = join(homedir(), 'Library/Application Support/Llama/models.ini');
export const USER_INI = join(homedir(), '.config/llama/models.user.ini');
const heading = /^\s*\[([^\]]+)\]\s*(?:[;#].*)?$/;
export function iniSections(text: string) {
  const sections = new Map<string, Record<string, string>>();
  let section: Record<string, string> | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const match = heading.exec(raw);
    if (match) { section = sections.get(match[1]) ?? {}; sections.set(match[1], section); }
    else if (section && !/^\s*[;#]/.test(raw)) {
      const key = /^\s*([^=]+?)\s*=\s*(.*)$/.exec(raw);
      if (key) section[key[1]] = key[2].replace(/\s+[;#].*$/, '').trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return sections;
}
export function parseModelsIni(text: string) {
  return [...iniSections(text)].map(([id, values]) => {
    const context = Number(values['ctx-size']);
    return { id, model: values.model ?? '', context_length: Number.isSafeInteger(context) && context > 0 ? context : undefined };
  });
}
export async function readOptional(file: string) {
  try { return await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
export async function llamaModels(modelsIni = MODELS_INI, userIni = USER_INI) {
  const [base, user] = await Promise.all([readOptional(modelsIni), readOptional(userIni)]), overrides = iniSections(user);
  return parseModelsIni(base).map(model => {
    const values = overrides.get(model.id), context = values?.['ctx-size'], path = values?.model;
    return { ...model, ...(path === undefined ? {} : { model: path }), ...(context === undefined ? {} : { context_length: Number.isSafeInteger(Number(context)) && Number(context) > 0 ? Number(context) : undefined }), contextSource: context === undefined ? 'Llama.app default' : 'user file' };
  });
}

// Read only GGUF metadata, skipping tokenizer arrays and tensors; native limits never come from ctx-size.
async function readGgufInfo(file: string) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size, values: Record<string, number> = {}; let offset = 0, cacheStart = -1, cache = Buffer.alloc(0);
    async function bytes(n: number) {
      if (!Number.isSafeInteger(n) || n < 0 || offset + n > size || n > 1024 * 1024) throw Error('Invalid GGUF metadata');
      if (offset < cacheStart || offset + n > cacheStart + cache.length) {
        cacheStart = offset; cache = Buffer.alloc(Math.min(size - offset, Math.max(n, 65536)));
        const read = await handle.read(cache, 0, cache.length, offset); cache = cache.subarray(0, read.bytesRead);
      }
      const b = cache.subarray(offset - cacheStart, offset - cacheStart + n); if (b.length !== n) throw Error('Truncated GGUF'); offset += n; return b;
    }
    const u32 = async () => (await bytes(4)).readUInt32LE();
    const u64 = async () => { const n = Number((await bytes(8)).readBigUInt64LE()); if (!Number.isSafeInteger(n)) throw Error('Invalid GGUF length'); return n; };
    const string = async () => (await bytes(await u64())).toString('utf8');
    async function value(type: number, keep = false): Promise<number | undefined> {
      const widths = [1, 1, 2, 2, 4, 4, 4, 1, 0, 0, 8, 8, 8], width = widths[type];
      if (type === 8) { const n = await u64(); if (offset + n > size) throw Error('Invalid GGUF string'); offset += n; return; }
      if (type === 9) {
        const subtype = await u32(), count = await u64();
        if (subtype === 9 || subtype > 12 || count > size) throw Error('Invalid GGUF array');
        if (subtype !== 8) { offset += widths[subtype] * count; if (offset > size) throw Error('Invalid GGUF array'); }
        else for (let i = 0; i < count; i++) await value(subtype);
        return;
      }
      if (!width) throw Error('Unknown GGUF type');
      const b = await bytes(width);
      if (keep && type === 4) return b.readUInt32LE();
      if (keep && type === 10) return Number(b.readBigUInt64LE());
    }
    if ((await bytes(4)).toString() !== 'GGUF' || ![2, 3].includes(await u32())) throw Error('Unsupported GGUF');
    await u64(); const count = await u64(); if (count > 1000000) throw Error('Invalid GGUF metadata count');
    for (let i = 0; i < count; i++) {
      const key = await string(), type = await u32(), number = await value(type, /\.(context_length|embedding_length|block_count|attention\.(head_count|head_count_kv|key_length|value_length))$/.test(key));
      if (number !== undefined && Number.isSafeInteger(number) && number > 0) values[key] = number;
    }
    const key = Object.keys(values).find(key => key.endsWith('.context_length')), prefix = key?.slice(0, -'context_length'.length) ?? '';
    const heads = values[prefix + 'attention.head_count'], kv = values[prefix + 'attention.head_count_kv'], layers = values[prefix + 'block_count'];
    const dimension = values[prefix + 'embedding_length'] / heads;
    const kvBytesPerToken = 2 * layers * kv * ((values[prefix + 'attention.key_length'] || dimension) + (values[prefix + 'attention.value_length'] || dimension));
    return { nativeContext: key ? values[key] : null, size, kvBytesPerToken: Number.isFinite(kvBytesPerToken) && kvBytesPerToken > 0 ? kvBytesPerToken : null };
  } finally { await handle.close(); }
}
const infoCache = new Map<string, { key: string; promise: ReturnType<typeof readGgufInfo> }>();
export async function ggufInfo(file: string) {
  const value = await stat(file), key = [value.size, value.mtimeMs, value.ctimeMs].join(':');
  let cached = infoCache.get(file);
  if (cached?.key !== key) { cached = { key, promise: readGgufInfo(file) }; infoCache.set(file, cached); }
  return cached.promise;
}
export function memoryWarning(size: number, kvBytesPerToken: number | null, tokens: number, memory = totalmem()) {
  if (kvBytesPerToken === null) return 'Memory estimate unavailable for this model; leave room for macOS and the draft.';
  const estimate = size + kvBytesPerToken * tokens + 3 * 1024 ** 3;
  return estimate > memory * 0.85 ? `Estimated model, KV cache and engine memory ${(estimate / 1024 ** 3).toFixed(1)} GiB may not fit in unified memory (${(memory / 1024 ** 3).toFixed(1)} GiB).` : null;
}
export function editContext(text: string, id: string, tokens: number | null) {
  if (!id || /[\r\n\[\]]/.test(id)) throw Error('Invalid model id');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  let section = '', found = false, changed = false;
  const lines = text.split(/(?<=\n)/), result: string[] = [];
  for (const line of lines) {
    const match = heading.exec(line.trimEnd());
    if (match) {
      if (section === id && !changed && tokens !== null) { if (result.at(-1) && !result.at(-1)!.endsWith('\n')) result.push(newline); result.push('ctx-size = ' + tokens + newline); changed = true; }
      section = match[1]; if (section === id) found = true;
    }
    const key = section === id ? /^(\s*ctx-size\s*=\s*)([^\r\n]*?)(\s+[;#][^\r\n]*)?(\r?\n)?$/.exec(line) : null;
    if (!key) { result.push(line); continue; }
    changed = true;
    if (tokens !== null) result.push(key[1] + tokens + (key[3] ?? '') + (key[4] ?? ''));
    else if (key[3]) result.push(key[3].trimStart() + (key[4] ?? ''));
  }
  if (tokens !== null && !changed) {
    if (result.at(-1) && !result.at(-1)!.endsWith('\n')) result.push(newline);
    if (!found) result.push('[' + id + ']' + newline);
    result.push('ctx-size = ' + tokens + newline);
  }
  // A reset leaves no bare `[id]` header behind when the section has nothing else.
  if (tokens === null) {
    const start = result.findIndex(line => heading.exec(line.trimEnd())?.[1] === id && !/[;#]/.test(line)), end = start < 0 ? -1 : result.findIndex((line, index) => index > start && heading.test(line.trimEnd()));
    if (start >= 0 && result.slice(start + 1, end < 0 ? undefined : end).every(line => !line.trim())) result.splice(start, (end < 0 ? result.length : end) - start);
  }
  return result.join('');
}
let writes = Promise.resolve();
export function setContext(id: string, tokens: number | null, modelsIni = MODELS_INI, userIni = USER_INI) {
  const run = writes.catch(() => {}).then(async () => {
    const model = (await llamaModels(modelsIni, userIni)).find(model => model.id === id);
    if (!model) throw Error('Llama.app model not found');
    const info = await ggufInfo(model.model).catch(() => null);
    if (tokens !== null && (!Number.isSafeInteger(tokens) || tokens <= 0 || !info?.nativeContext || tokens > info.nativeContext)) throw Error('Context must be a positive integer at most the native window (' + (info?.nativeContext ?? 'unknown') + ').');
    const before = await readOptional(userIni), after = editContext(before, id, tokens);
    if (before !== after) {
      await mkdir(dirname(userIni), { recursive: true, mode: 0o700 });
      const temp = userIni + '.' + randomUUID() + '.tmp', mode = await stat(userIni).then(s => s.mode & 0o777, () => 0o600);
      try {
        await writeFile(temp, after, { mode });
        if (await readOptional(userIni) !== before) throw Error('Context file changed; refresh and retry.');
        await rename(temp, userIni);
      } finally { await rm(temp, { force: true }); }
    }
    return { warning: info && tokens !== null ? memoryWarning(info.size, info.kvBytesPerToken, tokens) : null };
  });
  writes = run.then(() => {}, () => {}); return run;
}
