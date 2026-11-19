import { useEffect, useState } from 'react';
import { z } from 'zod';
import { experimental_Icon as Icon, useSdk } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';

// Idle Compact's header action ("Compact") only reaches bb's own thread header, so Agent Hub calls its RPCs when that plugin
// is installed, enabled and running: `compact { threadId }` from 0.3.0; `queue`, `cancelQueuedCompact` and `compactState` from 0.4.0.
const PLUGIN = 'idle-compact';
type Plugin = { id: string; version: string; enabled: boolean; status: string };
const usable = (plugins: Plugin[], min: number[]) => plugins.some(p => p.id === PLUGIN && p.enabled && p.status === 'running' && atLeast(p.version, min));
export const compactAvailable = (plugins: Plugin[]) => usable(plugins, [0, 3, 0]);
export const compactQueueable = (plugins: Plugin[]) => usable(plugins, [0, 4, 0]);
function atLeast(version: string, min: number[]) {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) { const a = parts[i] ?? 0; if (Number.isNaN(a)) return false; if (a !== min[i]) return a > min[i]!; }
  return true;
}
const POLL_MS = 3000;
const ok = z.object({ ok: z.literal(true) });

export function CompactButton({ threadId, status, onError }: { threadId: string; status: string; onError: (message: string) => void }) {
  const sdk = useSdk(), [plugins, setPlugins] = useState<Plugin[]>([]), [state, setState] = useState<'busy' | 'queued' | 'running' | 'failed' | null>(null);
  useEffect(() => { let live = true; void Promise.resolve().then(() => sdk.plugins.list()).then(r => { if (live) setPlugins(r.plugins); }).catch(() => {}); return () => { live = false; }; }, [sdk]);
  useEffect(() => setState(null), [threadId]);
  const available = compactAvailable(plugins), queueable = compactQueueable(plugins);
  // bb compacts only a thread that is idle or errored; during a turn, 0.4.0 queues the compaction until the thread stops.
  const ready = status === 'idle' || status === 'error';
  // No tag in 0.4.0, so poll its state on open and while a turn runs or a request waits (it survives a page reload).
  const watch = queueable && (!ready || state === 'queued' || state === 'running');
  useEffect(() => {
    if (!queueable) return;
    let live = true;
    const read = () => sdk.plugins.callRpc({ pluginId: PLUGIN, method: 'compactState', input: { threadId }, outputSchema: z.object({ queued: z.boolean(), running: z.boolean() }) })
      .then(r => { if (live) setState(s => r.queued ? 'queued' : r.running ? 'running' : s === 'queued' || s === 'running' ? null : s); }).catch(() => {});
    void read();
    const timer = watch ? setInterval(read, POLL_MS) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [sdk, threadId, queueable, watch]);
  if (!available || (!ready && !queueable && !state)) return null;
  const queued = state === 'queued';
  return <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground max-[639px]:hidden"
    disabled={state === 'busy' || state === 'running' || (!ready && !queueable)} onClick={async () => {
      if (!queued) setState('busy');
      try {
        if (queued) { await sdk.plugins.callRpc({ pluginId: PLUGIN, method: 'cancelQueuedCompact', input: { threadId }, outputSchema: ok }); setState(null); return; }
        const r = await sdk.plugins.callRpc({ pluginId: PLUGIN, method: 'compact', input: queueable ? { threadId, queue: true } : { threadId }, outputSchema: ok.extend({ queued: z.literal(true).optional() }) });
        setState(r.queued ? 'queued' : null);
      } catch (e) { setState('failed'); onError(e instanceof Error ? e.message : String(e)); }
    }}><Icon name="Minimize2" aria-hidden className="size-3.5" />{state === 'busy' || state === 'running' ? 'Compacting…' : queued ? 'Compact queued' : state === 'failed' ? 'Compact failed' : 'Compact'}</Button>;
}
