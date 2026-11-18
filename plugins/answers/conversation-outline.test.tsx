// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent} from '@testing-library/react';
import {renderSlot} from '@get-bb/plugin-sdk/testing/app';
import {ConversationOutline} from './conversation-outline';
afterEach(cleanup);
it('loads the owner outline only when opened and jumps to its message sequence', async () => {
  const conversationOutline=vi.fn(async()=>({items:[{id:'thr_example:user-seed:5',role:'user',preview:'First question'},{id:'thr_example:user-seed:9',role:'user',preview:'Next question'}],maxSeq:9})), onJump=vi.fn();
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump},{sdk:{threads:{conversationOutline}}} as any);
  expect(conversationOutline).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button',{name:'Thread table of contents'}));
  fireEvent.click(await slot.findByRole('button',{name:'First question'}));
  expect(onJump).toHaveBeenCalledWith(5);
  expect(slot.queryByRole('dialog')).toBeNull();
});
it('shows each entry as one plain line and names another agent as the sender', async () => {
  const conversationOutline=vi.fn(async()=>({items:[{id:'thr_example:user-seed:2',role:'user',preview:'# **Plan** for the week\nmore'},{id:'thr_example:user-seed:3',role:'user',preview:'> quoted\n\nmy reply'},{id:'thr_example:user-seed:4',role:'user',preview:'[bb message from thread:thr_sender] Review done'},{id:'thr_example:user-seed:6',role:'user',preview:'[bb system]\n\n@thread:thr_sender completed:'}],maxSeq:4}));
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump:()=>{}},{sdk:{threads:{conversationOutline}},sidebarThreads:{threads:[{id:'thr_sender',title:'Manager'}],projects:[]}} as any);
  fireEvent.click(slot.getByRole('button',{name:'Thread table of contents'}));
  for (const name of ['Plan for the week','my reply','Manager: Review done','bb: Manager completed:']) expect(await slot.findByRole('button',{name})).toBeTruthy();
});
it('names the outline button in a hover tooltip', () => {
  const slot=renderSlot({component:ConversationOutline},{threadId:'thr_example',onJump:()=>{}},{sdk:{threads:{conversationOutline:vi.fn()}}} as any);
  expect(slot.getByRole('button',{name:'Thread table of contents'}).getAttribute('title')).toBe('Table of contents');
});
