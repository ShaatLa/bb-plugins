// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
vi.mock('@get-bb/plugin-sdk/app', () => ({
  experimental_ThreadTitleText: ({ title }: { title: string }) => <span>{title}</span>,
  experimental_Icon: () => <span />,
  experimental_ThreadActionsMenu: vi.fn(({ trigger }) => trigger({ 'data-testid': 'thread-menu' })),
}));
import { experimental_ThreadActionsMenu, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import { ThreadHeader } from './thread-header';
import { threadTarget } from './thread-target';
afterEach(cleanup);
const thread = { id: 'thr_example', title: 'Selected title', parentThreadId: 'thr_parent', environment: { id: 'env_example', path: '/example', name: 'Example' } } as PluginSidebarThread;
const parent = { id: 'thr_parent', title: 'Parent title' } as PluginSidebarThread;
it('renders host title, selects its parent and supplies the shared menu target', () => {
  const onSelect = vi.fn();
  render(<ThreadHeader thread={thread} parent={parent} title="Fallback" onSelect={onSelect} />);
  expect(screen.getByText('Selected title')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Parent title' }));
  expect(onSelect).toHaveBeenCalledWith('thr_parent');
  expect(vi.mocked(experimental_ThreadActionsMenu).mock.calls.at(-1)?.[0].thread).toEqual(threadTarget(thread));
  expect(threadTarget(thread).environment).toEqual({ id: 'env_example', path: '/example' });
  expect(screen.getByRole('button', { name: 'Thread actions' }).dataset.testid).toBe('thread-menu');
});
it('omits the parent link when absent', () => {
  render(<ThreadHeader thread={thread} title="Fallback" onSelect={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /↑/ })).toBeNull();
});
