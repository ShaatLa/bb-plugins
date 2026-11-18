import { expect, it } from 'vitest';
import { mentionsForText, rememberMention } from './mentions';
it('builds send mentions for several tokens after multi-byte text', () => {
  const text = '😀 café @thread:thr_one and @thread:thr_two';
  const mentions = mentionsForText(text, id => ({ label: id === 'thr_one' ? 'One' : 'Two', projectId: 'proj_one' }));
  expect(mentions.map(m => text.slice(m.start,m.end))).toEqual(['@thread:thr_one','@thread:thr_two']);
  expect(mentions[0]).toEqual({ start: 8, end: 23, resource: { kind: 'thread', threadId: 'thr_one', projectId: 'proj_one', label: 'One' } });
});
it('keeps pasted bb mention resource kinds in sends', () => {
  rememberMention('@project:proj_one', { kind: 'project', projectId: 'proj_one', label: 'One' });
  expect(mentionsForText('See @project:proj_one')[0].resource.kind).toBe('project');
});
it('preserves every other bb mention kind from copied pills', () => {
  const resources = [
    { kind: 'section' as const, sectionId: 'sec_one', label: 'Section' },
    { kind: 'path' as const, path: 'src/app.ts', source: 'workspace' as const, entryKind: 'file' as const, label: 'app.ts' },
    { kind: 'command' as const, trigger: '/' as const, name: 'plan', source: 'command' as const, origin: 'builtin' as const, argumentHint: null, label: 'plan' },
    { kind: 'attachment' as const, path: '/a.txt', label: 'a.txt' },
  ];
  const tokens = ['@section:sec_one', '@src/app.ts', '/plan', '@a.txt'];
  resources.forEach((resource, i) => rememberMention(tokens[i], resource));
  const text = tokens.join(' '), mentions = mentionsForText(text);
  expect(mentions.map(m => m.resource.kind)).toEqual(['section', 'path', 'command', 'attachment']);
  expect(mentions.map(m => text.slice(m.start,m.end))).toEqual(tokens);
});
it('maps copied plugin mention ids to the send schema', () => {
  rememberMention('@Plugin item', { kind: 'plugin', pluginId: 'sample', provider: 'items', id: 'one', label: 'Plugin item' });
  expect(mentionsForText('@Plugin item')[0].resource).toEqual({ kind: 'plugin', pluginId: 'sample', itemId: 'one', label: 'Plugin item', icon: undefined });
});
