// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { ChatComment, COMMENT_EVENT } from './chat-comment';
afterEach(cleanup);
it('subscribes to the sidebar only while a comment popup is open', async () => {
  const slot = renderSlot({ component: ChatComment }, {}, { sidebarThreads: { threads: [], projects: [] } } as any);
  expect(slot.queryByRole('dialog')).toBeNull();
  await act(async () => { window.dispatchEvent(new CustomEvent(COMMENT_EVENT, { detail: { quote: 'q', threadId: 'thr_one', composer: {}, top: 0, left: 0 } })); });
  expect(slot.getByRole('dialog', { name:'Comment on chat selection' })).toBeTruthy();
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape' })); });
  expect(slot.queryByRole('dialog')).toBeNull();
});
