// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { activityOf, labelOf, sceneOf, stateOf } from './activity';

const started = (item: object) => ({ type: 'item/started', data: { item } });
it.each([
  [{ type: 'reasoning' }, 'think'], [{ type: 'agentMessage' }, 'write'], [{ type: 'fileChange' }, 'fix'], [{ type: 'fileRead' }, 'read'],
  [{ type: 'webSearch' }, 'search'], [{ type: 'delegation' }, 'wait'], [{ type: 'commandExecution', command: 'npm test' }, 'terminal'],
  [{ type: 'commandExecution', command: 'rg -n foo src' }, 'search'], [{ type: 'commandExecution', command: 'node -e "document.querySelector(1)"' }, 'terminal'], [{ type: 'commandExecution', command: 'sed -n 1,40p app.tsx' }, 'read'],
  [{ type: 'toolCall', server: 'bb-bridge', tool: 'agent_hub_list' }, 'read'], [{ type: 'toolCall', server: 'codegraph', tool: 'codegraph_search' }, 'search'],
] as const)('%j → %s', (item, scene) => expect(sceneOf(item)).toBe(scene));
it('reads the newest top-level event: an open item, thinking between items, waiting after the turn', () => {
  expect(activityOf([started({ type: 'commandExecution', command: 'npm run build' }), { type: 'item/completed', data: {} }])).toBe('terminal');
  expect(activityOf([{ type: 'item/completed', data: {} }, started({ type: 'fileChange' })])).toBe('think');
  expect(activityOf([{ type: 'turn/completed', data: {} }])).toBe('rest');
  expect(activityOf([{ type: 'item/started', data: { item: { type: 'fileRead' }, parentToolCallId: 'x' } }, started({ type: 'agentMessage' })])).toBe('write');
});

it('words the same item the robot acts out', () => {
  expect(stateOf([started({ type: 'commandExecution', command: 'npm test\n--watch' })])).toEqual({ activity: 'terminal', label: 'Running tests' });
  expect(stateOf([started({ type: 'commandExecution', command: 'npm test', presentation: { label: { pending: 'Running command' }, title: 'npm test' } })]).label).toBe('Running tests');
  expect(stateOf([started({ type: 'fileRead', path: 'src/app.tsx' })])).toEqual({ activity: 'read', label: 'Reading app.tsx' });
  expect(stateOf([{ type: 'item/completed', data: {} }, started({ type: 'fileRead', path: 'a' })])).toEqual({ activity: 'think', label: 'Thinking' });
  expect(stateOf([{ type: 'turn/completed', data: {} }]).activity).toBe('rest');
  // A failed or stopped turn is not waiting on its sub-sessions, so the chat must not say it is.
  expect(stateOf([{ type: 'turn/completed', data: { status: 'failed' } }])).toEqual({ activity: 'rest', label: 'Turn failed', ended: true });
  expect(stateOf([{ type: 'turn/completed', data: { status: 'interrupted' } }])).toEqual({ activity: 'rest', label: 'Stopped', ended: true });
});

it('says a shell command in a few words', async () => {
  const { commandLabel } = await import('./activity');
  expect(commandLabel('cd /Applications/bb.app/Contents && python3 - <<EOF\nimport re\nEOF')).toBe('Running a script');
  expect(commandLabel('cd plugins/answers; npx vitest run 2>&1 | grep Tests')).toBe('Running tests');
  expect(commandLabel('FOO=1 npm run build >/dev/null && rsync -a ./ x/')).toBe('Building');
  expect(commandLabel('git -C repo log --oneline -1')).toBe('Using git');
  expect(commandLabel("sed -n 1,20p app.tsx")).toBe('Reading files');
  expect(commandLabel('/opt/homebrew/bin/jq . file')).toBe('Reading files');
  expect(commandLabel('ffmpeg -i a.mp4 b.webm')).toBe('Running a command');
  expect(commandLabel('cd x')).toBe('Running a command');
  expect(stateOf([{ type: 'item/started', data: { item: { type: 'commandExecution', command: 'make', description: 'Build the release' } } }]).label).toBe('Build the release');
});

describe('scene and words agree', () => {
  it.each([
    [{ type: 'toolCall', tool: 'agent_hub_list' }, 'read', 'Reading: agent hub list'],
    [{ type: 'mcpToolCall', server: 'bb', tool: 'web_search' }, 'search', 'Searching: web search'],
    [{ type: 'toolCall', tool: 'agent_hub_resolve' }, 'terminal', 'Running agent hub resolve'],
    [{ type: 'commandExecution', command: 'ls -la' }, 'read', 'Reading files'],
    [{ type: 'commandExecution', command: 'cat a.log | grep error' }, 'read', 'Reading files'],
    [{ type: 'commandExecution', command: 'rg TODO src' }, 'search', 'Searching'],
    [{ type: 'commandExecution', command: 'sed -i s/a/b/ f' }, 'fix', 'Editing files'],
    [{ type: 'commandExecution', command: 'sleep 30' }, 'wait', 'Waiting'],
    [{ type: 'commandExecution', command: 'npm test' }, 'terminal', 'Running tests'],
  ])('%o', (item, scene, label) => {
    expect(sceneOf(item as never)).toBe(scene); expect(labelOf(item as never)).toBe(label);
  });
});

it('retains the same activity object across equal polls', async () => {
  const { renderSlot } = await import('@get-bb/plugin-sdk/testing/app');
  const { act, cleanup } = await import('@testing-library/react');
  const { vi } = await import('vitest');
  const { useAgentActivity } = await import('./activity');
  const seen: unknown[] = [];
  vi.useFakeTimers();
  try {
    renderSlot({ component: () => { seen.push(useAgentActivity('poll_equal', true, true)); return null; } }, {}, { sdk: { threads: { events: { list: async () => [started({ type: 'fileRead', path: 'same.ts' })] } } } } as any);
    await act(async () => {});
    const first = seen.at(-1);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(seen.at(-1)).toBe(first);
  } finally { cleanup(); vi.useRealTimers(); }
});
