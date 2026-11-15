import { useEffect, useState } from 'react';
import { useSdk } from '@get-bb/plugin-sdk/app';
import type { Activity } from './robot-loader';

type Item = { type?: string; command?: string; tool?: string; server?: string; path?: string | null; url?: string; queries?: string[]; changes?: { path: string }[]; presentation?: { label: { pending: string }; title?: string } };
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
    // A shell command that only looks or reads gets that scene; anything else is terminal work.
    case 'commandExecution': { const command = item.command ?? ''; return /(?:^|[\s|;&(])(?:rg|grep|egrep|ag|find|fd|locate)\s/.test(command) ? 'search' : /^\s*(?:cat|head|tail|less|more|sed -n|bat|jq|wc)\b/.test(command) ? 'read' : 'terminal'; }
    case 'toolCall': case 'mcpToolCall': { const tool = `${item.server ?? ''} ${item.tool ?? ''}`; return SEARCH.test(tool) ? 'search' : READ.test(tool) ? 'read' : 'terminal'; }
    default: return 'think';
  }
}

/** The words beside the robot for the same item, bb-style ("Running npm test", "Reading app.tsx"). */
export function labelOf(item: Item): string {
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
    case 'commandExecution': return `Running ${(item.command ?? 'a command').split('\n')[0]}`;
    case 'toolCall': case 'mcpToolCall': return `Running ${item.tool ?? 'a tool'}`;
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
    const read = () => void Promise.resolve().then(() => sdk.threads.events.list({ threadId, order: 'desc', limit: '40' })).then(rows => { if (live) setState(stateOf(rows as Row[])); }).catch(() => {});
    read(); const timer = setInterval(read, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [sdk, threadId, working, visible]);
  return working ? state : THINKING;
}
