// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
import { LocalLinks, localLink } from './inline-vis';

afterEach(cleanup);

it('reads local file links and leaves app routes and URLs alone', () => {
  expect(localLink('/repo/a%20b.md#L12-L20')).toEqual({ path: '/repo/a b.md', line: 12 });
  expect(localLink('file:///tmp/x.ts:7')).toEqual({ path: '/tmp/x.ts', line: 7 });
  expect(localLink('docs/ui.md')).toEqual({ path: 'docs/ui.md', line: null });
  for (const href of ['https://x.y/a.md', '/plugins/work-board/work-board/task/A-1', '/threads/t1', '#top', '//cdn/x', 'mailto:a@b']) expect(localLink(href)).toBeNull();
});

it('opens a message’s local file links in bb’s file preview', async () => {
  const sdk = { threads: { get: async () => ({ id: 't', environmentId: 'env' }) }, environments: { get: async () => ({ id: 'env', hostId: 'host', path: '/repo/' }) } };
  // The harness's Markdown is a stub, so the anchors bb's Markdown renders stand here as plain ones.
  const links = [['inside', '/repo/src/a.ts#L3'], ['outside', '/Users/me/notes.md'], ['relative', './docs/ui.md'], ['web', 'https://example.com']];
  const slot = renderSlot({ component: () => <LocalLinks threadId="t">{links.map(([name, href]) => <a key={name} href={href}>{name}</a>)}</LocalLinks> }, {}, { sdk } as any);
  for (const name of ['inside', 'outside', 'relative', 'web']) fireEvent.click(slot.getByText(name));
  await waitFor(() => expect(slot.inspection.navigateCalls.filter(call => call.method === 'experimental_openFilePreview')).toHaveLength(3));
  expect(slot.inspection.navigateCalls.map(call => call.method === 'experimental_openFilePreview' ? call.options : call.method)).toEqual([
    { target: { kind: 'workspace', environmentId: 'env', path: 'src/a.ts' }, location: { kind: 'line', line: 3, column: null } },
    { target: { kind: 'host', hostId: 'host', path: '/Users/me/notes.md' }, location: null },
    { target: { kind: 'workspace', environmentId: 'env', path: 'docs/ui.md' }, location: null },
  ]);
});
