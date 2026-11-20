// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { ItemCard, InlineCommentText, UpdateGroup, UserText, unlabel } from './app';
import { Inbox } from './inbox';
import { PendingInteractions, QuestionForm } from './interactions';
import { ComposerThread } from './rich-editor';
import { itemSchema } from './contract';
const base = itemSchema.parse({snoozedUntil:null,failedAt:null,likelyInterim:false,options:null,taskKey:null,
  id: 'ans_one', kind: 'mine', threadId: 'thr_one', projectId: 'pr_one', threadTitle: 'A thread', projectName: 'A project', status: 'answered', question: 'What changed?', questionSeq: 10,
  requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: 'The answer', answerSeq: 20, answerSource: 'turn', resolveTurnId: null, note: null, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: Date.now(), updatedAt: Date.now(),
});
const item = { ...base, id:'ans_inline', threadId:'thr_inline', question:'/optimize this /tmp/x' };
const commands = [{ name:'optimize', source:'skill', origin:'user', description:null, argumentHint:null }, { name:'reload', source:'command', origin:'builtin', description:null, argumentHint:null }];
const sdk = { threads: { get: async () => ({ id:'thr_inline', projectId:'p', environmentId:'e', providerId:'codex' }), queuedMessages:{ list:async () => [] }, context:async () => ({ usage:null }) }, projects:{ commands:async () => ({ commands }) } };
afterEach(() => { cleanup(); localStorage.clear(); });
async function pills(slot: ReturnType<typeof renderSlot>, count = 1) {
  await waitFor(() => expect(slot.container.querySelectorAll('[aria-label="command: optimize"]')).toHaveLength(count));
  expect(slot.container.querySelector('[aria-label="command: tmp/x"]')).toBeNull();
}
it.each(['bubble', 'echo', 'owner reply'] as const)('draws known commands in the %s and keeps paths plain', async site => {
  const slot = renderSlot({ component:ItemCard }, { item:site === 'owner reply' ? { ...item, kind:'for_me', status:'replied', answer:item.question } : item, ...(site === 'echo' ? { part:'answer' } : {}) }, { sdk } as any);
  await pills(slot); expect(slot.container.textContent).toContain('/tmp/x');
  expect(slot.container.querySelector('[aria-label="command: optimize"] [data-icon="Zap"]')).toBeTruthy();
});
it.each(['passage', 'comment'])('draws inline tokens in an inline %s', async site => {
  const text = site === 'quote' ? '> /optimize this /tmp/x' : `@short\nContext for @short (resolved by plugin "inline-comments"):\n\nThe user attached this passage from the conversation to their message:\n\n> ${site === 'passage' ? '/optimize this /tmp/x' : 'Passage'}\n\nTheir comment on it: ${site === 'comment' ? '/optimize this /tmp/x' : 'Comment'}`;
  const slot = renderSlot({ component:InlineCommentText }, { text, threadId:'thr_inline' }, { sdk } as any); await pills(slot);
});
it('routes background preview mentions through Markdown and keeps the two-line clamp', () => {
  const slot = renderSlot({ component:UpdateGroup }, { items:[{ ...item, answer:'See @thread:thr_other_name#msg=4 and [docs](https://example.com)' }], children:() => null }, { sdk } as any);
  const preview = slot.container.querySelector('[data-update-group] p > span')!;
  expect(preview.className).toContain('line-clamp-2');
  expect(preview.querySelector('[data-testid="bb-markdown"]')?.textContent).toBe('@thread:thr_other_name#msg=4');
  expect(preview.querySelectorAll('[data-testid="bb-markdown"]')).toHaveLength(2);
});
it('uses thread context and preserves plain owner formatting, unknown names and command boundaries', async () => {
  const slot = renderSlot({ component:() => <ComposerThread.Provider value="thr_inline"><UserText text={'**plain** /optimize /unknown /tmp/x /optimize/path\n$reload'} /></ComposerThread.Provider> }, {}, { sdk } as any);
  await pills(slot); expect(slot.container.querySelector('[aria-label="command: reload"]')).toBeTruthy();
  expect(slot.container.textContent).toContain('**plain**'); expect(slot.container.querySelector('strong')).toBeNull();
});
it('shows a pasted message URL as a message mention, not the whole thread', async () => {
  const slot = renderSlot({ component:() => <UserText text={'see https://bb.example/projects/proj_example/threads/thr_example?msg=5 now'} /> }, {}, { sdk } as any);
  await waitFor(() => expect(slot.container.querySelector('[data-testid="bb-markdown"]')?.textContent).toBe('@thread:thr_example#msg=5'));
});
it('hides HTML comment markers other plugins embed in message text', async () => {
  const slot = renderSlot({ component:() => <UserText text={'<!-- work-board-task:EXA-1 -->\nPick up the task'} /> }, {}, { sdk } as any);
  await waitFor(() => expect(slot.container.textContent).toBe('Pick up the task'));
});
it('draws commands in question form prompts and choices without an ambient thread', async () => {
  const slot = renderSlot({ component:QuestionForm }, { threadId:'thr_inline', questions:[{ id:'q', prompt:'/optimize this /tmp/x', required:true, multiSelect:false, allowFreeText:true, options:[{ value:'a', label:'/optimize option', description:'/optimize description' }] }], onSubmit:async () => {} }, { sdk } as any);
  await pills(slot, 3);
});
it('draws commands in pending interaction rows using their own thread', async () => {
  const slot = renderSlot({ component:PendingInteractions }, { threadId:'thr_inline', pending:true, shared:[{ id:'pending', status:'pending', payload:{ kind:'test/notice', title:'/optimize this /tmp/x', data:null } }] as any }, { sdk } as any);
  await pills(slot);
});
it.each(['owed'])('draws commands in the %s preview', async site => {
  const row = { id:'q1', threadId:'thr_inline', content:[{ type:'text', text:'/optimize this /tmp/x', mentions:[] }], updatedAt:1 };
  const slot = renderSlot({ component:Inbox }, {}, { rpc:{ recipients:() => ({ recipients:[{ threadId:'thr_inline', projectId:'p', threadTitle:'Inline', unread:1, lastAt:1, preview:'Done' }] }), list:() => ({ items:[item], nextCursor:null }), owed:() => ({ items:site === 'owed' ? [{ id:'old', question:item.question, createdAt:1, interim:false }] : [] }) }, sdk:{ ...sdk, threads:{ ...sdk.threads, queuedMessages:{ list:async () => site === 'queue' ? [row] : [] } } } } as any);
  fireEvent.click(await slot.findByRole('option'));
  const preview = site === 'queue' ? await waitFor(() => { const el = slot.container.querySelector('[data-queue-row]'); expect(el).toBeTruthy(); return el!; }) : await slot.findByRole('region', { name:'Answers owed' });
  await waitFor(() => expect(preview.querySelector('[aria-label="command: optimize"]')).toBeTruthy());
});

it('draws inline tokens in elicitation messages, warnings and descriptions', async () => {
  const slot = renderSlot({ component:PendingInteractions }, { threadId:'thr_inline', pending:true, shared:[{ id:'pending', status:'pending', payload:{ kind:'provider-codex/mcp-elicitation', title:'Permission', data:{ message:'/optimize message', warning:'/optimize warning', toolDescription:'/optimize description' } } }] as any }, { sdk } as any);
  await pills(slot, 3);
});
it('draws thread mentions in a deferred answer note', () => {
  const slot = renderSlot({ component:ItemCard }, { item:{ ...base, status:'deferred', answer:null, answerSeq:null, note:'Worker @thread:thr_worker is on it' } }, { sdk } as any);
  expect(Array.from(slot.container.querySelectorAll('[data-testid="bb-markdown"]')).map(m => m.textContent)).toContain('@thread:thr_worker');
});
it('keeps Markdown in queue rows and quoted text, as bb renders them', async () => {
  const text = '**EXA-1 · READY** from a lead';
  const row = { id:'q1', threadId:'thr_inline', content:[{ type:'text', text, mentions:[] }], updatedAt:1 };
  const slot = renderSlot({ component:Inbox }, {}, { rpc:{ recipients:() => ({ recipients:[{ threadId:'thr_inline', projectId:'p', threadTitle:'Inline', unread:1, lastAt:1, preview:'Done' }] }), list:() => ({ items:[item], nextCursor:null }), owed:() => ({ items:[] }) }, sdk:{ ...sdk, threads:{ ...sdk.threads, queuedMessages:{ list:async () => [row] } } } } as any);
  fireEvent.click(await slot.findByRole('option'));
  await waitFor(() => expect(slot.container.querySelector('[data-queue-row] [data-testid="bb-markdown"]')?.textContent).toBe(text));
  const quote = renderSlot({ component:InlineCommentText }, { text:'> **bold** quote\n\nreply', threadId:'thr_inline' }, { sdk } as any);
  expect(quote.container.querySelector('[data-testid="bb-markdown"]')?.textContent).toBe('**bold** quote');
});
it('keeps the card end in place when the group closes from its bottom bar, and the header when it closes from the top', () => {
  const items = [{ ...item, id:'ans_a', answer:'First' }, { ...item, id:'ans_b', answer:'Second' }];
  const slot = renderSlot({ component:() => <div data-scroll style={{ overflowY:'auto' }}><ul><UpdateGroup items={items}>{i => <li>{i.answer}</li>}</UpdateGroup></ul></div> }, {}, { sdk } as any);
  const box = slot.container.querySelector<HTMLElement>('[data-scroll]')!, row = slot.container.querySelector<HTMLElement>('[data-update-group]')!;
  const toggle = slot.getByRole('button', { name:/2 background updates/ });
  fireEvent.click(toggle); box.scrollTop = 1000;
  // Open, the card ends at 900; closed, it would end at 500 unless the view follows it.
  row.getBoundingClientRect = () => ({ bottom: toggle.getAttribute('aria-expanded') === 'true' ? 900 : 500 } as DOMRect);
  fireEvent.click(slot.getByRole('button', { name:'Collapse background updates' }));
  expect(toggle.getAttribute('aria-expanded')).toBe('false'); expect(box.scrollTop).toBe(600);
  fireEvent.click(toggle); box.scrollTop = 1000; fireEvent.click(toggle);
  expect(box.scrollTop).toBe(1000);
});
it('renders a quoted plugin or thread message through the agent text\'s Markdown, without bb\'s header', async () => {
  const question = '[bb message from plugin:example-plugin]\n\n## Title\n\n**bold** and `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |';
  const update = { ...item, id:'ans_fmt', kind:'update' as const, status:'answered' as const, question, questionSeq:null, answer:'Done', trigger:{ kind:'plugin' as const, sourceId:'example-plugin', sourceTitle:null } } as any;
  const slot = renderSlot({ component:ItemCard }, { item:update, chat:true }, { sdk } as any);
  // The test host draws Markdown as its source; the quote and the agent's reply share one renderer.
  const quote = await waitFor(() => { const node = slot.container.querySelector('[data-agent-message] [data-testid="bb-markdown"]'); expect(node).toBeTruthy(); return node!; });
  expect(quote.textContent).toBe(question.replace('[bb message from plugin:example-plugin]\n\n', ''));
  expect(slot.container.querySelector('[data-agent-body] [data-testid="bb-markdown"]')?.parentElement?.className).toBe(quote.parentElement?.className);
});
it('drops a sender\'s own leading [tag] from the quote but keeps task keys, links and checkboxes', () => {
  expect(unlabel('[bb message from thread:thr_example]\n\n[Agent Hub] A request')).toBe('A request');
  expect(unlabel('[example-plugin] Done')).toBe('Done');
  expect(unlabel('[EXA-1] landed')).toBe('[EXA-1] landed');
  expect(unlabel('[EXA-1](/plugins/work-board/work-board/task/EXA-1) ready')).toBe('[EXA-1](/plugins/work-board/work-board/task/EXA-1) ready');
  expect(unlabel('[x] done')).toBe('[x] done');
});
it('previews the quoted message of a background update that has no reply yet', () => {
  const plugin = { ...item, id:'ans_noreply', kind:'update' as const, status:'answered' as const, question:'[bb message from plugin:work-board]\n\n`New comment` on EXA-1', answer:null, answerSeq:null, trigger:{ kind:'plugin' as const, sourceId:'work-board', sourceTitle:null } } as any;
  const slot = renderSlot({ component:UpdateGroup }, { items:[{ ...plugin, id:'ans_first', answer:'Earlier' }, plugin], children:(i: any) => <ItemCard item={i} chat /> }, { sdk } as any);
  expect(slot.container.querySelector('[data-update-group]')?.textContent).toContain('New comment on EXA-1');
});
it('previews a bb notice in a background update that has no reply yet', () => {
  const notice = { ...item, id:'ans_notice', kind:'update' as const, status:'answered' as const, question:'[bb system]\n\n@thread:thr_example completed:\n\nAPPROVE v2', answer:'', answerSeq:null, trigger:{ kind:'system' as const, sourceId:null, sourceTitle:null } } as any;
  const slot = renderSlot({ component:UpdateGroup }, { items:[{ ...notice, id:'ans_first', answer:'Earlier' }, notice], children:(i: any) => <ItemCard item={i} chat /> }, { sdk } as any);
  expect(slot.container.querySelector('[data-update-group] p')?.textContent).toContain('APPROVE v2');
});
it('gives a message with no reply of its own only its expand and link icons, without the More menu', () => {
  const update = { ...item, id:'ans_bare', kind:'update' as const, status:'answered' as const, question:'[bb message from plugin:example-plugin]\n\nNotice', answer:null, answerSeq:null, trigger:{ kind:'plugin' as const, sourceId:'example-plugin', sourceTitle:null } } as any;
  const slot = renderSlot({ component:ItemCard }, { item:update, chat:true }, { sdk } as any);
  expect(slot.getByRole('button', { name:'Copy link' })).toBeTruthy();
  expect(slot.queryByRole('button', { name:'More' })).toBeNull();
  const replied = renderSlot({ component:ItemCard }, { item:{ ...update, id:'ans_replied', answer:'Done', answerSeq:7 }, chat:true }, { sdk } as any);
  expect(replied.getByRole('button', { name:'More' })).toBeTruthy();
});
it('gives an open background updates group the side inset the chat list has, for quotes and bled-out tables alike', () => {
  const plugin = { ...item, id:'ans_plugin', kind:'update' as const, status:'answered' as const, question:'**EXA-1 · READY** from a lead', trigger:{ kind:'plugin' as const, sourceId:'work-board', label:null } } as any;
  const slot = renderSlot({ component:UpdateGroup }, { items:[plugin, { ...plugin, id:'ans_plugin2' }], children:(i: any) => <ItemCard item={i} chat /> }, { sdk } as any);
  fireEvent.click(slot.getByRole('button', { name:/2 background updates/ }));
  const list = slot.container.querySelector('[data-update-group] ul')!;
  expect(list.querySelector('[data-agent-message]')).toBeTruthy();
  expect(list.className.split(' ')).toEqual(expect.arrayContaining(['px-2', '[&_[data-bubble-row]]:mr-2', '@container']));
});
it('gives every field on the Agent Hub page 16px text on touch screens, so iOS does not zoom in on focus', async () => {
  const { AgentHubPanel } = await import('./app');
  const slot = renderSlot({ component:AgentHubPanel }, {}, { sdk, rpc:{ recipients:() => ({ recipients:[] }), list:() => ({ items:[], nextCursor:null }), counts:() => ({ unread:0, waiting:0, forMe:0, inbox:0 }) } } as any);
  expect(slot.container.querySelector('section')!.className).toContain('[@media(pointer:coarse)]:[&_:is(input,textarea,select,[contenteditable=true])]:text-[16px]');
});
