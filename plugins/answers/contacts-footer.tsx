import { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, experimental_useProviders, useRpc, useSdk, useSettings } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { useStoredState } from './lib/stored-state';
import type { AnswersRpcContract } from './contract';

type Usage = 'auto' | 'always' | 'never';
type Window = { label: string; usedPercent: number; resetsAt: string | null; kind?: string };
type Provider = { status: string; accountEmail?: string | null; planLabel?: string | null; windows?: Window[] };

// shortcut: bb's SDK does not say whether its sidebar is collapsed, so this reads the shell's data-state attribute;
// when bb changes that markup, 'auto' simply stops showing usage, and 'always' still works.
export function useBbSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    let sidebar: Element | null = null;
    const state = new MutationObserver(() => setCollapsed(sidebar?.getAttribute('data-state') === 'collapsed'));
    const attach = () => {
      const next = document.querySelector('.peer[data-state]');
      if (next === sidebar) return;
      state.disconnect(); sidebar = next;
      if (sidebar) state.observe(sidebar, { attributes: true, attributeFilter: ['data-state'] });
      setCollapsed(sidebar?.getAttribute('data-state') === 'collapsed');
    };
    attach();
    const replacement = new MutationObserver(records => {
      if (records.some(record => [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(node => node === sidebar || (node instanceof Element && (node.matches('.peer[data-state]') || !!node.querySelector('.peer[data-state]')))))) attach();
    });
    replacement.observe(document.body, { childList: true, subtree: true });
    return () => { state.disconnect(); replacement.disconnect(); };
  }, []);
  return collapsed;
}

const left = (at: string) => { const m = Math.max(0, Math.round((Date.parse(at) - Date.now()) / 60000)); return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor(m % 1440 / 60)}h` : m >= 60 ? (m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`) : `${m}m`; };
// bb names limit windows by period: 'Weekly limit' reads 7d, a model's weekly window reads '7d · Fable'.
const PERIOD: Record<string, string> = { weekly: '7d', 'five-hour': '5h', daily: '1d' };
export const windowLabel = (w: Window) => { const label = w.label.replace(/\u2063/g, '').trim(), period = w.kind ? PERIOD[w.kind] : undefined; return !period || label.startsWith(period) ? label : /limit/i.test(label) ? period : `${period} · ${label}`; };

// Limit windows that reset (local models have none). The cached value paints immediately when revealed.
const USAGE_CACHE = 'bb-plugin-answers:page:usage-cache';
// The page mounts with the cached usage so the panel shows at once; the always-mounted nav badge keeps that cache fresh
// while the page is away, so returning to it no longer flashes numbers from the last visit.
export function useUsageKeeper() {
  const sdk = useSdk(), enabled = (useSettings().values?.usage ?? 'auto') !== 'never';
  useEffect(() => {
    if (!enabled) return;
    const keep = () => { if (document.visibilityState === 'visible') void Promise.resolve().then(() => sdk.system.usageLimits()).then(data => { try { localStorage.setItem(USAGE_CACHE, JSON.stringify(data)); } catch { /* storage unavailable */ } }).catch(() => {}); };
    keep(); const timer = setInterval(keep, 120000); return () => clearInterval(timer);
  }, [sdk, enabled]);
}
function useUsage(enabled: boolean) {
  // bb unmounts the page when switching plugins; the last numbers show at once while a fresh load runs.
  const sdk = useSdk(), [usage, setUsage] = useStoredState<Record<string, Provider> | null>(USAGE_CACHE, null), [tick, setTick] = useState(0), [reloading, setReloading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const load = () => Promise.resolve().then(() => sdk.system.usageLimits()).then(data => { if (live) setUsage(data as Record<string, Provider>); }).catch(() => {});
    // Like bb, only a manual refresh spins the icon; the 5-minute poll stays quiet.
    void load().finally(() => setReloading(false)); const timer = setInterval(() => void load(), 300000);
    return () => { live = false; clearInterval(timer); };
  }, [sdk, enabled, tick]);
  return { usage, reloading, reload: () => { setReloading(true); setTick(t => t + 1); } };
}

// Mirrors bb's sidebar usage panel (same tokens and layout): provider tabs, refresh, collapse, one section per account.
function UsageSummary({ usage, reload, reloading = false }: { usage: Record<string, Provider> | null; reload: () => void; reloading?: boolean }) {
  const providers = experimental_useProviders().providers;
  const [tab, setTab] = useStoredState<string>('bb-plugin-answers:page:usage-tab', 'all'), [folded, setFolded] = useStoredState('bb-plugin-answers:page:usage-folded', false);
  const all = Object.entries(usage ?? {}).flatMap(([id, p]) => { const windows = p.status === 'ok' ? (p.windows ?? []).filter(w => w.resetsAt) : []; return windows.length ? [{ id, p, windows }] : []; });
  if (!all.length) return null;
  const shown = all.filter(g => tab === 'all' || g.id === tab), tabClass = 'relative flex h-6 shrink-0 items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring';
  const iconButton = 'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground';
  return <div className="px-2 pt-2"><div aria-label="Usage" className="overflow-hidden rounded-lg border border-sidebar-border bg-sidebar-accent/50"><div className="flex max-h-80 flex-col">
    <div className="flex h-9 min-w-0 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5">
      <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <button type="button" aria-pressed={tab === 'all'} className={`${tabClass} px-2 ${tab === 'all' ? 'bg-sidebar-accent text-sidebar-foreground' : 'text-muted-foreground'}`} onClick={() => setTab('all')}><span className="text-2xs font-medium">All</span></button>
        {all.map(({ id }) => { const info = providers.find(p => p.id === id); return <button key={id} type="button" aria-pressed={tab === id} aria-label={info?.displayName ?? id} title={info?.displayName ?? id} className={`${tabClass} group/tab w-7 ${tab === id ? 'bg-sidebar-accent text-sidebar-foreground' : ''}`} onClick={() => setTab(id)}><ProviderIcon providerKind="agent" provider={info ?? { id }} className={`size-3.5 ${tab === id ? '' : 'opacity-60 group-hover/tab:opacity-100'}`} aria-hidden /></button>; })}
      </div>
      <button type="button" aria-label="Refresh usage" aria-busy={reloading} disabled={reloading} className={iconButton} onClick={reload}><Icon name="RotateCcw" aria-hidden className={`size-3.5 ${reloading ? 'animate-spin' : ''}`} /></button>
      <button type="button" aria-label={folded ? 'Expand usage' : 'Collapse usage'} aria-expanded={!folded} className={iconButton} onClick={() => setFolded(!folded)}><Icon name="ChevronDown" aria-hidden className={`size-4 transition-transform ${folded ? 'rotate-180' : ''}`} /></button>
    </div>
    {!folded && <div className="min-h-0 overflow-y-auto p-2.5"><div className="grid grid-cols-[max-content_minmax(0,1fr)_max-content_max-content] gap-x-3 gap-y-2.5">
      {shown.map(({ id, p, windows }) => { const info = providers.find(x => x.id === id); return <div key={id} className="col-span-full grid grid-cols-subgrid gap-y-2 border-t border-sidebar-border pt-2.5 first:border-t-0 first:pt-0"><section className="col-span-full grid grid-cols-subgrid">
        <div className="col-span-full flex h-5 min-w-0 items-center gap-1.5"><ProviderIcon providerKind="agent" provider={info ?? { id }} className="size-3 shrink-0" aria-hidden /><h3 className="min-w-0 flex-1 truncate text-2xs font-medium text-sidebar-foreground">{p.accountEmail ?? info?.displayName ?? id}</h3>{p.planLabel && <span className="shrink-0 rounded-sm bg-sidebar-border/60 px-1 py-0.5 text-2xs leading-none text-subtle-foreground">{p.planLabel}</span>}</div>
        {windows.map(w => { const hot = w.usedPercent >= 80; return <div key={w.label} className="col-span-full grid h-5 grid-cols-subgrid items-center text-2xs">
          <span className="max-w-20 truncate text-subtle-foreground" title={w.label}>{windowLabel(w)}</span>
          <span className="h-1 min-w-0 overflow-hidden rounded-full bg-sidebar-border"><span className={`block h-full rounded-full ${hot ? 'bg-warning' : 'bg-sidebar-foreground'}`} style={{ width: `${Math.min(100, Math.max(1, w.usedPercent))}%` }} /></span>
          <span className={`text-right tabular-nums ${hot ? 'text-warning' : 'text-sidebar-foreground'}`}>{Math.round(w.usedPercent)}%</span>
          <span className="min-w-9 text-right tabular-nums text-subtle-foreground">{left(w.resetsAt!)}</span>
        </div>; })}
      </section></div>; })}
    </div></div>}
  </div></div></div>;
}

export function ContactsFooter() {
  const rpc = useRpc<AnswersRpcContract>(), values = useSettings().values, collapsed = useBbSidebarCollapsed();
  const [open, setOpen] = useState(false), [error, setError] = useState(''), menu = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close); return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const groupByProject = values?.groupByProject === true, usage = (values?.usage ?? 'auto') as Usage, showUsage = usage === 'always' || (usage === 'auto' && collapsed), usageData = useUsage(showUsage);
  const set = (prefs: { groupByProject?: boolean; usage?: Usage }) => { setError(''); void rpc.call('setPreferences', prefs).catch(e => setError(e instanceof Error ? e.message : String(e))); };
  const item = 'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover';
  return <div>
    {showUsage && <UsageSummary {...usageData} />}
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
