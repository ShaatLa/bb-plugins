import { strict as assert } from 'node:assert';
import Database from 'better-sqlite3';
import { deliveryStore } from './delivery.ts';
const db = new Database(':memory:');
const store = deliveryStore(db);
store.stage('p', 'action', Buffer.from('candidate'));
assert.equal(store.read('p').committed, null);
assert.throws(() => store.stage('p', 'lost', null));
assert.equal(store.read('p').pending_message, 'action');
store.acknowledge('p');
assert.equal(store.read('p').committed.toString(), 'candidate');
assert.equal(store.read('p').pending_message, null);
store.stage('p', 'heartbeat', null);
store.acknowledge('p');
assert.equal(store.read('p').committed.toString(), 'candidate');

store.seed('seeded', Buffer.from('{}'));assert.throws(()=>store.seed('seeded', Buffer.from('{}')));store.stage('pending','message',null);assert.throws(()=>store.seed('pending',Buffer.from('{}')));
