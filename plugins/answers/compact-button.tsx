import { useEffect, useState } from 'react';
import { z } from 'zod';
import { experimental_Icon as Icon, useSdk } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';

// Idle Compact's header action ("Compact") only reaches bb's own thread header, so Answers' header calls its `compact` RPC
// (from 0.3.0; input { threadId }, output { ok: true }) when that plugin is installed, enabled and running.
const PLUGIN = 'idle-compact';
export const compactAvailable = (plugins: { id: string; version: string; enabled: boolean; status: string }[]) =>
  plugins.some(p => p.id === PLUGIN && p.enabled && p.status === 'running' && atLeast(p.version, [0, 3, 0]));
function atLeast(version: string, min: number[]) {
  const parts = version.split(/[.-]/).slice(0, 3).map(Number);
  for (let i = 0; i < 3; i++) { const a = parts[i] ?? 0; if (Number.isNaN(a)) return false; if (a !== min[i]) return a > min[i]!; }
  return true;
}

export function CompactButton({ threadId, status, onError }: { threadId: string; status: string; onError: (message: string) => void }) {
  const sdk = useSdk(), [available, setAvailable] = useState(false), [state, setState] = useState<'busy' | 'failed' | null>(null);
  useEffect(() => { let live = true; void Promise.resolve().then(() => sdk.plugins.list()).then(r => { if (live) setAvailable(compactAvailable(r.plugins)); }).catch(() => {}); return () => { live = false; }; }, [sdk]);
  useEffect(() => setState(null), [threadId]);
  // Shown only when it can act (bb compacts an idle or errored thread), or while its own compaction is in flight or just failed.
  const ready = status === 'idle' || status === 'error';
  if (!available || (!ready && !state)) return null;
  // bb compacts only a thread that is idle or errored; the labels are Idle Compact's own.
  return <Button type="button" size="sm" variant="ghost" className="h-6 gap-1 px-1.5 text-xs text-muted-foreground max-[639px]:hidden" disabled={state === 'busy' || !ready} onClick={async () => {
    setState('busy');
    try { await sdk.plugins.callRpc({ pluginId: PLUGIN, method: 'compact', input: { threadId }, outputSchema: z.object({ ok: z.literal(true) }) }); setState(null); } catch (e) { setState('failed'); onError(e instanceof Error ? e.message : String(e)); }
  }}><Icon name="Minimize2" aria-hidden className="size-3.5" />{state === 'busy' ? 'Compacting…' : state === 'failed' ? 'Compact failed' : 'Compact'}</Button>;
}
