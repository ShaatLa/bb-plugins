import { strict as assert } from 'node:assert';
import { command } from './runner.ts';
const result = await command(process.execPath, ['-e', 'process.stdout.write(Buffer.from([0xd0]));setTimeout(()=>process.stdout.write(Buffer.from([0x96])),30)'], process.cwd(), new AbortController().signal);
assert.equal(result.output, 'Ж');
await assert.rejects(command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], process.cwd(), new AbortController().signal, 50), /timed out/);
