import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command } from './runner.ts';
const result = await command(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xd0]));setTimeout(()=>process.stdout.write(Buffer.from([0x96])),30)'], process.cwd(), new AbortController().signal);
assert.equal(result.output, 'Ж');
await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), new AbortController().signal, 50), /timed out/);

if (process.platform !== 'win32') {
  const checkout = await mkdtemp(join(tmpdir(), 'sweep-lock-'));
  const lock = join(checkout, 'shallow.lock');
  const timeOut = script => assert.rejects(
    command(process.execPath, ['-e', script], checkout, new AbortController().signal, 1000, process.env, lock),
    /timed out/,
  );
  const hang = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
  try {
    await timeOut(`require('node:fs').writeFileSync('shallow.lock', 'new'); ${hang}`);
    await assert.rejects(readFile(lock), { code: 'ENOENT' });
    await writeFile(lock, 'existing');
    await timeOut(hang);
    assert.equal(await readFile(lock, 'utf8'), 'existing');
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
