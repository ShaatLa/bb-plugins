// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_copyToClipboard: vi.fn(async () => true) }));
import { experimental_copyToClipboard } from '@get-bb/plugin-sdk/app';
import { loadPluginApp, renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { itemSchema, NOTICE_THREAD, type Item } from './contract';

afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); });
const now = Date.now();
const notice = (over: Partial<Item> = {}): Item => itemSchema.parse({
  id: 'ans_notice', kind: 'update', threadId: NOTICE_THREAD, projectId: 'proj_example', threadTitle: null, projectName: 'Example project', status: 'answered', question: 'Check report',
  questionSeq: null, requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: 'Preview of the report', answerSeq: null, answerSource: 'agent', resolveTurnId: null, note: null,
  snoozedUntil: null, failedAt: null, likelyInterim: false, options: null, taskKey: null, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: now, updatedAt: now, asks: true,
  trigger: { kind: 'plugin', sourceId: 'example-plugin', sourceTitle: null }, notice: { source: 'example-plugin', managerThreadId: 'thr_manager', bytes: 90000, truncated: true }, ...over,
});

async function stack(items: Item[]) {
  localStorage.setItem('bb-plugin-answers:page:questions', 'true');
  const app = await loadPluginApp(() => import('./app'));
  const noticeBody = vi.fn(() => ({ markdown: 'The FULL report' })), markRead = vi.fn(() => ({ ok: true }));
  const slot = renderSlot(app.navPanels[0]!, { subPath: '' }, { rpc: {
    recipients: () => ({ recipients: [] }), noticeBody, markRead, counts: () => ({ unread: items.length, waiting: 0, forMe: 0, inbox: items.length }),
    list: (input: any) => ({ items: input.notices ? items : [], nextCursor: null }),
  } });
  await waitFor(() => expect(slot.container.querySelector('section[aria-label="Check report"]')).toBeTruthy());
  return { slot, noticeBody, markRead };
}

describe('notices in the Questions section', () => {
  it('lists a thread-less notice with its project and sender, and links to no thread', async () => {
    const { slot } = await stack([notice()]);
    expect(slot.getByText(/Example project · Report from example-plugin/)).toBeTruthy();
    expect(slot.queryByRole('link', { name: 'Open thread' })).toBeNull();
    expect(slot.queryByRole('link', { name: /Open in/ })).toBeNull();
    expect(slot.queryByRole('button', { name: 'Copy link' })).toBeNull();
    expect(slot.getByRole('link', { name: 'Intended manager' }).getAttribute('href')).toBe('/projects/proj_example/threads/thr_manager');
    expect(slot.getByRole('button', { name: /^Questions/ }).textContent).toContain('1');
  });

  it('lists a threaded notice with a link to its thread', async () => {
    const { slot } = await stack([notice({ threadId: 'thr_manager' })]);
    expect(slot.getByRole('link', { name: 'Open thread' })).toBeTruthy();
    expect(slot.queryByRole('link', { name: 'Intended manager' })).toBeNull();
  });

  it('loads the full report only when asked, and copies it then', async () => {
    const { slot, noticeBody } = await stack([notice()]);
    expect(noticeBody).not.toHaveBeenCalled();
    expect(slot.getByText('Preview of the report')).toBeTruthy();
    fireEvent.click(slot.getByRole('button', { name: 'Show full report' }));
    await slot.findByText('The FULL report');
    expect(noticeBody).toHaveBeenCalledTimes(1);
    expect(noticeBody.mock.calls[0]).toEqual([{ id: 'ans_notice' }]);
    expect(slot.queryByRole('button', { name: 'Show full report' })).toBeNull();
    fireEvent.click(slot.getByRole('button', { name: 'Copy' }));
    expect(experimental_copyToClipboard).toHaveBeenCalledWith({ text: 'The FULL report' });
  });

  it('offers no full-report button for a report that fits', async () => {
    const { slot } = await stack([notice({ notice: { source: 'example-plugin', managerThreadId: null, bytes: 20, truncated: false } })]);
    expect(slot.queryByRole('button', { name: 'Show full report' })).toBeNull();
  });

  it('marks it handled with Mark read', async () => {
    const { slot, markRead } = await stack([notice()]);
    fireEvent.click(slot.getByRole('button', { name: 'Mark read' }));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith({ ids: ['ans_notice'] }));
  });
});

describe('a notice in a chat', () => {
  it('shows the preview and loads the full report on request', async () => {
    const { ItemCard } = await import('./app');
    const noticeBody = vi.fn(() => ({ markdown: 'The FULL report' }));
    const slot = renderSlot({ component: () => <ul><ItemCard item={notice({ threadId: 'thr_manager' })} chat /></ul> }, {}, { rpc: { noticeBody } } as any);
    expect(slot.getByText('Preview of the report')).toBeTruthy();
    expect(slot.getByText('Check report')).toBeTruthy();
    fireEvent.click(slot.getByRole('button', { name: 'Show full report' }));
    await slot.findByText('The FULL report');
    expect(slot.getAllByRole('button', { name: 'Copy link' }).length).toBeGreaterThan(0);
  });
});
