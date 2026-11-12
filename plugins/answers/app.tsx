import { taskKeyRegex } from './task-links';
import { Component, Fragment, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { definePluginApp, experimental_Icon as Icon, experimental_PluginIcon as PluginIcon, experimental_describePromptMention, experimental_PromptMentionIcon as PromptMentionIcon, experimental_ThreadTitleText as ThreadTitleText, experimental_ImageLightbox as ImageLightbox, experimental_ThreadStatusGlyph as ThreadStatusGlyph, Markdown, UrlLink, useRpc, useSdk, useSettings, experimental_useRpcQuery as useQuery, experimental_useSidebarThreads, experimental_useProviders, experimental_useAppPanel, experimental_usePanelTabs, experimental_useRpcRefresh, useComposer } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type ItemAttachment, type View, type Attachment, type SendOptions } from './contract';
import { Inbox, Pools, Avatar, ago, activityAt, conversation, type Entry } from './inbox';
import { PendingInteractions, usePendingInteractionRows } from './interactions';
import { ChatComment, COMMENT_EVENT } from './chat-comment';
import { Composer } from './composer';
import { EmptyState, useTransientText, type IconName } from './empty';
import { Button } from './components/ui/button';
import { useUsageKeeper } from './contacts-footer';
import { useStoredState } from './lib/stored-state';
import { parseInlineComments } from './inline-comments';

const emptyCopy: Record<View, [IconName, string, string]> = {
  unread: ['MailOpen', 'All caught up', 'New answers will show up here.'],
  waiting: ['Clock', 'Nothing waiting', 'Questions still waiting for an answer show up here.'],
  for_me: ['MessageQuestion', 'No questions for you', 'When an agent asks you something, it shows up here.'],
  pinned: ['Pin', 'Nothing pinned', 'Pin an answer to keep it at hand.'],
  saved: ['Star', 'Nothing saved', 'Use “Save to Answers” on any chat message to keep it here.'],
  all: ['MessageQuestion', 'No answers yet', 'Your questions and the agents’ answers show up here.'],
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

function ItemAttachments({ attachments, projectId }: { attachments: ItemAttachment[]; projectId: string | null }) {
  const sdk = useSdk(), [urls, setUrls] = useState<Record<number, string>>({}), [open, setOpen] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true;
    const loaded: string[] = [];
    const read = (index: number) => {
      const attachment = attachments[index];
      if (!attachment || attachment.type !== 'localImage') return;
      const owner = attachment.sourceProjectId ?? projectId;
      if (!owner) return;
      void sdk.projects.attachments.read({projectId:owner,path:attachment.path}).then(file => {
        const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], {type:file.mimeType}));
        if (active) { loaded.push(url); setUrls(current => ({...current,[index]:url})); }
        else URL.revokeObjectURL(url);
      }).catch(() => {});
    };
    const targets = container.current?.querySelectorAll<HTMLElement>('[data-answers-image]') ?? [];
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { observer?.unobserve(entry.target); read(Number((entry.target as HTMLElement).dataset.answersImage)); }
    });
    targets.forEach(target => { if (observer) observer.observe(target); else read(Number(target.dataset.answersImage)); });
    return () => { active = false; observer?.disconnect(); loaded.forEach(url => URL.revokeObjectURL(url)); };
  }, [attachments, projectId, sdk]);
  const download = async (attachment: ItemAttachment) => {
    const owner = attachment.sourceProjectId ?? projectId;
    if (!owner) return;
    const file = await sdk.projects.attachments.read({ projectId: owner, path: attachment.path });
    const url = URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mimeType }));
    const link = document.createElement('a'); link.href = url; link.download = attachment.name ?? attachment.path.split('/').at(-1) ?? 'Attachment'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const images = attachments.map((attachment, index) => attachment.type === 'localImage' ? index : -1).filter(index => index >= 0);
  const selected = open === null ? null : attachments[open];
  return <>
    <div ref={container} className="mt-2 flex flex-wrap gap-2">{attachments.map((attachment, index) => {
      const name = attachment.name ?? attachment.path.split('/').at(-1) ?? 'Attachment', url = urls[index];
      return attachment.type === 'localImage' ? <button key={index} data-answers-image={index} type="button" aria-label={name} className="overflow-hidden rounded-lg border border-border-seam" onClick={() => setOpen(index)} disabled={!url}>{url ? <img src={url} alt={name} className="max-h-48 max-w-64 object-contain" /> : <span className="block px-3 py-2 text-xs">{name}</span>}</button>
        : <a key={index} href="#" download={name} onClick={event => { event.preventDefault(); void download(attachment); }} className="inline-flex items-center gap-1.5 rounded-lg border border-border-seam px-2.5 py-1.5 text-xs hover:bg-state-hover"><Icon name="File" aria-hidden className="size-4" />{name}</a>;
    })}</div>
    {selected && <ImageLightbox isOpen imageSrc={urls[open!] ?? null} imageAlt={selected.name ?? 'Attached image'} title={selected.name ?? selected.path.split('/').at(-1) ?? 'Image'} hasMultipleImages={images.length > 1} previousDisabled={open === images[0]} nextDisabled={open === images.at(-1)} onClose={() => setOpen(null)} onPrevious={() => setOpen(images[images.indexOf(open!) - 1] ?? null)} onNext={() => setOpen(images[images.indexOf(open!) + 1] ?? null)} />}
  </>;
}

// A reinstall or reload restarts the plugin server, and queries fail for a moment before the next refetch succeeds;
// an error shows only once it outlasts that window.
export function useSteadyError<E>(error: E | null | undefined, ms = 3000): E | null {
  const [steady, setSteady] = useState(false), failing = !!error;
  // Keyed on failing, not the error object, so a retry that fails again does not restart the wait.
  useEffect(() => { if (!failing) { setSteady(false); return; } const timer = setTimeout(() => setSteady(true), ms); return () => clearTimeout(timer); }, [failing, ms]);
  return steady && error ? error : null;
}
export function useAnswersBadge() {
  useUsageKeeper();
  const { data } = useQuery({ contract: rpcContract, method: 'counts', input: {} });
  const count = data ? data.inbox : 0;
  return count ? { count, label: `${count} unread answers and questions for you` } : null;
}

// chat: render as a conversation exchange (no thread header); markable: offer Mark read (the Inbox marks on open).
// Like Telegram's read cursor: a message is read once its end has reached the screen or was scrolled past. No timer.
const readLists = new WeakMap<HTMLElement, { cards: Map<HTMLElement, () => void>; check: () => void; schedule: () => void; frame: number }>();
function useReadOnView(ref: React.RefObject<HTMLElement | null>, enabled: boolean, onRead: () => void) {
  const latest = useRef(onRead); latest.current = onRead;
  useEffect(() => {
    const node = ref.current, root = node?.closest<HTMLElement>('.overflow-auto');
    if (!enabled || !node || !root) return;
    let list = readLists.get(root);
    if (!list) {
      const cards = new Map<HTMLElement, () => void>();
      list = { cards, frame: 0, check: () => {}, schedule: () => {} };
      const shared = list;
      shared.check = () => { shared.frame = 0; if (document.visibilityState === 'hidden') return; const bottom = root.getBoundingClientRect().bottom; for (const [card, read] of cards) { const box = card.getBoundingClientRect(); if (box.height > 0 && box.bottom <= bottom) { cards.delete(card); read(); } } };
      shared.schedule = () => { if (!shared.frame) shared.frame = requestAnimationFrame(shared.check); };
      root.addEventListener('scroll', shared.schedule, { passive: true }); document.addEventListener('visibilitychange', shared.schedule);
      readLists.set(root, shared);
    }
    list.cards.set(node, () => latest.current()); list.schedule();
    return () => { list.cards.delete(node); if (!list.cards.size) { cancelAnimationFrame(list.frame); root.removeEventListener('scroll', list.schedule); document.removeEventListener('visibilitychange', list.schedule); readLists.delete(root); } };
  }, [ref, enabled]);
}
// bb's icon set has no double check; drawn in its stroke style (geometry as Lucide's check-check).
function ReadTicks({ at }: { at: number }) {
  const label = `Read ${new Date(at).toLocaleString()}`;
  return <svg role="img" aria-label={label} viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round"><title>{label}</title><path d="M18 6 7 17l-5-5" /><path d="m22 10-7.5 7.5L13 16" /></svg>;
}
export const isUnread = (item: Item) => item.dismissedAt === null && item.readAt === null && item.snoozedUntil === null && (((item.kind === 'mine' || item.kind === 'update') && item.status === 'answered') || (item.kind === 'for_me' && item.status === 'open') || (item.kind === 'mine' && (item.status === 'waiting' || item.status === 'deferred') && item.failedAt !== null));
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
// Installed plugins' names and branding icons, listed once per page load: references to a plugin show those, not its id.
type PluginBrand = { id: string; name: string; icon: string | null };
let pluginBrands: Promise<PluginBrand[]> | null = null;
export function usePluginBrands(enabled = true) {
  const sdk = useSdk(), [brands, setBrands] = useState<PluginBrand[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    (pluginBrands ??= sdk.plugins.list().then(r => r.plugins.map(p => ({ id: p.id, name: p.name ?? p.id, icon: p.icon ?? null })), () => { pluginBrands = null; return []; })).then(list => { if (live) setBrands(list); });
    return () => { live = false; };
  }, [enabled]);
  return brands;
}
export function usePluginBrand(id: string | null) {
  const brands = usePluginBrands(!!id);
  return id ? brands.find(brand => brand.id === id) ?? null : null;
}
// An update has no owner message; bb's own row for what started its turn names it: a finished child or another thread
// (bb's "… finished" and "Message from" rows, same classes and icons), or a plugin. bb's quote of the trigger is left out.
// The notice that woke the agent, as one line after its sender: the text below is the agent's reply to it, not the sender's.
function notice(text: string, sender: string) {
  const line = text.split('\n').map(l => l.replace(/[*`_#>]/g, '').trim()).find(Boolean) ?? '';
  const rest = (line.toLowerCase().startsWith(sender.toLowerCase()) ? line.slice(sender.length) : line.replace(/^\[[^\]]*\]\s*/, '')).replace(/^[\s·:—-]+/, '');
  return rest ? ` · ${rest}` : '';
}
function UpdateCaption({ item, time }: { item: Item; time: ReactNode }) {
  const { threads } = experimental_useSidebarThreads(), trigger = item.trigger, source = trigger?.sourceId ?? null, brand = usePluginBrand(trigger?.kind === 'plugin' ? source : null);
  const thread = threads.find(t => t.id === source), projectId = thread?.projectId ?? item.projectId, title = thread?.displayTitle ?? thread?.title ?? trigger?.sourceTitle ?? source ?? '';
  const href = source ? `${projectId ? `/projects/${encodeURIComponent(projectId)}` : ''}/threads/${encodeURIComponent(source)}` : '';
  const mention = source ? { kind: 'thread' as const, threadId: source, label: title, ...(projectId ? { projectId } : {}) } : null, look = mention && experimental_describePromptMention(mention);
  const [icon, body]: [IconName | null, ReactNode] = !source ? [null, null]
    : trigger?.kind === 'system' ? ['CircleCheck', <><UrlLink href={href} className="min-w-0 cursor-pointer truncate whitespace-pre text-left font-medium text-foreground underline underline-offset-2 opacity-70 focus-visible:outline-none">{title}</UrlLink><span className="shrink-0 whitespace-pre text-muted-foreground"> finished</span></>]
    : trigger?.kind === 'agent' && mention && look ? ['MessageSquare', <><span className="shrink-0 whitespace-pre text-muted-foreground">Message from </span><UrlLink href={href} title={look.title} className={`${look.className} min-w-0 bg-surface-raised/50 font-normal no-underline hover:no-underline whitespace-nowrap`}><PromptMentionIcon mention={mention} className="size-3.5 shrink-0 self-center text-muted-foreground" /><span className="truncate"><ThreadTitleText title={title} /></span></UrlLink></>]
    : trigger?.kind === 'plugin' && brand ? [null, <span className="flex min-w-0 items-center gap-2"><PluginIcon pluginId={brand.id} icon={brand.icon} className="size-4 shrink-0" /><span className="min-w-0 truncate whitespace-pre text-muted-foreground"><span className="text-foreground/80">{brand.name}</span>{notice(item.question, brand.name)}</span></span>]
    // A tagged script waking its own thread: bb's automation icon; a plugin that is not installed any more: its bare id.
    : trigger?.kind === 'plugin' || trigger?.kind === 'other' ? [trigger.kind === 'other' ? 'Repeat' : 'Info', <span className="min-w-0 truncate whitespace-pre text-muted-foreground"><span className="text-foreground/80">{source}</span>{notice(item.question, source)}</span>] : [null, null];
  if (!body && !time) return null;
  return <div data-update-caption className="flex min-w-0 items-center gap-2 px-2 text-sm leading-5">{icon && <Icon name={icon} aria-hidden className="size-4 shrink-0 text-muted-foreground" />}{(body || time) && <span className="inline-flex min-w-0 max-w-full items-baseline overflow-hidden whitespace-nowrap">{body}{time && <span className="shrink-0 whitespace-pre text-muted-foreground [&_time]:text-sm">{body && ' · '}{time}</span>}</span>}</div>;
}
// A run of agent updates that ask nothing, collapsed like bb's "N threads updated" batch row, with a two-line preview of the
// latest on bb's nested-rows rail; expanded, each shows as usual. reveal: a jump or search target that opens the group.
const OPEN_GROUPS = 'bb-plugin-answers:open-update-groups';
const openGroups = (): string[] => { try { const ids = JSON.parse(localStorage.getItem(OPEN_GROUPS) ?? '[]'); return Array.isArray(ids) ? ids : []; } catch { return []; } };
export function UpdateGroup({ items, reveal, children }: { items: Item[]; reveal?: string | null; children: (item: Item) => ReactNode }) {
  // A group is known by its first update, which a newer update joining it does not change; an opened group stays open
  // across chats, screens and reloads (the last 200 are remembered).
  const key = items[0]!.id, [open, setOpenState] = useState(() => openGroups().includes(key)), row = useRef<HTMLLIElement>(null), last = items.at(-1)!;
  const setOpen = (value: boolean) => { setOpenState(value); try { localStorage.setItem(OPEN_GROUPS, JSON.stringify([...openGroups().filter(id => id !== key), ...(value ? [key] : [])].slice(-200))); } catch { /* storage unavailable */ } };
  useEffect(() => { if (reveal && items.some(item => item.id === reveal)) setOpen(true); }, [reveal]);
  const at = activityAt(last), age = ago(at), previewText = (last.answer ?? '').replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1').replace(/\*\*|`|^#+\s*/gm, '').replace(/\s+/g, ' ').trim();
  // The stack-card look of "Active child threads", so the group stands out from the caption rows around it. Opening it
  // keeps the latest update where its preview was; the earlier ones open above it, like older messages in a chat.
  const preview = useRef<HTMLParagraphElement>(null);
  const keepLatestAt = (top: number | undefined) => {
    const latest = row.current?.querySelector('ul')?.lastElementChild as HTMLElement | null | undefined; if (top === undefined || !latest) return;
    let box = row.current?.parentElement ?? null; while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    if (box) box.scrollTop += latest.getBoundingClientRect().top - top;
  };
  return <li ref={row} data-update-group data-history-ids={items.map(item => item.id).join(' ')} className="py-3">
    <div className="overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lift">
      <button type="button" aria-expanded={open} aria-label={`${items.length} background updates`} onClick={() => { if (open) { setOpen(false); return; } const at = preview.current?.getBoundingClientRect().top; setOpen(true); requestAnimationFrame(() => keepLatestAt(at)); }} className="flex min-h-9 w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-state-hover">
        <Icon name="ListTodo" aria-hidden className="size-3.5 shrink-0" /><span className="min-w-0 truncate font-medium text-foreground">Background updates</span><span className="rounded-full bg-surface-recessed px-1.5 text-2xs">{items.length}</span>
        <time className="shrink-0" dateTime={new Date(at).toISOString()}>{age === 'now' ? 'Just now' : `${age} ago`}</time><span className="flex-1" />
        <Icon name="ChevronDown" aria-hidden className={`size-4 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open ? <><ul className="divide-y divide-border-seam border-t border-border-hairline bg-background">{items.map(item => <Fragment key={item.id}>{children(item)}</Fragment>)}</ul>
        {/* bb's queue-card collapse bar: a long open group can be closed from its end; the header is kept in view. */}
        <button type="button" aria-label="Collapse background updates" className="flex min-h-[1.875rem] w-full cursor-pointer items-center justify-center border-t border-border-hairline text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => { setOpen(false); requestAnimationFrame(() => row.current?.scrollIntoView({ block: 'nearest' })); }}><Icon name="ChevronUp" aria-hidden className="size-3.5" /></button></> : <p ref={preview} className="line-clamp-2 break-words border-t border-border-hairline px-3 py-2 text-sm text-muted-foreground">{previewText}</p>}
    </div>
  </li>;
}
// part: a late answer split from its question (see conversation in inbox.tsx); onJump scrolls to the other part's history id.
export function ItemCard({ item, members, late, chat = false, markable = !chat, autoRead = false, replyToOwn = true, part, onJump, compact = false, open }: { item: Item; members?: Item[]; late?: Item[]; chat?: boolean; markable?: boolean; autoRead?: boolean; replyToOwn?: boolean; part?: 'question' | 'answer'; onJump?: (id: string) => void; compact?: boolean; open?: { href: string; label: string; onClick?: () => void } }) {
  const rpc = useRpc<AnswersRpcContract>();
  // Answers' own writes refresh through the server's realtime invalidation; a reply goes to bb's thread, so it refreshes here.
  const { refresh } = experimental_useRpcRefresh();
  const group = members?.length ? members : [item], last = group.at(-1)!;
  // An earlier question answered by this message: the owner's bubble, clamped and muted, that jumps to where it was asked.
  const echo = (member: Item) => <button key={`echo-${member.id}`} type="button" title="Go to the question" className={`${userBubble.replace("text-foreground", "text-muted-foreground")} block cursor-pointer text-left`} onClick={() => onJump?.(member.id)}><span className="line-clamp-2 whitespace-pre-wrap break-words">{member.question}</span></button>;
  const [menu, setMenu] = useState<'main' | 'snooze' | 'task' | null>(null), moreButton = useRef<HTMLButtonElement>(null), menuBox = useRef<HTMLDivElement>(null);
  // The menu is portaled out of scrolling, clipping cards (Questions, the stack above the composer), so it follows its button.
  const [menuAt, setMenuAt] = useState<{ left: number; top?: number; bottom?: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const place = () => { const r = moreButton.current?.getBoundingClientRect(); if (r) setMenuAt(r.top > 240 ? { left: r.left, bottom: window.innerHeight - r.top + 4 } : { left: r.left, top: r.bottom + 4 }); };
    const close = (event: Event) => { if (!menuBox.current?.contains(event.target as Node)) setMenu(null); };
    place(); window.addEventListener('scroll', close, true); window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', place); setMenuAt(null); };
  }, [menu]);
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
  const [error, setError] = useState(''), [copied, setCopied] = useState(false), [savedOwn, setSavedOwn] = useState(false);
  async function act(write: () => Promise<unknown>) {
    setError('');
    try { await write(); } catch (cause) { setError(message(cause)); }
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
  const readMark = unread ? <span className="size-1.5 rounded-full bg-foreground/70" aria-label="Unread" /> : group.every(member => member.readAt !== null) && (last.kind === 'mine' || (last.kind === 'update' && last.asks)) && last.status === 'answered' ? <ReadTicks at={last.readAt!} /> : null;
  useReadOnView(card, autoRead && unread && part !== 'question', () => void act(() => rpc.call('markRead', { ids: group.filter(isUnread).map(member => member.id) })));
  // "Done" said different things per item; name what dismissing actually does, and offer it only where it does something.
  const dismiss: [string, IconName] | null = item.dismissedAt !== null ? null
    : item.kind === 'mine' && (item.status === 'waiting' || item.status === 'deferred') ? ['Stop waiting', 'X']
    : item.kind === 'for_me' && item.status === 'open' ? ['Won’t reply', 'X']
    : item.kind === 'saved' ? ['Remove from Saved', 'Trash2'] : null;
  // bb's own working spinner while the answer is pending; a failed turn shows its own notice instead.
  const replyButton = item.kind !== 'saved' && item.kind !== 'update' && !item.threadDeleted && (item.kind !== 'mine' || replyToOwn) && <Button size="sm" {...iconProps('Reply')} disabled={pending || (item.kind === 'for_me' && item.status === 'replied')} aria-expanded={replying} onClick={() => setReplying(!replying)}><Icon name="ArrowTurnBackward" aria-hidden /></Button>;
  const status = item.status === 'waiting' && item.failedAt === null ? <span title="Waiting for the answer" className="inline-flex items-center"><ThreadStatusGlyph indicator="runtime" size="compact" /><span className="sr-only">waiting</span></span> : item.status;
  const time = <time className="text-xs text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>{age}</time>;
  const agentBody = (content: string, seq: number | null) => <div className={agentText} data-agent-body data-item={item.id} data-seq={seq ?? undefined}><Markdown content={content} /></div>;
  return <li ref={card} data-history-ids={part && group.map(member => part === 'answer' ? `${member.id}:answer` : member.id).join(' ')} className={compact ? 'group space-y-1.5 py-2' : chat ? 'group space-y-3 py-5' : 'group space-y-3 rounded-xl border border-border-seam p-4'}>
    {!chat && <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 text-xs text-muted-foreground">
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{item.threadTitle ?? 'Untitled thread'}</h2>
      {item.projectName && <span>{item.projectName}</span>}
      <span className="flex-1" />
      {item.status !== 'answered' && <span>{status}</span>}
      {time}
      {item.threadDeleted && <span>Thread deleted</span>}
    </div>}
    {item.kind === 'for_me' ? <div className="space-y-1">
      <div className="flex min-h-8 items-center gap-2 pl-2 text-xs text-muted-foreground">{chat && time}<span className="flex-1" /><span className="opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">{!item.threadDeleted && <Button asChild size="sm" {...iconProps(open?.label ?? 'Open in chat')}><UrlLink href={open?.href ?? href} onClick={event => { if (open?.onClick) { event.preventDefault(); open.onClick(); } }}><Icon name="ExternalLink" aria-hidden /></UrlLink></Button>}</span></div>
      <div ref={question} className={expanded ? '' : 'line-clamp-6'}>{agentBody(item.question, item.questionSeq)}</div>
    </div> : item.kind === 'update' ? <UpdateCaption item={item} time={chat ? time : null} /> : part === 'answer' ? <div className="ml-auto flex w-fit max-w-[70%] flex-col items-end gap-1">{group.map(echo)}</div> : <div className="ml-auto flex w-fit max-w-[70%] flex-col items-end gap-1">
      {late?.map(echo)}
      {group.map(member => <div key={member.id} className={userBubble}>{member.question && <div ref={member === item ? question : undefined} className={`whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}><InlineCommentText text={member.question} prefixes={workBoard?.projects.map(p => p.prefix)} /></div>}{member.attachments.length > 0 && <ItemAttachments attachments={member.attachments} projectId={member.projectId} />}</div>)}
      {/* bb's row under the owner's own message: time, then Copy and Save, shown on hover (always on touch screens). */}
      {chat && <div className="flex items-center gap-[13px] text-muted-foreground">{time}<span className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <Button size="sm" {...iconProps(copied ? 'Copied' : 'Copy')} className="size-6 px-0 [&_[data-icon-root]]:size-[13px]" onClick={() => void navigator.clipboard?.writeText(group.map(member => member.question).filter(Boolean).join('\n\n')).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}><Icon name={copied ? 'Check' : 'Copy'} aria-hidden /></Button>
        {item.kind === 'mine' && group.every(member => member.questionSeq !== null) && <Button size="sm" {...iconProps(savedOwn ? 'Saved to Answers' : 'Save to Answers')} className="size-6 px-0 [&_[data-icon-root]]:size-[13px]" onClick={() => void act(async () => { for (const member of group) await rpc.call('save', { threadId: member.threadId, seq: member.questionSeq!, role: 'user', text: member.question }); setSavedOwn(true); })}><Icon name={savedOwn ? 'Check' : 'Star'} aria-hidden /></Button>}
      </span></div>}
    </div>}
    {(clamped || expanded) && <Button variant="ghost" size="sm" className={chat ? 'ml-auto flex h-6 px-2 text-xs text-muted-foreground' : undefined} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{chat ? (expanded ? 'Show less' : 'Show more') : (expanded ? 'Collapse question' : 'Expand question')}</Button>}
    {part === 'question' && <Button variant="ghost" size="sm" className="ml-auto flex h-6 px-2 text-xs text-muted-foreground" onClick={() => onJump?.(`${last.id}:answer`)}>Answered below</Button>}
    {part !== 'question' && item.answer && agentBody(item.answer, item.answerSeq)}
    {part !== 'answer' && item.interim && <div className="space-y-1">{/* While the final answer is still owed, bb's running glyph says the work goes on; afterwards a clock marks the reply as interim. */}
      {item.status === 'deferred' ? <span title="Interim reply: the agent is still working and will report back" className="flex w-fit px-2"><ThreadStatusGlyph indicator="runtime" size="compact" /><span className="sr-only">Interim reply, work in progress</span></span>
        : <span title="Interim reply" className="flex w-fit px-2 text-muted-foreground"><Icon name="Clock" aria-label="Interim reply" className="size-3.5" /></span>}{agentBody(item.interim, item.interimSeq)}</div>}
    {part !== 'question' && <>{item.likelyInterim && item.status === 'answered' && <div className="flex flex-wrap items-center gap-2 px-2 text-xs text-muted-foreground"><span>Looks like an interim reply</span><Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('keepWaiting', { id: last.id }))}>Keep waiting</Button><Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('setInterim', { id: last.id, value: false }))}>It's the answer</Button></div>}
    {item.failedAt !== null && <div className="flex items-center gap-2 px-2 text-xs text-destructive">Turn failed <Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('retryTurn', { id: last.id }))}>Retry</Button></div>}
    {item.snoozedUntil !== null && <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground">Snoozed until {new Date(item.snoozedUntil).toLocaleString()} <Button size="sm" variant="ghost" onClick={() => void act(() => rpc.call('snooze', { id: last.id, until: null }))}>Unsnooze</Button></div>}
    {item.taskKey && <UrlLink href={`/plugins/work-board/work-board/task/${encodeURIComponent(item.taskKey)}`} className="mx-2 text-xs">{item.taskKey}</UrlLink>}
    </>}{part !== 'answer' && item.note && <p className="px-2 text-sm text-muted-foreground whitespace-pre-wrap">{item.note}</p>}
    {part !== 'question' && <><div className="flex items-center gap-2"><div className="flex items-center gap-0.5 px-1 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100 has-[[role=menu]]:opacity-100">
      {item.kind === 'for_me' && replyButton}
      {item.kind !== 'for_me' && !item.threadDeleted && <Button asChild size="sm" {...iconProps('Open in chat')}><UrlLink href={href} onClick={() => { if (unread) void act(() => rpc.call('markRead', { ids: group.filter(isUnread).map(member => member.id) })); }}><Icon name="ExternalLink" aria-hidden /></UrlLink></Button>}
      {markable && unread && <Button size="sm" {...iconProps('Mark read')} onClick={() => void act(() => rpc.call('markRead', { ids: group.filter(isUnread).map(member => member.id) }))}><Icon name="MailOpen" aria-hidden /></Button>}
      <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && !menuBox.current?.contains(event.relatedTarget as Node)) setMenu(null); }} onKeyDown={event => { if (event.key === 'Escape') setMenu(null); }}>
        <Button ref={moreButton} size="sm" {...iconProps('More')} aria-haspopup="menu" aria-expanded={!!menu} onClick={() => setMenu(menu ? null : 'main')}><Icon name="MoreHorizontal" aria-hidden /></Button>
        {menu && menuAt && createPortal(<div ref={menuBox} role="menu" aria-label="Item actions" className="fixed z-[100] w-48 rounded-lg border border-border bg-background p-1 shadow-lg" style={menuAt} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node) && event.relatedTarget !== moreButton.current) setMenu(null); }} onKeyDown={event => { if (event.key === 'Escape') { setMenu(null); moreButton.current?.focus(); } }}>
          {menu === 'main' ? <>
            {item.kind !== 'saved' && <button role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { setMenu(null); void act(() => rpc.call('setPinned', { id: last.id, pinned: !item.pinned })); }}>{item.pinned ? 'Remove from Saved' : 'Save'}</button>}
            {item.kind !== 'saved' && <button role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => setMenu('snooze')}>Remind later</button>}
            {item.kind !== 'saved' && workBoard?.available && <button type="button" role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => setMenu('task')}>Create task</button>}
            {dismiss && <button role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { setMenu(null); void act(() => rpc.call('setDismissed', { id: last.id, dismissed: true })); }}>{dismiss[0]}</button>}
          </> : menu === 'snooze' ? <>{(['In 1 hour', 'This evening', 'Tomorrow 9:00', 'Next Monday 9:00'] as const).map((label, index) => <button key={label} role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { const now = new Date(), until = new Date(now); if (index === 0) until.setHours(now.getHours() + 1); if (index === 1) { until.setHours(18, 0, 0, 0); if (+until <= +now) until.setTime(+now + 3 * 3600000); } if (index === 2) { until.setDate(now.getDate() + 1); until.setHours(9, 0, 0, 0); } if (index === 3) { until.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7)); until.setHours(9, 0, 0, 0); } setMenu(null); void act(() => rpc.call('snooze', { id: last.id, until: +until })); }}>{label}</button>)}</> : [...(workBoard?.projects ?? [])].sort((a, b) => Number(b.id === localStorage.getItem(PROJECT_CHOICE)) - Number(a.id === localStorage.getItem(PROJECT_CHOICE))).map(project => <button key={project.id} role="menuitem" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { localStorage.setItem(PROJECT_CHOICE, project.id); setMenu(null); void act(() => rpc.call('createTask', { id: last.id, projectId: project.id })); }}>{project.name}</button>)}
        </div>, document.body)}
      </div>
      {item.kind !== 'for_me' && replyButton}
      {/* Only the running glyph says something; raw statuses ('open', 'replied', 'deferred') told the owner nothing. */}
      {chat && item.status === 'waiting' && item.failedAt === null && <span className="ml-1 inline-flex items-center text-xs">{status}</span>}
    </div>{readMark && <span className="ml-auto flex items-center px-2 text-muted-foreground">{readMark}</span>}</div>
    {item.kind === 'for_me' && item.status === 'open' && item.options && <div className="flex flex-wrap gap-1 px-2">{item.options.map(option => <Button key={option} size="sm" variant={option === item.recommended ? 'default' : 'outline'} className="h-auto min-h-8 whitespace-normal py-1 text-left" disabled={pending} onClick={() => void reply(undefined, option)}>{option}{option === item.recommended && <>{' '}<span className="sr-only">(recommended)</span></>}</Button>)}
      {item.recommendReason && <p className="w-full pt-1 text-xs text-muted-foreground">{item.recommendReason}</p>}</div>}
    {replying && <div ref={replyBox}><Composer label="Reply text" sendLabel="Send reply" autoFocus value={text} onChange={setText} attachments={files} onAttachments={update => setFiles(update)} projectId={item.projectId} pending={pending} sendDisabled={!text.trim() && !files.length} onSend={options => void reply(options)} /></div>}
    {feedback && <p role="status">{feedback}</p>}</>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </li>;
}

// Like bb's chat: earlier messages load by themselves when the reader nears the top, with a small spinner while they
// come. Without IntersectionObserver (old browsers, tests) a plain Load earlier link stands in.
export function EarlierLoader({ loading, enabled = true, onLoad }: { loading: boolean; enabled?: boolean; onLoad: () => void }) {
  const sentinel = useRef<HTMLDivElement>(null), load = useRef(onLoad); load.current = onLoad;
  const watch = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const node = sentinel.current; if (!node || !watch || !enabled || loading) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) load.current(); }, { rootMargin: '600px 0px 0px 0px' });
    observer.observe(node); return () => observer.disconnect();
  }, [watch, enabled, loading]);
  return <div ref={sentinel} className="flex min-h-8 items-center justify-center">{loading ? <Icon name="Spinner" aria-label="Loading earlier messages" className="size-4 animate-spin text-muted-foreground" /> : !watch && <Button variant="ghost" size="sm" className="text-xs text-muted-foreground" onClick={onLoad}>Load earlier</Button>}</div>;
}

function Page({ threadId, view, projectId, query, cursor, orphans }: { threadId?: string; view: View; projectId?: string; query: string; cursor?: string; orphans?: Item[][] }) {
  // A thread tab's older pages freeze once loaded, as HistoryPage does, so they stop refetching on every tick.
  const [settled, setSettled] = useState(false);
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view, ...(threadId ? { threadId, order: 'activity' as const } : {}), ...(projectId ? { projectId } : {}), query, ...(cursor ? { cursor } : {}), limit: 50 }, enabled: !threadId || !cursor || !settled });
  useEffect(() => { if (threadId && cursor && result.data) setSettled(true); }, [threadId, cursor, result.data]);
  const [next, setNext] = useState(false);
  const firstUnread = useRef<string | null | undefined>(undefined);
  // A thread tab reads like the chat beside it: oldest first, earlier pages load above.
  const chronological = !!threadId, nextCursor = result.data?.nextCursor;
  // Open agent questions live in the Questions section; the thread feed shows them once replied.
  const items = result.data ? (chronological ? [...result.data.items].reverse().filter(item => item.kind !== 'for_me' || item.status !== 'open') : result.data.items) : [];
  if (chronological && !cursor && result.data && firstUnread.current === undefined) firstUnread.current = items.find(isUnread)?.id ?? null;
  // Pages render apart, so a split question older than this page goes on to the earlier one.
  const { entries, orphans: carry } = chronological ? conversation(items.map(item => [item]), !!nextCursor, orphans) : { entries: items.map((item): Entry => ({ group: [item] })), orphans: [] };
  const jump = (id: string) => document.querySelector(`[data-history-ids~="${id}"]`)?.scrollIntoView?.({ block: 'center' });
  const more = nextCursor && (next ? <Page key={nextCursor} {...{ threadId, view, projectId, query }} cursor={nextCursor} orphans={carry} /> : chronological ? <EarlierLoader loading={false} onLoad={() => setNext(true)} /> : <Button variant="ghost" size="sm" className="mx-auto flex text-xs text-muted-foreground" onClick={() => setNext(true)}>Load more</Button>);
  return <>
    {result.isLoading && <p role="status" className="px-2 text-xs text-muted-foreground">Loading answers…</p>}
    {result.error && <div role="alert">{result.error.message} <Button variant="outline" onClick={() => void result.refetch()}><Icon name="ArrowReloadHorizontal" aria-hidden />Retry</Button></div>}
    {result.data && <>
      {!cursor && !items.length && <EmptyState icon={emptyCopy[view][0]} title={emptyCopy[view][1]}>{query ? 'Nothing matches this search.' : emptyCopy[view][2]}</EmptyState>}
      {chronological && more}
      <ul aria-label="Answers" className={chronological ? 'divide-y divide-border-seam [&>:has(+[data-new])]:border-b-0' : 'space-y-3'}>{entries.map(({ group, part, updates, late }) => { const item = group[0], card = (member: Item) => <ItemCard item={member} part={part} late={updates ? undefined : late} onJump={jump} chat={chronological} markable autoRead={chronological && view === 'all'} replyToOwn={!threadId} />; return <Fragment key={part === 'answer' ? `${item.id}:answer` : item.id}>{chronological && part !== 'question' && group.some(member => member.id === firstUnread.current) && <li data-new className="flex items-center gap-3 border-b-0 py-2 text-xs font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />New<span className="h-px flex-1 bg-border" /></li>}{updates ? <UpdateGroup items={group}>{card}</UpdateGroup> : card(item)}</Fragment>; })}</ul>
      {!chronological && more}
    </>}
  </>;
}

type ViewOption = { value: View | 'inbox'; label: string; hint: string; icon: IconName };
// The views as tasks: what is new, what I am waiting for, what I owe, what I kept, everything.
// Removal candidate (review 2026-11): unused in day-to-day work so far (the view picker beyond Inbox); keep until a usage review decides.
// The thread tab's views; the page only switches between chats and the Questions section.
const viewOptions: ViewOption[] = [
  { value: 'unread', label: 'Unread', hint: 'New answers in this thread', icon: 'Mail' },
  { value: 'waiting', label: 'Awaiting answer', hint: 'Your questions agents have not answered yet', icon: 'Clock' },
  { value: 'saved', label: 'Saved', hint: 'Answers you saved or pinned', icon: 'Star' },
  { value: 'all', label: 'History', hint: 'Every question and answer, searchable', icon: 'LayoutList' },
];

// User text stays plain (no Markdown reflow); only thread mentions go through bb's renderer to become chips.
// Thread mentions and Markdown links (the composer stores task chips as links) render through bb as a whole.
const THREAD_URL = /\bhttps?:\/\/[^\s/]+(?:\/projects\/[\w-]+)?\/threads\/(thr_[A-Za-z0-9]+)(?![\w/])/g;
const MENTION = /(@thread:thr_[A-Za-z0-9]+(?:#msg=\d+)?|\[[^\]\n]+\]\([^)\s]+\))/;
export function InlineCommentText({ text, prefixes }: { text: string; prefixes?: string[] }) {
  const parsed = parseInlineComments(text);
  return <div className="space-y-2">{parsed.comments.map((entry, index) => <div key={index}>
    {entry.passage && <div className="border-l-2 border-border-seam pl-2 text-muted-foreground"><div className="line-clamp-3">{entry.passage}</div></div>}
    {entry.comment && <div>{entry.comment}</div>}
  </div>)}{quoteSegments(parsed.text).map((part, index) => part.quote
    ? <div key={`q${index}`} className="border-l-2 border-border-seam pl-2 text-muted-foreground [&_p]:m-0"><div className="line-clamp-3"><Markdown content={part.text} /></div></div>
    : <div key={`t${index}`}><UserText text={part.text} prefixes={prefixes} /></div>)}</div>;
}
// Pool replies and quote replies are Markdown with '> ' quote lines; show those as quote bars, the rest as plain text.
export function quoteSegments(text: string) {
  const parts: { quote: boolean; text: string }[] = [];
  for (const line of text.split('\n')) {
    const quote = /^>\s?/.test(line), body = quote ? line.replace(/^>\s?/, '') : line, last = parts.at(-1);
    if (last && last.quote === quote) last.text += `\n${body}`; else parts.push({ quote, text: body });
  }
  return parts.map(part => ({ ...part, text: part.text.trim() })).filter(part => part.text);
}

function UserText({ text, prefixes = [] }: { text: string; prefixes?: string[] }) {
  // Only prefixes of real Work Board projects, so look-alikes such as GPT-6 or UTF-8 stay text.
  const task = taskKeyRegex(prefixes);
  const inline = (content: string, key: string) => <Markdown key={key} content={content} className="inline-block align-baseline [&_p]:m-0" />;
  // A pasted bb thread link reads as that thread's mention pill, as bb's composer turns it into one.
  return <>{text.replace(THREAD_URL, '@thread:$1').split(MENTION).flatMap((part, index) => index % 2 ? [inline(part, `m${index}`)]
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
  const { projects, threads } = experimental_useSidebarThreads();
  const [stored, setView] = useStoredState<View | 'inbox'>(threadId ? null : 'bb-plugin-answers:page:view', threadId ? 'unread' : 'inbox');
  const view = !threadId ? 'inbox' : stored === 'pinned' ? 'saved' : stored === 'for_me' ? 'unread' : stored; // Pinned merged into Saved
  const [query, setQuery] = useStoredState(threadId ? null : 'bb-plugin-answers:page:query', '');
  const [searchQuery, setSearchQuery] = useState(query);
  useEffect(() => { const timer = setTimeout(() => setSearchQuery(query), 200); return () => clearTimeout(timer); }, [query]);
  const bbChat = useSettings().values?.chatMode === 'bb';
  const [projectId, setProjectId] = useStoredState(threadId ? null : 'bb-plugin-answers:page:project', '');
  // Page only: the Questions section replaces the chats; a stored 'Asked of you' view (now removed) opens it.
  const [questions, setQuestions] = useStoredState(threadId ? null : 'bb-plugin-answers:page:questions', stored === 'for_me');
  // Opening a thread's conversation: the Chats view picks the stored selection up when it mounts.
  const openChat = (id: string) => { try { localStorage.setItem('bb-plugin-answers:page:selected', JSON.stringify(id)); } catch { /* storage unavailable */ } setQuestions(false); };
  // A link from bb's chat (?thread=) opens that conversation once; the parameter is dropped so a reload keeps the user's place.
  // The selection is stored during this render, before the Chats view mounts and reads it; the section switch follows.
  const [linked] = useState(() => { const id = threadId ? null : linkedThread(); if (!id) return null; try { localStorage.setItem('bb-plugin-answers:page:selected', JSON.stringify(id)); } catch { /* storage unavailable */ } const url = new URL(window.location.href); url.searchParams.delete('thread'); window.history.replaceState(window.history.state, '', url); return id; });
  useEffect(() => { if (linked) setQuestions(false); }, [linked]);
  const { rows: pendingRows, settle: settlePending } = usePendingInteractionRows(threadId ? [] : threads);
  // The Questions section is page-only, so a thread tab never reads the global list.
  const forMe = useQuery({ contract: rpcContract, method: 'list', input: { view: 'for_me', limit: 50 }, enabled: !threadId });
  const questionCount = Object.values(pendingRows).reduce((sum, rows) => sum + rows.length, 0) + (forMe.data?.items.length ?? 0);
  const [error, setError] = useState('');
  const undo = useReadUndo(), [saved, setSaved] = useTransientText();
  useEffect(() => { const receive = (event: Event) => { const detail = (event as CustomEvent<{created:boolean}>).detail; localStorage.removeItem(SAVED_FLASH); setSaved(detail.created ? 'Saved to Answers' : 'Already in Saved'); }; const stored = localStorage.getItem(SAVED_FLASH); if (stored) { localStorage.removeItem(SAVED_FLASH); try { const detail = JSON.parse(stored); if (Date.now() - detail.at < 5000) receive(new CustomEvent('answers:saved', { detail })); } catch {} } window.addEventListener('answers:saved', receive); return () => window.removeEventListener('answers:saved', receive); }, [setSaved]);
  const list = view === 'saved' || view === 'all';
  return <section className="flex h-full flex-col bg-background">
    {threadId && <Pools threadId={threadId} />}
    <div className="space-y-2 border-b border-border-seam bg-background px-3 py-2">
      <div className="flex items-center gap-1">
        {threadId ? <ViewPicker options={viewOptions} value={view} onChange={setView} />
          // Markup of bb's Preview/Source switch.
          : <div role="tablist" aria-label="Section" className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border p-0.5">{([['Chats', false], ['Questions', true]] as const).map(([label, on]) => <Button key={label} type="button" size="sm" variant="ghost" className="h-6 gap-1.5 rounded-sm px-2 text-xs text-muted-foreground max-md:pointer-coarse:h-9" aria-pressed={questions === on} onClick={() => setQuestions(on)}>{label}{on && questionCount > 0 && <span aria-label={`${questionCount} pending`} className="rounded-full bg-surface-recessed px-1.5 text-2xs">{questionCount}</span>}</Button>)}</div>}
        <span className="flex-1" />
        {/* Removal candidate (review 2026-11): Mark all read is unused so far; keep until a usage review decides. */}
        {!questions && (view === 'inbox' || view === 'unread') && <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={async () => { setError(''); try { const result = await rpc.call('markRead', { all: true, ...(threadId ? { threadId } : {}) }); if ('batch' in result) undo.record(result); } catch (cause) { setError(message(cause)); } }}><Icon name="MailOpen" aria-hidden className="size-3.5" />Mark all read</Button>}
      </div>
      {list && !questions && <div className="flex gap-2">
        <input aria-label="Search answers" type="search" placeholder={view === 'saved' ? 'Search saved' : 'Search history'} maxLength={4000} className="min-w-0 flex-1 rounded-md border border-border-seam bg-transparent px-2.5 py-1 text-sm outline-none focus:border-ring" value={query} onChange={event => setQuery(event.target.value)} />
        {!threadId && <select aria-label="Project" className="max-w-40 rounded-md border border-border-seam bg-background px-2 py-1 text-sm" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
      </div>}
    </div>
    {error && <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error}</p>}{saved && <p role="status" className="px-4 py-2 text-xs">{saved}{threadId && <> · <Button size="sm" variant="ghost" onClick={() => setView('saved')}>Show in Saved</Button></>}</p>}
    {questions ? <QuestionsSection threads={threads} projects={projects} rows={pendingRows} settle={settlePending} items={forMe.data?.items ?? []} loading={!forMe.data} onOpen={openChat} /> : view === 'inbox' ? <div className="min-h-0 flex-1"><Inbox onBulkRead={undo.record} bbChat={bbChat} /></div> : <div className={`min-h-0 flex-1 overflow-auto bg-background ${threadId ? 'px-4' : 'p-4'}`}><Page key={JSON.stringify([threadId, view, searchQuery, projectId])} {...{ threadId, view }} query={list ? searchQuery : ''} projectId={list ? projectId || undefined : undefined} /></div>}
    {undo.line}
  </section>;
}


type Sidebar = ReturnType<typeof experimental_useSidebarThreads>;
// Every pending question in one stack, oldest first: bb's blocking forms (one card per thread) and open agent questions.
function QuestionsSection({ threads, projects, rows, settle, items, loading, onOpen }: { threads: Sidebar['threads']; projects: Sidebar['projects']; rows: ReturnType<typeof usePendingInteractionRows>['rows']; settle: (threadId: string, rowId: string) => void; items: Item[]; loading: boolean; onOpen: (threadId: string) => void }) {
  const providers = experimental_useProviders().providers;
  const entries = [...threads.flatMap(thread => rows[thread.id]?.length ? [{ key: thread.id, threadId: thread.id, at: Math.min(...rows[thread.id]!.map(row => row.createdAt)), item: null as Item | null }] : []), ...items.map(item => ({ key: item.id, threadId: item.threadId, at: item.createdAt, item }))].sort((a, b) => a.at - b.at);
  if (!entries.length) return loading ? null : <div className="min-h-0 flex-1 overflow-auto"><EmptyState icon={emptyCopy.for_me[0]} title={emptyCopy.for_me[1]}>{emptyCopy.for_me[2]}</EmptyState></div>;
  return <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3"><div className="space-y-3">{entries.map(entry => {
    const thread = threads.find(t => t.id === entry.threadId), projectId = thread?.projectId ?? entry.item?.projectId, title = thread?.displayTitle ?? thread?.title ?? entry.item?.threadTitle ?? 'Untitled thread';
    return <section key={entry.key} aria-label={title} className="min-w-0 overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lift">
      <header className="flex min-w-0 items-center gap-2.5 border-b border-border-hairline px-3 py-2"><Avatar id={entry.threadId} title={title} provider={thread?.providerId ? providers.find(p => p.id === thread.providerId) ?? { id: thread.providerId } : undefined} /><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{title}</div><div className="truncate text-xs text-muted-foreground">{projects.find(project => project.id === projectId)?.name ?? entry.item?.projectName ?? 'No project'} · <time dateTime={new Date(entry.at).toISOString()}>{ago(entry.at)}</time></div></div><UrlLink href={answersThreadHref(entry.threadId)} className="shrink-0 text-xs" onClick={event => { event.preventDefault(); onOpen(entry.threadId); }}>Open thread</UrlLink></header>
      {entry.item ? <ul className="px-2"><ItemCard item={entry.item} chat compact open={{ href: answersThreadHref(entry.threadId), label: 'Open in Answers', onClick: () => onOpen(entry.threadId) }} /></ul> : <PendingInteractions threadId={entry.threadId} projectId={projectId} pending status={thread?.status} stacked shared={rows[entry.threadId]} onAnswered={rowId => settle(entry.threadId, rowId)} />}
    </section>;
  })}</div></div>;
}

// A thread's open agent questions, oldest first, in bb's collapsible card for the stack above a composer (bb's thread chat
// and the Inbox conversation). Same items as the Questions section, so an answer anywhere closes them everywhere.
// shell: the Inbox stack's card chrome; bb's composer banner draws the card bare.
const linkedThread = () => { try { return new URLSearchParams(window.location.search).get('thread'); } catch { return null; } };
export const answersThreadHref = (threadId: string) => `/plugins/answers/answers?thread=${encodeURIComponent(threadId)}`;
export function ThreadQuestions({ threadId, shell }: { threadId: string; shell?: string }) {
  const { data } = useQuery({ contract: rpcContract, method: 'list', input: { view: 'for_me', threadId, limit: 50 } });
  const items = (data?.items ?? []).filter(item => item.kind === 'for_me' && item.status === 'open').sort((a, b) => a.createdAt - b.createdAt);
  if (!items.length) return null;
  // Open from the start (bb's CollapsibleStackCard always starts collapsed and hid them); header as "Active child threads".
  const card = <section aria-label="Questions for you"><div className="flex min-h-9 items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground"><Icon name="MessageQuestion" aria-hidden className="size-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate font-medium text-foreground">{items.length === 1 ? 'Question for you' : 'Questions for you'}</span><span className="rounded-full bg-surface-recessed px-1.5 text-2xs">{items.length}</span></div><ul aria-label="Questions for you" className="max-h-[min(32rem,50dvh)] divide-y divide-border-seam overflow-y-auto overscroll-contain border-t border-border-hairline px-2">{items.map(item => <ItemCard key={item.id} item={item} chat compact open={shell ? undefined : { href: answersThreadHref(threadId), label: 'Open in Answers' }} />)}</ul></section>;
  return shell ? <div data-promptbox-shell className={shell}>{card}</div> : card;
}
// bb shows its own blocking question forms in its chat; this banner adds only the agents' open questions.
export function ComposerQuestions() {
  const { scope } = useComposer();
  return scope.kind === 'thread' ? <ThreadQuestions threadId={scope.threadId} /> : null;
}

const PANEL_KEY = 'bb-plugin-answers:page-panel-tab';

// bb does not restore the plugin page's side panel, so remember the selected tab and reopen it.
export function useRememberedPagePanel() {
  const panel = experimental_useAppPanel();
  const { open, selectedKey, tabs } = experimental_usePanelTabs();
  const restored = useRef(false);
  useEffect(() => {
    // A phone (even in landscape) has no room for the panel: bb may restore it there, so the page closes it on arrival,
    // and the phone's panel state never overwrites the one remembered for wide screens.
    const wide = window.matchMedia?.('(min-width: 1024px)').matches ?? true;
    if (!restored.current) {
      restored.current = true;
      if (!wide) { if (open) panel.close(); return; }
      const saved = localStorage.getItem(PANEL_KEY);
      if (saved && !open && tabs.some(tab => tab.key === saved)) panel.selectTab(saved);
      return;
    }
    if (!wide) return;
    if (open && selectedKey) localStorage.setItem(PANEL_KEY, selectedKey); else localStorage.removeItem(PANEL_KEY);
  }, [open, selectedKey, tabs, panel]);
}

// bb's own crash screen shows no error, so the app catches its crashes: the message stays on screen with Try again, and
// the stack goes to the plugin log.
export class CrashGuard extends Component<{ where: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    const body = { where: this.props.where, message: String(error?.message ?? error).slice(0, 2000), stack: `${error?.stack ?? ''}\n${info.componentStack ?? ''}`.slice(0, 8000) };
    void fetch('/api/v1/plugins/answers/rpc/logClientError', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(() => {});
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <div role="alert" className="m-3 space-y-2 rounded-lg border border-border bg-background p-3 text-sm">
      <p className="font-medium text-destructive">Answers crashed: {error.message}</p>
      <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Details</summary><pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap">{error.stack}</pre></details>
      <Button size="sm" variant="ghost" onClick={() => this.setState({ error: null })}>Try again</Button>
    </div>;
  }
}
const guarded = <P extends object>(where: string, View: (props: P) => ReactNode) => (props: P) => <CrashGuard where={where}><View {...props} /></CrashGuard>;

function AnswersPage() {
  useRememberedPagePanel();
  return <AnswersPanel />;
}

export default definePluginApp(app => {
  app.slots.navPanel({ id: 'answers', title: 'Answers', icon: 'MessageQuestion', path: 'answers', component: guarded('page', AnswersPage), experimental_useBadge: useAnswersBadge });
  app.slots.experimental_tab({ id: 'my-questions', title: 'My questions', icon: 'MessageQuestion', context: { kind: 'thread' }, availability: 'fixed', component: guarded('thread tab', AnswersPanel) });
  app.slots.experimental_tab({ id: 'pools', title: 'Reply pools', icon: 'Sent', context: { kind: 'nav-panel', panelId: 'answers' }, availability: 'fixed', component: () => <CrashGuard where="pools"><Pools /></CrashGuard> });
  app.slots.messageAction({ id: 'pool', title: 'Add to reply pool', icon: 'Sent', async run({ threadId, message, selectedText, experimental_panel }) {
    const input = rpcContract.poolAdd.input.parse({ threadId, quote: selectedText ?? message.text, quoteSeq: message.experimental_messageSeq });
    const response = await fetch('/api/v1/plugins/answers/rpc/poolAdd', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? 'Unable to add to reply pool');
    rpcContract.poolAdd.output.parse(body.result);
    experimental_panel.openTab({ tab: { id: 'my-questions', context: { kind: 'thread' }, availability: 'fixed' } });
  } });
  app.slots.experimental_appOverlay({ id: 'chat-comment', component: guarded('comment', ChatComment) });
  app.composer.customize({ id: 'questions', scopes: ['thread'], banners: [{ id: 'questions', chrome: 'card', component: guarded('composer banner', ComposerQuestions) }] });
  app.slots.messageAction({ id: 'comment', title: 'Comment', icon: 'MessageSquare', run({ selectedText, message, composer }) {
    if (!composer) throw new Error('The thread composer is unavailable on this surface');
    const selection = window.getSelection();
    const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    window.dispatchEvent(new CustomEvent(COMMENT_EVENT, { detail: { quote: selectedText ?? message.text, quoteSeq: message.experimental_messageSeq, threadId: message.threadId, composer, top: rect?.bottom ?? window.innerHeight / 2, left: rect?.left ?? window.innerWidth / 2 } }));
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
