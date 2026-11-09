import { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, experimental_useProviders, useRpc, useSdk, useSettings } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import type { AnswersRpcContract } from './contract';

type Usage = 'auto' | 'always' | 'never';
type Window = { label: string; usedPercent: number; resetsAt: string | null };
type Provider = { status: string; planLabel?: string | null; windows?: Window[] };

// shortcut: bb's SDK does not say whether its sidebar is collapsed, so this reads the shell's data-state attribute;
// when bb changes that markup, 'auto' simply stops showing usage, and 'always' still works.
export function useBbSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // bb may re-create the sidebar element, so look it up afresh on every data-state change in the page.
    const read = () => setCollapsed(document.querySelector('.peer[data-state]')?.getAttribute('data-state') === 'collapsed');
    read();
    const observer = new MutationObserver(read);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-state'], childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return collapsed;
}

const left = (at: string) => { const m = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60000)); return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

// Compact usage like bb's sidebar panel: limit windows that reset (local models have none, so they are skipped).
// Loaded while usage is enabled at all, so revealing it (e.g. collapsing bb's sidebar) shows numbers at once.
function useUsage(enabled: boolean) {
  const sdk = useSdk(), [usage, setUsage] = useState<Record<string, Provider> | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => void Promise.resolve().then(() => sdk.system.usageLimits()).then(data => { if (live) setUsage(data as Record<string, Provider>); }).catch(() => {});
    load(); const timer = setInterval(load, 300000);
    return () => { live = false; clearInterval(timer); };
  }, [sdk, enabled]);
  return usage;
}

function UsageSummary({ usage }: { usage: Record<string, Provider> | null }) {
  const providers = experimental_useProviders().providers;
  const groups = Object.entries(usage ?? {}).flatMap(([id, p]) => { const windows = p.status === 'ok' ? (p.windows ?? []).filter(w => w.resetsAt) : []; return windows.length ? [{ id, plan: p.planLabel ?? null, windows }] : []; });
  if (!groups.length) return null;
  return <div aria-label="Usage" className="space-y-2 px-3 pb-1 pt-2">
    {groups.map(({ id, plan, windows }) => { const info = providers.find(p => p.id === id); return <div key={id} className="space-y-0.5 text-[11px] text-muted-foreground">
      <div className="flex items-center gap-1.5 text-foreground"><ProviderIcon providerKind="agent" provider={info ?? { id }} className="size-3.5 shrink-0" aria-hidden /><span className="min-w-0 flex-1 truncate font-medium">{info?.displayName ?? id}</span>{plan && <span className="shrink-0 text-muted-foreground">{plan}</span>}</div>
      {windows.map(w => <div key={w.label} className="flex items-center gap-2 pl-5">
        <span className="w-16 shrink-0 truncate" title={w.label}>{w.label.replace(/\u2063/g, '')}</span>
        <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-state-hover"><span className={`block h-full rounded-full ${w.usedPercent >= 80 ? 'bg-orange-500' : 'bg-foreground/70'}`} style={{ width: `${Math.min(100, w.usedPercent)}%` }} /></span>
        <span className={`w-8 shrink-0 text-right tabular-nums ${w.usedPercent >= 80 ? 'text-orange-500' : ''}`}>{Math.round(w.usedPercent)}%</span>
        <span className="w-12 shrink-0 text-right tabular-nums">{left(w.resetsAt!)}</span>
      </div>)}
    </div>; })}
  </div>;
}

export function ContactsFooter() {
  const rpc = useRpc<AnswersRpcContract>(), values = useSettings().values, collapsed = useBbSidebarCollapsed();
  const [open, setOpen] = useState(false), [error, setError] = useState(''), menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const groupByProject = values?.groupByProject === true, usage = (values?.usage ?? 'auto') as Usage, usageData = useUsage(usage !== 'never');
  const set = (prefs: { groupByProject?: boolean; usage?: Usage }) => { setError(''); void rpc.call('setPreferences', prefs).catch(e => setError(e instanceof Error ? e.message : String(e))); };
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover';
  return <div className="border-t border-border-seam">
    {(usage === 'always' || (usage === 'auto' && collapsed)) && <UsageSummary usage={usageData} />}
    <div ref={menu} className="relative flex items-center justify-end px-2 py-1">
      {error && <p role="alert" className="mr-auto truncate text-xs text-destructive">{error}</p>}
      <Button size="sm" variant="ghost" className="size-7 p-0 text-muted-foreground" aria-label="Contact list settings" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="Settings" aria-hidden /></Button>
      {open && <div role="menu" aria-label="Contact list settings" className="absolute bottom-full left-2 z-20 mb-1 w-64 rounded-md border border-border-seam bg-background p-1 shadow-lg" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
        <button type="button" role="menuitemcheckbox" aria-checked={groupByProject} className={item} onClick={() => set({ groupByProject: !groupByProject })}><Icon name={groupByProject ? 'Check' : 'Layers'} aria-hidden className="size-4 text-muted-foreground" />Group by project</button>
        <p className="px-2 pb-0.5 pt-2 text-xs text-muted-foreground">Usage</p>
        {([['auto', 'When bb’s sidebar is hidden'], ['always', 'Always'], ['never', 'Never']] as const).map(([value, label]) =>
          <button key={value} type="button" role="menuitemradio" aria-checked={usage === value} className={item} onClick={() => set({ usage: value })}><Icon name={usage === value ? 'Check' : 'ChartColumn'} aria-hidden className={`size-4 ${usage === value ? '' : 'opacity-0'}`} />{label}</button>)}
      </div>}
    </div>
  </div>;
}
