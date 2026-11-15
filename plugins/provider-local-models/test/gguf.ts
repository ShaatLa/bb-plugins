// Minimal metadata-only GGUF, used exclusively by fake fixtures.
export function fakeGguf(context = 131072) {
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const string = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
  const values = { 'fake.context_length': context, 'fake.embedding_length': 4096, 'fake.block_count': 32, 'fake.attention.head_count': 32, 'fake.attention.head_count_kv': 8 };
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(Object.keys(values).length + 1),
    string('tokenizer.ggml.tokens'), u32(9), u32(8), u64(2), string('ctx-size is not native'), string('test'),
    ...Object.entries(values).flatMap(([key, value]) => [string(key), u32(4), u32(value)])]);
}
