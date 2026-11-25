// Fake `bb` CLI for the shim's Machine Slots calls: FAKE_SLOTS picks the scenario, FAKE_SLOTS_LOG records every call.
import {appendFileSync,readFileSync} from 'node:fs';
const [,, , command, ...rest] = process.argv, log = process.env.FAKE_SLOTS_LOG, mode = process.env.FAKE_SLOTS;
const record = entry => appendFileSync(log, JSON.stringify(entry) + '\n');
const print = (value, code = 0) => { process.stdout.write(JSON.stringify(value) + '\n'); process.exit(code); };
const leased = {ok: true, data: {kind: 'leased', useId: 'use-1', lease: {id: 'lease-1', device: 'box2'}}};
record({command, args: rest});
if (command !== 'acquire') print({ok: true, data: {}});
const acquires = readFileSync(log, 'utf8').split('\n').filter(line => line.includes('"acquire"')).length;
if (mode === 'down') print({ok: false, error: {code: 'internal', message: 'Slots down'}}, 1);
if (mode === 'timeout' && acquires <= 2) print({ok: false, error: {code: 'timeout', message: 'still queued at position 1'}}, 75);
if (mode === 'slow') setTimeout(() => print(leased), 1600);
else if (mode === 'hang' || mode === 'race') {
  process.on('SIGTERM', () => { record({command: 'sigterm'}); mode === 'race' ? print(leased) : print({ok: false, error: {code: 'not-found', message: 'canceled'}}, 1); });
  setInterval(() => {}, 1000);
} else print(leased);
