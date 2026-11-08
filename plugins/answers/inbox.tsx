import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, Markdown, UrlLink, useRpc, useSdk, experimental_useRpcQuery as useQuery, experimental_useRpcRefresh, experimental_useAppPanel } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type Pool, type PoolEntry, type ListResult, type Attachment, type SendOptions } from './contract';
import { Button } from './components/ui/button';
import { useStoredState } from './lib/stored-state';
import { ItemCard, isUnread } from './app';
import { Composer, SendButton } from './composer';
import { EmptyState, useTransientText } from './empty';
import { clipSelection, selectionMarkdown, selectionPosition } from './selection';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const SCROLL_KEY = 'bb-plugin-answers:page:scroll';
const COMPOSE_KEY = 'bb-plugin-answers:page:compose';
type ComposeDraft = { text: string; files: Attachment[] };
function composeDrafts(): Record<string, ComposeDraft> { try { return JSON.parse(localStorage.getItem(COMPOSE_KEY) ?? '{}'); } catch { return {}; } }
function groupItems(items: Item[]) { const groups: Item[][] = []; for (const item of items) { const last = groups.at(-1)?.at(-1); if (item.kind === 'mine' && item.turnId && item.answerSeq !== null && last?.kind === 'mine' && last.turnId === item.turnId && last.answerSeq === item.answerSeq) groups.at(-1)!.push(item); else groups.push([item]); } return groups; }
const poolsTab = { id: 'pools', context: { kind: 'nav-panel' as const, panelId: 'answers' }, availability: 'fixed' as const };
type Draft = { threadId: string; projectId?: string | null; itemId: string; quote: string; quoteSeq?: number; top: number; above?: number; left: number; width: number };

// Each page follows the freshly returned cursor of its predecessor; depth lives above the chain.
function HistoryPage({ threadId, cursor, index, depth, receive, unread = 0 }: { threadId: string; cursor?: string; index: number; depth: number; receive: (index: number, data: ListResult) => void; unread?: number }) {
  // The newest page only needs the unread messages and a little context above them; Load earlier fetches the rest.
  // Frozen at mount so reading (which lowers the unread count) does not refetch it.
  const [limit] = useState(() => index === 0 ? Math.min(50, Math.max(20, unread + 5)) : 50);
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view: 'all', threadId, limit, ...(cursor ? { cursor } : {}) } });
  // The first delivery skips cached data while a refetch runs, so the open position and New divider see current read state;
  // later ones pass straight through, or back-to-back refetches on a slow link would keep the conversation empty.
  const delivered = useRef(false);
  useEffect(() => { if (!result.data || (!delivered.current && result.isFetching)) return; delivered.current = true; receive(index, result.data); }, [result.data, result.isFetching, index, receive]);
  return <>{result.error && <p role="alert">{result.error.message}<Button onClick={() => void result.refetch()}>Retry</Button></p>}{result.data?.nextCursor && index + 1 < depth && <HistoryPage {...{ threadId, depth, receive }} index={index + 1} cursor={result.data.nextCursor} />}</>;
}
// Compact relative time, like chat lists: now, 5m, 3h, 2d.
const ago = (at: number) => { const m = Math.max(0, Math.floor((Date.now() - at) / 60000)); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
function Avatar({ id, title }: { id: string; title: string | null }) {
  let hue = 0; for (const c of id) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: `hsl(${hue} 35% 38%)` }}>{(title ?? '?').trim().charAt(0).toUpperCase() || '?'}</span>;
}
export function Inbox({ questions = false }: { questions?: boolean }) {
  const rpc = useRpc<AnswersRpcContract>(), sdk = useSdk(), { refresh } = experimental_useRpcRefresh(), panel = experimental_useAppPanel();
  const [selected, setSelected] = useStoredState<string | undefined>('bb-plugin-answers:page:selected', undefined);
  const result = useQuery({ contract: rpcContract, method: 'recipients', input: { ...(selected ? { selected } : {}), ...(questions ? { questions } : {}) } });
  const [draft, setDraft] = useStoredState<Draft | null>('bb-plugin-answers:page:draft', null), [text, setText] = useStoredState('bb-plugin-answers:page:draft-text', ''), [files, setFiles] = useStoredState<Attachment[]>('bb-plugin-answers:page:draft-files', []), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), selectedRef = useRef(selected); selectedRef.current = selected;
  // Where the reader was in the open conversation, so leaving the screen and coming back keeps the place.
  const restore = useRef(useState(() => { try { return JSON.parse(localStorage.getItem(SCROLL_KEY) ?? 'null') as { threadId: string; top: number; depth: number } | null; } catch { return null; } })[0]);
  const [depth, setDepth] = useState(() => restore.current && restore.current.threadId === selected ? restore.current.depth : 1), [pages, setPages] = useState<ListResult[]>([]);
  const [compose, setCompose] = useState<ComposeDraft>(() => selected ? composeDrafts()[selected] ?? { text: '', files: [] } : { text: '', files: [] }), [composeError, setComposeError] = useState(''), [composePending, setComposePending] = useState(false), [search, setSearch] = useState(false), [query, setQuery] = useState(''), [matches, setMatches] = useState<Item[]>([]), [searchError, setSearchError] = useState(''), [jump, setJump] = useState<string | null>(null), [older, setOlder] = useState(false), [flash, setFlash] = useState<string | null>(null);
  useEffect(() => {
    if (!selected || !search || !query.trim()) { setMatches([]); setSearchError(''); return; }
    let active = true; const timer = setTimeout(() => { void rpc.call('list', { view: 'all', threadId: selected, query: query.trim(), limit: 20 }).then(data => { if (active) { setMatches(data.items); setSearchError(''); } }).catch(e => { if (active) setSearchError(errorText(e)); }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [selected, search, query, rpc]);
  const receive = useRef((index: number, data: ListResult) => setPages(old => { const next = [...old]; next[index] = data; if (!data.nextCursor) next.length = index + 1; return next; })).current;
  // fresh: just opened, start at the top; prepend: Load earlier grew the top, keep the reader's place.
  const position = useRef({ height: 0, top: 0, bottom: false, fresh: true, prepend: false });
  // First unread message when the conversation opened; it keeps its divider after the thread is marked read.
  const mark = useRef<string | null>(null);
  // Where the open landed (the New divider, or null for the newest); held while messages above finish rendering and grow.
  const pin = useRef<{ target: HTMLElement | null; until: number } | null>(null);
  // Reads count only once the open position settled: while messages above grow, the list briefly jumps past unread ones.
  const [settled, setSettled] = useState(false), settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const release = () => { clearTimeout(settle.current); pin.current = null; setSettled(true); };
  function updateCompose(threadId: string, value: ComposeDraft) { const all = composeDrafts(); all[threadId] = value; try { localStorage.setItem(COMPOSE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ } if (threadId === selectedRef.current) setCompose(value); }
  async function sendCompose(options?: SendOptions) {
    if (!selected || composePending || !compose.text.trim()) return;
    const threadId = selected, sent = compose;
    setComposePending(true); setComposeError('');
    try {
      const input = [{ type: 'text' as const, mentions: [], text: sent.text }, ...sent.files.map(f => f.type === 'localImage' ? { type: 'localImage' as const, path: f.path, ...(f.sourceProjectId ? { sourceProjectId: f.sourceProjectId } : {}) } : { type: 'localFile' as const, path: f.path, name: f.name, ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.sizeBytes ? { sizeBytes: f.sizeBytes } : {}), ...(f.sourceProjectId ? { sourceProjectId: f.sourceProjectId } : {}) })];
      await sdk.threads.send({ threadId, mode: options?.mode === 'steer' ? 'steer-if-active' : 'queue-if-active', input, ...(options?.sendAt ? { sendAt: options.sendAt } : {}), ...(options?.mode === 'draft' ? { pluginSubmission: { pluginId: 'answers', data: { kind: 'draft' } } } : {}) });
      if (JSON.stringify(composeDrafts()[threadId]) === JSON.stringify(sent)) { const all = composeDrafts(); delete all[threadId]; try { localStorage.setItem(COMPOSE_KEY, JSON.stringify(all)); } catch { /* storage unavailable */ } }
      if (selectedRef.current === threadId) setCompose(current => JSON.stringify(current) === JSON.stringify(sent) ? { text: '', files: [] } : current);
      refresh(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
    } catch (e) { if (selectedRef.current === threadId) setComposeError(`Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setComposePending(false); }
  }
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => { if (!jump || !pages.length) return; const node = scroll.current, card = node?.querySelector<HTMLElement>(`[data-history-id="${jump}"]`); if (card && node) { release(); const header = node.querySelector<HTMLElement>('[data-conversation-header]')?.offsetHeight ?? 0; node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top - header; setFlash(jump); setTimeout(() => setFlash(current => current === jump ? null : current), 1500); setJump(null); setOlder(false); } else if (pages.at(-1)?.nextCursor && depth < 20 && pages.length >= depth) { position.current.prepend = true; setDepth(depth + 1); } else if (!pages.at(-1)?.nextCursor || depth >= 20) { setOlder(true); setJump(null); } }, [jump, pages, depth]);
  useLayoutEffect(() => {
    const node = scroll.current; if (!node || !pages.length) return;
    const old = position.current;
    if (old.fresh) {
      const keep = restore.current?.threadId === selected ? restore.current : null;
      if (keep && pages.length < depth && pages.at(-1)?.nextCursor) return; // wait for the remembered pages
      // Open like a chat app: at the first unread message, else where the reader left off, else at the newest.
      const divider = node.querySelector<HTMLElement>('[data-new]'), header = node.querySelector<HTMLElement>('.sticky')?.offsetHeight ?? 0;
      node.scrollTop = divider ? divider.offsetTop - header : keep ? keep.top : node.scrollHeight; restore.current = null;
      pin.current = divider || !keep ? { target: divider, until: Date.now() + 3000 } : null;
      clearTimeout(settle.current); settle.current = setTimeout(release, pin.current ? 3000 : 0);
    } else if (old.prepend) node.scrollTop = old.top + node.scrollHeight - old.height;
    else if (old.bottom) node.scrollTop = node.scrollHeight;
    position.current = { height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 24, fresh: false, prepend: false };
  }, [pages]);
  useEffect(() => {
    const node = scroll.current, list = node?.querySelector('[aria-label=History]');
    if (!node || !list) return;
    const hold = () => {
      const held = pin.current; if (!held || Date.now() > held.until) { if (held) release(); return; }
      const header = node.querySelector<HTMLElement>('.sticky')?.offsetHeight ?? 0;
      node.scrollTop = held.target ? node.scrollTop + held.target.getBoundingClientRect().top - node.getBoundingClientRect().top - header : node.scrollHeight;
    };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(hold); observer?.observe(list);
    for (const name of events) node.addEventListener(name, release, { passive: true });
    return () => { observer?.disconnect(); for (const name of events) node.removeEventListener(name, release); };
  }, [selected]);
  // Flip the popup above the selection when it would be clipped by the bottom of the scroll area.
  useLayoutEffect(() => {
    const node = popup.current, box = scroll.current; if (!draft || draft.above === undefined || !node || !box) return;
    const height = node.offsetHeight, top = draft.above - height;
    if (draft.top + height > box.scrollTop + box.clientHeight && top >= box.scrollTop) setDraft({ ...draft, top, above: undefined });
  }, [draft]);
  useEffect(() => {
    if (!draft) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setDraft(null); };
    const outside = (e: PointerEvent) => { if ((e.target as Element).closest?.('[role=option]')) return; if (popup.current && !popup.current.contains(e.target as Node)) setDraft(null); };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => setDraft(old => old && ({ ...old, left: Math.max(8, Math.min(old.left, (scroll.current?.clientWidth ?? 396) - (old.width + 8))) })));
    if (scroll.current) observer?.observe(scroll.current);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); observer?.disconnect(); };
  }, [!!draft]);
  function capture(event: React.SyntheticEvent) {
    const body = (event.target as Element).closest<HTMLElement>('[data-agent-body]'), selection = window.getSelection();
    if (!body || !selected || !selection || selection.rangeCount !== 1 || selection.isCollapsed || !scroll.current) return;
    const range = clipSelection(selection.getRangeAt(0), body); if (!range) return;
    const quote = selectionMarkdown(range, body); if (!quote.trim()) return;
    setDraft({ threadId: selected, projectId: result.data?.recipients.find(r => r.threadId === selected)?.projectId ?? null, itemId: body.dataset.item!, quote, quoteSeq: body.dataset.seq ? Number(body.dataset.seq) : undefined, ...selectionPosition(range, scroll.current, Math.min(380, scroll.current.clientWidth - 16)), width: Math.min(380, scroll.current.clientWidth - 16) });
    setText(''); setFiles([]); setError(quote.length > 20000 ? 'Quote exceeds 20,000 characters' : '');
  }
  async function send(pool: boolean, options?: SendOptions) {
    if (!draft || pending || draft.quote.length > 20000) return;
    setPending(true); setError('');
    try {
      if (pool) { await rpc.call('poolAdd', { threadId: draft.threadId, quote: draft.quote, itemId: draft.itemId, ...(draft.quoteSeq === undefined ? {} : { quoteSeq: draft.quoteSeq }), note: text, ...(files.length ? { attachments: files } : {}) }); panel.openTab({ tab: poolsTab }); }
      else await rpc.call('quoteReply', { threadId: draft.threadId, quote: draft.quote, itemId: draft.itemId, text, ...(files.length ? { attachments: files } : {}), ...(options ? { send: options } : {}) });
      refresh(); setDraft(null); setFiles([]);
    } catch (e) { setError(pool ? errorText(e) : `Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setPending(false); }
  }
  const seen = new Set<string>();
  const items = pages.slice(0, depth).flatMap(page => page.items).filter(item => !seen.has(item.id) && !!seen.add(item.id)).reverse();
  if (position.current.fresh && pages.length) mark.current = items.find(isUnread)?.id ?? null;
  return <div className="grid h-full min-[640px]:grid-cols-[minmax(170px,230px)_1fr]">
    <div role="listbox" aria-label="Recipients" className={`space-y-0.5 overflow-auto p-2 min-[640px]:border-r min-[640px]:border-border-seam ${selected ? 'max-[639px]:hidden' : ''}`}>
      {result.error && <p role="alert">{result.error.message}</p>}
      {result.data?.recipients.length && result.data.recipients.every(r => !r.unread) ? <p className="px-3 py-2 text-xs text-muted-foreground">All caught up</p> : null}{result.data?.recipients.length === 0 && <EmptyState icon="MailOpen" title={questions ? 'No open questions' : 'All caught up'}>{questions ? 'Answers to your questions will show up here.' : 'New answers from your threads will show up here.'}</EmptyState>}
      {result.data?.recipients.map(recipient => <button key={recipient.threadId} role="option" aria-selected={selected === recipient.threadId} className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 ${selected === recipient.threadId ? 'bg-state-active' : 'hover:bg-state-hover'} ${recipient.unread ? '' : 'opacity-70'}`} onKeyDown={event => { if (event.key === 'ArrowDown') (event.currentTarget.nextElementSibling as HTMLElement)?.focus(); if (event.key === 'ArrowUp') (event.currentTarget.previousElementSibling as HTMLElement)?.focus(); }} onClick={async () => {
        if (selected !== recipient.threadId) { setCompose(composeDrafts()[recipient.threadId] ?? { text: '', files: [] }); setComposeError(''); setPages([]); setDepth(1); setSettled(false); position.current = { height: 0, top: 0, bottom: false, fresh: true, prepend: false }; setSelected(recipient.threadId); }
        else try { await rpc.call('markThreadRead', { threadId: recipient.threadId }); refresh(); } catch (e) { setError(errorText(e)); }
      }}><Avatar id={recipient.threadId} title={recipient.threadTitle} /><span className="min-w-0 flex-1"><span className="flex items-baseline gap-2"><span className={`min-w-0 flex-1 truncate ${recipient.unread ? 'font-medium' : 'font-normal text-muted-foreground'}`}>{recipient.threadTitle ?? 'Untitled thread'}</span><span className="shrink-0 text-[11px] text-muted-foreground">{ago(recipient.lastAt)}</span></span><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{recipient.preview || recipient.projectName || 'No project'}</span>{recipient.unread > 0 && <span aria-label={`${recipient.unread} unread`} className="shrink-0 rounded-full bg-foreground/85 px-1.5 text-[11px] font-medium leading-[18px] text-background">{recipient.unread}</span>}</span></span></button>)}
    </div>
    <div ref={scroll} className={`relative overflow-auto min-w-0 ${!selected ? 'max-[639px]:hidden' : ''}`} onMouseUp={capture} onKeyUp={capture} onScroll={event => { const node = event.currentTarget; position.current = { ...position.current, height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 24 }; if (selected && !position.current.fresh) try { localStorage.setItem(SCROLL_KEY, JSON.stringify({ threadId: selected, top: node.scrollTop, depth })); } catch { /* storage unavailable */ } }}>
      {!selected && <EmptyState icon="MessageQuestion" title="Pick a conversation">Answers are grouped by thread. Open one to read it from the start and reply with quotes.</EmptyState>}
      {selected && <><div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b border-border-seam bg-background px-4 py-2 min-[640px]:hidden"><Button size="sm" variant="ghost" className="min-[640px]:hidden" aria-label="Back" onClick={() => setSelected(undefined)}><Icon name="ArrowLeft" aria-hidden /></Button>{(() => { const current = result.data?.recipients.find(r => r.threadId === selected); return <><Avatar id={selected} title={current?.threadTitle ?? null} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{current?.threadTitle ?? 'Untitled thread'}</span><span className="block truncate text-xs text-muted-foreground">{current?.projectName ?? 'No project'}</span></span><Button asChild size="sm" variant="ghost" aria-label="Open thread"><UrlLink href={`${current?.projectId ? `/projects/${current.projectId}` : ''}/threads/${selected}`}><Icon name="ExternalLink" aria-hidden /></UrlLink></Button></>; })()}</div><div data-conversation-header className="sticky top-[57px] z-[2] flex justify-end min-[640px]:top-0 border-b border-border-seam bg-background px-3 py-1"><Button size="sm" variant="ghost" aria-label="Search conversation" onClick={() => { setSearch(!search); setOlder(false); }}><Icon name="Search" aria-hidden /></Button>{search && <input aria-label="Search conversation" autoFocus className="w-56 rounded border border-border-seam bg-background px-2 text-sm" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearch(false); setQuery(''); setOlder(false); } }} />}{search && query.trim() && <div role="listbox" aria-label="Search results" className="absolute right-3 top-full z-10 max-h-64 w-72 overflow-auto rounded border border-border-seam bg-background shadow-lg">{searchError && <p role="alert">{searchError}</p>}{matches.map(match => <button key={match.id} role="option" aria-selected={false} className="block w-full border-b border-border-seam p-2 text-left text-xs hover:bg-state-hover" onClick={() => { setJump(match.id); setOlder(false); setSearch(false); }}>{(match.answer || match.question).slice(0, 160)} <time className="block text-muted-foreground">{new Date(match.updatedAt).toLocaleDateString()}</time></button>)}</div>}</div>{older && <p role="status" className="px-4 text-xs">Older than loaded history — <UrlLink href={`${result.data?.recipients.find(r => r.threadId === selected)?.projectId ? `/projects/${result.data?.recipients.find(r => r.threadId === selected)?.projectId}` : ''}/threads/${selected}`}>open in chat</UrlLink></p>}<HistoryPage key={selected} threadId={selected} index={0} unread={result.data?.recipients.find(r => r.threadId === selected)?.unread} {...{ depth, receive }} />{pages.at(-1)?.nextCursor && <Button onClick={() => { position.current.prepend = true; setDepth(depth + 1); }}>Load earlier</Button>}<ul className="divide-y divide-border-seam px-4 [&>:has(+[data-new])]:border-b-0" aria-label="History">{groupItems(items).map(group => <Fragment key={group.at(-1)!.id}>{group.at(-1)!.id === mark.current && <li data-new className="border-b-0 flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />New<span className="h-px flex-1 bg-border" /></li>}<div data-history-id={group.at(-1)!.id} data-flash={flash === group.at(-1)!.id || undefined} className={`transition-colors duration-[1500ms] ${flash === group.at(-1)!.id ? 'bg-state-active' : ''}`}><ItemCard item={group.at(-1)!} members={group.length > 1 ? group : undefined} chat autoRead={settled} /></div></Fragment>)}</ul>{!draft && <div className="sticky bottom-0 z-[1] bg-background px-3 py-2"><Composer key={selected} label="Send message" sendLabel="Send message" placeholder="Message…" value={compose.text} onChange={text => updateCompose(selected, { ...composeDrafts()[selected], text, files: composeDrafts()[selected]?.files ?? [] })} attachments={compose.files} onAttachments={update => { const current = composeDrafts()[selected] ?? { text: '', files: [] }; updateCompose(selected, { ...current, files: update(current.files) }); }} projectId={result.data?.recipients.find(r => r.threadId === selected)?.projectId} pending={composePending} onSend={options => void sendCompose(options)} />{composeError && <p role="alert">{composeError}</p>}</div>}</>}
      {draft && <div ref={popup} role="dialog" aria-label="Quote reply" className="absolute z-10" style={{ width: draft.width, top: draft.top, left: draft.left }} onBlur={event => { if (event.relatedTarget && !(event.relatedTarget as Element).closest?.('[role=option]') && !event.currentTarget.contains(event.relatedTarget as Node)) setDraft(null); }}>
        <Composer label="Quote reply text" className="shadow-lg" autoFocus value={text} onChange={setText} attachments={files} onAttachments={update => setFiles(update)} projectId={draft.projectId} pending={pending} sendDisabled={draft.quote.length > 20000} onSend={options => void send(false, options)}
          header={<div className="flex items-start gap-2 pl-4 pr-2 pt-2"><div className="mt-1 max-h-32 min-w-0 flex-1 overflow-auto border-l-2 border-border-seam pl-2 text-sm text-muted-foreground"><Markdown content={draft.quote} /></div><Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" aria-label="Close" onClick={() => setDraft(null)}><Icon name="X" aria-hidden /></Button></div>}
          actions={<Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="Add to pool" disabled={pending || draft.quote.length > 20000} onClick={() => void send(true)}><Icon name="ListEnd" aria-hidden /></Button>} />
        {error && <p role="alert" className="mt-1 rounded-md bg-background px-2 text-xs text-destructive">{error}</p>}
      </div>}
      {!draft && error && <p role="alert">{error}</p>}
    </div>
  </div>;
}

type Editor = { flush: () => Promise<void> };
function PoolNote({ entry, editors, autoFocus }: { entry: PoolEntry; editors: Map<string, Editor>; autoFocus?: boolean }) {
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
  const remove = async () => { try { await rpc.call('poolRemove', { id: entry.id }); refresh(); } catch (e) { setStatus(errorText(e)); } };
  return <li className="group/entry relative space-y-2 rounded-xl border border-border-seam bg-background p-3">
    <Button type="button" size="icon" variant="ghost" className="absolute right-1.5 top-1.5 size-7 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/entry:opacity-100" aria-label="Remove" onClick={() => void remove()}><Icon name="Trash2" aria-hidden className="size-3.5" /></Button>
    {entry.quote && <div className="border-l-2 border-border-seam pl-3 pr-7 text-sm text-muted-foreground"><div ref={quote} className={expanded ? '' : 'line-clamp-3'}><Markdown content={entry.quote} /></div>{(clamped || expanded) && <button type="button" className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}</div>}
    <textarea aria-label="Pool note" rows={2} autoFocus={autoFocus} placeholder={entry.quote ? 'Your reply to this quote…' : 'Your message…'} className="field-sizing-content block max-h-48 min-h-[3.25rem] w-full resize-none rounded-lg border border-border-seam bg-surface-recessed px-3 py-2 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground focus:border-ring" maxLength={8000} value={note} onChange={e => { local.current.note = e.target.value; setNote(e.target.value); setStatus('Not saved'); }} onBlur={() => void flush().catch(() => {})} />
    {(entry.attachments.length > 0 || status !== 'Saved') && <div className="flex flex-wrap items-center gap-1.5">{entry.attachments.map(file => <span key={file.path} className="flex items-center gap-1 rounded-md border border-border-seam bg-surface-recessed px-1.5 py-0.5 text-xs"><Icon name="Paperclip" aria-hidden className="size-3" /><span className="max-w-[160px] truncate">{file.name}</span></span>)}<span className="flex-1" /><p role="status" className={`text-[11px] ${status.startsWith('Not saved:') ? 'text-destructive' : 'text-muted-foreground'}`}>{status === 'Saved' ? '' : status}</p></div>}
  </li>;
}
function ReplyPool({ pool, setFeedback }: { pool: Pool; setFeedback: (text: string) => void }) {
  const rpc = useRpc<AnswersRpcContract>(), { refresh } = experimental_useRpcRefresh();
  const editors = useRef(new Map<string, Editor>()).current;
  const [pending, setPending] = useState(false);
  const [focusId, setFocusId] = useState<string>();
  async function addMessage() {
    try { const { id } = await rpc.call('poolAdd', { threadId: pool.threadId, quote: '', note: '' }); setFocusId(id); refresh(); } catch (e) { setFeedback(`Not added — ${errorText(e)}`); }
  }
  async function sendAll(options?: SendOptions) {
    setPending(true); setFeedback('');
    try {
      try { await Promise.all([...editors.values()].map(editor => editor.flush())); } catch (e) { setFeedback(`Not sent — ${errorText(e)}`); return; }
      const result = await rpc.call('poolSend', { threadId: pool.threadId, ...(options ? { send: options } : {}) }); refresh();
      setFeedback(`${options?.mode === 'draft' ? 'Draft saved' : options?.sendAt ? 'Scheduled' : result.delivery === 'sent' ? 'Sent' : 'Queued'}${result.keptEdited ? ` — ${result.keptEdited} edited entries were not sent` : ''}`);
    } catch (e) { setFeedback(`Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setPending(false); }
  }
  return <section className="space-y-2 border-b border-border-seam px-3 py-3 last:border-b-0">
    <UrlLink className="block truncate text-sm font-medium hover:underline" href={`${pool.projectId ? `/projects/${pool.projectId}` : ''}/threads/${pool.threadId}`}>{pool.threadTitle ?? 'Untitled thread'}</UrlLink>
    <ul className="space-y-2">{pool.entries.map(entry => <PoolNote key={entry.id} {...{ entry, editors }} autoFocus={entry.id === focusId} />)}</ul>
    {/* Read and write first, then act: the actions sit under the messages. */}
    <footer className="flex items-center gap-2 pt-1">
      <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs text-muted-foreground" disabled={pending} onClick={() => void addMessage()}><Icon name="Plus" aria-hidden className="size-3.5" />Add message</Button>
      <span className="flex-1" />
      <SendButton label={pending ? 'Sending…' : 'Send all'} side="top" className="gap-1.5 px-2.5" disabled={pending} onSend={options => void sendAll(options)}><Icon name="Sent" aria-hidden className="size-3.5" />{pending ? 'Sending…' : <>Send all<span className="opacity-60">· {pool.entries.length}</span></>}</SendButton>
    </footer>
  </section>;
}
export function Pools({ threadId }: { threadId?: string }) {
  const [feedback, setFeedback] = useTransientText();
  const result = useQuery({ contract: rpcContract, method: 'pools', input: {} });
  const pools = result.data?.pools.filter(pool => !threadId || pool.threadId === threadId);
  if (threadId && !pools?.length && !feedback) return null;
  // In a thread tab the pool sits above the answers list, so it must not take the whole height.
  return <div className={threadId ? 'max-h-[50%] shrink-0 overflow-auto border-b border-border-seam' : 'h-full overflow-auto'}>
    {feedback && <p role="status" className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground"><Icon name={/uncertain|not sent/i.test(feedback) ? 'X' : 'Check'} aria-hidden className="size-3.5" />{feedback}</p>}
    {result.error && <p role="alert" className="px-3 pt-2 text-xs text-destructive">{result.error.message}</p>}
    {pools?.length === 0 && !threadId && <EmptyState icon="Sent" title="No reply pools yet">Select text in an answer and choose <span className="font-medium text-foreground">Add to pool</span>. Collect quotes from one thread, then send them together.</EmptyState>}
    {pools?.map(pool => <ReplyPool key={pool.threadId} pool={pool} setFeedback={setFeedback} />)}
  </div>;
}
