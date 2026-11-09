import { mentionsForText } from './mentions';
import { PendingInteractions } from './interactions';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useSettings, experimental_Icon as Icon, experimental_ProviderModelPicker as ProviderModelPicker, experimental_PermissionModePicker as PermissionModePicker, experimental_ThreadActionsContextMenu as ThreadActionsContextMenu, experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_resolveThreadStatus as resolveThreadStatus, experimental_useSidebarThreads, experimental_useTabVisible, ThreadChat, Markdown, UrlLink, useRpc, useSdk, experimental_useRpcQuery as useQuery, experimental_useRpcRefresh, experimental_useAppPanel, type ExperimentalProviderModelPickerValue } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type Pool, type PoolEntry, type ListResult, type Attachment, type SendOptions } from './contract';
import { Button } from './components/ui/button';
import { useStoredState } from './lib/stored-state';
import { ContactsFooter } from './contacts-footer';
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
const NO_PAGES: ListResult[] = [];
// Context fill as a ring, like bb's composer footer; the label says what is left, the tooltip the token counts.
function ContextRing({ used, total }: { used: number; total: number }) {
  const fill = Math.min(1, Math.max(0, used / total)), r = 6, c = 2 * Math.PI * r;
  return <button type="button" aria-label={`Context window ${Math.round(100 * fill)}% used`} title={`${Math.round(100 * fill)}% of context used · ${used.toLocaleString()} / ${total.toLocaleString()} tokens`} className="-m-1 inline-flex size-8 shrink-0 items-center justify-center">
    <svg viewBox="0 0 16 16" className={`size-4 -rotate-90 text-muted-foreground ${fill >= .8 ? 'text-warning' : ''}`} aria-hidden><circle cx="8" cy="8" r={r} fill="none" className="stroke-border-hairline" strokeWidth="2" /><circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - fill)} /></svg>
  </button>;
}
const CONTACTS_MIN = 170, CONTACTS_MAX = 560, CONTACTS_DEFAULT = 230;
const userBubble = 'max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground';
type QueueRow = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['queuedMessages']['list']>>[number];
type QueueEdit = { id: string; text: string; files: Attachment[]; model: string; reasoningLevel: ExperimentalProviderModelPickerValue['reasoningLevel']; serviceTier: ExperimentalProviderModelPickerValue['serviceTier']; permissionMode: QueueRow['permissionMode'] };
// bb previews a queued message as one truncated line of inline Markdown: blocks flatten to spans, links read as text, code stays a chip.
const queuePreview = "block truncate !text-xs !leading-4 text-foreground [&_:not(br,img,hr)]:!inline [&_*]:!m-0 [&_*]:!text-xs [&_*]:!leading-4 [&_:not(code,blockquote)]:!p-0 [&_:is(p,li,h1,h2,h3,h4,h5,h6,td,th)]:after:content-['_'] [&_:is(br,img,hr)]:!hidden [&_a]:pointer-events-none [&_a]:!text-inherit [&_a]:!no-underline [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-surface-selected-border [&_blockquote]:!pl-2 [&_blockquote]:text-muted-foreground";
function QueueCard({ rows, sourceName, projectId, providerId, edit, onEdit, onFinish, onSend, onDelete, onSchedule, onReorder }: { rows: QueueRow[]; sourceName: (row: QueueRow) => string | null; projectId?: string | null; providerId?: string; edit: QueueEdit | null; onEdit: (row: QueueRow, update?: Partial<QueueEdit>) => void; onFinish: (row: QueueRow, save: boolean) => void; onSend: (row: QueueRow) => void; onDelete: (row: QueueRow) => void; onSchedule: (row: QueueRow, sendAt: number) => void; onReorder: (row: QueueRow, previousQueuedMessageId: string | null, nextQueuedMessageId: string | null) => void }) {
  // The bottom fade only hints at rows hidden below; with nothing to scroll it would just shade the last row.
  const list = useRef<HTMLDivElement>(null), [more, setMore] = useState(false);
  const measure = () => { const node = list.current; setMore(!!node && node.scrollHeight - node.scrollTop - node.clientHeight > 1); };
  useLayoutEffect(measure, [rows.length, edit]);
  const [collapsed, setCollapsed] = useStoredState('bb-plugin-answers:page:queue-collapsed', false);
  const [later, setLater] = useState<string | null>(null), [date, setDate] = useState(''), [dateError, setDateError] = useState('');
  const [dragging, setDragging] = useState<string | null>(null);
  const action = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover';
  const move = (row: QueueRow, index: number) => { const others = rows.filter(item => item.id !== row.id); onReorder(row, others[index - 1]?.id ?? null, others[index]?.id ?? null); };
  const schedule = (row: QueueRow) => { const sendAt = new Date(date).getTime(); if (!(sendAt > Date.now())) { setDateError('Pick a time in the future'); return; } onSchedule(row, sendAt); setLater(null); setDateError(''); };
  return <section aria-label="Queued messages" className={`relative z-10 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lift ${collapsed ? 'mb-1' : '-mb-[11px] rounded-b-none border-b-0 pb-3'}`}>
    <header className="shrink-0"><button type="button" aria-label="Toggle queued messages" aria-expanded={!collapsed} className="flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs text-foreground hover:bg-state-hover focus-visible:bg-state-hover" onClick={() => setCollapsed(!collapsed)}><span>Queue</span><span className="ml-auto mr-px flex w-6 shrink-0 items-center justify-center"><span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-recessed px-1 text-2xs leading-none tabular-nums text-subtle-foreground">{rows.length}</span></span></button></header>
    {!collapsed && <><div className="relative min-h-0 flex-1"><div ref={list} onScroll={measure} className="max-h-64 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"><ul className="group/queue pt-1">{rows.map((row, index) => {
      const scheduled = row.sendAt && row.sendAt > Date.now();
      const distance = scheduled ? Math.max(1, Math.ceil((row.sendAt! - Date.now()) / 60000)) : 0;
      const relative = distance >= 1440 ? `${Math.ceil(distance / 1440)}d` : distance >= 60 ? `${Math.ceil(distance / 60)}h` : `${distance}m`;
      const queueText = row.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const source = sourceName(row), files = row.content.filter(part => part.type !== 'text').length;
      return edit?.id === row.id ? <li key={row.id} data-queued-message-inline-editor className="relative z-10 border-b border-border/35 px-2.5 py-1"><div className="mb-1.5 flex min-h-7 items-center gap-1.5 pl-1 text-xs text-subtle-foreground"><Icon name="Edit" aria-hidden className="size-3.5 shrink-0" /><span>Editing queued message {index + 1}</span><button type="button" aria-label="Stop editing queued message" className={`${action} ml-auto size-6`} onClick={() => onFinish(row, false)}><Icon name="X" aria-hidden className="size-3" /></button></div><Composer editMode label="Edit queued message" sendLabel="Confirm queued message edit" placeholder="Ask for a follow-up…" autoFocus value={edit.text} onChange={text => onEdit(row, { text })} attachments={edit.files} onAttachments={update => onEdit(row, { files: update(edit.files) })} projectId={projectId} actions={providerId && <ProviderModelPicker allowProviderChange={false} value={{ providerId, model: edit.model, reasoningLevel: edit.reasoningLevel, serviceTier: edit.serviceTier }} onChange={value => onEdit(row, { model: value.model, reasoningLevel: value.reasoningLevel, serviceTier: value.serviceTier })} />} onSend={() => onFinish(row, true)} onCancel={() => onFinish(row, false)} />{providerId && <div className="mt-1 flex justify-end pr-3.5"><PermissionModePicker providerId={providerId} value={edit.permissionMode} onChange={permissionMode => onEdit(row, { permissionMode })} /></div>}</li> : <li key={row.id} className="group/dispatch-row relative border-b border-border/35 px-2.5 py-0.5" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const from = rows.find(item => item.id === dragging); if (from && from.id !== row.id) { const others = rows.filter(item => item.id !== from.id); const at = others.findIndex(item => item.id === row.id); onReorder(from, others[at - 1]?.id ?? null, others[at]?.id ?? null); } setDragging(null); }}>
        <div className="flex items-center gap-1.5"><button type="button" draggable onDragStart={() => setDragging(row.id)} onDragEnd={() => setDragging(null)} aria-label={`Reorder queued message ${index + 1}`} className={`${action} cursor-grab`} onKeyDown={event => { if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); move(row, index - 1); } if (event.key === 'ArrowDown' && index < rows.length - 1) { event.preventDefault(); move(row, index + 1); } }}><Icon name="DragDropVertical" aria-hidden className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/dispatch-row:opacity-100 focus:opacity-100" /></button>
          <div className="min-w-0 flex-1 py-1.5"><div className="flex min-w-0 items-center gap-1"><div className={`min-w-0 flex-1 ${queuePreview}`} title={queueText}><Markdown content={queueText} /></div>{files > 0 && <span data-queued-message-attachment role="img" aria-label={files === 1 ? '1 attachment' : `${files} attachments`} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle-foreground opacity-70 transition-opacity group-hover/dispatch-row:opacity-0 group-focus-within/dispatch-row:opacity-0"><Icon name="FileAttachment" aria-hidden className="size-3.5" /><span aria-hidden>{files}</span></span>}</div>{(source || scheduled) && <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-2xs text-subtle-foreground">{source && <><span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1"><span className="shrink-0">From</span><span className="min-w-0 truncate">{source}</span></span>{scheduled && <span className="shrink-0">·</span>}</>}{scheduled && <span className="flex min-w-0 items-center gap-1"><Icon name="TimeSchedule" aria-hidden className="size-3 shrink-0" /><span className="truncate">Scheduled for {new Date(row.sendAt!).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: false })}</span><span className="shrink-0 tabular-nums">· in {relative}</span></span>}</div>}</div>
          <div className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center bg-surface-raised-solid opacity-0 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-r before:from-transparent before:to-surface-raised-solid before:content-[''] group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100 group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100"><button type="button" className={action} aria-label={`Send queued message ${index + 1} now`} onClick={() => onSend(row)}><Icon name="Sent" aria-hidden className="size-4" /></button><button type="button" className={action} aria-label={`Edit queued message ${index + 1}`} onClick={() => onEdit(row)}><Icon name="Edit" aria-hidden className="size-4" /></button><button type="button" className={action} aria-label={`Change when queued message ${index + 1} sends`} onClick={() => { setLater(row.id); setDate(''); }}><Icon name="Calendar" aria-hidden className="size-4" /></button><button type="button" className={action} aria-label={`Delete queued message ${index + 1}`} onClick={() => onDelete(row)}><Icon name="Trash2" aria-hidden className="size-4" /></button></div>
        </div>
        {later === row.id && <div className="absolute right-2 top-full z-20 w-56 space-y-2 rounded-lg border border-border bg-background p-2 shadow-lg"><input type="datetime-local" aria-label="Send at" autoFocus className="w-full rounded-md border border-border-seam bg-transparent px-2 py-1 text-sm" value={date} onChange={event => setDate(event.target.value)} />{dateError && <p role="alert" className="text-xs text-destructive">{dateError}</p>}<div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setLater(null)}>Cancel</Button><Button size="sm" disabled={!date} onClick={() => schedule(row)}>Schedule</Button></div></div>}
      </li>;
    })}</ul></div>{more && <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-b from-transparent to-surface-raised-solid" />}</div><div className="shrink-0"><button type="button" aria-label="Collapse queued messages" className="-mb-3 flex min-h-[1.875rem] w-full cursor-pointer items-center justify-center rounded-none pb-3 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setCollapsed(true)}><Icon name="ChevronUp" aria-hidden className="size-3.5" /></button></div></>}
  </section>;
}
function HistoryPage({ threadId, cursor, index, depth, receive, unread = 0 }: { threadId: string; cursor?: string; index: number; depth: number; receive: (threadId: string, index: number, data: ListResult) => void; unread?: number }) {
  // The newest page only needs the unread messages and a little context above them; Load earlier fetches the rest.
  // Frozen at mount so reading (which lowers the unread count) does not refetch it.
  const [limit] = useState(() => index === 0 ? Math.min(50, Math.max(20, unread + 5)) : 50);
  const [settled, setSettled] = useState(false), [olderData, setOlderData] = useState<ListResult | null>(null);
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view: 'all', threadId, limit, ...(cursor ? { cursor } : {}) }, enabled: index === 0 || !settled });
  // The first delivery skips cached data while a refetch runs, so the open position and New divider see current read state;
  // later ones pass straight through, or back-to-back refetches on a slow link would keep the conversation empty.
  const delivered = useRef(false);
  useEffect(() => { if (!result.data || (!delivered.current && result.isFetching)) return; delivered.current = true; receive(threadId, index, result.data); if (index > 0 && !settled) { setOlderData(result.data); setSettled(true); } }, [result.data, result.isFetching, threadId, index, receive, settled]);
  const page = olderData ?? result.data;
  return <>{result.error && <p role="alert">{result.error.message}<Button onClick={() => void result.refetch()}>Retry</Button></p>}{page?.nextCursor && index + 1 < depth && <HistoryPage key={page.nextCursor} {...{ threadId, depth, receive }} index={index + 1} cursor={page.nextCursor} />}</>;
}
// Compact relative time, like chat lists: now, 5m, 3h, 2d.
const ago = (at: number) => { const m = Math.max(0, Math.floor((Date.now() - at) / 60000)); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
function Avatar({ id, title }: { id: string; title: string | null }) {
  let hue = 0; for (const c of id) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: `hsl(${hue} 35% 38%)` }}>{(title ?? '?').trim().charAt(0).toUpperCase() || '?'}</span>;
}
export function Inbox({ questions = false, onBulkRead, bbChat = false }: { questions?: boolean; onBulkRead?: (result: { batch: string | null; count: number }) => void; bbChat?: boolean }) {
  const rpc = useRpc<AnswersRpcContract>(), sdk = useSdk(), { refresh } = experimental_useRpcRefresh(), panel = experimental_useAppPanel(), tabVisible = experimental_useTabVisible();
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => { const update = () => setDocumentVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  const visible = tabVisible && documentVisible;
  const sidebar = experimental_useSidebarThreads(), sidebarThreads = sidebar.threads, projects = sidebar.projects;
  // A thread read in bb drops its unread mark there; refetch so the server can mark the same answers read here.
  const bbReadKey = sidebarThreads.filter(t => !t.isUnread).map(t => t.id).join(' ');
  const firstBbRead = useRef(true);
  useEffect(() => { if (firstBbRead.current) { firstBbRead.current = false; return; } refresh(); }, [bbReadKey]);
  // The contact column is resizable at the chat's expense; the width is remembered like the rest of the page state.
  const grid = useRef<HTMLDivElement>(null), [contactsWidth, setContactsWidth] = useStoredState('bb-plugin-answers:page:contacts-width', CONTACTS_DEFAULT);
  const resize = (width: number) => setContactsWidth(Math.round(Math.max(CONTACTS_MIN, Math.min(CONTACTS_MAX, (grid.current?.clientWidth || Infinity) - 320, width))));
  // Like a collapsed row in bb's sidebar, a contact counts its sub-threads' work, so a manager shows busy while its leads run.
  const children = new Map<string, typeof sidebarThreads[number][]>();
  for (const t of sidebarThreads) if (t.parentThreadId) children.set(t.parentThreadId, [...(children.get(t.parentThreadId) ?? []), t]);
  const descendants = (id: string): typeof sidebarThreads[number][] => (children.get(id) ?? []).flatMap(t => [t, ...descendants(t.id)]);
  const statusOf = (thread: typeof sidebarThreads[number]) => resolveThreadStatus({ thread, hiddenThreads: descendants(thread.id), hasUnsubmittedDraft: false, rowStatus: null });
  const [selected, setSelected] = useStoredState<string | undefined>('bb-plugin-answers:page:selected', undefined);
  const result = useQuery({ contract: rpcContract, method: 'recipients', input: { ...(selected ? { selected } : {}), ...(questions ? { questions } : {}) } });
  // Each selection has its own cache entry, and a revisited one holds old unread counts until its refetch lands.
  // Show the last settled list instead, so switching neither blanks the list nor flashes stale unread badges.
  const lastRecipients = useRef(result.data); if (result.data && !result.isFetching) lastRecipients.current = result.data; const settledRecipients = lastRecipients.current ?? result.data;
  // bb's sidebar threads are live, so a rename shows at once instead of on the next recipients refetch.
  const liveTitles = new Map(sidebarThreads.flatMap(t => t.title ? [[t.id, t.title] as const] : []));
  const recipients = settledRecipients && { ...settledRecipients, recipients: settledRecipients.recipients.map(r => ({ ...r, threadTitle: liveTitles.get(r.threadId) ?? r.threadTitle })) };
  // Optional project headers. bb's sidebar keeps its own (client-local) project order in Custom mode and offers no way
  // to read it, so Answers keeps its order in plugin settings; projects missing from it follow in bb's project order.
  const prefs = useSettings().values, byProject = prefs?.groupByProject === true, grouped = new Map<string | null, NonNullable<typeof recipients>['recipients']>();
  for (const r of recipients?.recipients ?? []) { const key = byProject ? r.projectId ?? '' : null; grouped.set(key, [...(grouped.get(key) ?? []), r]); }
  const saved = String(prefs?.projectOrder ?? ''), [projectOrder, setProjectOrder] = useState<string[] | null>(null);
  useEffect(() => setProjectOrder(null), [saved]);
  const known = sidebar.projects.filter(p => !p.isPersonal).map(p => p.id), stored = saved.split(',').filter(id => known.includes(id));
  const order = projectOrder ?? [...stored, ...known.filter(id => !stored.includes(id))];
  const rank = (key: string | null) => { const i = key ? order.indexOf(key) : -1; return i < 0 ? Infinity : i; };
  const groups = [...grouped].sort((a, b) => rank(a[0]) - rank(b[0]));
  const [drag, setDrag] = useState<{ id: string; over?: string; after?: boolean } | null>(null);
  function moveProject(id: string, target: string, after: boolean) {
    const next = order.filter(x => x !== id); let at = next.indexOf(target); if (at < 0 || !order.includes(id)) return; if (after) at++;
    next.splice(at, 0, id); setProjectOrder(next);
    void rpc.call('setPreferences', { projectOrder: next.join(',') }).catch(e => { setProjectOrder(null); setError(errorText(e)); });
  }

  const [draft, setDraft] = useStoredState<Draft | null>('bb-plugin-answers:page:draft', null), [text, setText] = useStoredState('bb-plugin-answers:page:draft-text', ''), [files, setFiles] = useStoredState<Attachment[]>('bb-plugin-answers:page:draft-files', []), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const scroll = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), selectedRef = useRef(selected); selectedRef.current = selected;
  // Where the reader was in the open conversation, so leaving the screen and coming back keeps the place.
  const restore = useRef(useState(() => { try { return JSON.parse(localStorage.getItem(SCROLL_KEY) ?? 'null') as { threadId: string; top: number; depth: number } | null; } catch { return null; } })[0]);
  const [depth, setDepth] = useState(() => restore.current && restore.current.threadId === selected ? restore.current.depth : 1), [loaded, setLoaded] = useState<{ threadId?: string; pages: ListResult[] }>({ pages: [] });
  // The previous conversation stays on screen until the new one's first page arrives, then both swap in one frame.
  const pages = loaded.threadId === selected ? loaded.pages : NO_PAGES;
  const [optimistic, setOptimistic] = useState<{ threadId: string; text: string; id: number; seenIds: string[] }[]>([]), [queue, setQueue] = useState<Awaited<ReturnType<typeof sdk.threads.queuedMessages.list>>>([]), [queueError, setQueueError] = useState(''), [queueVersion, setQueueVersion] = useState(0), [context, setContext] = useState<Awaited<ReturnType<typeof sdk.threads.context>> | null>(null);
  const [compose, setCompose] = useState<ComposeDraft>(() => selected ? composeDrafts()[selected] ?? { text: '', files: [] } : { text: '', files: [] }), [composeError, setComposeError] = useState(''), [composePending, setComposePending] = useState(false), [search, setSearch] = useState(false), [query, setQuery] = useState(''), [matches, setMatches] = useState<Item[]>([]), [searchError, setSearchError] = useState(''), [jump, setJump] = useState<string | null>(null), [older, setOlder] = useState(false), [flash, setFlash] = useState<string | null>(null);
  const [drafts] = useState(composeDrafts), draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined), scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined), scrollPending = useRef<{ threadId: string; top: number; depth: number } | null>(null);
  const saveDrafts = () => { clearTimeout(draftTimer.current); try { localStorage.setItem(COMPOSE_KEY, JSON.stringify(drafts)); } catch { /* storage unavailable */ } };
  const saveScroll = () => { clearTimeout(scrollTimer.current); scrollTimer.current = undefined; if (scrollPending.current) { try { localStorage.setItem(SCROLL_KEY, JSON.stringify(scrollPending.current)); } catch { /* storage unavailable */ } scrollPending.current = null; } };
  useEffect(() => () => { saveDrafts(); saveScroll(); }, []);
  useEffect(() => { saveDrafts(); saveScroll(); }, [selected]);
  useEffect(() => {
    if (!selected || !search || !query.trim()) { setMatches([]); setSearchError(''); return; }
    let active = true; const timer = setTimeout(() => { void rpc.call('list', { view: 'all', threadId: selected, query: query.trim(), limit: 20 }).then(data => { if (active) { setMatches(data.items); setSearchError(''); } }).catch(e => { if (active) setSearchError(errorText(e)); }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [selected, search, query, rpc]);
  const receive = useRef((threadId: string, index: number, data: ListResult) => setLoaded(old => { const next = old.threadId === threadId ? [...old.pages] : []; next[index] = data; if (!data.nextCursor) next.length = index + 1; return { threadId, pages: next }; })).current;
  // fresh: just opened, start at the top; prepend: Load earlier grew the top, keep the reader's place.
  const position = useRef({ height: 0, top: 0, bottom: false, fresh: true, prepend: false });
  // First unread message when the conversation opened; it keeps its divider after the thread is marked read.
  const mark = useRef<string | null>(null);
  // Where the open landed (the New divider, or null for the newest); held while messages above finish rendering and grow.
  const pin = useRef<{ target: HTMLElement | null; until: number } | null>(null);
  // Reads count only once the open position settled: while messages above grow, the list briefly jumps past unread ones.
  const [settled, setSettled] = useState(false), settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const release = () => { clearTimeout(settle.current); pin.current = null; setSettled(true); };
  function updateCompose(threadId: string, value: ComposeDraft) { drafts[threadId] = value; clearTimeout(draftTimer.current); draftTimer.current = setTimeout(saveDrafts, 300); if (threadId === selectedRef.current) setCompose(value); }
  async function sendCompose(options?: SendOptions) {
    if (!selected || composePending || (!compose.text.trim() && !compose.files.length)) return;
    const threadId = selected, sent = compose;
    setComposePending(true); setComposeError('');
    const optimisticId = Date.now() + Math.random(), showBubble = options?.mode !== 'draft' && !options?.sendAt && !!sent.text.trim();
    if (showBubble) setOptimistic(old => [...old, { threadId, text: sent.text.trim(), id: optimisticId, seenIds: pages.flatMap(page => page.items.map(item => item.id)) }]);
    try {
      const input = [...(sent.text.trim() ? [{ type: 'text' as const, mentions: mentionsForText(sent.text, id => { const thread = sidebarThreads.find(t => t.id === id); return thread ? { label: thread.displayTitle, projectId: thread.projectId } : undefined; }), text: sent.text }] : []), ...sent.files.map(f => f.type === 'localImage' ? { type: 'localImage' as const, path: f.path, ...(f.sourceProjectId ? { sourceProjectId: f.sourceProjectId } : {}) } : { type: 'localFile' as const, path: f.path, name: f.name, ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.sizeBytes ? { sizeBytes: f.sizeBytes } : {}), ...(f.sourceProjectId ? { sourceProjectId: f.sourceProjectId } : {}) })];
      const result = await sdk.threads.send({ threadId, mode: options?.mode === 'steer' ? 'steer-if-active' : 'queue-if-active', input, ...(options?.sendAt ? { sendAt: options.sendAt } : {}), ...(options?.mode === 'draft' ? { pluginSubmission: { pluginId: 'answers', data: { kind: 'draft' } } } : {}) });
      // A queued message lives in the queue card until bb delivers it, as in bb's own chat; a bubble would show it twice.
      if (result.ok && result.delivery === 'queued') setOptimistic(old => old.filter(b => b.id !== optimisticId));
      if (JSON.stringify(drafts[threadId]) === JSON.stringify(sent)) { delete drafts[threadId]; saveDrafts(); }
      if (selectedRef.current === threadId) setCompose(current => JSON.stringify(current) === JSON.stringify(sent) ? { text: '', files: [] } : current);
      setQueueVersion(n => n + 1); refresh(); scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
    } catch (e) { setOptimistic(old => old.filter(b => b.id !== optimisticId)); if (selectedRef.current === threadId) setComposeError(`Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setComposePending(false); }
  }
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => { if (!optimistic.length) return; const timer = setTimeout(() => setOptimistic(old => old.filter(b => Date.now() - b.id < 30000)), 30000); return () => clearTimeout(timer); }, [optimistic]);
  useEffect(() => { if (!selected || !visible) return; let active = true; void sdk.threads.queuedMessages.list({ threadId: selected }).then(rows => { if (active) { setQueue(rows); setQueueError(''); } }).catch(e => { if (active) setQueueError(errorText(e)); }); return () => { active = false; }; }, [sdk, selected, visible, queueVersion]);
  useEffect(() => { if (!selected || !visible || !queue.length) return; const timer = setInterval(() => setQueueVersion(n => n + 1), 5000); return () => clearInterval(timer); }, [selected, visible, queue.length]);
  const openThread = sidebarThreads.find(t => t.id === selected);
  const working = openThread ? statusOf(openThread).isWorking : false;
  useEffect(() => { if (!selected) { setContext(null); return; } if (!visible) return; let active = true; const read = () => { void sdk.threads.context({ threadId: selected }).then(value => { if (active) setContext(value); }).catch(() => { if (active) setContext(null); }); }; read(); const timer = working ? setInterval(read, 30000) : undefined; return () => { active = false; clearInterval(timer); }; }, [sdk, selected, visible, working]);
  async function queueAction(action: () => Promise<unknown>) { try { await action(); setQueueVersion(n => n + 1); refresh(); } catch (e) { setQueueError(errorText(e)); } }
  const [queueEdit, setQueueEdit] = useState<QueueEdit | null>(null);
  const editHold = useRef<{ threadId: string; queuedMessageId: string } | null>(null), editLease = useRef(120000);
  const releaseEditHold = async () => { const target = editHold.current; editHold.current = null; if (target) await sdk.threads.queuedMessages.experimental_releaseEditHold(target); };
  useEffect(() => { setQueueEdit(null); return () => { void releaseEditHold(); }; }, [selected]);
  // bb's edit hold is a lease (2 min); bb's own editor renews it every quarter lease, so a long edit never dispatches mid-way.
  useEffect(() => {
    const target = editHold.current; if (!queueEdit || !target) return;
    const timer = setInterval(() => void sdk.threads.queuedMessages.experimental_holdForEdit(target).catch(e => {
      // Gone (404) or already being sent (409): the edit cannot be saved, so close it like bb does; other failures retry on the next tick.
      const status = (e as { status?: number }).status;
      if ((status === 404 || status === 409) && editHold.current === target) { editHold.current = null; setQueueEdit(null); setQueueError(errorText(e)); }
    }), editLease.current / 4);
    return () => clearInterval(timer);
  }, [queueEdit?.id]);
  const queueText = (row: typeof queue[number]) => row.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  const queueFiles = (row: typeof queue[number]): Attachment[] => row.content.flatMap(part => part.type === 'localImage' ? [{ type: 'localImage', path: part.path, name: part.path.split('/').at(-1) || 'Image', ...(part.sourceProjectId ? { sourceProjectId: part.sourceProjectId } : {}) }] as Attachment[] : part.type === 'localFile' ? [{ type: 'localFile', path: part.path, name: part.name || part.path.split('/').at(-1) || 'File', ...(part.mimeType ? { mimeType: part.mimeType } : {}), ...(part.sizeBytes ? { sizeBytes: part.sizeBytes } : {}), ...(part.sourceProjectId ? { sourceProjectId: part.sourceProjectId } : {}) }] as Attachment[] : []);
  // bb holds a queued row while it is edited so it cannot dispatch mid-edit; every exit path releases the hold.
  async function startQueueEdit(row: typeof queue[number]) { try { const target = { threadId: row.threadId, queuedMessageId: row.id }; const { leaseMs } = await sdk.threads.queuedMessages.experimental_holdForEdit(target); if (leaseMs > 0) editLease.current = leaseMs; editHold.current = target; setQueueEdit({ id: row.id, text: queueText(row), files: queueFiles(row), model: row.model, reasoningLevel: row.reasoningLevel as QueueEdit['reasoningLevel'], serviceTier: row.serviceTier as QueueEdit['serviceTier'], permissionMode: row.permissionMode }); } catch (e) { setQueueError(errorText(e)); } }
  async function finishQueueEdit(row: typeof queue[number], save: boolean) {
    const target = { threadId: row.threadId, queuedMessageId: row.id }, text = queueEdit?.text ?? '', files = queueEdit?.files ?? [];
    setQueueEdit(null);
    await queueAction(async () => { try { if (save && text.trim() && (text !== queueText(row) || JSON.stringify(files) !== JSON.stringify(queueFiles(row)) || queueEdit?.model !== row.model || queueEdit?.reasoningLevel !== row.reasoningLevel || queueEdit?.serviceTier !== row.serviceTier || queueEdit?.permissionMode !== row.permissionMode)) await sdk.threads.queuedMessages.update({ ...target, expectedUpdatedAt: row.updatedAt, model: queueEdit!.model, reasoningLevel: queueEdit!.reasoningLevel, serviceTier: queueEdit!.serviceTier, permissionMode: queueEdit!.permissionMode, input: [{ type: 'text', text, mentions: mentionsForText(text, id => { const thread = sidebarThreads.find(t => t.id === id); return thread ? { label: thread.displayTitle, projectId: thread.projectId } : undefined; }) }, ...files.map(file => {
      const original = row.content.find(part => part.type === file.type && part.path === file.path);
      return original ?? (file.type === 'localImage' ? { type: 'localImage' as const, path: file.path, ...(file.sourceProjectId ? { sourceProjectId: file.sourceProjectId } : {}) } : { type: 'localFile' as const, path: file.path, name: file.name, ...(file.mimeType ? { mimeType: file.mimeType } : {}), ...(file.sizeBytes ? { sizeBytes: file.sizeBytes } : {}), ...(file.sourceProjectId ? { sourceProjectId: file.sourceProjectId } : {}) });
    }), ...row.content.filter(part => part.type === 'image')] }); } finally { await releaseEditHold(); } });
  }
  useEffect(() => { if (!jump || !pages.length) return; const node = scroll.current, card = node?.querySelector<HTMLElement>(`[data-history-ids~="${jump}"]`); if (card && node) { release(); const header = node.querySelector<HTMLElement>('[data-conversation-header]')?.offsetHeight ?? 0; node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top - header; setFlash(jump); setTimeout(() => setFlash(current => current === jump ? null : current), 1500); setJump(null); setOlder(false); } else if (pages.at(-1)?.nextCursor && depth < 20 && pages.length >= depth) { position.current.prepend = true; setDepth(depth + 1); } else if (!pages.at(-1)?.nextCursor || depth >= 20) { setOlder(true); setJump(null); } }, [jump, pages, depth]);
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
    setDraft({ threadId: selected, projectId: recipients?.recipients.find(r => r.threadId === selected)?.projectId ?? null, itemId: body.dataset.item!, quote, quoteSeq: body.dataset.seq ? Number(body.dataset.seq) : undefined, ...selectionPosition(range, scroll.current, Math.min(560, scroll.current.clientWidth - 16)), width: Math.min(560, scroll.current.clientWidth - 16) });
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
  const items = useMemo(() => { const seen = new Set<string>(); return (pages === NO_PAGES ? loaded.pages : pages.slice(0, depth)).flatMap(page => page.items).filter(item => !seen.has(item.id) && !!seen.add(item.id)).reverse(); }, [pages, loaded.pages, depth]);
  const historyGroups = useMemo(() => groupItems(items), [items]);
  useEffect(() => { if (!selected || !pages.length) return; const questions = [...pages.flatMap(page => page.items)].filter(item => item.threadId === selected); setOptimistic(old => { const remaining = [...questions], matched = new Set<number>(); for (const b of [...old].reverse()) { if (b.threadId !== selected) continue; const index = remaining.findIndex(item => !b.seenIds.includes(item.id) && item.question.trim() === b.text); if (index >= 0) { remaining.splice(index, 1); matched.add(b.id); } } return matched.size ? old.filter(b => !matched.has(b.id)) : old; }); }, [selected, pages]);
  if (position.current.fresh && pages.length) mark.current = items.find(isUnread)?.id ?? null;
  const openUnread = recipients?.recipients.find(r => r.threadId === selected)?.unread ?? 0;
  // bb's chat has no per-message read marks, so an open conversation counts as read.
  useEffect(() => { if (bbChat && selected && openUnread) void rpc.call('markThreadRead', { threadId: selected }).then(() => refresh()).catch(() => {}); }, [bbChat, selected, openUnread]);
  const mobileHeader = selected && <div className="sticky top-0 z-[1] flex items-center gap-2.5 border-b border-border-seam bg-background px-4 py-2 min-[640px]:hidden"><Button size="sm" variant="ghost" className="min-[640px]:hidden" aria-label="Back" onClick={() => setSelected(undefined)}><Icon name="ArrowLeft" aria-hidden /></Button>{(() => { const current = recipients?.recipients.find(r => r.threadId === selected); return <><Avatar id={selected} title={current?.threadTitle ?? null} /><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{current?.threadTitle ?? 'Untitled thread'}</span><span className="block truncate text-xs text-muted-foreground">{current?.projectName ?? 'No project'}</span></span><Button asChild size="sm" variant="ghost" aria-label="Open thread"><UrlLink href={`${current?.projectId ? `/projects/${current.projectId}` : ''}/threads/${selected}`}><Icon name="ExternalLink" aria-hidden /></UrlLink></Button></>; })()}</div>;
  return <div ref={grid} className="relative grid h-full min-[640px]:grid-cols-[var(--contacts-width)_1fr]" style={{ '--contacts-width': `${contactsWidth}px` } as CSSProperties}>
    <div role="separator" aria-orientation="vertical" aria-label="Resize contacts" aria-valuenow={contactsWidth} aria-valuemin={CONTACTS_MIN} aria-valuemax={CONTACTS_MAX} tabIndex={0} title="Drag to resize; double-click to reset"
      className="absolute inset-y-0 z-[3] w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-border focus-visible:bg-border focus-visible:outline-none max-[639px]:hidden" style={{ left: contactsWidth }}
      onPointerDown={event => { event.preventDefault(); const handle = event.currentTarget, left = grid.current!.getBoundingClientRect().left; handle.setPointerCapture(event.pointerId); const move = (e: PointerEvent) => resize(e.clientX - left); const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); }; handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); }}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(contactsWidth + (event.key === 'ArrowLeft' ? -16 : 16)); } }}
      onDoubleClick={() => setContactsWidth(CONTACTS_DEFAULT)} />
    <div className={`flex min-h-0 flex-col min-[640px]:border-r min-[640px]:border-border-seam ${selected ? 'max-[639px]:hidden' : ''}`}><div role="listbox" aria-label="Recipients" className="relative min-h-0 flex-1 space-y-0.5 overflow-auto p-2">
      {/* With a list already shown, a failed refresh (e.g. while the plugin restarts) floats over it instead of pushing the rows down. */}
      {result.error && <p role="alert" className={recipients ? 'absolute inset-x-2 top-2 z-10 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive shadow-lift' : 'px-2 py-1 text-xs text-destructive'}>{result.error.message}</p>}
      {recipients?.recipients.length === 0 && <EmptyState icon="MailOpen" title={questions ? 'No open questions' : 'All caught up'}>{questions ? 'Answers to your questions will show up here.' : 'New answers from your threads will show up here.'}</EmptyState>}
      {groups.map(([group, list]) => { const movable = !!group && order.includes(group), over = drag?.over === group && drag.id !== group; return <div key={group ?? ''} role={group !== null ? 'group' : undefined} aria-label={group !== null ? list[0]?.projectName ?? 'No project' : undefined}
        className={`space-y-0.5 ${over ? (drag!.after ? 'shadow-[0_2px_0_0_var(--color-ring,currentColor)]' : 'shadow-[0_-2px_0_0_var(--color-ring,currentColor)]') : ''} ${drag?.id === group ? 'opacity-50' : ''}`}
        onDragOver={event => { if (!drag || !movable || drag.id === group) return; event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(), after = event.clientY > r.top + r.height / 2; if (drag.over !== group || drag.after !== after) setDrag({ ...drag, over: group!, after }); }}
        onDrop={event => { if (!drag || !movable || drag.id === group) return; event.preventDefault(); moveProject(drag.id, group!, !!drag.after); setDrag(null); }}>
        {group !== null && <p draggable={movable} title={movable ? 'Drag to reorder projects' : undefined} className={`px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground ${movable ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', group); setDrag({ id: group }); }} onDragEnd={() => setDrag(null)}>{list[0]?.projectName ?? 'No project'}</p>}{list.map(recipient => { const thread = sidebarThreads.find(t => t.id === recipient.threadId), status = thread ? statusOf(thread) : null, busy = !!status && (status.isWorking || status.indicator === 'waiting-for-input'); const row = <button role="option" aria-selected={selected === recipient.threadId} className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 ${selected === recipient.threadId ? 'bg-state-active' : 'hover:bg-state-hover'} ${recipient.unread ? '' : 'opacity-70'}`} onKeyDown={event => { if (event.key === 'ArrowDown') (event.currentTarget.nextElementSibling as HTMLElement)?.focus(); if (event.key === 'ArrowUp') (event.currentTarget.previousElementSibling as HTMLElement)?.focus(); }} onClick={async () => {
        if (selected !== recipient.threadId) { setCompose(drafts[recipient.threadId] ?? { text: '', files: [] }); setComposeError(''); setDepth(1); setSettled(false); position.current = { height: 0, top: 0, bottom: false, fresh: true, prepend: false }; setSelected(recipient.threadId); }
        else try { onBulkRead?.(await rpc.call('markThreadRead', { threadId: recipient.threadId })); refresh(); } catch (e) { setError(errorText(e)); }
      }}><Avatar id={recipient.threadId} title={recipient.threadTitle} /><span className="min-w-0 flex-1"><span className="flex items-baseline gap-2"><span className={`min-w-0 flex-1 truncate ${recipient.unread ? 'font-medium' : 'font-normal text-muted-foreground'}`}>{recipient.threadTitle ?? 'Untitled thread'}</span><span className="flex shrink-0 items-center text-[11px] text-muted-foreground">{busy ? <ThreadStatusGlyph indicator={status!.indicator} size="compact" /> : ago(recipient.lastAt)}</span></span><span className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{recipient.preview || recipient.projectName || 'No project'}</span>{recipient.unread > 0 && <span aria-label={`${recipient.unread} unread`} className="shrink-0 rounded-full bg-foreground/85 px-1.5 text-[11px] font-medium leading-[18px] text-background">{recipient.unread}</span>}</span></span></button>
        // bb's own thread menu on right-click (Archive, Pin, Rename, Delete); threads bb does not list keep a plain row.
        return thread ? <ThreadActionsContextMenu key={recipient.threadId} thread={{ ...thread, environment: thread.environment?.id ? { id: thread.environment.id, path: thread.environment.path } : null }}>{row}</ThreadActionsContextMenu> : <Fragment key={recipient.threadId}>{row}</Fragment>; })}</div>; })}
    </div><ContactsFooter /></div>
    {bbChat && selected ? <div className="flex min-h-0 min-w-0 flex-col">{mobileHeader}<ThreadChat key={selected} threadId={selected} variant="full" className="min-h-0 flex-1" /></div> :
    <div ref={scroll} className={`relative overflow-auto min-w-0 ${!selected ? 'max-[639px]:hidden' : ''}`} onMouseUp={capture} onKeyUp={capture} onScroll={event => { const node = event.currentTarget; position.current = { ...position.current, height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < 24 }; if (selected && !position.current.fresh) { scrollPending.current = { threadId: selected, top: node.scrollTop, depth }; if (!scrollTimer.current) scrollTimer.current = setTimeout(saveScroll, 200); } }}>
      {!selected && <EmptyState icon="MessageQuestion" title="Pick a conversation">Answers are grouped by thread. Open one to read it from the start and reply with quotes.</EmptyState>}
      {selected && <>{mobileHeader}<div data-conversation-header className="sticky top-[57px] z-[2] flex justify-end min-[640px]:top-0 border-b border-border-seam bg-background px-3 py-1"><Button size="sm" variant="ghost" aria-label="Search conversation" onClick={() => { setSearch(!search); setOlder(false); }}><Icon name="Search" aria-hidden /></Button>{search && <input aria-label="Search conversation" autoFocus className="w-56 rounded border border-border-seam bg-background px-2 text-sm" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearch(false); setQuery(''); setOlder(false); } }} />}{search && query.trim() && <div role="listbox" aria-label="Search results" className="absolute right-3 top-full z-10 max-h-64 w-72 overflow-auto rounded border border-border-seam bg-background shadow-lg">{searchError && <p role="alert">{searchError}</p>}{matches.map(match => <button key={match.id} role="option" aria-selected={false} className="block w-full border-b border-border-seam p-2 text-left text-xs hover:bg-state-hover" onClick={() => { setJump(match.id); setOlder(false); setSearch(false); }}>{(match.answer || match.question).slice(0, 160)} <time className="block text-muted-foreground">{new Date(match.updatedAt).toLocaleDateString()}</time></button>)}</div>}</div>{older && <p role="status" className="px-4 text-xs">Older than loaded history — <UrlLink href={`${recipients?.recipients.find(r => r.threadId === selected)?.projectId ? `/projects/${recipients?.recipients.find(r => r.threadId === selected)?.projectId}` : ''}/threads/${selected}`}>open in chat</UrlLink></p>}<HistoryPage key={selected} threadId={selected} index={0} unread={recipients?.recipients.find(r => r.threadId === selected)?.unread} {...{ depth, receive }} />{pages.at(-1)?.nextCursor && <Button onClick={() => { position.current.prepend = true; setDepth(depth + 1); }}>Load earlier</Button>}<ul className="divide-y divide-border-seam px-4 [&>:has(+[data-new])]:border-b-0" aria-label="History">{historyGroups.map(group => <Fragment key={group.at(-1)!.id}>{group.some(member => member.id === mark.current) && <li data-new className="border-b-0 flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />New<span className="h-px flex-1 bg-border" /></li>}<div data-history-ids={group.map(member => member.id).join(' ')} data-flash={(flash !== null && group.some(member => member.id === flash)) || undefined} className={`transition-colors duration-[1500ms] ${flash !== null && group.some(member => member.id === flash) ? 'bg-state-active' : ''}`}><ItemCard item={group.at(-1)!} members={group.length > 1 ? group : undefined} chat autoRead={settled} replyToOwn={false} /></div></Fragment>)}</ul>{optimistic.filter(b => b.threadId === selected).map(b => <div key={b.id} role="status" className="mx-4 mb-3 ml-auto flex w-fit max-w-[70%] flex-col items-end"><div className={`${userBubble} opacity-70`}><div className="whitespace-pre-wrap break-words">{b.text}</div></div></div>)}<div className="sticky bottom-0 z-[1] bg-background px-3 py-2"><PendingInteractions key={selected} threadId={selected} projectId={openThread?.projectId} pending={!!openThread?.hasPendingInteraction} status={openThread?.status} />{queue.some(row => row.threadId === selected) && <QueueCard rows={queue.filter(row => row.threadId === selected)} providerId={openThread?.providerId} sourceName={row => row.senderThreadId ? sidebarThreads.find(thread => thread.id === row.senderThreadId)?.title ?? null : row.originPluginId ?? (row.origin === 'cli' ? 'CLI' : null)} projectId={recipients?.recipients.find(r => r.threadId === selected)?.projectId} edit={queueEdit} onEdit={(row, update) => update ? setQueueEdit(current => current?.id === row.id ? { ...current, ...update } : current) : void startQueueEdit(row)} onFinish={(row, save) => void finishQueueEdit(row, save)} onSend={row => void queueAction(() => sdk.threads.queuedMessages.send({ threadId: row.threadId, queuedMessageId: row.id, mode: 'auto' }))} onDelete={row => void queueAction(() => sdk.threads.queuedMessages.delete({ threadId: row.threadId, queuedMessageId: row.id }))} onSchedule={(row, sendAt) => void queueAction(() => sdk.threads.queuedMessages.update({ threadId: row.threadId, queuedMessageId: row.id, expectedUpdatedAt: row.updatedAt, sendAt }))} onReorder={(row, previousQueuedMessageId, nextQueuedMessageId) => void queueAction(() => sdk.threads.queuedMessages.reorder({ threadId: row.threadId, queuedMessageId: row.id, previousQueuedMessageId, nextQueuedMessageId }))} />}{queueError && <p role="alert" className="text-xs text-destructive">{queueError}</p>}<div className="relative z-20"><Composer key={selected} editableWhilePending label="Send message" sendLabel="Send message" placeholder="Message…" value={compose.text} onChange={text => updateCompose(selected, { ...drafts[selected], text, files: drafts[selected]?.files ?? [] })} attachments={compose.files} onAttachments={update => { const current = drafts[selected] ?? { text: '', files: [] }; updateCompose(selected, { ...current, files: update(current.files) }); }} projectId={recipients?.recipients.find(r => r.threadId === selected)?.projectId} pending={composePending} onSend={options => void sendCompose(options)} /></div>{composeError && <p role="alert">{composeError}</p>}<div className="mt-1 flex min-h-6 max-h-6 items-center justify-between gap-2 overflow-hidden pl-[15px]"><div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{openThread && <span className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1 text-xs leading-tight text-muted-foreground"><Icon name="Folder" aria-hidden className="size-4 shrink-0" /><span className="truncate">{projects.find(p => p.id === openThread.projectId)?.name ?? 'No project'}</span></span>}{(openThread?.environment?.branchName || openThread?.environment?.name) && <span className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1 text-xs leading-tight text-muted-foreground" title={openThread!.environment!.isWorktree ? 'Worktree' : 'Branch'}><Icon name="GitBranch" aria-hidden className="size-4 shrink-0" /><span className="truncate">{openThread!.environment!.branchName ?? openThread!.environment!.name}</span></span>}</div><div className="flex shrink-0 items-center gap-2">{context?.usage && context.usage.modelContextWindow > 0 && <ContextRing used={context.usage.usedTokens} total={context.usage.modelContextWindow} />}</div></div></div></>}
      {draft && <div ref={popup} role="dialog" aria-label="Quote reply" className="absolute z-10" style={{ width: draft.width, top: draft.top, left: draft.left }} onBlur={event => { if (event.relatedTarget && !(event.relatedTarget as Element).closest?.('[role=option]') && !event.currentTarget.contains(event.relatedTarget as Node)) setDraft(null); }}>
        <Composer label="Quote reply text" className="shadow-lg" autoFocus value={text} onChange={setText} attachments={files} onAttachments={update => setFiles(update)} projectId={draft.projectId} pending={pending} sendDisabled={draft.quote.length > 20000} onSend={options => void send(false, options)}
          header={<div className="flex items-start gap-2 pl-4 pr-2 pt-2"><div className="mt-1 max-h-32 min-w-0 flex-1 overflow-auto border-l-2 border-border-seam pl-2 text-sm text-muted-foreground"><Markdown content={draft.quote} /></div><Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" aria-label="Close" onClick={() => setDraft(null)}><Icon name="X" aria-hidden /></Button></div>}
          actions={<Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="Add to pool" disabled={pending || draft.quote.length > 20000} onClick={() => void send(true)}><Icon name="ListEnd" aria-hidden /></Button>} />
        {error && <p role="alert" className="mt-1 rounded-md bg-background px-2 text-xs text-destructive">{error}</p>}
      </div>}
      {!draft && error && <p role="alert">{error}</p>}
    </div>}
  </div>;
}

type Editor = { flush: () => Promise<void> };
function PoolNote({ entry, projectId, editors, autoFocus, pending, onSend }: { entry: PoolEntry; projectId: string | null; editors: Map<string, Editor>; autoFocus?: boolean; pending: boolean; onSend: (id: string, options?: SendOptions) => void }) {
  const rpc = useRpc<AnswersRpcContract>(), { refresh } = experimental_useRpcRefresh();
  const [note, setNote] = useState(entry.note), [files, setFiles] = useState(entry.attachments), [status, setStatus] = useState('Saved'), [expanded, setExpanded] = useState(false), [clamped, setClamped] = useState(false);
  const quote = useRef<HTMLDivElement>(null);
  const local = useRef({ note: entry.note, files: entry.attachments, saved: entry.note, savedFiles: entry.attachments, revision: entry.revision, flight: null as Promise<void> | null });
  useEffect(() => { const node = quote.current; if (node) setClamped(node.scrollHeight > node.clientHeight + 1); }, [entry.quote]);
  useEffect(() => { if (entry.revision > local.current.revision) { const clean = local.current.note === local.current.saved && JSON.stringify(local.current.files) === JSON.stringify(local.current.savedFiles); local.current.revision = entry.revision; local.current.saved = entry.note; local.current.savedFiles = entry.attachments; if (clean) { local.current.note = entry.note; local.current.files = entry.attachments; setNote(entry.note); setFiles(entry.attachments); } } }, [entry.revision, entry.note, entry.attachments]);
  async function flush(): Promise<void> {
    const state = local.current;
    if (state.flight) await state.flight;
    if (state.note === state.saved && JSON.stringify(state.files) === JSON.stringify(state.savedFiles)) return;
    const saving = state.note, savingFiles = state.files;
    setStatus('Saving…');
    state.flight = rpc.call('poolUpdate', { id: entry.id, note: saving, attachments: savingFiles, revision: state.revision }).then(result => { state.revision = result.revision; state.saved = saving; state.savedFiles = savingFiles; setStatus('Saved'); refresh(); }).catch(e => { setStatus(`Not saved: ${errorText(e)}`); refresh(); throw e; }).finally(() => { state.flight = null; });
    await state.flight;
    if (state.note !== state.saved || JSON.stringify(state.files) !== JSON.stringify(state.savedFiles)) await flush();
  }
  editors.set(entry.id, { flush });
  useEffect(() => () => { editors.delete(entry.id); }, [entry.id, editors]);
  useEffect(() => { if (note === local.current.saved && JSON.stringify(files) === JSON.stringify(local.current.savedFiles)) return; const timer = setTimeout(() => { void flush().catch(() => {}); }, 800); return () => clearTimeout(timer); }, [note, files]);
  // Autosave is silent: pending and in-flight states would add a line and make the card jump; only failures show.
  const problem = !['Saved', 'Saving…', 'Not saved'].includes(status);
  const remove = async () => { try { await rpc.call('poolRemove', { id: entry.id }); refresh(); } catch (e) { setStatus(errorText(e)); } };
  return <li className="space-y-2">
    <Composer label="Pool note" sendLabel="Send entry" autoFocus={autoFocus} placeholder={entry.quote ? 'Your reply to this quote…' : 'Your message…'} value={note} onChange={value => { local.current.note = value; setNote(value); setStatus('Not saved'); }} attachments={files} onAttachments={update => { const next = update(local.current.files); local.current.files = next; setFiles(next); setStatus('Not saved'); }} projectId={projectId} pending={pending} onBlur={() => void flush().catch(() => {})} onSend={options => onSend(entry.id, options)} actions={<Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="Remove" onClick={() => void remove()}><Icon name="Trash2" aria-hidden className="size-3.5" /></Button>} header={entry.quote && <div className="border-l-2 border-border-seam pl-3 pr-3 pt-3 text-sm text-muted-foreground"><div ref={quote} className={expanded ? '' : 'line-clamp-3'}><Markdown content={entry.quote} /></div>{(clamped || expanded) && <button type="button" className="mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}</div>} />
    {problem && <p role="status" className={`text-[11px] ${status.startsWith('Not saved:') ? 'text-destructive' : 'text-muted-foreground'}`}>{status}</p>}
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
  async function sendAll(options?: SendOptions, id?: string) {
    setPending(true); setFeedback('');
    try {
      try { await Promise.all((id ? [editors.get(id)!] : [...editors.values()]).map(editor => editor.flush())); } catch (e) { setFeedback(`Not sent — ${errorText(e)}`); return; }
      const result = await rpc.call('poolSend', { threadId: pool.threadId, ...(id ? { ids: [id] } : {}), ...(options ? { send: options } : {}) }); refresh();
      setFeedback(`${options?.mode === 'draft' ? 'Draft saved' : options?.sendAt ? 'Scheduled' : result.delivery === 'sent' ? 'Sent' : 'Queued'}${result.keptEdited ? ` — ${result.keptEdited} edited entries were not sent` : ''}`);
    } catch (e) { setFeedback(`Delivery uncertain — check the thread before retrying. ${errorText(e)}`); }
    finally { setPending(false); }
  }
  return <section className="space-y-2 border-b border-border-seam px-3 py-3 last:border-b-0">
    <UrlLink className="block truncate text-sm font-medium hover:underline" href={`${pool.projectId ? `/projects/${pool.projectId}` : ''}/threads/${pool.threadId}`}>{pool.threadTitle ?? 'Untitled thread'}</UrlLink>
    <ul className="space-y-2">{pool.entries.map(entry => <PoolNote key={entry.id} {...{ entry, editors, pending }} projectId={pool.projectId} onSend={(id, options) => { if (!pending) void sendAll(options, id); }} autoFocus={entry.id === focusId} />)}</ul>
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
