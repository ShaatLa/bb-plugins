import { expect, it } from 'vitest';
import { activityOf, sceneOf } from './activity';

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
  expect(activityOf([{ type: 'turn/completed', data: {} }])).toBe('wait');
  expect(activityOf([{ type: 'item/started', data: { item: { type: 'fileRead' }, parentToolCallId: 'x' } }, started({ type: 'agentMessage' })])).toBe('write');
});
