import { expect, it } from 'vitest';
import { splitInlineVis } from './inline-vis';

it('splits directive and fenced inline-vis pages out of a message, leaving other fences as text', () => {
  const text = ['Intro', '', '::inline-vis{source="thread-storage" file="robots/all.html"}', '', '```inline-vis', '<b>hi</b>', '```', '', '```md', '::inline-vis{file="x.html"}', '```', 'Outro'].join('\n');
  expect(splitInlineVis(text)).toEqual([
    { kind: 'markdown', text: 'Intro\n' },
    { kind: 'file', file: 'robots/all.html', source: 'thread-storage' },
    { kind: 'page', html: '<b>hi</b>' },
    { kind: 'markdown', text: '\n```md\n::inline-vis{file="x.html"}\n```\nOutro' },
  ]);
  expect(splitInlineVis('::inline-vis{file="demo.html"}')).toEqual([{ kind: 'file', file: 'demo.html', source: 'workspace' }]);
});
it('splits a Work Board ::task directive out as a task card, but not inside a code fence', () => {
  expect(splitInlineVis('Plan ready.\n::task{key="EXA-4"}\nMore.')).toEqual([{ kind: 'markdown', text: 'Plan ready.' }, { kind: 'task', key: 'EXA-4' }, { kind: 'markdown', text: 'More.' }]);
  expect(splitInlineVis('```\n::task{key="EXA-4"}\n```')).toEqual([{ kind: 'markdown', text: '```\n::task{key="EXA-4"}\n```' }]);
});
