import { useEffect, useState } from 'react';
import { useSdk } from '@get-bb/plugin-sdk/app';
import type { Activity } from './robot-loader';

type Row = { type: string; data?: { item?: { type?: string; command?: string; tool?: string; server?: string }; parentToolCallId?: string | null } | null };

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
    case 'commandExecution': { const command = item.command ?? ''; return SEARCH.test(command) ? 'search' : /^\s*(?:cat|head|tail|less|more|sed -n|bat|jq|wc)\b/.test(command) ? 'read' : 'terminal'; }
    case 'toolCall': case 'mcpToolCall': { const tool = `${item.server ?? ''} ${item.tool ?? ''}`; return SEARCH.test(tool) ? 'search' : READ.test(tool) ? 'read' : 'terminal'; }
    default: return 'think';
  }
}

/** What a working agent does now, from its newest top-level events (newest first): the open item's scene, thinking
 *  between items, waiting once the turn is over (children, background work). */
export function activityOf(events: Row[]): Activity {
  for (const event of events) {
    if (event.data?.parentToolCallId) continue;
    if (event.type === 'turn/completed') return 'wait';
    if (event.type === 'turn/started' || event.type === 'item/completed') return 'think';
    if (event.type === 'item/started' && event.data?.item) return sceneOf(event.data.item);
  }
  return 'think';
}

/** Polls the open chat's newest events every 2.5 s while its agent works and the page is visible. */
export function useAgentActivity(threadId: string | undefined, working: boolean, visible: boolean): Activity {
  const sdk = useSdk(), [activity, setActivity] = useState<Activity>('think');
  useEffect(() => {
    if (!threadId || !working || !visible) return;
    let live = true;
    const read = () => void Promise.resolve().then(() => sdk.threads.events.list({ threadId, order: 'desc', limit: '40' })).then(rows => { if (live) setActivity(activityOf(rows as Row[])); }).catch(() => {});
    read(); const timer = setInterval(read, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [sdk, threadId, working, visible]);
  return working ? activity : 'think';
}
