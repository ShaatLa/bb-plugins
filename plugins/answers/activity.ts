import { useEffect, useState } from 'react';
import { useSdk } from '@get-bb/plugin-sdk/app';
import type { Activity } from './robot-loader';

type Item = { type?: string; command?: string; description?: string; tool?: string; server?: string; path?: string | null; url?: string; queries?: string[]; changes?: { path: string }[]; presentation?: { label: { pending: string }; title?: string } };
type Row = { type: string; data?: { item?: Item; parentToolCallId?: string | null } | null };
export type AgentState = { activity: Activity; label: string };
const name = (path?: string | null) => path?.split('/').pop() ?? '';

const SEARCH = /\b(?:rg|grep|ag|find|fd|locate)\b|search|query|lookup/i, READ = /\b(?:cat|head|tail|less|more|sed -n|bat|jq|ls|tree|wc)\b|read|fetch|get|list|view|show/i;

/** The robot's scene for one item the agent has started. */
export function sceneOf(item: NonNullable<NonNullable<Row['data']>['item']>): Activity {
  switch (item.type) {
    case 'reasoning': return 'think';
    case 'agentMessage': case 'plan': return 'write';
    case 'fileChange': return 'fix';
    case 'fileRead': case 'imageView': case 'webFetch': return 'read';
    case 'webSearch': case 'listFiles': case 'search': return 'search';
    case 'delegation': case 'backgroundTask': return 'wait';
    // A shell command acts out the same kind of work its words name (commandLabel), so the two never disagree.
    case 'commandExecution': return COMMAND_SCENE[commandLabel(item.command ?? '')] ?? 'terminal';
    case 'toolCall': case 'mcpToolCall': { const tool = `${item.server ?? ''} ${item.tool ?? ''}`; return SEARCH.test(tool) ? 'search' : READ.test(tool) ? 'read' : 'terminal'; }
    default: return 'think';
  }
}

// A few broad kinds, so every command gets a plain phrase; anything not recognised is just "Running a command".
const KIND: Record<string, string> = {};
for (const [label, programs] of Object.entries({
  'Running a script': 'python python3 node tsx deno ruby perl php bash sh zsh osascript',
  'Searching': 'grep egrep rg ag find fd locate',
  'Reading files': 'cat head tail less more bat jq awk wc ls tree stat file',
  'Editing files': 'sed tee patch cp mv rm mkdir touch rsync ln chmod',
  'Running tests': 'vitest jest pytest mocha',
  'Building': 'tsc make cargo go swift xcodebuild gradle',
  'Using git': 'git gh',
  'Installing packages': 'brew pip pip3 uv',
  'Fetching from the web': 'curl wget',
  'Waiting': 'sleep',
})) for (const program of programs.split(' ')) KIND[program] ??= label;
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const COMMAND_SCENE: Record<string, Activity> = { 'Searching': 'search', 'Reading files': 'read', 'Editing files': 'fix', 'Waiting': 'wait' };
/** A shell command as a broad kind of work, from the first step that does the work (past `cd`, env settings and wrappers). */
export function commandLabel(command: string): string {
  for (const step of command.split(/&&|\|\||;|\||\n/)) {
    const words = step.trim().split(/\s+/).filter(Boolean);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!) || ['sudo', 'env', 'time', 'exec', 'command', 'nohup', 'npx', 'bunx'].includes(words[0]!))) words.shift();
    const program = words[0]?.split('/').pop()?.replace(/^\(+/, '');
    if (!program || ['cd', 'export', 'set', 'source', '.', 'echo', 'printf', 'for', 'do', 'done', 'then', 'fi', 'if', 'true', 'test', '[', 'local', 'unset'].includes(program) || program.startsWith('#')) continue;
    if (program === 'sed' && words[1] === '-n') return 'Reading files';
    if (PACKAGE_MANAGERS.has(program)) { const args = words.slice(1).join(' '); return /\btest\b/.test(args) ? 'Running tests' : /\bbuild\b/.test(args) ? 'Building' : /\b(?:i|install|add|ci)\b/.test(args) ? 'Installing packages' : 'Running a command'; }
    return KIND[program] ?? 'Running a command';
  }
  return 'Running a command';
}

/** The words beside the robot for the same item, bb-style ("Running npm test", "Reading app.tsx"). */
export function labelOf(item: Item): string {
  // A provider's own one-line description of the command wins; bb's schema has it, though no provider here fills it yet.
  if (item.type === 'commandExecution') return item.description?.trim().split('\n')[0] || commandLabel(item.command ?? '');
  // A tool's words follow its scene, so a reading robot never says "Running": "answers_list" reads, "web_search" searches.
  if (item.type === 'toolCall' || item.type === 'mcpToolCall') { const scene = sceneOf(item), tool = (item.tool ?? 'a tool').replace(/_/g, ' '); return scene === 'search' ? `Searching: ${tool}` : scene === 'read' ? `Reading: ${tool}` : `Running ${tool}`; }
  if (item.presentation) return `${item.presentation.label.pending}${item.presentation.title ? ` ${item.presentation.title}` : ''}`;
  switch (item.type) {
    case 'reasoning': return 'Thinking';
    case 'agentMessage': return 'Writing';
    case 'plan': return 'Planning';
    case 'fileChange': return item.changes?.length === 1 ? `Editing ${name(item.changes[0]!.path)}` : 'Editing files';
    case 'fileRead': return `Reading ${name(item.path)}`;
    case 'imageView': return 'Viewing an image';
    case 'webSearch': return item.queries?.length ? `Searching the web: ${item.queries[0]}` : 'Searching the web';
    case 'webFetch': return `Reading ${item.url ? new URL(item.url, 'https://x').hostname : 'a web page'}`;
    case 'search': case 'listFiles': return 'Searching';
    case 'delegation': return 'Waiting for a subagent';
    case 'backgroundTask': return 'Waiting for background work';
    default: return 'Thinking';
  }
}

/** What a working agent does now, from its newest top-level events (newest first): the open item's scene, thinking
 *  between items, resting once the turn is over while background work still runs. */
export function stateOf(events: Row[]): AgentState {
  for (const event of events) {
    if (event.data?.parentToolCallId) continue;
    if (event.type === 'turn/completed') return { activity: 'rest', label: 'Waiting for background work' };
    if (event.type === 'turn/started' || event.type === 'item/completed') break;
    if (event.type === 'item/started' && event.data?.item) return { activity: sceneOf(event.data.item), label: labelOf(event.data.item) };
  }
  return THINKING;
}
export const activityOf = (events: Row[]) => stateOf(events).activity;
const THINKING: AgentState = { activity: 'think', label: 'Thinking' };

/** Polls the open chat's newest events every 2.5 s while its agent works and the page is visible. */
export function useAgentActivity(threadId: string | undefined, working: boolean, visible: boolean): AgentState {
  const sdk = useSdk(), [state, setState] = useState<AgentState>(THINKING);
  useEffect(() => {
    if (!threadId || !working || !visible) return;
    let live = true;
    const read = () => void Promise.resolve().then(() => sdk.threads.events.list({ threadId, order: 'desc', limit: '40' })).then(rows => { if (live) { const next = stateOf(rows as Row[]); setState(old => old.activity === next.activity && old.label === next.label ? old : next); } }).catch(() => {});
    read(); const timer = setInterval(read, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [sdk, threadId, working, visible]);
  return working ? state : THINKING;
}
