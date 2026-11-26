import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import Database from 'better-sqlite3';
import plugin from './server';
import { migrations } from './schema';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0)) await dispose(); vi.useRealTimers(); });
function setup() {
  const send = vi.fn(async (_args: unknown) => ({ ok: true as const, delivery: 'queued' as const }));
  const host = createFakePluginHost({ pluginId: 'agent-hub', sdk: { threads: { list: async () => [], get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId: 'p', title: 'T' }), events: { list: async () => [] }, send }, projects: { list: async () => [] } } });
  plugin(host.bb); cleanup.push(() => host.harness.lifecycle.dispose());
  const db = host.bb.storage.database(), { callRpc, callAgentTool } = host.harness.behavior;
  const ask = (id = 'ans_q', thread = 't') => { db.prepare("INSERT INTO items(id,kind,thread_id,status,question,notify_state,created_at,updated_at) VALUES (?,'for_me',?,'open','Which one?',1,1,1)").run(id, thread); return id; };
  const agentList = async (thread = 't') => String(await callAgentTool('agent_hub_list', {}, { threadId: thread }));
  const ownerList = async () => ((await callRpc('list', { view: 'for_me' })) as { items: { id: string; declinedAt: number | null }[] }).items;
  return { ...host, db, send, ask, agentList, ownerList, callRpc, callAgentTool };
}

describe('Won’t reply', () => {
  it('keeps the question open for the owner and the agent, and sends the agent nothing', async () => {
    const { db, send, ask, agentList, ownerList, callRpc } = setup(); const id = ask();
    await callRpc('setDismissed', { id, dismissed: true });
    expect(db.prepare('SELECT status,dismissed_at,declined_at IS NOT NULL AS declined,notify_state FROM items WHERE id=?').get(id)).toEqual({ status: 'open', dismissed_at: null, declined: 1, notify_state: 0 });
    expect((await ownerList()).map(i => [i.id, i.declinedAt !== null])).toEqual([[id, true]]);
    expect(await agentList()).toContain(`Your open questions to the user:\n${id} `);
    expect(send).not.toHaveBeenCalled();
  });
  it('does the same for a multi-part form and for a sub-thread’s Agent Hub question', async () => {
    const { db, ask, agentList, ownerList, callRpc } = setup(); const form = ask('ans_form');
    db.prepare("UPDATE items SET questions='[{\"id\":\"q1\",\"prompt\":\"A?\",\"multiSelect\":false,\"allowFreeText\":true,\"required\":true},{\"id\":\"q2\",\"prompt\":\"B?\",\"multiSelect\":false,\"allowFreeText\":true,\"required\":true}]' WHERE id=?").run(form);
    db.prepare("INSERT INTO sub_threads VALUES ('sub')").run(); const sub = ask('ans_sub', 'sub');
    await callRpc('setDismissed', { id: form, dismissed: true }); await callRpc('setDismissed', { id: sub, dismissed: true });
    expect((await ownerList()).map(i => i.id).sort()).toEqual([form, sub]);
    expect(await agentList()).toContain(form); expect(await agentList('sub')).toContain(sub);
  });
  it('leaves the attention list, the unread view and both counts', async () => {
    const { ask, callRpc } = setup(); const id = ask();
    expect(await callRpc('counts', {})).toMatchObject({ inbox: 1, forMe: 1 });
    await callRpc('setDismissed', { id, dismissed: true });
    expect(await callRpc('counts', {})).toMatchObject({ inbox: 0, forMe: 0 });
    expect(((await callRpc('list', { view: 'unread' })) as { items: unknown[] }).items).toEqual([]);
  });
  it('gets no reminder', async () => {
    vi.useFakeTimers(); const { db, ask, callRpc } = setup(); const id = ask(); db.prepare("UPDATE items SET urgency='blocking',created_at=? WHERE id=?").run(Date.now() - 7200000, id);
    await callRpc('setDismissed', { id, dismissed: true }); await callRpc('updatePreferences', { remindHours: 1 }); await vi.advanceTimersByTimeAsync(5000);
    expect(db.prepare('SELECT notify_state,reminders FROM items WHERE id=?').get(id)).toEqual({ notify_state: 0, reminders: 0 });
  });
  it('comes back when the agent adds a part to it, or when the owner snoozes it', async () => {
    vi.useFakeTimers();
    const { harness, db, ask, callRpc, callAgentTool } = setup(); const id = ask(); db.prepare('UPDATE items SET notify_state=0').run(); const push = vi.fn(async () => ({ channels: ['mobile'] })); harness.sdk.stub('plugins.callRpc', push as any); db.prepare("INSERT INTO threads_state(thread_id,last_seq,updated_at,active_turn_id) VALUES ('t',0,1,'turn')").run(); db.prepare("UPDATE items SET turn_id='turn' WHERE id=?").run(id);
    await callRpc('setDismissed', { id, dismissed: true });
    expect(await callRpc('counts', {})).toMatchObject({ inbox: 0 });
    await callAgentTool('agent_hub_ask', { question: 'And this?' }, { threadId: 't' });
    expect(db.prepare('SELECT declined_at FROM items WHERE id=?').get(id)).toEqual({ declined_at: null }); await vi.advanceTimersByTimeAsync(11000); expect(push).toHaveBeenCalledTimes(1);
    expect(await callRpc('counts', {})).toMatchObject({ inbox: 1 });
    await callRpc('setDismissed', { id, dismissed: true }); await callRpc('snooze', { id, until: Date.now() + 3600000 });
    expect(db.prepare('SELECT declined_at FROM items WHERE id=?').get(id)).toEqual({ declined_at: null });
  });
  it('stops marking a sub-thread as asking once its question is declined', async () => {
    const { db, ask, callRpc } = setup(); db.prepare("INSERT INTO sub_threads VALUES ('sub')").run(); const id = ask('ans_sub', 'sub');
    expect(((await callRpc('recipients', {})) as { asking: string[] }).asking).toEqual(['sub']);
    await callRpc('setDismissed', { id, dismissed: true });
    expect(((await callRpc('recipients', {})) as { asking: string[] }).asking).toEqual([]);
  });
  it('keeps a declined question in the owner’s Questions list, and drops answered and withdrawn ones', async () => {
    const { ask, ownerList, callRpc, callAgentTool } = setup();
    const open = ask('ans_open'), declined = ask('ans_declined'), answered = ask('ans_answered'), withdrawn = ask('ans_withdrawn');
    await callRpc('setDismissed', { id: declined, dismissed: true });
    await callRpc('reply', { id: answered, text: 'Yes' });
    await callAgentTool('agent_hub_withdraw', { id: withdrawn, reason: 'Found it' }, { threadId: 't' });
    expect((await ownerList()).map(i => i.id).sort()).toEqual([declined, open]);
    expect(await callRpc('counts', {})).toMatchObject({ forMe: 1 });
  });
  it('lists only answerable questions when asked, so declined ones cannot fill the page', async () => {
    const { db, ask, callRpc } = setup(); const old = ask('ans_old');
    for (let i = 0; i < 60; i++) { const id = ask(`ans_d${i}`); db.prepare('UPDATE items SET declined_at=1,created_at=? WHERE id=?').run(100 + i, id); }
    const page = (await callRpc('list', { view: 'for_me', threadId: 't', limit: 50, answerable: true })) as { items: { id: string }[] };
    expect(page.items.map(i => i.id)).toEqual([old]);
  });
  it('lets the agent withdraw a declined question', async () => {
    const { db, ask, agentList, callRpc, callAgentTool } = setup(); const id = ask(); await callRpc('setDismissed', { id, dismissed: true });
    expect(await callAgentTool('agent_hub_withdraw', { id, reason: 'Found it' }, { threadId: 't' })).toBe('Withdrawn.');
    expect(await agentList()).not.toContain(id); expect(db.prepare('SELECT dismissed_at IS NOT NULL AS gone,answer_source FROM items WHERE id=?').get(id)).toEqual({ gone: 1, answer_source: 'agent' });
  });
  it('still closes a question Agent Hub only caught in the agent’s chat text as “Not a question”', async () => {
    const { db, send, ask, callRpc } = setup(); const id = ask(); db.prepare('UPDATE items SET chat_asked=1 WHERE id=?').run(id);
    await callRpc('setDismissed', { id, dismissed: true });
    expect(send).not.toHaveBeenCalled(); expect(db.prepare('SELECT dismissed_at IS NOT NULL AS gone,declined_at FROM items WHERE id=?').get(id)).toEqual({ gone: 1, declined_at: null });
  });
  it('keeps a snoozed open question in the Questions view and in the agent’s own list', async () => {
    const { db, ask, agentList, ownerList } = setup(); const id = ask(); db.prepare('UPDATE items SET snoozed_until=? WHERE id=?').run(Date.now() + 3600000, id);
    expect((await ownerList()).map(i => i.id)).toEqual([id]); expect(await agentList()).toContain(id);
  });
});

describe('questions the owner dismissed before this release', () => {
  it('close as withdrawn with a reason, and withdrawals and chat-asked ones stay as they were', () => {
    const db = new Database(':memory:'), at = migrations.findIndex(m => m.includes('ADD COLUMN declined_at')); db.exec(migrations.slice(0, at).join('\n'));
    const add = (id: string, column: string, value: string) => db.prepare(`INSERT INTO items(id,kind,thread_id,status,question,dismissed_at,${column},created_at,updated_at) VALUES (?,'for_me','t','open','Q?',5,${value},1,1)`).run(id);
    add('owner', 'answer_source', 'NULL'); add('agent', 'answer_source', "'agent'"); add('chat', 'chat_asked', '1');
    db.prepare("UPDATE items SET note='Found it' WHERE id='agent'").run();
    db.exec(migrations[at]!);
    const rows = db.prepare('SELECT id,status,answer_source,dismissed_at,note FROM items ORDER BY id').all() as { id: string; note: string | null }[];
    expect(rows.find(r => r.id === 'owner')).toMatchObject({ status: 'open', answer_source: 'agent', dismissed_at: 5 }); expect(rows.find(r => r.id === 'owner')!.note).toMatch(/Won’t reply/);
    expect(rows.find(r => r.id === 'agent')).toMatchObject({ answer_source: 'agent', note: 'Found it' }); expect(rows.find(r => r.id === 'chat')).toMatchObject({ answer_source: null, note: null });
    expect(db.prepare('SELECT declined_at FROM items LIMIT 1').get()).toEqual({ declined_at: null });
  });
});
