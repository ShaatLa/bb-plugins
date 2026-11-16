import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { useSdk } from '@get-bb/plugin-sdk/app';

// A port of bb's composer context ring and its hover card (same markup, tokens and texts); the SDK exports neither.
export type ContextUsage = NonNullable<Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['context']>>['usage']>;
type Details = NonNullable<ContextUsage['snapshot']>;
type Category = Details['categories'][number];

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
const COLORS = ['var(--ansi-4)', 'var(--ansi-1)', 'var(--ansi-3)', 'var(--ansi-5)', 'var(--ansi-6)', 'var(--ansi-2)', 'var(--ansi-8)'];
const short = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 0 });
const tokens = (n: number) => short.format(Math.max(0, Math.round(n))).toLowerCase();
export const percentUsed = (u: ContextUsage) => u.modelContextWindow <= 0 ? 0 : Math.round(Math.min(Math.max(u.usedTokens / u.modelContextWindow, 0), 1) * 100);
const tone = (p: number) => p >= 90 ? 'text-destructive' : p >= 75 ? 'text-warning-text' : 'text-muted-foreground';
function money(cost: NonNullable<ContextUsage['cost']>) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cost.currency, minimumFractionDigits: 2, maximumFractionDigits: cost.amount < 1 ? 4 : 2 }).format(cost.amount); } catch { return `${cost.amount} ${cost.currency}`; }
}
const Chevron = ({ d, className }: { d: string; className: string }) => <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" aria-hidden data-icon-root="" className={className}><path d={d} /></svg>;

function Reveal({ id, open, children }: { id: string; open: boolean; children: ReactNode }) {
  return <div id={id} aria-hidden={!open} inert={!open} className={cx('grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none', open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0')}><div className="min-h-0 overflow-hidden">{children}</div></div>;
}

function CategoryRow({ category, color, capacity }: { category: Category; color: string; capacity: number }) {
  const [open, setOpen] = useState(false), id = useId(), expandable = category.entries.length > 0, counted = category.kind !== 'deferred';
  const label = counted ? category.label : category.label.replace(/\s*\(deferred\)$/i, '');
  const body = <>
    <span aria-hidden className={cx('size-3 shrink-0 rounded-[3px]', (category.kind === 'free' || category.kind === 'reserved') && 'border border-border')} style={{ backgroundColor: category.kind === 'used' ? color : 'var(--border)' }} />
    <span className="min-w-0 flex-1 text-left">{label}</span>
    <span className="flex shrink-0 items-baseline gap-2 tabular-nums @max-[20rem]/context-window:flex-col @max-[20rem]/context-window:items-end @max-[20rem]/context-window:gap-0"><span>{category.tokens.toLocaleString('en-US')}</span>{counted && <span className="w-12 text-right text-xs text-muted-foreground">{(category.tokens / capacity * 100).toFixed(1)}%</span>}</span>
    <Chevron d="m6 4 4 4-4 4" className={cx('size-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-out motion-reduce:transition-none', open && 'rotate-90', !expandable && 'invisible')} />
  </>;
  const row = cx('flex w-full items-center gap-2 py-1.5 text-xs max-md:pointer-coarse:text-sm', category.kind === 'used' ? 'text-foreground' : 'text-muted-foreground');
  return <div>
    {expandable ? <button type="button" className={cx(row, 'cursor-pointer rounded-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')} aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>{body}</button> : <div className={row}>{body}</div>}
    {expandable && <Reveal id={id} open={open}><div className={cx('space-y-1 pb-2 pl-5 pr-5 text-xs text-muted-foreground max-md:pointer-coarse:text-sm', counted && 'pr-[4.75rem] @max-[20rem]/context-window:pr-5')}>{category.entries.map(entry => <div key={entry.id} className="flex items-baseline gap-3"><span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{entry.label}</span><span className="shrink-0 tabular-nums">{entry.tokens.toLocaleString('en-US')}</span></div>)}</div></Reveal>}
  </div>;
}

function Breakdown({ details, capacity }: { details: Details; capacity: number }) {
  const used = details.categories.filter(c => c.kind === 'used'), spare = details.categories.filter(c => c.kind === 'free' || c.kind === 'reserved'), deferred = details.categories.filter(c => c.kind === 'deferred');
  return <div className="mt-2"><div className="mx-2 border-t border-border-hairline max-md:mx-4" /><div className="max-h-[min(32rem,55dvh)] overflow-y-auto overscroll-contain"><div className="px-2 pt-2 max-md:px-4">
    <h3 className="pb-1 text-xs font-medium text-muted-foreground">In context</h3>
    {used.map((c, i) => <CategoryRow key={c.id} category={c} capacity={capacity} color={COLORS[i % COLORS.length]!} />)}
    {spare.length > 0 && <div className="mt-1 border-t border-border-hairline pt-1">{spare.map(c => <CategoryRow key={c.id} category={c} capacity={capacity} color="var(--muted-foreground)" />)}</div>}
    {deferred.length > 0 && <section className="mt-2 border-t border-border-hairline pt-2"><h3 className="text-xs font-medium text-muted-foreground">Available on demand</h3><p className="mt-1 mb-1 text-xs text-muted-foreground">Loaded when needed. Excluded from current usage.</p>{deferred.map(c => <CategoryRow key={c.id} category={c} capacity={capacity} color="var(--muted-foreground)" />)}</section>}
  </div></div></div>;
}

/** bb's context card: used and left, the session cost, and with a provider snapshot the per-category breakdown. */
export function ContextCard({ usage }: { usage: ContextUsage }) {
  const details = usage.snapshot?.categories.length ? usage.snapshot : undefined, [open, setOpen] = useState(false), id = useId();
  const p = percentUsed(usage), fill = Math.min(Math.max(p, 0), 100), color = tone(p), wide = !!details && open;
  return <div className={cx('@container/context-window w-56 rounded-md border bg-popover p-2 text-popover-foreground shadow-md max-md:pointer-coarse:px-4', details && 'transition-[width] duration-200 ease-out motion-reduce:transition-none', wide && 'w-90')}>
    <div className="flex flex-col gap-2 max-md:pointer-coarse:gap-3">
      <div className="flex items-baseline justify-between gap-2 text-xs max-md:pointer-coarse:text-sm"><span className={cx('text-muted-foreground', wide && 'font-medium text-foreground')}>{usage.estimated ? 'Estimated context' : 'Context window'}</span><span className={cx('font-medium tabular-nums', color)}>{p}% used</span></div>
      <div className={cx('relative h-1.5 w-full overflow-hidden rounded-full bg-border transition-[height] duration-200 motion-reduce:transition-none max-md:pointer-coarse:h-2', wide && 'order-2 h-4 max-md:pointer-coarse:h-5')}>
        <div className={cx('h-full rounded-full bg-current transition-opacity duration-200 ease-out motion-reduce:transition-none', color, wide && 'opacity-0')} style={{ width: `${fill}%` }} />
        {details && <div aria-hidden className={cx('pointer-events-none absolute inset-0 flex transition-opacity duration-200 ease-out motion-reduce:transition-none', open ? 'opacity-100' : 'opacity-0')}>{details.categories.filter(c => c.kind === 'used').map((c, i) => <div key={c.id} className="h-full shrink-0" style={{ width: `${c.tokens / usage.modelContextWindow * 100}%`, backgroundColor: COLORS[i % COLORS.length] }} />)}</div>}
      </div>
      <div className={cx('flex items-baseline justify-between gap-2 text-xs tabular-nums text-muted-foreground max-md:pointer-coarse:text-sm', wide && 'order-1')}><span><span className={cx(wide && 'font-medium text-foreground')}>{tokens(usage.usedTokens)}</span> / {tokens(usage.modelContextWindow)} tokens</span><span>{Math.max(0, 100 - p)}% left</span></div>
      {usage.cost && <div className={cx('flex items-baseline justify-between gap-2 text-xs tabular-nums text-muted-foreground max-md:pointer-coarse:text-sm', wide && 'order-3')}><span>Session cost</span><span>{money(usage.cost)}</span></div>}
    </div>
    {details && <>
      <div className="-mx-2 max-md:pointer-coarse:-mx-4"><Reveal id={id} open={open}><Breakdown details={details} capacity={usage.modelContextWindow} /></Reveal></div>
      <button type="button" className="ml-auto mt-2 flex cursor-pointer items-center gap-1.5 rounded-xs text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-md:pointer-coarse:mt-3 max-md:pointer-coarse:py-1 max-md:pointer-coarse:text-sm" aria-expanded={open} aria-controls={id} onClick={() => setOpen(o => !o)}>
        {open ? 'Hide details' : 'Show details'}<Chevron d="m4 6 4 4 4-4" className={cx('size-3 transition-transform duration-200 ease-out motion-reduce:transition-none', open && 'rotate-180')} />
      </button>
    </>}
  </div>;
}

/** bb's composer context ring: opens its card on hover or click, above the ring, aligned to its right edge. */
export function ContextRing({ usage }: { usage: ContextUsage }) {
  const p = percentUsed(usage), fill = Math.min(Math.max(p, 0), 100), c = 2 * Math.PI * 6.5, color = tone(p);
  const hoverable = !!usage.snapshot?.categories.length, [open, setOpen] = useState(false), [at, setAt] = useState<CSSProperties>(), trigger = useRef<HTMLButtonElement>(null), card = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // bb keeps the card up a little longer when it has details to reach with the pointer.
  const show = () => { clearTimeout(timer.current); setOpen(true); }, hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), hoverable ? 200 : 60); };
  const hover = { onPointerEnter: (e: ReactPointerEvent) => { if (e.pointerType === 'mouse') show(); }, onPointerLeave: (e: ReactPointerEvent) => { if (e.pointerType === 'mouse') hide(); } };
  // Fixed to the viewport so the composer's box never clips it.
  useLayoutEffect(() => { if (!open || !trigger.current) return; const r = trigger.current.getBoundingClientRect(); setAt({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 8 }); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => { if (!trigger.current?.contains(e.target as Node) && !card.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    const close = () => { clearTimeout(timer.current); setOpen(false); };
    const scrolled = (event: Event) => { if (event.target === document || event.target === window || (event.target instanceof Element && event.target.contains(trigger.current))) close(); };
    const containers: { node: HTMLElement; width: number; height: number }[] = [];
    for (let node = trigger.current?.parentElement; node; node = node.parentElement) { const rect = node.getBoundingClientRect(); containers.push({ node, width: rect.width, height: rect.height }); }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => { if (containers.some(({ node, width, height }) => { const rect = node.getBoundingClientRect(); return rect.width !== width || rect.height !== height; })) close(); });
    containers.forEach(({ node }) => observer?.observe(node));
    document.addEventListener('pointerdown', away); document.addEventListener('keydown', esc); window.addEventListener('scroll', scrolled, true); window.addEventListener('resize', close);
    return () => { observer?.disconnect(); document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); window.removeEventListener('scroll', scrolled, true); window.removeEventListener('resize', close); };
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <>
    <button ref={trigger} type="button" {...hover} aria-label={`Context window ${p}% used`} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(o => !o)} className="-m-1 inline-flex size-8 cursor-pointer max-md:pointer-coarse:my-0 max-md:pointer-coarse:-mr-3 max-md:pointer-coarse:-ml-1 max-md:pointer-coarse:h-11 max-md:w-auto max-md:gap-1.5 max-md:pointer-coarse:pl-2 max-md:pointer-coarse:pr-3.5 items-center justify-center rounded-full transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span aria-hidden className={cx('hidden text-xs tabular-nums max-md:inline', color)}>{p}%</span>
      <svg viewBox="0 0 16 16" className={cx('size-4', color)} aria-hidden><circle cx="8" cy="8" r={6.5} fill="none" strokeWidth="3" className="stroke-border-hairline" /><circle cx="8" cy="8" r={6.5} fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - fill / 100)} transform="rotate(-90 8 8)" className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none" /></svg>
    </button>
    {/* shortcut: phones get the same floating card, not bb's bottom sheet; port the sheet if the card proves cramped there. */}
    {open && at && <div ref={card} role="dialog" aria-label={usage.estimated ? 'Estimated context' : 'Context window'} className="fixed z-[100]" style={at} {...(hoverable ? hover : {})}><ContextCard usage={usage} /></div>}
  </>;
}
