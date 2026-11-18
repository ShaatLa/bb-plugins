import { useEffect, useState } from 'react';
import { useSdk } from '@get-bb/plugin-sdk/app';

export type Command = Awaited<ReturnType<ReturnType<typeof useSdk>['projects']['commands']>>['commands'][number];
const commandCache = new Map<string, { at: number; list: Promise<Command[]> }>();
export function useThreadCommands(threadId: string | null) {
  const sdk = useSdk(), [list, setList] = useState<Command[]>([]);
  useEffect(() => {
    if (!threadId) { setList([]); return; }
    let live = true, cached = commandCache.get(threadId);
    if (!cached || Date.now() - cached.at > 300000) {
      // Any failure (no environment yet, provider without commands) just means no menu; the next composer retries.
      cached = { at: Date.now(), list: (async () => { const thread = await sdk.threads.get({ threadId }); return thread.projectId && thread.environmentId && thread.providerId ? (await sdk.projects.commands({ projectId: thread.projectId, environmentId: thread.environmentId, provider: thread.providerId })).commands : []; })().catch(() => { commandCache.delete(threadId); return []; }) };
      commandCache.set(threadId, cached);
    }
    void cached.list.then(commands => { if (live) setList(commands); });
    return () => { live = false; };
  }, [sdk, threadId]);
  return list;
}
export const commandMention = (command: Command, trigger: '/' | '$') => ({ kind: 'command' as const, trigger, name: command.name, source: command.source, origin: command.origin, argumentHint: command.argumentHint, label: command.name });
