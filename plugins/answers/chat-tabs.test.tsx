// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { InfoTab, DiffTab, WorkBoardTab } from './chat-tabs';
import { setOpenChat } from './open-chat';

const environment = { id: 'env', name: 'Checkout', path: '/repo', isWorktree: true };
const workspace = { branch: { currentBranch: 'feature', defaultBranch: 'main' }, workingTree: { fileCount: 1, files: [], hasUncommittedChanges: true }, mergeBase: { mergeBaseBranch: 'main', aheadCount: 2, behindCount: 1, fileCount: 7, files: [{ path: 'a.ts', status: 'M', insertions: 3, deletions: 1 }], commits: Array.from({ length: 6 }, (_, i) => ({ sha: `sha${i}`, shortSha: `s${i}`, subject: `Commit ${i}` })) } };
const file = { path: 'a.ts', revision: 'r1', changeKind: 'modified', additions: 3, deletions: 1, binary: false, loadMode: 'auto' };
const patch = { path: 'a.ts', patch: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n', truncated: false };
function setup(component: typeof InfoTab, rpc = {}, extra: Record<string, unknown> = {}) {
  setOpenChat('thr_one', false);
  const get = vi.fn(async ({ threadId }) => ({ id: threadId, title: threadId === 'parent' ? 'Parent chat' : threadId, parentThreadId: threadId === 'parent' ? null : 'parent', projectId: 'project', environmentId: 'env' }));
  const slot = renderSlot({ component }, {}, { sdk: { threads: { get }, environments: { get: async () => environment }, projects: { get: async () => ({ name: 'Project' }) } }, rpc: { status: () => ({ env: { outcome: 'available', workspace } }), files: () => ({ outcome: 'available', files: [file], initialPatches: [patch], truncated: false }), viewed: () => ({ files: [] }), ...rpc }, ...extra } as any);
  return { slot, get };
}
afterEach(() => { cleanup(); setOpenChat(undefined, false); });
it('hands the open chat to separate tab trees and refreshes after completion', async () => {
  const { slot, get } = setup(InfoTab);
  await slot.findByText('feature');
  act(() => setOpenChat('thr_two', true));
  await waitFor(() => expect(get).toHaveBeenCalledWith({ threadId: 'thr_two' }));
  await slot.findByText('feature');
  const before = get.mock.calls.length;
  act(() => setOpenChat('thr_two', false));
  await waitFor(() => expect(get.mock.calls.length).toBeGreaterThan(before));
});
it('shows Info rows and host list expansion from git status', async () => {
  const { slot } = setup(InfoTab);
  await slot.findByText('feature');
  for (const text of ['Parent chat', 'Project', 'Checkout', '/repo', 'Merge base', '2 ahead, 1 behind main, Uncommitted changes', '6 more files not shown']) expect(slot.getAllByText(text).length).toBeGreaterThan(0);
  // The SDK harness delegates list rendering without implementing host expansion.
  expect(slot.getByText('Commit 5').closest('ul')?.getAttribute('data-limit')).toBe('5');

});
it('reads nothing while hidden and shows no-chat state', () => {
  const { slot, get } = setup(InfoTab, {}, { tabVisible: false });
  expect(get).not.toHaveBeenCalled();
  act(() => setOpenChat(undefined, false));
  expect(slot.getByText('No chat open')).toBeTruthy();
});
it.each(['not_applicable', 'unavailable', 'failed'])('fails softly for %s git status', async outcome => {
  const { slot } = setup(InfoTab, { status: () => ({ env: { outcome, message: 'No repository', failure: { message: 'No repository' } } }) });
  await slot.findByText('No repository');
});
it('handles missing environment and unavailable Git RPC', async () => {
  const absent = setup(DiffTab, {}, { sdk: { threads: { get: async () => ({ id: 'thr_one', environmentId: null, projectId: null, parentThreadId: null }) } } });
  await absent.slot.findByText('No environment'); absent.slot.unmount();
  const { slot } = setup(InfoTab, { status: () => { throw new Error('Git unavailable'); } });
  await slot.findByText('Git unavailable');
});
it('renders files and saves and clears revision-aware Viewed marks', async () => {
  let marks: { path: string; revision: string }[] = [];
  const markViewed = vi.fn((input: any) => { marks = [{ path: input.path, revision: input.revision }]; return { ok: true }; });
  const clearViewed = vi.fn(() => { marks = []; return { ok: true }; });
  const files = vi.fn(() => ({ outcome: 'available', files: [file], initialPatches: [patch], truncated: false }));
  const { slot } = setup(DiffTab, { files, viewed: () => ({ files: marks }), markViewed, clearViewed });
  await slot.findByText('a.ts'); expect(slot.getByText('+3')).toBeTruthy();
  fireEvent.click(slot.getByRole('checkbox', { name: 'Viewed' }));
  await waitFor(() => expect(markViewed).toHaveBeenCalledWith({ environmentId: 'env', target: { type: 'uncommitted' }, path: 'a.ts', revision: 'r1' }));
  await waitFor(() => expect((slot.getByRole('checkbox') as HTMLInputElement).checked).toBe(true));
  fireEvent.click(slot.getByRole('checkbox'));
  await waitFor(() => expect(clearViewed).toHaveBeenCalled());
  fireEvent.change(slot.getByRole('combobox', { name: 'Diff target' }), { target: { value: 'branch' } });
  await waitFor(() => expect(files).toHaveBeenCalledWith({ environmentId: 'env', target: { type: 'branch_committed', mergeBaseBranch: 'main' }, ignoreWhitespace: false }));
});
it('shows linked tasks and opens their in-app route', async () => {
  const { slot } = setup(WorkBoardTab, { threadTasks: () => ({ tasks: [{ key: 'WB-1', title: 'Task', status: { id: 'done', name: 'Done', icon: 'Check', color: '#008800', future: true }, projectName: 'Project', archived: true, url: '/plugins/work-board/work-board/task/WB-1', future: true }] }) });
  const moved = vi.fn(); window.addEventListener('popstate', moved);
  fireEvent.click(await slot.findByRole('button', { name: 'Open WB-1: Task' }));
  expect(window.location.pathname).toBe('/plugins/work-board/work-board/task/WB-1'); expect(moved).toHaveBeenCalledOnce(); window.removeEventListener('popstate', moved);
  expect(slot.getByText('Done')).toBeTruthy();
  expect(slot.getByText('WB-1').className).toContain('w-14');
});
it('draws Work Board\'s own status glyph and color once it sends them', async () => {
  const { slot } = setup(WorkBoardTab, { threadTasks: () => ({ tasks: [{ key: 'WB-2', title: 'Glyph', status: { id: 'in_progress', name: 'In Progress', iconName: 'work-board/status-in_progress', cssColor: 'goldenrod' }, projectName: 'P', archived: false, url: '/plugins/work-board/work-board/task/WB-2' }] }) });
  const glyph = await slot.findByLabelText('In Progress');
  expect(glyph.getAttribute('style')).toContain('goldenrod'); expect(slot.queryByText('In Progress')).toBeNull();
});
it.each([undefined, () => { throw new Error('offline'); }])('fails softly without Work Board', async handler => {
  const { slot } = setup(WorkBoardTab, handler ? { threadTasks: handler } : {});
  await slot.findByText('Work Board unavailable');
});
it('loads on-demand patches using the file revision and surfaces truncation', async () => {
  const patches = vi.fn(({ keys }: { keys: string[] }) => ({ [keys[0]!]: { outcome: 'available', patch: { ...patch, truncated: true } } }));
  const { slot } = setup(DiffTab, { files: () => ({ outcome: 'available', files: [{ ...file, loadMode: 'on_demand' }], initialPatches: [], truncated: true }), patches });
  fireEvent.click(await slot.findByRole('button', { name: 'Load diff' }));
  await slot.findByText('Diff truncated');
  expect(patches).toHaveBeenCalledWith({ keys: [JSON.stringify(['env', { type: 'uncommitted' }, false, 'a.ts', 'r1'])] });
  expect(slot.getByText('More files not shown')).toBeTruthy();
});
it('keeps the selected Diff target through turn completion', async () => {
  const { slot } = setup(DiffTab);
  await slot.findByText('a.ts');
  await waitFor(() => expect((slot.getByRole('option', { name: 'Branch against main' }) as HTMLOptionElement).disabled).toBe(false));
  fireEvent.change(slot.getByRole('combobox'), { target: { value: 'branch' } });
  act(() => setOpenChat('thr_one', true));
  act(() => setOpenChat('thr_one', false));
  await slot.findByText('a.ts');
  expect((slot.getByRole('combobox') as HTMLSelectElement).value).toBe('branch');
});
it('does not mark a file Viewed when the save fails', async () => {
  const { slot } = setup(DiffTab, { markViewed: () => { throw new Error('Cannot save Viewed'); } });
  fireEvent.click(await slot.findByRole('checkbox', { name: 'Viewed' }));
  await slot.findByText('Cannot save Viewed');
  expect((slot.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
it('shows no linked tasks and avoids Work Board reads while hidden', async () => {
  const threadTasks = vi.fn(() => ({ tasks: [] }));
  const hidden = setup(WorkBoardTab, { threadTasks }, { tabVisible: false });
  expect(threadTasks).not.toHaveBeenCalled(); hidden.slot.unmount();
  const { slot } = setup(WorkBoardTab, { threadTasks });
  await slot.findByText('No linked tasks');
});
