import { useEffect, useState } from 'react';
import { useRpc } from '@get-bb/plugin-sdk/app';
import type { AnswersRpcContract, Cost } from './contract';

type ThreadCost = { own: Cost; total: Cost; descendantCount: number };
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
  const rpc = useRpc<AnswersRpcContract>(), [cost, setCost] = useState(() => threadId ? known.get(threadId) ?? null : null);
  useEffect(() => {
    if (!threadId) return;
    setCost(known.get(threadId) ?? null);
    if (working) return;
    let live = true;
    const read = () => { readAt.set(threadId, Date.now()); void rpc.call('threadCost', { threadId }).then(r => {
    // No tokens yet usually means Tokenomos has not matched this thread (e.g. still backfilling), so show nothing rather than $0.00.
    const next = r.available && r.own && r.total && tokens(r.total) > 0 ? { own: r.own, total: r.total, descendantCount: r.descendantCount } : null; known.set(threadId, next); if (live) setCost(next); }).catch(() => {}); };
    const timer = setTimeout(read, Math.max(0, 10000 - (Date.now() - (readAt.get(threadId) ?? 0))));
    return () => { live = false; clearTimeout(timer); };
  }, [rpc, threadId, working]);
  return threadId ? cost : null;
}

export function ThreadCostLabel({ cost }: { cost: ThreadCost | null }) {
  if (!cost) return null;
  const subs = cost.descendantCount, own = money(cost.own), total = money(cost.total);
  const title = `This session: ${own} (${compact(tokens(cost.own))} tokens)${subs ? `\nWith ${subs} sub-session${subs === 1 ? '' : 's'}: ${total} (${compact(tokens(cost.total))} tokens)` : ''}\nAPI-equivalent cost, by Tokenomos`;
  return <span title={title} aria-label={title.replaceAll('\n', '. ')} className="mr-auto flex min-w-0 items-center gap-1.5 truncate text-xs tabular-nums text-muted-foreground">
    <span>{own}</span>{subs > 0 && <span className="text-subtle-foreground">· {total} with {subs} sub{subs === 1 ? '' : 's'}</span>}
  </span>;
}
