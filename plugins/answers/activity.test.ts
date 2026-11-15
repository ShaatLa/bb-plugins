import { expect, it } from 'vitest';
import { activityOf, sceneOf, stateOf } from './activity';

const started = (item: object) => ({ type: 'item/started', data: { item } });
it.each([
  [{ type: 'reasoning' }, 'think'], [{ type: 'agentMessage' }, 'write'], [{ type: 'fileChange' }, 'fix'], [{ type: 'fileRead' }, 'read'],
  [{ type: 'webSearch' }, 'search'], [{ type: 'delegation' }, 'wait'], [{ type: 'commandExecution', command: 'npm test' }, 'terminal'],
  [{ type: 'commandExecution', command: 'rg -n foo src' }, 'search'], [{ type: 'commandExecution', command: 'node -e "document.querySelector(1)"' }, 'terminal'], [{ type: 'commandExecution', command: 'sed -n 1,40p app.tsx' }, 'read'],
  [{ type: 'toolCall', server: 'bb-bridge', tool: 'answers_list' }, 'read'], [{ type: 'toolCall', server: 'codegraph', tool: 'codegraph_search' }, 'search'],
] as const)('%j → %s', (item, scene) => expect(sceneOf(item)).toBe(scene));
it('reads the newest top-level event: an open item, thinking between items, waiting after the turn', () => {
  expect(activityOf([started({ type: 'commandExecution', command: 'npm run build' }), { type: 'item/completed', data: {} }])).toBe('terminal');
  expect(activityOf([{ type: 'item/completed', data: {} }, started({ type: 'fileChange' })])).toBe('think');
  expect(activityOf([{ type: 'turn/completed', data: {} }])).toBe('rest');
  expect(activityOf([{ type: 'item/started', data: { item: { type: 'fileRead' }, parentToolCallId: 'x' } }, started({ type: 'agentMessage' })])).toBe('write');
});

it('words the same item the robot acts out', () => {
  expect(stateOf([started({ type: 'commandExecution', command: 'npm test\n--watch' })])).toEqual({ activity: 'terminal', label: 'Running npm test' });
  expect(stateOf([started({ type: 'commandExecution', command: 'npm test', presentation: { label: { pending: 'Running command' }, title: 'npm test' } })]).label).toBe('Running npm test');
  expect(stateOf([started({ type: 'fileRead', path: 'src/app.tsx' })])).toEqual({ activity: 'read', label: 'Reading app.tsx' });
  expect(stateOf([{ type: 'item/completed', data: {} }, started({ type: 'fileRead', path: 'a' })])).toEqual({ activity: 'think', label: 'Thinking' });
  expect(stateOf([{ type: 'turn/completed', data: {} }]).activity).toBe('rest');
});

it('says a shell command in a few words', async () => {
  const { commandLabel } = await import('./activity');
  expect(commandLabel('cd /Applications/bb.app/Contents && python3 - <<EOF\nimport re\nEOF')).toBe('Running a Python script');
  expect(commandLabel('cd plugins/answers; npx vitest run 2>&1 | grep Tests')).toBe('Running tests');
  expect(commandLabel('FOO=1 npm run build >/dev/null && rsync -a ./ x/')).toBe('Running npm run build');
  expect(commandLabel('git -C repo log --oneline -1')).toBe('Running git log');
  expect(commandLabel("sed -n 1,20p app.tsx")).toBe('Reading files');
  expect(commandLabel('/opt/homebrew/bin/jq . file')).toBe('Running jq');
  expect(commandLabel('cd x')).toBe('Running a command');
  expect(stateOf([{ type: 'item/started', data: { item: { type: 'commandExecution', command: 'make', description: 'Build the release' } } }]).label).toBe('Build the release');
});
