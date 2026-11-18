import { RollingText } from './rolling-text';
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { AgentHubRpcContract, Cost } from './contract';

type ThreadCost = { threadId: string; own: Cost; total: Cost; descendantCount: number };
// Last known cost per thread, so switching chats paints at once while a fresh read runs.
const known = new Map<string, ThreadCost | null>(), readAt = new Map<string, number>();
const tokens = (c: Cost) => c.tokens.freshIn + c.tokens.cacheRead + c.tokens.cacheWrite + c.tokens.output;
const compact = (n: number) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
// API-equivalent dollars; "~" when Tokenomos estimated a price or misses some data; tokens when no model price is known.
export function money(c: Cost) {
  if (c.usd === null) return `${compact(tokens(c))} tokens`;
  return `${c.estimated || c.partial ? '~' : ''}$${c.usd < 10 ? c.usd.toFixed(2) : Math.round(c.usd).toLocaleString('en-US')}`;
}

/** Tokenomos' cost of the open chat's session and its sub-sessions: read on open and when a turn ends, at most once per 10 s. */
export function useThreadCost(threadId: string | null | undefined, working: boolean) {
  const rpc = useRpc<AgentHubRpcContract>(), [cost, setCost] = useState(() => ({ threadId, value: threadId ? known.get(threadId) ?? null : null }));
  useEffect(() => {
    if (!threadId) return;
    setCost({ threadId, value: known.get(threadId) ?? null });
    if (working) return;
    let live = true;
    const read = () => { readAt.set(threadId, Date.now()); void rpc.call('threadCost', { threadId }).then(r => {
    // No tokens yet usually means Tokenomos has not matched this thread (e.g. still backfilling), so show nothing rather than $0.00.
    const next = r.available && r.own && r.total && tokens(r.total) > 0 ? { threadId, own: r.own, total: r.total, descendantCount: r.descendantCount } : null; known.set(threadId, next); if (live) setCost({ threadId, value: next }); }).catch(() => {}); };
    const timer = setTimeout(read, Math.max(0, 10000 - (Date.now() - (readAt.get(threadId) ?? 0))));
    return () => { live = false; clearTimeout(timer); };
  }, [rpc, threadId, working]);
  return threadId ? cost.threadId === threadId ? cost.value : known.get(threadId) ?? null : null;
}

type Details = { available: boolean; today: Cost | null; week: Cost | null; models: { provider: string; model: string; cost: Cost; calls: number }[] };
// Tokenomos' series colors (components/colors.ts), slots 1..5; "Other" is the muted foreground.
const SLOTS = ['light-dark(#ea580c, #fb923c)', 'light-dark(#2563eb, #60a5fa)', 'light-dark(#9333ea, #c084fc)', 'light-dark(#e11d48, #fb7185)', 'light-dark(#65a30d, #a3e635)'];
type Slice = { name: string; label: string; usd: number; color: string; opacity?: number };
const SIZE = 64, RING = 10, GAP = 2, R = (SIZE - RING) / 2, CIRC = 2 * Math.PI * R;
const Row = ({ label, value }: { label: string; value: string }) => <div className="flex justify-between gap-3"><span className="text-muted-foreground">{label}</span><span className="text-foreground tabular-nums">{value}</span></div>;

// Anchored under the chip, right-aligned to it; in a portal so the header cannot clip it.
function CostDetails({ anchor, cost, onClose }: { anchor: HTMLElement; cost: ThreadCost; onClose: () => void }) {
  const rpc = useRpc<AgentHubRpcContract>(), [at, setAt] = useState<CSSProperties | null>(null), [details, setDetails] = useState<Details | 'loading'>('loading'), box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    // The chip sits under the composer: open upward there, as RowPopover does.
    const place = () => { const r = anchor.getBoundingClientRect(); setAt({ right: Math.max(8, window.innerWidth - r.right), ...(r.top > window.innerHeight / 2 ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) }); };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  useEffect(() => {
    let live = true;
    void rpc.call('threadCostDetails', { threadId: cost.threadId, today: new Date().setHours(0, 0, 0, 0), week: Date.now() - 7 * 86400000 })
      .then(r => { if (live) setDetails(r); }).catch(() => { if (live) setDetails({ available: false, today: null, week: null, models: [] }); });
    return () => { live = false; };
  }, [rpc, cost.threadId]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const down = (e: MouseEvent) => { const n = e.target as Node; if (!box.current?.contains(n) && !anchor.contains(n)) onClose(); };
    document.addEventListener('keydown', key); document.addEventListener('mousedown', down);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('mousedown', down); };
  }, [anchor, onClose]);
  const subs = cost.descendantCount, ready = details !== 'loading' && details.available ? details : null;
  const period = (c: Cost | null | undefined) => details === 'loading' ? '…' : c ? money(c) : '—';
  const total = ready?.models.reduce((n, m) => n + (m.cost.usd ?? 0), 0) ?? 0, top = ready?.models.slice(0, 5) ?? [], rest = ready?.models.slice(5) ?? [];
  const pct = (usd: number | null) => total > 0 && usd !== null ? `${usd > 0 && usd / total < 0.005 ? '<1' : Math.round(usd / total * 100)}%` : '';
  const other = rest.reduce((n, m) => n + (m.cost.usd ?? 0), 0);
  const slices: Slice[] = top.map((m, i) => ({ name: m.model, label: `${money(m.cost)}${pct(m.cost.usd) && ` · ${pct(m.cost.usd)}`}`, usd: m.cost.usd ?? 0, color: SLOTS[i] }));
  if (rest.length > 0) slices.push({ name: 'Other', label: `${money({ ...rest[0].cost, usd: rest.every(m => m.cost.usd !== null) ? other : null })}${pct(other) && ` · ${pct(other)}`}`, usd: other, color: 'var(--color-muted-foreground)', opacity: 0.4 });
  let from = 0;
  // Hovering a slice or its legend row grows the slice and marks the row, so the two read as one.
  const [hot, setHot] = useState<string | null>(null);
  const arcs = slices.map(x => { const len = total > 0 ? x.usd / total * CIRC : 0, start = from; from += len; return { x, start, dash: Math.max(0, len - GAP) }; });
  const group = 'mt-2 space-y-1 border-t border-border-hairline pt-2';
  const sub = cost.total.usd !== null && cost.own.usd !== null ? { ...cost.total, usd: Math.max(0, cost.total.usd - cost.own.usd) } : { ...cost.total, usd: null };
  return at && createPortal(<div ref={box} role="dialog" aria-label="Cost details" className="fixed z-[100] w-80 rounded-lg border border-border bg-background p-3 text-xs shadow-lg" style={at}>
    <div className="space-y-1"><Row label="This session" value={money(cost.own)} />{subs > 0 && <Row label={`Sub-sessions (${subs})`} value={money(sub)} />}<Row label="Total" value={money(cost.total)} /></div>
    <div className={group}>{details !== 'loading' && !details.available ? <p className="text-muted-foreground">Details unavailable</p> : <><Row label="Today" value={period(ready?.today)} /><Row label="Last 7 days" value={period(ready?.week)} /></>}</div>
    {ready && ready.models.length > 0 && <div className={`${group} flex items-center gap-3`}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} className="shrink-0 overflow-visible" role="img" aria-label={`Cost by model: ${slices.map(x => `${x.name} ${x.label.split(' · ')[1] ?? ''}`.trim()).join(', ')}`}>
        <g transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}>{arcs.filter(a => a.x.usd > 0 && a.dash > 0).map(a => <circle key={a.x.name} data-slice={a.x.name} cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke={a.x.color} strokeOpacity={(a.x.opacity ?? 1) * (hot && hot !== a.x.name ? 0.45 : 1)} strokeWidth={hot === a.x.name ? RING + 2 : RING} strokeDasharray={`${a.dash} ${CIRC - a.dash}`} strokeDashoffset={-a.start} className="cursor-default transition-[stroke-width,stroke-opacity] duration-150" onMouseEnter={() => setHot(a.x.name)} onMouseLeave={() => setHot(null)} />)}</g>
      </svg>
      <div className="min-w-0 flex-1 space-y-1">{slices.map(x => <div key={x.name} data-legend={x.name} data-hot={hot === x.name || undefined} className={`-mx-1 flex items-center gap-2 rounded px-1 transition-colors ${hot === x.name ? 'bg-state-hover' : ''}`} onMouseEnter={() => setHot(x.name)} onMouseLeave={() => setHot(null)}><span className="h-2 w-2 shrink-0 rounded-full" style={{ background: x.color, opacity: x.opacity }} /><span className="min-w-0 flex-1 truncate text-foreground">{x.name}</span><span className="tabular-nums text-muted-foreground">{x.label}</span></div>)}</div>
    </div>}
  </div>, document.body);
}

export function ThreadCostLabel({ cost, className = '' }: { cost: ThreadCost | null; className?: string }) {
  const [open, setOpen] = useState(false), [anchor, setAnchor] = useState<HTMLButtonElement | null>(null), id = cost?.threadId;
  useEffect(() => setOpen(false), [id]);
  if (!cost) return null;
  const subs = cost.descendantCount, own = money(cost.own), total = money(cost.total);
  const title = `This session: ${own} (${compact(tokens(cost.own))} tokens)${subs ? `\nWith ${subs} sub-session${subs === 1 ? '' : 's'}: ${total} (${compact(tokens(cost.total))} tokens)` : ''}\nAPI-equivalent cost, by Tokenomos. Click for details`;
  // A click toggles the details; shift- or cmd-click is left alone.
  return <><button ref={setAnchor} type="button" title={title} aria-label={title.replaceAll('\n', '. ')} aria-haspopup="dialog" aria-expanded={open} onClick={event => { if (event.metaKey || event.ctrlKey || event.shiftKey) return; setOpen(o => !o); }} className={`flex min-w-0 cursor-pointer items-center gap-1.5 truncate rounded-md px-1 text-xs tabular-nums text-muted-foreground hover:text-foreground ${className}`}>
    <RollingText text={own} />
  </button>{open && anchor && <CostDetails anchor={anchor} cost={cost} onClose={() => setOpen(false)} />}</>;
}
