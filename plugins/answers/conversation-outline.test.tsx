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
