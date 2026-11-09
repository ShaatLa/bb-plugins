import { Fragment, useEffect, useRef, useState } from 'react';
import { definePluginApp, experimental_Icon as Icon, experimental_ImageLightbox as ImageLightbox, experimental_ThreadStatusGlyph as ThreadStatusGlyph, Markdown, UrlLink, useRpc, useSdk, useSettings, experimental_useRpcQuery as useQuery, experimental_useSidebarThreads, experimental_useAppPanel, experimental_usePanelTabs, experimental_useRpcRefresh } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type ItemAttachment, type View, type Attachment, type SendOptions } from './contract';
import { Inbox, Pools } from './inbox';
import { ChatComment, COMMENT_EVENT } from './chat-comment';
import { Composer } from './composer';
import { EmptyState, useTransientText, type IconName } from './empty';
import { Button } from './components/ui/button';
import { useStoredState } from './lib/stored-state';
import { parseInlineComments } from './inline-comments';

const emptyCopy: Record<View, [IconName, string, string]> = {
  unread: ['MailOpen', 'All caught up', 'New answers will show up here.'],
  waiting: ['Clock', 'Nothing waiting', 'Questions still waiting for an answer show up here.'],
  for_me: ['MessageQuestion', 'No questions for you', 'When an agent asks you something without blocking, it shows up here.'],
  pinned: ['Pin', 'Nothing pinned', 'Pin an answer to keep it at hand.'],
  saved: ['Star', 'Nothing saved', 'Use “Save to Answers” on any chat message to keep it here.'],
  all: ['MessageQuestion', 'No answers yet', 'Your questions and the agents’ answers show up here.'],
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function ItemAttachments({ attachments, projectId }: { attachments: ItemAttachment[]; projectId: string | null }) {
  const sdk = useSdk(), [urls, setUrls] = useState<Record<number, string>>({}), [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    let active = true;
    const loaded: string[] = [];
    attachments.forEach((attachment, index) => {
      const owner = attachment.sourceProjectId ?? projectId;
      if (!owner) return;
      void sdk.projects.attachments.read({projectId:owner,path:attachment.path}).then(file => {
        const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], {type:file.mimeType}));
        if (active) { loaded.push(url); setUrls(current => ({...current,[index]:url})); }
        else URL.revokeObjectURL(url);
      }).catch(() => {});
    });
    return () => { active = false; loaded.forEach(url => URL.revokeObjectURL(url)); };
  }, [attachments, projectId, sdk]);
  const images = attachments.map((attachment, index) => attachment.type === 'localImage' ? index : -1).filter(index => index >= 0);
  const selected = open === null ? null : attachments[open];
  return <>
    <div className="mt-2 flex flex-wrap gap-2">{attachments.map((attachment, index) => {
      const name = attachment.name ?? attachment.path.split('/').at(-1) ?? 'Attachment', url = urls[index];
      return attachment.type === 'localImage' ? <button key={index} type="button" aria-label={name} className="overflow-hidden rounded-lg border border-border-seam" onClick={() => setOpen(index)} disabled={!url}>{url ? <img src={url} alt={name} className="max-h-48 max-w-64 object-contain" /> : <span className="block px-3 py-2 text-xs">{name}</span>}</button>
        : <a key={index} href={url} download={name} aria-disabled={!url} className="inline-flex items-center gap-1.5 rounded-lg border border-border-seam px-2.5 py-1.5 text-xs hover:bg-state-hover"><Icon name="File" aria-hidden className="size-4" />{name}</a>;
    })}</div>
    {selected && <ImageLightbox isOpen imageSrc={urls[open!] ?? null} imageAlt={selected.name ?? 'Attached image'} title={selected.name ?? selected.path.split('/').at(-1) ?? 'Image'} hasMultipleImages={images.length > 1} previousDisabled={open === images[0]} nextDisabled={open === images.at(-1)} onClose={() => setOpen(null)} onPrevious={() => setOpen(images[images.indexOf(open!) - 1] ?? null)} onNext={() => setOpen(images[images.indexOf(open!) + 1] ?? null)} />}
  </>;
}

export function useAnswersBadge() {
  const { data } = useQuery({ contract: rpcContract, method: 'counts', input: {} });
  const count = data ? data.inbox : 0;
  return count ? { count, label: `${count} unread answers and questions for you` } : null;
}

// chat: render as a conversation exchange (no thread header); markable: offer Mark read (the Inbox marks on open).
// Like Telegram's read cursor: a message is read once its end has reached the screen or was scrolled past. No timer.
function useReadOnView(ref: React.RefObject<HTMLElement | null>, enabled: boolean, onRead: () => void) {
  const latest = useRef(onRead); latest.current = onRead;
  useEffect(() => {
    const node = ref.current, root = node?.closest<HTMLElement>('.overflow-auto');
    if (!enabled || !node || !root) return;
    let frame = 0, done = false;
    const check = () => {
      frame = 0; if (done || document.visibilityState === 'hidden') return;
      const box = node.getBoundingClientRect();
      if (box.height > 0 && box.bottom <= root.getBoundingClientRect().bottom) { done = true; latest.current(); }
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(check); };
    root.addEventListener('scroll', schedule, { passive: true }); document.addEventListener('visibilitychange', check);
    check();
    return () => { done = true; cancelAnimationFrame(frame); root.removeEventListener('scroll', schedule); document.removeEventListener('visibilitychange', check); };
  }, [ref, enabled]);
}
// bb's icon set has no double check; drawn in its stroke style (geometry as Lucide's check-check).
function ReadTicks({ at }: { at: number }) {
  const label = `Read ${new Date(at).toLocaleString()}`;
  return <svg role="img" aria-label={label} viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><title>{label}</title><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></svg>;
}
export const isUnread = (item: Item) => item.dismissedAt === null && item.readAt === null && item.snoozedUntil === null && ((item.kind === 'mine' && item.status === 'answered') || (item.kind === 'for_me' && item.status === 'open') || (item.kind === 'mine' && (item.status === 'waiting' || item.status === 'deferred') && item.failedAt !== null));
const SAVED_FLASH = 'bb-plugin-answers:saved-flash';
const PROJECT_CHOICE = 'bb-plugin-answers:task-project';
export function useReadUndo() {
  const rpc = useRpc<AnswersRpcContract>(), { refresh } = experimental_useRpcRefresh();
  const [undo, setUndo] = useState<{ batch: string; count: number } | null>(null), [expired, setExpired] = useState(false);
  useEffect(() => { if (!undo) return; const timer = setTimeout(() => setUndo(null), 8000); return () => clearTimeout(timer); }, [undo]);
  const record = (result: { batch: string | null; count: number }) => { if (result.batch && result.count) { setUndo({ batch: result.batch, count: result.count }); setExpired(false); } };
  const line = undo && <p role="status" className="px-4 py-2 text-xs">{expired ? 'Undo expired' : `Marked ${undo.count} read`} · <Button variant="ghost" size="sm" onClick={async () => { const result = await rpc.call('undoRead', { batch: undo.batch }); if (result.count) setUndo(null); else setExpired(true); refresh(); }}>Undo</Button></p>;
  return { record, line };
}
export function ItemCard({ item, members, chat = false, markable = !chat, autoRead = false, replyToOwn = true }: { item: Item; members?: Item[]; chat?: boolean; markable?: boolean; autoRead?: boolean; replyToOwn?: boolean }) {
  const rpc = useRpc<AnswersRpcContract>();
  // Refresh reads after our own writes instead of relying only on the server's realtime invalidation.
  const { refresh } = experimental_useRpcRefresh();
  const group = members?.length ? members : [item], last = group.at(-1)!;
  const [menu, setMenu] = useState<'main' | 'snooze' | 'task' | null>(null);
  const { data: workBoard } = useQuery({ contract: rpcContract, method: 'workBoardProjects', input: {} });
  const [expanded, setExpanded] = useState(false);
  const question = useRef<HTMLDivElement>(null);
  const [clamped, setClamped] = useState(false);
  // Offer Expand only when the 2-line clamp actually hides text.
  useEffect(() => {
    const node = question.current;
    if (!node) return;
    const measure = () => setClamped(node.scrollHeight > node.clientHeight + 1);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [item.question]);
  const [replying, setReplying] = useState(false);
  const replyBox = useRef<HTMLDivElement>(null);
  // Focus alone leaves the reply box under the conversation's sticky bottom composer; scroll it clear.
  useEffect(() => {
    const node = replyBox.current; if (!replying || !node) return;
    const sticky = node.closest('.overflow-auto')?.querySelector<HTMLElement>('.sticky.bottom-0')?.offsetHeight ?? 0;
    node.style.scrollMarginBottom = `${sticky + 8}px`; node.scrollIntoView?.({ block: 'nearest' });
  }, [replying]);
  const [text, setText] = useState(''), [files, setFiles] = useState<Attachment[]>([]);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  async function act(write: () => Promise<unknown>) {
    setError('');
    try { await write(); refresh(); } catch (cause) { setError(message(cause)); }
  }
  async function reply(options?: SendOptions, quick?: string) {
    if (sending.current || !(quick ?? text).trim()) return;
    sending.current = true;
    setPending(true); setError(''); setFeedback('');
    try {
      const result = await rpc.call('reply', { id: last.id, text: quick ?? text, ...(files.length ? { attachments: files } : {}), ...(options ? { send: options } : {}) });
      refresh(); setFeedback(options?.mode === 'draft' ? 'Draft saved' : options?.sendAt ? 'Scheduled' : result.delivery === 'sent' ? 'Sent' : 'Queued'); setText(''); setFiles([]); setReplying(false);
    } catch (cause) {
      setError(`Delivery uncertain — check the thread before retrying. ${message(cause)}`);
    } finally { sending.current = false; setPending(false); }
  }
  const seq = last.answerSeq ?? last.questionSeq;
  // BB's message routes use the project prefix when the thread belongs to a project.
  const href = `${item.projectId ? `/projects/${encodeURIComponent(item.projectId)}` : ''}/threads/${encodeURIComponent(item.threadId)}${seq === null ? '' : `?msg=${seq}`}`;
  const minutes = Math.max(0, Math.floor((Date.now() - item.createdAt) / 60000));
  const age = minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  // Same look as bb chat: my message is a recessed bubble on the right, the agent's text has no background.
  const userBubble = 'max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground';
  const agentText = 'w-full px-2 text-sm leading-relaxed';
  const iconProps = (text: string) => ({ 'aria-label': text, title: text, variant: 'ghost' as const, className: 'size-8 px-0' });
  const unread = group.some(isUnread), card = useRef<HTMLLIElement>(null);
  // Telegram-style status: a dot while the answer is new, a double check once read.
  const readMark = unread ? <span className="size-1.5 rounded-full bg-foreground/70" aria-label="Unread" /> : group.every(member => member.readAt !== null) && last.kind === 'mine' && last.status === 'answered' ? <ReadTicks at={last.readAt!} /> : null;
  useReadOnView(card, autoRead && unread, () => void act(() => rpc.call('markRead', { ids: group.filter(isUnread).map(member => member.id) })));
  // "Done" said different things per item; name what dismissing actually does, and offer it only where it does something.
  const dismiss: [string, IconName] | null = item.dismissedAt !== null ? null
    : item.kind === 'mine' && (item.status === 'waiting' || item.status === 'deferred') ? ['Stop waiting', 'X']
    : item.kind === 'for_me' && item.status === 'open' ? ['Won’t reply', 'X']
    : item.kind === 'saved' ? ['Remove from Saved', 'Trash2'] : null;
  const isQuestion = item.kind === 'mine' && /[?？]/.test(item.question);
  // bb's own working spinner while the answer is pending; a failed turn shows its own notice instead.
  const status = item.status === 'waiting' && item.failedAt === null ? <span title="Waiting for the answer" className="inline-flex items-center"><ThreadStatusGlyph indicator="runtime" size="compact" /><span className="sr-only">waiting</span></span> : item.status;
  const time = <time className="text-xs text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>{age}</time>;
  const agentBody = (content: string, seq: number | null) => <div className={agentText} data-agent-body data-item={item.id} data-seq={seq ?? undefined}><Markdown content={content} /></div>;
  return <li ref={card} className={chat ? 'group space-y-3 py-5' : 'group space-y-3 rounded-xl border border-border-seam p-4'}>
    {!chat && <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 text-xs text-muted-foreground">
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{item.threadTitle ?? 'Untitled thread'}</h2>
      {item.projectName && <span>{item.projectName}</span>}
      <span className="flex-1" />
      {item.status !== 'answered' && <span>{status}</span>}
      {time}
      {item.threadDeleted && <span>Thread deleted</span>}
    </div>}
    {item.kind === 'for_me' ? <div className="space-y-1">
      <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><Icon name="MessageQuestion" aria-hidden />Question for you{chat && <>{' · '}{time}</>}</div>
      <div ref={question} className={expanded ? '' : 'line-clamp-6'}>{agentBody(item.question, item.questionSeq)}</div>
    </div> : <div className="ml-auto flex w-fit max-w-[70%] flex-col items-end gap-1">
      {(chat || isQuestion) && <div className="flex items-center gap-2 text-xs text-muted-foreground">{isQuestion && <span className="flex items-center gap-1"><Icon name="MessageQuestion" aria-hidden className="size-3.5" />Question</span>}{chat && time}</div>}
      {group.map(member => <div key={member.id} className={userBubble}><div ref={member === item ? question : undefined} className={`whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}><InlineCommentText text={member.question} prefixes={workBoard?.projects.map(p => p.prefix)} /></div>{member.attachments.length > 0 && <ItemAttachments attachments={member.attachments} projectId={member.projectId} />}</div>)}
    </div>}
    {(clamped || expanded) && <Button variant="ghost" size="sm" className={chat ? 'ml-auto flex h-6 px-2 text-xs text-muted-foreground' : undefined} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{chat ? (expanded ? 'Show less' : 'Show more') : (expanded ? 'Collapse question' : 'Expand question')}</Button>}
    {item.answer && agentBody(item.answer, item.answerSeq)}
    {item.interim && <div className="space-y-1"><h3 className="px-2 text-xs font-medium text-muted-foreground">Interim reply</h3>{agentBody(item.interim, item.interimSeq)}</div>}
    {item.likelyInterim && item.status === 'answered' && <div className="flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground"><span>Looks like an interim reply</span><Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('keepWaiting', { id: last.id }))}>Keep waiting</Button><Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('setInterim', { id: last.id, value: false }))}>It's the answer</Button></div>}
    {item.failedAt !== null && <div className="flex items-center gap-2 px-2 text-xs text-destructive">Turn failed <Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('retryTurn', { id: last.id }))}>Retry</Button></div>}
    {item.snoozedUntil !== null && <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">Snoozed until {new Date(item.snoozedUntil).toLocaleString()} <Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('snooze', { id: last.id, until: null }))}>Unsnooze</Button></div>}
    {item.taskKey && <UrlLink href={`/plugins/work-board/work-board/task/${encodeURIComponent(item.taskKey)}`} className="mx-2 text-xs">{item.taskKey}</UrlLink>}
    {item.note && <p className="px-2 text-sm text-muted-foreground whitespace-pre-wrap">{item.note}</p>}
    <div className="flex items-center gap-2"><div className="flex items-center gap-0.5 px-1 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[role=menu]]:opacity-100">
      {!item.threadDeleted && <Button asChild size="sm" {...iconProps('Open in chat')}><UrlLink href={href} onClick={() => { if (unread) void act(() => rpc.call('markRead', { ids: group.filter(isUnread).map(member => member.id) })); }}><Icon name="ExternalLink" aria-hidden /></UrlLink></Button>}
      {markable && unread && <Button size="sm" {...iconProps('Mark read')} onClick={() => void act(() => rpc.call('markRead', { ids: group.filter(isUnread).map(member => member.id) }))}><Icon name="MailOpen" aria-hidden /></Button>}
      <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setMenu(null); }} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
        <Button size="sm" {...iconProps('More')} aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : 'main')}><Icon name="MoreHorizontal" aria-hidden /></Button>
        {menu && <div role="menu" aria-label="Item actions" className="absolute bottom-full left-0 z-20 mb-1 w-48 rounded-lg border border-border bg-background p-1 shadow-lg">
          {menu === 'main' ? <>
            {item.kind !== 'saved' && <button role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { setMenu(null); void act(() => rpc.call('setPinned', { id: last.id, pinned: !item.pinned })); }}>{item.pinned ? 'Remove from Saved' : 'Save'}</button>}
            {item.kind !== 'saved' && <button role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => setMenu('snooze')}>Remind later</button>}
            {item.kind !== 'saved' && workBoard?.available && <button type="button" role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => setMenu('task')}>Create task</button>}
            {dismiss && <button role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { setMenu(null); void act(() => rpc.call('setDismissed', { id: last.id, dismissed: true })); }}>{dismiss[0]}</button>}
          </> : menu === 'snooze' ? <>{(['In 1 hour', 'This evening', 'Tomorrow 9:00', 'Next Monday 9:00'] as const).map((label, index) => <button key={label} role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { const now = new Date(), until = new Date(now); if (index === 0) until.setHours(now.getHours() + 1); if (index === 1) { until.setHours(18, 0, 0, 0); if (+until <= +now) until.setTime(+now + 3 * 3600000); } if (index === 2) { until.setDate(now.getDate() + 1); until.setHours(9, 0, 0, 0); } if (index === 3) { until.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); until.setHours(9, 0, 0, 0); } setMenu(null); void act(() => rpc.call('snooze', { id: last.id, until: +until })); }}>{label}</button>)}</> : [...(workBoard?.projects ?? [])].sort((a, b) => Number(b.id === localStorage.getItem(PROJECT_CHOICE)) - Number(a.id === localStorage.getItem(PROJECT_CHOICE))).map(project => <button key={project.id} role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { localStorage.setItem(PROJECT_CHOICE, project.id); setMenu(null); void act(() => rpc.call('createTask', { id: last.id, projectId: project.id })); }}>{project.name}</button>)}
        </div>}
      </div>
      {item.kind !== 'saved' && !item.threadDeleted && (item.kind !== 'mine' || replyToOwn) && <Button size="sm" {...iconProps('Reply')} disabled={pending || (item.kind === 'for_me' && item.status === 'replied')} aria-expanded={replying} onClick={() => setReplying(!replying)}><Icon name="ArrowTurnBackward" aria-hidden /></Button>}
      {chat && item.status !== 'answered' && <span className="ml-1 inline-flex items-center text-xs">{status}</span>}
    </div>{readMark && <span className="ml-auto flex items-center px-2 text-muted-foreground">{readMark}</span>}</div>
    {item.kind === 'for_me' && item.status === 'open' && item.options && <div className="flex flex-wrap gap-1 px-2">{item.options.map(option => <Button key={option} size="sm" variant={option === item.recommended ? 'default' : 'outline'} className="h-auto min-h-8 whitespace-normal py-1 text-left" disabled={pending} onClick={() => void reply(undefined, option)}>{option}{option === item.recommended && <>{' '}<span className="sr-only">(recommended)</span></>}</Button>)}
      {item.recommendReason && <p className="w-full text-xs text-muted-foreground">Recommended: {item.recommendReason}</p>}</div>}
    {replying && <div ref={replyBox}><Composer label="Reply text" sendLabel="Send reply" autoFocus value={text} onChange={setText} attachments={files} onAttachments={update => setFiles(update)} projectId={item.projectId} pending={pending} sendDisabled={!text.trim()} onSend={options => void reply(options)} /></div>}
    {feedback && <p role="status">{feedback}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </li>;
}

function Page({ threadId, view, projectId, query, questions, cursor }: { threadId?: string; view: View; projectId?: string; query: string; questions?: boolean; cursor?: string }) {
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view, ...(questions ? { questions } : {}), ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}), query, ...(cursor ? { cursor } : {}), limit: 50 } });
  const [next, setNext] = useState(false);
  const firstUnread = useRef<string | null | undefined>(undefined);
  // A thread tab reads like the chat beside it: oldest first, earlier pages load above.
  const chronological = !!threadId, nextCursor = result.data?.nextCursor;
  const items = result.data ? (chronological ? [...result.data.items].reverse() : result.data.items) : [];
  if (chronological && !cursor && result.data && firstUnread.current === undefined) firstUnread.current = items.find(isUnread)?.id ?? null;
  const more = nextCursor && (next ? <Page key={nextCursor} {...{ threadId, view, projectId, query, questions }} cursor={nextCursor} /> : <Button variant="ghost" size="sm" className="mx-auto flex text-xs text-muted-foreground" onClick={() => setNext(true)}>{chronological ? 'Load earlier' : 'Load more'}</Button>);
  return <>
    {result.isLoading && <p role="status" className="px-2 text-xs text-muted-foreground">Loading answers…</p>}
    {result.error && <div role="alert">{result.error.message} <Button variant="outline" onClick={() => void result.refetch()}><Icon name="ArrowReloadHorizontal" aria-hidden />Retry</Button></div>}
    {result.data && <>
      {!cursor && !result.data.items.length && <EmptyState icon={emptyCopy[view][0]} title={emptyCopy[view][1]}>{query ? 'Nothing matches this search.' : emptyCopy[view][2]}</EmptyState>}
      {chronological && more}
      <ul aria-label="Answers" className={chronological ? 'divide-y divide-border-seam [&>:has(+[data-new])]:border-b-0' : 'space-y-3'}>{items.map(item => <Fragment key={item.id}>{chronological && item.id === firstUnread.current && <li data-new className="flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />New<span className="h-px flex-1 bg-border" /></li>}<ItemCard item={item} chat={chronological} markable autoRead={chronological && view === 'all'} replyToOwn={!threadId} /></Fragment>)}</ul>
      {!chronological && more}
    </>}
  </>;
}

type ViewOption = { value: View | 'inbox'; label: string; hint: string; icon: IconName };
// The views as tasks: what is new, what I am waiting for, what I owe, what I kept, everything.
const viewOptions = (thread: boolean): ViewOption[] => [
  thread ? { value: 'unread', label: 'Unread', hint: 'New answers and questions for you in this thread', icon: 'Mail' } : { value: 'inbox', label: 'Inbox', hint: 'New answers and questions for you, by thread', icon: 'Mail' },
  { value: 'waiting', label: 'Awaiting answer', hint: 'Your questions agents have not answered yet', icon: 'Clock' },
  { value: 'for_me', label: 'Asked of you', hint: 'Agent questions you have not replied to', icon: 'MessageQuestion' },
  { value: 'saved', label: 'Saved', hint: 'Answers you saved or pinned', icon: 'Star' },
  { value: 'all', label: 'History', hint: 'Every question and answer, searchable', icon: 'LayoutList' },
];

// User text stays plain (no Markdown reflow); only thread mentions go through bb's renderer to become chips.
// Thread mentions and Markdown links (the composer stores task chips as links) render through bb as a whole.
const MENTION = /(@thread:thr_[A-Za-z0-9]+(?:#msg=\d+)?|\[[^\]\n]+\]\([^)\s]+\))/;
function InlineCommentText({ text, prefixes }: { text: string; prefixes?: string[] }) {
  const parsed = parseInlineComments(text);
  return <div className="space-y-2">{parsed.comments.map((entry, index) => <div key={index}>
    {entry.passage && <div className="border-l-2 border-border-seam pl-2 text-muted-foreground"><div className="line-clamp-3">{entry.passage}</div></div>}
    {entry.comment && <div>{entry.comment}</div>}
  </div>)}{parsed.text && <div><UserText text={parsed.text} prefixes={prefixes} /></div>}</div>;
}

function UserText({ text, prefixes = [] }: { text: string; prefixes?: string[] }) {
  // Only prefixes of real Work Board projects, so look-alikes such as GPT-6 or UTF-8 stay text.
  const task = prefixes.length ? new RegExp(`(?<![\\w-])((?:${prefixes.map(p => p.replace(/[^A-Za-z0-9]/g, '')).join('|')})-\\d+)(?![\\w-])`) : null;
  const inline = (content: string, key: string) => <Markdown key={key} content={content} className="inline-block align-baseline [&_p]:m-0" />;
  return <>{text.split(MENTION).flatMap((part, index) => index % 2 ? [inline(part, `m${index}`)]
    : task ? part.split(task).map((piece, j) => j % 2 ? inline(`[${piece}](/plugins/work-board/work-board/task/${piece})`, `t${index}-${j}`) : piece) : [part])}</>;
}

function ViewPicker({ options, value, onChange }: { options: ViewOption[]; value: View | 'inbox'; onChange: (value: View | 'inbox') => void }) {
  const [open, setOpen] = useState(false), current = options.find(o => o.value === value) ?? options[0]!;
  return <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }} onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }}>
    <Button type="button" size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-sm font-medium" aria-label={`View: ${current.label}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name={current.icon} aria-hidden className="size-4 text-muted-foreground" />{current.label}<Icon name="ChevronDown" aria-hidden className="size-3.5 text-muted-foreground" /></Button>
    {open && <div role="menu" aria-label="Views" className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border border-border bg-background p-1 shadow-lg">
      {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === current.value} className={`flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-state-hover ${option.value === current.value ? 'bg-state-active' : ''}`} onClick={() => { onChange(option.value); setOpen(false); }}>
        <Icon name={option.icon} aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0"><span className="block text-sm">{option.label}</span><span className="block text-xs text-muted-foreground">{option.hint}</span></span>
      </button>)}
    </div>}
  </div>;
}

export function AnswersPanel({ threadId }: { threadId?: string }) {
  const rpc = useRpc<AnswersRpcContract>();
  // Refresh reads after our own writes instead of relying only on the server's realtime invalidation.
  const { refresh } = experimental_useRpcRefresh();
  const { projects } = experimental_useSidebarThreads();
  const [stored, setView] = useStoredState<View | 'inbox'>(threadId ? null : 'bb-plugin-answers:page:view', threadId ? 'unread' : 'inbox');
  const view = stored === 'pinned' ? 'saved' : stored; // Pinned merged into Saved
  const [query, setQuery] = useStoredState(threadId ? null : 'bb-plugin-answers:page:query', '');
  const bbChat = useSettings().values?.chatMode === 'bb';
  const [projectId, setProjectId] = useStoredState(threadId ? null : 'bb-plugin-answers:page:project', '');
  const [questions, setQuestions] = useStoredState(threadId ? null : 'bb-plugin-answers:page:questions', false);
  const [error, setError] = useState('');
  const undo = useReadUndo(), [saved, setSaved] = useTransientText();
  useEffect(() => { const receive = (event: Event) => { const detail = (event as CustomEvent<{created:boolean}>).detail; localStorage.removeItem(SAVED_FLASH); setSaved(detail.created ? 'Saved to Answers' : 'Already in Saved'); }; const stored = localStorage.getItem(SAVED_FLASH); if (stored) { localStorage.removeItem(SAVED_FLASH); try { const detail = JSON.parse(stored); if (Date.now() - detail.at < 5000) receive(new CustomEvent('answers:saved', { detail })); } catch {} } window.addEventListener('answers:saved', receive); return () => window.removeEventListener('answers:saved', receive); }, [setSaved]);
  const list = view === 'saved' || view === 'all';
  return <section className="flex h-full flex-col bg-background">
    {threadId && <Pools threadId={threadId} />}
    <div className="space-y-2 border-b border-border-seam bg-background px-3 py-2">
      <div className="flex items-center gap-1">
        <ViewPicker options={viewOptions(!!threadId)} value={view} onChange={setView} />
        <span className="flex-1" />
        {view !== 'for_me' && <Button size="sm" variant="ghost" className={`h-7 gap-1.5 px-2 text-xs ${questions ? 'bg-state-active text-foreground' : 'text-muted-foreground'}`} aria-pressed={questions} aria-label="Questions only" onClick={() => setQuestions(!questions)}><Icon name="MessageQuestion" aria-hidden className="size-3.5" />Questions</Button>}
        {(view === 'inbox' || view === 'unread') && <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={async () => { setError(''); try { const result = await rpc.call('markRead', { all: true, ...(threadId ? { threadId } : {}) }); if ('batch' in result) undo.record(result); refresh(); } catch (cause) { setError(message(cause)); } }}><Icon name="MailOpen" aria-hidden className="size-3.5" />Mark all read</Button>}
      </div>
      {list && <div className="flex gap-2">
        <input aria-label="Search answers" type="search" placeholder={view === 'saved' ? 'Search saved' : 'Search history'} maxLength={4000} className="min-w-0 flex-1 rounded-md border border-border-seam bg-transparent px-2.5 py-1 text-sm outline-none focus:border-ring" value={query} onChange={event => setQuery(event.target.value)} />
        {!threadId && <select aria-label="Project" className="max-w-40 rounded-md border border-border-seam bg-background px-2 py-1 text-sm" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
      </div>}
    </div>
    {error && <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error}</p>}{saved && <p role="status" className="px-4 py-2 text-xs">{saved} · <Button size="sm" variant="ghost" onClick={() => setView('saved')}>Show in Saved</Button></p>}
    {view === 'inbox' ? <div className="min-h-0 flex-1"><Inbox questions={questions} onBulkRead={undo.record} bbChat={bbChat} /></div> : <div className={`min-h-0 flex-1 overflow-auto bg-background ${threadId ? 'px-4' : 'p-4'}`}><Page key={JSON.stringify([threadId, view, query, projectId, questions])} {...{ threadId, view, questions }} query={list ? query : ''} projectId={list ? projectId || undefined : undefined} /></div>}
    {undo.line}
  </section>;
}

const PANEL_KEY = 'bb-plugin-answers:page-panel-tab';

// bb does not restore the plugin page's side panel, so remember the selected tab and reopen it.
export function useRememberedPagePanel() {
  const panel = experimental_useAppPanel();
  const { open, selectedKey, tabs } = experimental_usePanelTabs();
  const restored = useRef(false);
  useEffect(() => {
    if (!restored.current) {
      restored.current = true;
      const saved = localStorage.getItem(PANEL_KEY);
      if (saved && !open && tabs.some(tab => tab.key === saved)) panel.selectTab(saved);
      return;
    }
    if (open && selectedKey) localStorage.setItem(PANEL_KEY, selectedKey); else localStorage.removeItem(PANEL_KEY);
  }, [open, selectedKey, tabs, panel]);
}

function AnswersPage() {
  useRememberedPagePanel();
  return <AnswersPanel />;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'answers', title: 'Answers', icon: 'MessageQuestion', path: 'answers', component: AnswersPage, experimental_useBadge: useAnswersBadge });
  app.slots.experimental_tab({ id: 'my-questions', title: 'My questions', icon: 'MessageQuestion', context: { kind: 'thread' }, availability: 'fixed', component: AnswersPanel });
  app.slots.experimental_tab({ id: 'pools', title: 'Reply pools', icon: 'Sent', context: { kind: 'nav-panel', panelId: 'answers' }, availability: 'fixed', component: () => <Pools /> });
  app.slots.messageAction({ id: 'pool', title: 'Add to reply pool', icon: 'Sent', async run({ threadId, message, selectedText, experimental_panel }) {
    const input = rpcContract.poolAdd.input.parse({ threadId, quote: selectedText ?? message.text, quoteSeq: message.experimental_messageSeq });
    const response = await fetch('/api/v1/plugins/answers/rpc/poolAdd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? 'Unable to add to reply pool');
    rpcContract.poolAdd.output.parse(body.result);
    experimental_panel.openTab({ tab: { id: 'my-questions', context: { kind: 'thread' }, availability: 'fixed' } });
  } });
  app.slots.experimental_appOverlay({ id: 'chat-comment', component: ChatComment });
  app.slots.messageAction({ id: 'comment', title: 'Comment', icon: 'MessageSquare', run({ selectedText, message, composer }) {
    if (!composer) throw new Error('The thread composer is unavailable on this surface');
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    window.dispatchEvent(new CustomEvent(COMMENT_EVENT, { detail: { quote: selectedText ?? message.text, composer, top: rect?.bottom ?? window.innerHeight / 2, left: rect?.left ?? window.innerWidth / 2 } }));
  } });
  app.slots.messageAction({ id: 'save', title: 'Save to Answers', icon: 'Star', async run({ threadId, message, selectedText, experimental_panel }) {
    const input = rpcContract.save.input.parse({ threadId, seq: message.experimental_messageSeq, role: message.role, text: selectedText ?? message.text });
    // Message actions have no React hook context; use the public plugin RPC endpoint.
    const response = await fetch('/api/v1/plugins/answers/rpc/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? `Unable to save to Answers (${response.status})`);
    const result = rpcContract.save.output.parse(body.result);
    const detail = { id: result.id, created: result.created, at: Date.now() };
    localStorage.setItem(SAVED_FLASH, JSON.stringify(detail)); window.dispatchEvent(new CustomEvent('answers:saved', { detail }));
    experimental_panel.openTab({ tab: { id: 'my-questions', context: { kind: 'thread' }, availability: 'fixed' } });
  } });
});
