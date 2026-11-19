import { afterEach, expect, it } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin, { INSTRUCTIONS } from './server';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const f of cleanup.splice(0)) await f();});
function setup() {
 const host = createFakePluginHost({pluginId: 'agent-hub', sdk: {threads: {list: async () => [], get: async ({threadId}) => makeThreadResponse({id: threadId, projectId: 'p'}), events: {list: async () => []}, send: async () => ({ok: true as const, delivery: 'sent' as const})}, projects: {list: async () => []}}});
 plugin(host.bb); cleanup.push(() => host.harness.lifecycle.dispose());
 const db = host.bb.storage.database();
 const call = (name: string, p: object = {}, threadId = 't') => host.harness.behavior.callAgentTool(name, p, {threadId, projectId: 'p'});
 const seed = (id: string, kind: string, status: string, thread = 't') => db.prepare('INSERT INTO items(id,kind,thread_id,status,question,created_at,updated_at) VALUES (?,?,?,?,?,1,1)').run(id, kind, thread, status, 'Question');
 return {...host, db, call, seed};
}
const pair = ['Yes', 'No'];
// Every refusal below must say what to change, so each case lists the field and a word of the fix.
it.each([
 ['no question and no questions', {}, /question: question is required for a single question: add question, or pass questions/],
 ['reason without recommended', {question: 'Pick', options: pair, reason: 'cheaper'}, /reason: reason explains the recommended option; add recommended \(equal to one of options\) or drop reason/],
 ['recommended not in options', {question: 'Pick', options: pair, recommended: 'Maybe'}, /recommended: recommended must equal one of options exactly.*add it to options/],
 ['recommended without options', {question: 'Pick', recommended: 'Yes'}, /recommended: recommended needs options; add options/],
 ['multiSelect without options', {question: 'Pick', multiSelect: true}, /multiSelect: multiSelect needs options to tick; add options or drop multiSelect/],
 ['empty options', {question: 'Pick', options: []}, /options: options is empty; give 1–6 options or leave options out/],
 ['seven options', {question: 'Pick', options: Array.from({length: 7}, (_, i) => 'o' + i)}, /options: options has more than 6 entries; keep at most 6/],
 ['long option', {question: 'Pick', options: ['x'.repeat(201)]}, /an option is longer than 200 characters; shorten it/],
 ['duplicate options', {question: 'Pick', options: ['a', ' a ']}, /options must be unique after trimming; remove the duplicate/],
 ['deadline without recommended', {question: 'Pick', options: pair, deadlineMinutes: 30}, /deadlineMinutes: deadlineMinutes on a single question needs recommended .*add recommended, drop deadlineMinutes, or use questions/],
 ['deadline out of range', {question: 'Pick', options: pair, recommended: 'Yes', deadlineMinutes: 2}, /deadlineMinutes: deadlineMinutes must be an integer from 5 to 10080/],
 ['top-level options with questions', {questions: [{question: 'A'}, {question: 'B'}], options: pair}, /questions: with questions, put options, multiSelect and recommended on each part/],
 ['one part', {questions: [{question: 'A'}]}, /questions needs 2–10 parts; for one question pass question instead/],
 ['part without question', {questions: [{header: 'A'}, {question: 'B'}]}, /questions\.0\.question: each part needs a question/],
 ['part recommended not in options', {questions: [{question: 'A', options: pair, recommended: 'Maybe'}, {question: 'B'}]}, /questions\.0\.recommended: recommended must equal one of this part’s options exactly/],
 ['unknown field', {question: 'Pick', title: 'x'}, /unknown field "title"; agent_hub_ask accepts urgency, deadlineMinutes, question/],
])('agent_hub_ask refuses %s and names the fix', async (_name, input, message) => {
 const {call} = setup(); await expect(call('agent_hub_ask', input)).rejects.toThrow(message);
});
it('agent_hub_ask takes questions without a top-level question and uses question only as the form title', async () => {
 const {call, db} = setup();
 const id = await call('agent_hub_ask', {questions: [{question: 'Which database?', header: 'DB', options: pair}, {question: 'Which cache?'}]});
 expect(db.prepare('SELECT question FROM items WHERE id=?').get(id)).toEqual({question: '1. **DB.** Which database?\n2. Which cache?'});
 const titled = await call('agent_hub_ask', {question: 'Setup', questions: [{question: 'Which database?'}, {question: 'Which cache?'}]}, 'u');
 expect(db.prepare('SELECT question FROM items WHERE id=?').get(titled)).toEqual({question: 'Setup\n\n1. Which database?\n2. Which cache?'});
});
it('merging into a title-less form keeps it title-less', async () => {
 const {call, db} = setup();
 db.prepare("INSERT INTO threads_state(thread_id,last_seq,active_turn_id,updated_at) VALUES ('t',0,'turn',1)").run();
 const id = await call('agent_hub_ask', {questions: [{question: 'A?'}, {question: 'B?'}]});
 await call('agent_hub_ask', {question: 'C?'});
 expect(db.prepare('SELECT question FROM items WHERE id=?').get(id)).toEqual({question: '1. A?\n2. B?\n3. C?'});
});
it('id-taking tools refuse a missing or malformed id with the fix', async () => {
 const {call} = setup();
 await expect(call('agent_hub_resolve', {})).rejects.toThrow(/id: id is required: call agent_hub_list and pass the id of the deferred question/);
 await expect(call('agent_hub_defer', {id: 'x'})).rejects.toThrow(/id: id must be an item id such as ans_… .*agent_hub_list/);
 await expect(call('agent_hub_withdraw', {id: 'ans_a'})).rejects.toThrow(/reason: reason is required: say in a few words why/);
 await expect(call('agent_hub_withdraw', {id: 'ans_a', reason: ' '})).rejects.toThrow(/reason: reason is empty/);
 await expect(call('agent_hub_list', {id: 'ans_a'})).rejects.toThrow(/unknown field "id"; agent_hub_list accepts no arguments/);
});
it('defer and resolve refuse an id that is not pending, answered, foreign or not a user message, and say what to do', async () => {
 const {call, seed, db} = setup(); seed('ans_done', 'mine', 'answered'); seed('ans_foreign', 'mine', 'waiting', 'other'); seed('ans_ask', 'for_me', 'open');
 db.prepare("INSERT INTO threads_state(thread_id,last_seq,active_turn_id,updated_at) VALUES ('t',0,'turn',1)").run();
 for (const method of ['defer', 'resolve']) {
  await expect(call('agent_hub_' + method, {id: 'ans_done'})).rejects.toThrow(/pending question not found: ans_done is already answered; call agent_hub_list/);
  for (const id of ['ans_foreign', 'ans_ask', 'ans_missing']) await expect(call('agent_hub_' + method, {id})).rejects.toThrow(/pending question not found in calling thread; call agent_hub_list.*agent_hub_withdraw/);
 }
 await expect(call('agent_hub_defer', {})).rejects.toThrow(/no waiting message in this thread to defer; if you deferred it earlier, call agent_hub_list/);
});
it('withdraw refuses an answered, withdrawn, foreign or user-message id and says what to do', async () => {
 const {call, seed, db} = setup(); seed('ans_mine', 'mine', 'waiting'); seed('ans_foreign', 'for_me', 'open', 'other'); seed('ans_closed', 'for_me', 'replied');
 await expect(call('agent_hub_withdraw', {id: 'ans_foreign', reason: 'x'})).rejects.toThrow(/open question not found in calling thread; call agent_hub_list and pass an id from "Your open questions to the user"/);
 await expect(call('agent_hub_withdraw', {id: 'ans_mine', reason: 'x'})).rejects.toThrow(/open question not found in calling thread.*agent_hub_resolve/);
 await expect(call('agent_hub_withdraw', {id: 'ans_closed', reason: 'x'})).rejects.toThrow(/already answered or withdrawn, so there is nothing to withdraw; call agent_hub_list/);
 expect(db.prepare("SELECT dismissed_at FROM items WHERE id='ans_foreign'").get()).toEqual({dismissed_at: null});
});
it('keeps the injected instructions short, with must-rules and one neutral tag example', () => {
 expect(INSTRUCTIONS).toMatch(/You must ask the owner a decision with agent_hub_ask/);
 expect(INSTRUCTIONS).toMatch(/you must call agent_hub_report/);
 expect(INSTRUCTIONS).toMatch(/must start the text with a \[tag\], e\.g\. `\[example-watcher\] done`/);
 expect(INSTRUCTIONS).not.toMatch(/\bshould\b/);
});
it('deprecated answers_* aliases carry the agent_hub_* description unchanged, behind a pointer', () => {
 const {harness} = setup(); const tools = harness.inspection.registrations.agentTools;
 for (const m of ['ask', 'report', 'defer', 'list', 'resolve', 'withdraw']) {
  const main = tools.find(t => t.name === 'agent_hub_' + m)!.description, alias = tools.find(t => t.name === 'answers_' + m)!.description;
  expect(alias).toBe(`Deprecated alias of agent_hub_${m}; call agent_hub_${m} instead. ${main}`);
  expect(main).not.toMatch(/\bshould\b/);
 }
});
