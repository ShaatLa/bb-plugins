import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Markdown, UrlLink, useRpc, experimental_useRpcQuery as useQuery, experimental_useRpcRefresh, experimental_useAppPanel } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type Pool, type PoolEntry, type ListResult } from './contract';
import { Button } from './components/ui/button';
import { ItemCard } from './app';
import { clipSelection, selectionMarkdown, selectionPosition } from './selection';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const poolsTab = { id: 'pools', context: { kind: 'nav-panel' as const, panelId: 'answers' }, availability: 'fixed' as const };
type Draft = { threadId: string; itemId: string; quote: string; quoteSeq?: number; top: number; left: number };

// Each page follows the freshly returned cursor of its predecessor; depth lives above the chain.
function HistoryPage({ threadId, cursor, index, depth, receive }: { threadId: string; cursor?: string; index: number; depth: number; receive: (index: number, data: ListResult) => void }) {
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view: 'all', threadId, limit: 50, ...(cursor ? { cursor } : {}) } });
  useEffect(() => { if (result.data) receive(index, result.data); }, [result.data, index, receive]);
  return <>{result.error && <p role="alert">{result.error.message}<Button onClick={() => void result.refetch()}>Retry</Button></p>}{result.data?.nextCursor && index + 1 < depth && <HistoryPage {...{ threadId, depth, receive }} index={index + 1} cursor={result.data.nextCursor} />}</>;
}
export function Inbox() {
  const rpc = useRpc<AnswersRpcContract>(), { refresh } = experimental_useRpcRefresh(), panel = experimental_useAppPanel();
  const [selected, setSelected] = useState<string>();
  const result = useQuery({ contract: rpcContract, method: 'recipients', input: selected ? { selected } : {} });
  const [draft, setDraft] = useState<Draft | null>(null), [text, setText] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null);
  const [depth, setDepth] = useState(1), [pages, setPages] = useState<ListResult[]>([]);
  const receive = useRef((index: number, data: ListResult) => setPages(old => { const next = [...old]; next[index] = data; if (!data.nextCursor) next.length = index + 1; return next; })).current;
  const position = useRef({ height: 0, top: 0, bottom: true });
  useLayoutEffect(() => {
    const node = scroll.current; if (!node) return;
    const old = position.current;
    node.scrollTop = old.bottom ? node.scrollHeight : old.top + node.scrollHeight - old.height;
    position.current = { height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 24 };
  }, [pages]);
  useEffect(() => {
    if (!draft) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setDraft(null); };
    const outside = (e: PointerEvent) => { if ((e.target as Element).closest?.('[role=option]')) return; if (popup.current && !popup.current.contains(e.target as Node)) setDraft(null); };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setDraft(old => old && ({ ...old, left: Math.max(8, Math.min(old.left, (scroll.current?.clientWidth ?? 336) - 328)) })));
    if (scroll.current) observer?.observe(scroll.current);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); observer?.disconnect(); };
  }, [!!draft]);
  function capture(event: React.SyntheticEvent) {
    const body = (event.target as Element).closest<HTMLElement>('[data-agent-body]'), selection = window.getSelection();
    if (!body || !selected || !selection || selection.rangeCount !== 1 || selection.isCollapsed || !scroll.current) return;
    const range = clipSelection(selection.getRangeAt(0), body); if (!range) return;
    const quote = selectionMarkdown(range, body); if (!quote.trim()) return;
    setDraft({ threadId: selected, itemId: body.dataset.item!, quote, quoteSeq: body.dataset.seq ? Number(body.dataset.seq) : undefined, ...selectionPosition(range, scroll.current) });
    setText(''); setError(quote.length > 20000 ? 'Quote exceeds 20,000 characters' : '');
  }
  async function send(pool: boolean) {
    if (!draft || pending || draft.quote.length > 20000) return;
    setPending(true); setError('');
    try {
      if (pool) { await rpc.call('poolAdd', { threadId: draft.threadId, quote: draft.quote, itemId: draft.itemId, ...(draft.quoteSeq === undefined ? {} : { quoteSeq: draft.quoteSeq }), note: text }); panel.openTab({ tab: poolsTab }); }
      else await rpc.call('quoteReply', { threadId: draft.threadId, quote: draft.quote, itemId: draft.itemId, text });
      refresh(); setDraft(null);
    } catch (e) { setError(pool ? errorText(e) : `Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setPending(false); }
  }
  const seen = new Set<string>();
  const items = pages.slice(0, depth).flatMap(page => page.items).filter(item => !seen.has(item.id) && !!seen.add(item.id)).reverse();
  return <div className="grid min-[640px]:grid-cols-[minmax(220px,280px)_1fr] h-[70vh] gap-3">
    <div role="listbox" aria-label="Recipients" className={`overflow-auto ${selected ? 'max-[639px]:hidden' : ''}`}>
      {result.error && <p role="alert">{result.error.message}</p>}
      {result.data?.recipients.length === 0 && <p>No unread answers</p>}
      {result.data?.recipients.map(recipient => <button key={recipient.threadId} role="option" aria-selected={selected === recipient.threadId} className="block w-full text-left border-b p-3" onKeyDown={event => { if (event.key === 'ArrowDown') (event.currentTarget.nextElementSibling as HTMLElement)?.focus(); if (event.key === 'ArrowUp') (event.currentTarget.previousElementSibling as HTMLElement)?.focus(); }} onClick={async () => {
        if (selected !== recipient.threadId) { setPages([]); setDepth(1); position.current = { height: 0, top: 0, bottom: true }; setSelected(recipient.threadId); }
        try { await rpc.call('markThreadRead', { threadId: recipient.threadId }); refresh(); } catch (e) { setError(errorText(e)); }
      }}><strong>{recipient.threadTitle ?? 'Untitled thread'}</strong><span className="block text-xs">{recipient.projectName} · {recipient.unread} unread · {Math.max(0, Math.floor((Date.now() - recipient.lastAt) / 60000))}m ago</span><span className="block truncate">{recipient.preview}</span></button>)}
    </div>
    <div ref={scroll} className={`relative overflow-auto min-w-0 ${!selected ? 'max-[639px]:hidden' : ''}`} onMouseUp={capture} onKeyUp={capture} onScroll={event => { const node = event.currentTarget; position.current = { height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 24 }; }}>
      {selected && <><Button className="min-[640px]:hidden" onClick={() => setSelected(undefined)}>Back</Button><HistoryPage key={selected} threadId={selected} index={0} {...{ depth, receive }} />{pages.at(-1)?.nextCursor && <Button onClick={() => { position.current.bottom = false; setDepth(depth + 1); }}>Load earlier</Button>}<ul className="space-y-3" aria-label="History">{items.map(item => <ItemCard key={item.id} item={item} />)}</ul></>}
      {draft && <div ref={popup} role="dialog" aria-label="Quote reply" className="absolute z-10 w-80 max-w-full rounded border bg-background p-3 shadow-lg" style={{ top: draft.top, left: draft.left }} onBlur={event => { if (event.relatedTarget && !(event.relatedTarget as Element).closest?.('[role=option]') && !event.currentTarget.contains(event.relatedTarget as Node)) setDraft(null); }}>
        <Markdown content={draft.quote} /><textarea aria-label="Quote reply text" maxLength={8000} value={text} onChange={e => setText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(false); } }} />
        <Button disabled={pending || draft.quote.length > 20000} onClick={() => void send(false)}>Send</Button><Button disabled={pending || draft.quote.length > 20000} onClick={() => void send(true)}>Add to pool</Button><Button onClick={() => setDraft(null)}>Close</Button>{error && <p role="alert">{error}</p>}
      </div>}
      {!draft && error && <p role="alert">{error}</p>}
    </div>
  </div>;
}

type Editor = { flush: () => Promise<void> };
function PoolNote({ entry, editors }: { entry: PoolEntry; editors: Map<string, Editor> }) {
  const rpc = useRpc<AnswersRpcContract>(), { refresh } = experimental_useRpcRefresh();
  const [note, setNote] = useState(entry.note), [status, setStatus] = useState('Saved'), [expanded, setExpanded] = useState(false), [clamped, setClamped] = useState(false);
  const quote = useRef<HTMLDivElement>(null);
  const local = useRef({ note: entry.note, saved: entry.note, revision: entry.revision, flight: null as Promise<void> | null });
  useEffect(() => { const node = quote.current; if (node) setClamped(node.scrollHeight > node.clientHeight + 1); }, [entry.quote]);
  useEffect(() => { if (entry.revision > local.current.revision) { const clean = local.current.note === local.current.saved; local.current.revision = entry.revision; local.current.saved = entry.note; if (clean) { local.current.note = entry.note; setNote(entry.note); } } }, [entry.revision, entry.note]);
  async function flush(): Promise<void> {
    const state = local.current;
    if (state.flight) await state.flight;
    if (state.note === state.saved) return;
    const saving = state.note;
    setStatus('Saving…');
    state.flight = rpc.call('poolUpdate', { id: entry.id, note: saving, revision: state.revision }).then(result => { state.revision = result.revision; state.saved = saving; setStatus('Saved'); refresh(); }).catch(e => { setStatus(`Not saved: ${errorText(e)}`); refresh(); throw e; }).finally(() => { state.flight = null; });
    await state.flight;
    if (state.note !== state.saved) await flush();
  }
  editors.set(entry.id, { flush });
  useEffect(() => () => { editors.delete(entry.id); }, [entry.id, editors]);
  useEffect(() => { if (note === local.current.saved) return; const timer = setTimeout(() => { void flush().catch(() => {}); }, 800); return () => clearTimeout(timer); }, [note]);
  return <div className="border rounded p-3 space-y-2"><div ref={quote} className={expanded ? '' : 'line-clamp-3'}><Markdown content={entry.quote.split('\n').map(line => `> ${line}`).join('\n')} /></div>{(clamped || expanded) && <Button onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse' : 'Expand'}</Button>}
    <textarea aria-label="Pool note" className="w-full border rounded bg-transparent" maxLength={8000} value={note} onChange={e => { local.current.note = e.target.value; setNote(e.target.value); setStatus('Not saved'); }} onBlur={() => void flush().catch(() => {})} /><p role="status">{status}</p><Button onClick={async () => { try { await rpc.call('poolRemove', { id: entry.id }); refresh(); } catch (e) { setStatus(errorText(e)); } }}>Remove</Button></div>;
}
function ReplyPool({ pool, setFeedback }: { pool: Pool; setFeedback: (text: string) => void }) {
  const rpc = useRpc<AnswersRpcContract>(), { refresh } = experimental_useRpcRefresh();
  const editors = useRef(new Map<string, Editor>()).current;
  const [pending, setPending] = useState(false);
  return <section className="space-y-3 p-3 border-b"><h2><UrlLink href={`${pool.projectId ? `/projects/${pool.projectId}` : ''}/threads/${pool.threadId}`}>{pool.threadTitle ?? 'Untitled thread'}</UrlLink> · {pool.entries.length}</h2>{pool.entries.map(entry => <PoolNote key={entry.id} {...{ entry, editors }} />)}<Button disabled={pending} onClick={async () => {
    setPending(true); setFeedback('');
    try {
      try { await Promise.all([...editors.values()].map(editor => editor.flush())); } catch (e) { setFeedback(`Not sent — ${errorText(e)}`); return; }
      const result = await rpc.call('poolSend', { threadId: pool.threadId }); refresh(); setFeedback(`${result.delivery === 'sent' ? 'Sent' : 'Queued'}${result.keptEdited ? ` — ${result.keptEdited} edited entries were not sent` : ''}`);
    } catch (e) { setFeedback(`Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setPending(false); }
  }}>{pending ? 'Sending…' : 'Send all'}</Button></section>;
}
export function Pools({ threadId }: { threadId?: string }) {
  const [feedback, setFeedback] = useState('');
  const result = useQuery({ contract: rpcContract, method: 'pools', input: {} });
  const pools = result.data?.pools.filter(pool => !threadId || pool.threadId === threadId);
  return <div className="h-full overflow-auto">{feedback && <p role="status">{feedback}</p>}{result.error && <p role="alert">{result.error.message}</p>}{pools?.length === 0 && <p>Select text in an answer and choose Add to pool.</p>}{pools?.map(pool => <ReplyPool key={pool.threadId} pool={pool} setFeedback={setFeedback} />)}</div>;
}
