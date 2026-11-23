import { usePreferences } from './use-preferences';
import { FullTranscript, FullTranscriptContext } from './full-transcript';
import { ConversationOutline } from './conversation-outline';
import { bindChatCommands, chatShortcut } from './chat-commands';
import { ThreadHeader } from './thread-header';
import { COMPOSE_KEY, DRAFTS_EVENT } from './drafts';
import { QuestionStack } from './question-stack';
import { ContactsList, useContacts } from './contacts';
import { JUMP_EVENT, takeJump, useContactSelection } from './open-chat';
import { mentionsForText } from './mentions';
import { PendingInteractions, usePendingInteractionRows } from './interactions';
import { Activity, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { experimental_Icon as Icon, experimental_PluginIcon as PluginIcon, experimental_ProviderIcon as ProviderIcon, experimental_resolveThreadStatus as resolveThreadStatus, experimental_useSidebarThreads, ThreadChat, Markdown, UrlLink, useRpc, useSdk, experimental_useRpcQuery as useQuery, experimental_useRpcRefresh, experimental_useAppPanel, type ExperimentalProviderModelPickerValue, type ExperimentalPermissionModePickerProps } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AgentHubRpcContract, type Item, type Pool, type PoolEntry, type ListResult, type Attachment, type SendOptions } from './contract';
import { Button } from './components/ui/button';
import { useStoredState } from './lib/stored-state';
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { ContextRing, type ContextUsage } from './context-ring';
import { ThreadCostLabel, useThreadCost } from './cost';
import { CompactButton } from './compact-button';
import { unlabel, echoLine, UserText, EditSentContext, ItemCard, ThreadQuestions, UpdateGroup, InlineCommentText, isUnread, quoteSegments, usePluginBrands, useSteadyError, EarlierLoader } from './app';
import { ActivityContext, ActivityLabelContext, RobotLoader } from './robot-loader';
import { WorkLog, ThreadPlan } from './work-log';
import { useAgentActivity } from './activity';
import { deliveryError } from './delivery';
import { buildReplyMessage } from './reply-message';
import { uploadAttachment, Composer, localInput, SendButton } from './composer';
import { EmptyState, useTransientText, type IconName } from './empty';
import { clipSelection, selectionMarkdown, selectionPosition } from './selection';
import { ComposerThread } from './rich-editor';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const SCROLL_KEY = 'bb-plugin-answers:page:scroll';
// anchor: the first message on screen (one of its data-history-ids) and its distance from the view's top; pixels alone
// drift because the conversation keeps growing while it renders.
// bottom: the reader was at the newest message, so the chat reopens there (with whatever came since) rather than at an old anchor.
type Scroll = { top: number; depth: number; anchor?: string; offset?: number; bottom?: true };
// Where each conversation was left, so switching chats or screens returns to it. The old one-thread format is dropped.
function readScrolls(): Record<string, Scroll> { try { const value = JSON.parse(localStorage.getItem(SCROLL_KEY) ?? '{}'); return value && typeof value === 'object' && !('threadId' in value) ? value : {}; } catch { return {}; } }
type HistoryInput = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['promptHistory']>>[number]['input'];
type ComposeDraft = { text: string; files: Attachment[]; historyInput?: HistoryInput; execution?: ExperimentalProviderModelPickerValue; permissionMode?: ExperimentalPermissionModePickerProps['value'] };
function composeDrafts(): Record<string, ComposeDraft> { try { return JSON.parse(localStorage.getItem(COMPOSE_KEY) ?? '{}'); } catch { return {}; } }
// One turn's messages from the owner (a question and its steers) share one card: still waiting, or answered by one reply.
export function groupItems(items: Item[]) { const groups: Item[][] = []; for (const item of items) { const last = groups.at(-1)?.at(-1); if (item.kind === 'mine' && item.turnId && ((item.answerSeq ?? item.interimSeq) !== null || item.status === 'waiting') && last?.kind === 'mine' && last.turnId === item.turnId && last.status === item.status && (last.answerSeq ?? last.interimSeq) === (item.answerSeq ?? item.interimSeq)) groups.at(-1)!.push(item); else groups.push([item]); } return groups; }
export const activityAt = (item: Item) => item.answeredAt ?? item.createdAt;
// updates: a run of consecutive agent updates that ask nothing, shown as one collapsed group (UpdateGroup in app.tsx).
// late: earlier questions answered by this same message (one reply resolving several), echoed above it instead of a second copy.
export type Entry = { group: Item[]; part?: 'question' | 'answer'; updates?: true; late?: Item[] };
const quietUpdate = (entry: Entry) => !entry.part && entry.group.length === 1 && entry.group[0].kind === 'update' && !entry.group[0].asks && entry.group[0].status !== 'waiting';
// Messenger-style reply: when other messages arrived between a question and its late answer, the question stays at its
// time and the answer becomes its own message at answer time. groups run oldest first; more: earlier pages exist, so a
// split question older than the oldest loaded item waits there (orphans, carried to the earlier page; carried: from a newer one).
// showLast: the chat is the newest page and has gone quiet (it and its sub-sessions idle), so its last message is final.
// keep: an update already shown in full that way stays so while it is the last (a turn starting must not fold it back).
// from: the first unread; it starts its own run of updates, so older read updates joining later never move the New divider's row.
export function conversation(groups: Item[][], more: boolean, carried: Item[][] = [], showLast = true, keep: string | null = null, groupUpdates = true, from: string | null = null) {
  // A message that joined the turn answering the owner (a child's completion, another thread's or a plugin's message) stands
  // above the owner's message, so the question and its answer stay together.
  const asked = new Map(groups.filter(group => group[0].kind === 'mine' && group[0].turnId).map(group => [group[0].turnId!, group[0].createdAt] as const));
  // Only while no message of another turn came in between: displaced over others, a late unread update would sit far above
  // the new messages, and the New divider with it.
  const above = (group: Item[]) => {
    const item = group[0], from = item.kind === 'update' && !item.answer && item.turnId ? asked.get(item.turnId) : undefined; if (from === undefined) return null;
    const to = activityAt(item);
    return groups.some(other => other[0].turnId !== item.turnId && [activityAt(other.at(-1)!), ...(other[0].kind === 'mine' ? [other[0].createdAt] : [])].some(time => time > from && time < to)) ? null : from;
  };
  // One the agent answered in that turn follows the owner's answer instead, without splitting the owner's message from it.
  const after = (group: Item[]) => { const item = group[0]; return item.kind === 'update' && !!item.answer && !!item.turnId && asked.has(item.turnId); };
  const rank = (group: Item[]) => above(group) !== null ? -1 : after(group) ? 1 : 0;
  const floor = groups.length ? activityAt(groups[0][0]) : Infinity, marks = groups.filter(group => rank(group) === 0).flatMap(group => [group[0].createdAt, activityAt(group[0])]);
  const placed: [number, Entry][] = [], orphans: Item[][] = [];
  const ask = (group: Item[]) => { if (more && group[0].createdAt < floor) orphans.push(group); else placed.push([group[0].createdAt, { group, part: 'question' }]); };
  carried.forEach(ask);
  for (const group of groups) {
    const asked = group[0].createdAt, at = activityAt(group.at(-1)!);
    if (group[0].kind === 'mine' && group.at(-1)!.answer !== null && marks.some(mark => mark > asked && mark < at)) { ask(group); placed.push([at, { group, part: 'answer' }]); }
    else placed.push([above(group) ?? at, { group }]);
  }
  // One message can answer an older question and a new one; it shows once, under the new question, echoing the older one.
  for (let i = placed.length - 1; i >= 0; i--) {
    const [, entry] = placed[i]!, seq = entry.group.at(-1)!.answerSeq;
    if (entry.part !== 'answer' || seq === null) continue;
    const home = placed.find(([, other]) => !other.part && other.group.at(-1)!.kind === 'mine' && other.group.at(-1)!.answerSeq === seq);
    if (home) { home[1].late = [...(home[1].late ?? []), ...entry.group]; placed.splice(i, 1); }
  }
  const entries: Entry[] = [];
  for (const [, entry] of placed.sort((a, b) => a[0] - b[0] || rank(a[1].group) - rank(b[1].group))) { const prev = entries.at(-1); if (groupUpdates && prev && quietUpdate(entry) && (prev.updates || quietUpdate(prev)) && !entry.group.some(item => item.id === from)) entries[entries.length - 1] = { group: [...prev.group, ...entry.group], updates: true }; else entries.push(entry); }
  // Once the chat has gone quiet its latest message does not hide in a collapsed group: a final report after a run of updates
  // stays in full view. While work goes on, the updates still flying in stay collapsed.
  const tail = entries.at(-1);
  if ((showLast || (keep !== null && tail?.group.at(-1)?.id === keep)) && tail?.updates) entries.splice(-1, 1, tail.group.length > 2 ? { group: tail.group.slice(0, -1), updates: true } : { group: tail.group.slice(0, -1) }, { group: tail.group.slice(-1) });
  return { entries, orphans };
}
const poolsTab = { id: 'pools', context: { kind: 'nav-panel' as const, panelId: 'agent-hub' }, availability: 'fixed' as const };
type Draft = { threadId: string; projectId?: string | null; itemId: string; quote: string; quoteSeq?: number; top: number; above?: number; left: number; width: number };

// Each page follows the freshly returned cursor of its predecessor; depth lives above the chain.
export function receivePage(old: { threadId?: string; pages: ListResult[] }, threadId: string, index: number, data: ListResult) { if (old.threadId === threadId && old.pages[index] === data) return old; const next = old.threadId === threadId ? [...old.pages] : []; next[index] = data; if (!data.nextCursor) next.length = index + 1; return { threadId, pages: next }; }
const NO_PAGES: ListResult[] = [];
// Pages can land out of order (an older one from cache while the newest refetches); only the unbroken run from the newest is shown.
export const unbroken = (pages: ListResult[]) => { const gap = pages.findIndex(page => !page); return gap < 0 ? pages : pages.slice(0, gap); };
const CONTACTS_MIN = 170, CONTACTS_MAX = 560, CONTACTS_DEFAULT = 230;
type QueueRow = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['queuedMessages']['list']>>[number];
type QueueEdit = { id: string; text: string; files: Attachment[]; model: string; reasoningLevel: ExperimentalProviderModelPickerValue['reasoningLevel']; serviceTier: ExperimentalProviderModelPickerValue['serviceTier']; permissionMode: QueueRow['permissionMode'] };
type Notice = NonNullable<QueueRow['systemNotice']>;
const noticeIcons = { 'ownership-assigned': 'ChildThread', 'ownership-removed': 'UserRound', 'ownership-batch': 'ChildThread', 'child-needs-attention': 'AlertTriangle', 'child-completed': 'CircleCheck', 'child-failed': 'CircleX', 'child-interrupted': 'AlertCircle', 'child-outcome-batch': 'ListTodo', 'tool-result-delivered': 'Toolbox', 'environment-directory-updated': 'FolderOpen', unlabeled: 'Info' } as const;
function noticeText({ kind, subject }: Notice) {
  if (kind === 'ownership-batch' || kind === 'child-outcome-batch') return subject?.kind === 'thread-batch' ? kind === 'ownership-batch' ? `Ownership changed for ${subject.count} threads` : `${subject.count} threads updated` : 'System Message';
  if (kind === 'tool-result-delivered') return subject?.kind === 'tool-call' ? `Delivered ${subject.toolName} result` : 'System Message';
  if (kind === 'environment-directory-updated') return subject?.kind === 'directory' ? `Continued in ${subject.path}` : 'System Message';
  const suffix = { 'ownership-assigned': 'assigned to you', 'ownership-removed': 'unassigned', 'child-needs-attention': 'needs attention', 'child-completed': 'finished', 'child-failed': 'failed', 'child-interrupted': 'was interrupted' } as const;
  return subject?.kind === 'thread' && kind in suffix ? `${subject.threadName} ${suffix[kind as keyof typeof suffix]}` : 'System Message';
}
type Child = ReturnType<typeof experimental_useSidebarThreads>['threads'][number];
type Interaction = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['interactions']['list']>>[number];
function interactionTitle(row: Interaction) {
  const payload = row.payload;
  if (payload.kind === 'user_question') return payload.questions[0]?.prompt ?? 'User answer requested';
  if (payload.kind !== 'approval') return payload.title;
  if (payload.reason) return payload.reason;
  const subject = payload.subject;
  return subject.kind === 'command' ? subject.command : subject.kind === 'file_change' ? 'File changes pending approval' : subject.kind === 'plan' ? 'Plan ready for review' : subject.kind === 'permission_grant' ? subject.toolName ?? 'Permission request' : subject.presentation.title ?? 'Approval needed';
}
// Slides its content out from under the composer (or back under it) while the height follows, so the chat above moves
// smoothly instead of jumping. The content stays mounted while it slides away. The column is capped (minmax(0,1fr)) so a
// long unwrapped line cannot widen the card past the composer.
// Within this many pixels of the end the chat counts as scrolled to the bottom (sub-pixel rounding only): there it follows
// new messages; scrolled up even a little, nothing moves.
const AT_BOTTOM = 2;
// Left at the end, for reopening: a reader a few lines short of the very bottom (a quarter of the view) still saw the newest
// messages, so the chat reopens at the newest, not at the card that happened to be on top then.
// The row a pin or an anchor means: the element itself while it is in the page, else the one now carrying the same id (a rebuilt row's old node has no box).
const live = (node: HTMLElement, el: HTMLElement | null, selector: string) => el?.isConnected ? el : node.querySelector<HTMLElement>(selector);
const rowOf = (id: string) => `[aria-label=History] [data-history-ids~="${CSS.escape(id)}"]`;
export const atEnd = (node: HTMLElement) => node.scrollHeight - node.scrollTop - node.clientHeight <= Math.max(AT_BOTTOM, node.clientHeight / 4);
// Following new content stops before it carries away what the reader saw at the bottom: a big arrival (a long reply) halts
// with its start under the header (covered: the header, the composer and a margin), and the chat stops following there.
export const followTo = (top: number, height: number, client: number, before: number, covered: number) => Math.max(top, Math.min(height - client, before - covered));
// Cards already shown, by id: coming back to a chat whose card did not change draws it in place instead of replaying the slide.
// An id is forgotten once its card has slid away (or was hidden when it left), so a card that comes back later slides in again.
const revealed = new Set<string>();
// show: null while not known yet (a chat's queue still loading), which neither shows nor hides the card.
function Reveal({ show, id, children }: { show: boolean | null; id?: string; children: ReactNode }) {
  const last = useRef(children), [gone, setGone] = useState(!show), still = useRef(!!show && !!id && revealed.has(id));
  if (show) last.current = children;
  // Appearing from nothing: in place if this card was already up, sliding in if it is new.
  if (show && gone) still.current = !!id && revealed.has(id);
  useEffect(() => {
    if (show === null) return;
    if (show) { setGone(false); if (id) revealed.add(id); return () => { still.current = true; }; }
    // Hiding: a card that shows again before the slide ends reverses in place and stays known.
    const timer = setTimeout(() => { setGone(true); if (id) revealed.delete(id); }, 200);
    return () => { clearTimeout(timer); if (id) revealed.delete(id); };
  }, [show]);
  if (!show && gone) return null;
  const enter = still.current ? '' : 'starting:grid-rows-[0fr]', slide = still.current ? '' : 'starting:translate-y-full';
  return <div className={`grid grid-cols-[minmax(0,1fr)] transition-[grid-template-rows] duration-200 ease-out ${enter} motion-reduce:transition-none ${show ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
    <div className="min-h-0 min-w-0 overflow-clip [overflow-clip-margin:8px]"><div className={`transition-transform duration-200 ease-out ${slide} motion-reduce:transition-none ${show ? '' : 'translate-y-full'}`}>{show ? children : last.current}</div></div></div>;
}
// A message on its way, drawn as the card it becomes once the thread records it (time, Copy, Save, the waiting robot and the
// card actions), so nothing jumps when the real one replaces it; the list holding it is inert until then.
function sendingItem(b: { threadId: string; text: string; id: number }, recipient?: { threadTitle: string | null; projectId: string | null; projectName: string | null }): Item {
  const at = Math.floor(b.id);
  return { id: `ans_sending${at}`, notice: null, kind: 'mine', threadId: b.threadId, projectId: recipient?.projectId ?? null, threadTitle: recipient?.threadTitle ?? null, projectName: recipient?.projectName ?? null, status: 'waiting', question: b.text, attachments: [], questionSeq: 0, requestId: null, turnId: null, candidate: null, candidateSeq: null, interim: null, interimSeq: null, answer: null, answerSeq: null, answerSource: null, resolveTurnId: null, note: null, snoozedUntil: null, declinedAt: null, failedAt: null, failureReason: null, interruptedAt: null, likelyInterim: false, options: null, questions: null, recommended: null, recommendReason: null, deadlineAt: null, urgency: null, taskKey: null, trigger: null, answeredAt: null, asks: false, chatAsked: false, readAt: null, pinned: false, dismissedAt: null, threadDeleted: false, createdAt: at, updatedAt: at };
}
const stackShell = 'mb-2 overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lift';
// bb previews a queued message as one truncated line of inline Markdown: blocks flatten to spans, links read as text, code stays a chip.
const queuePreview = "block truncate !text-xs !leading-4 text-foreground [&_:not(br,img,hr)]:!inline [&_*]:!m-0 [&_*]:!text-xs [&_*]:!leading-4 [&_:not(code,blockquote)]:!p-0 [&_:is(p,li,h1,h2,h3,h4,h5,h6,td,th)]:after:content-['_'] [&_:is(br,img,hr)]:!hidden [&_a]:pointer-events-none [&_a]:!text-inherit [&_a]:!no-underline [&_:is(h1,h2,h3,h4,h5,h6)]:font-semibold [&_blockquote]:border-l-2 [&_blockquote]:border-surface-selected-border [&_blockquote]:!pl-2 [&_blockquote]:text-muted-foreground";
// A queued quote reply is '> quote' lines, a blank line and the note; the editor shows the quote as a quote bar, like the
// quote popup, and edits only the note.
function editBody(text: string) { const lead = /^((?:>.*(?:\n|$))+)\n*/.exec(text); return lead ? { quote: lead[1]!.replace(/\n$/, ''), body: text.slice(lead[0].length) } : { quote: '', body: text }; }
// bb's queue row under @dnd-kit sortable: the other rows slide apart to show where the dragged one lands, and the dragged
// row lifts like bb's (border, shadow).
function SortableRow({ id, lifted = false, children }: { id: string; lifted?: boolean; children: (handle: { ref: (node: HTMLElement | null) => void; props: Record<string, unknown>; dragging: boolean }) => ReactNode }) {
  const { attributes, listeners, isDragging, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({ id });
  // A dropped row waiting for its new send time stays lifted where it was dropped, like a row still being dragged.
  return <li ref={setNodeRef} data-queue-row={id} data-lifted={lifted || undefined} style={{ transform: DndCSS.Translate.toString(transform), transition }} className={`group/dispatch-row relative border-b border-border/35 px-2.5 py-0.5 ${isDragging ? 'z-20 rounded-lg border border-border bg-background opacity-90 shadow-lift' : lifted ? 'z-20 rounded-lg border border-border bg-background shadow-lift' : ''}`}>{children({ ref: setActivatorNodeRef, props: { ...attributes, ...listeners }, dragging: isDragging })}</li>;
}
const OwedCard = memo(function OwedCard({ threadId, newest, working, onJump }: { threadId: string; newest?: Entry; working: boolean; onJump: (id: string) => void }) {
  const rpc = useRpc<AgentHubRpcContract>();
  const result = useQuery({ contract: rpcContract, method: 'owed', input: { threadId } });
  const { data: workBoard } = useQuery({ contract: rpcContract, method: 'workBoardProjects', input: {} });
  const [collapsed, setCollapsed] = useStoredState('bb-plugin-answers:page:owed-collapsed', false);
  const [error, setError] = useState('');
  // Only the newest history card has a robot; deferred items without an interim have none.
  const robot = newest?.group.at(-1);
  const hidden = robot?.kind === 'mine' && robot.status === 'deferred' && robot.dismissedAt === null && !!robot.interim ? newest!.group.map(item => item.id) : [];
  const rows = (result.data?.items ?? []).filter(item => !hidden.includes(item.id));
  const settle = async (id: string, action: 'answered' | 'dismissed') => {
    setError('');
    try { await rpc.call('settleOwed', { id, action }); await result.refetch(); } catch (e) { setError(errorText(e)); }
  };
  const action = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover';
  // While the chat, its background work or its sub-threads still run the answer may be on its way; Answered would only race it.
  if (!rows.length || working) return null;
  return <section aria-label="Answers owed" className="relative z-10 mb-1 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lift">
    <header className="shrink-0"><button type="button" aria-label="Toggle answers owed" aria-expanded={!collapsed} className="answers-hit flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs text-foreground hover:bg-state-hover focus-visible:bg-state-hover" onClick={() => setCollapsed(!collapsed)}>{rows.length} {rows.length === 1 ? 'answer' : 'answers'} owed</button></header>
    {!collapsed && <ul className="max-h-64 overflow-y-auto overscroll-contain pt-1">{rows.map(row => <li key={row.id} className="flex items-center gap-1.5 border-b border-border/35 px-2.5 py-1 text-xs">
      <span className="min-w-0 flex-1 truncate" title={row.question}><UserText threadId={threadId} text={echoLine(row.question)} prefixes={workBoard?.projects.map(p => p.prefix)} /></span>
      <time className="shrink-0 text-2xs tabular-nums text-subtle-foreground" dateTime={new Date(row.createdAt).toISOString()} title={new Date(row.createdAt).toLocaleString()}>{ago(row.createdAt)}</time>
      <button type="button" className={action} title="Jump" aria-label="Jump" onClick={() => onJump(row.id)}><Icon name="ArrowTurnBackward" aria-hidden className="size-3.5" /></button>
      <button type="button" className={action} title="Answered" aria-label="Answered" onClick={() => void settle(row.id, 'answered')}><Icon name="Check" aria-hidden className="size-3.5" /></button>
      <button type="button" className={action} title="Dismiss" aria-label="Dismiss" onClick={() => void settle(row.id, 'dismissed')}><Icon name="X" aria-hidden className="size-3.5" /></button>
    </li>)}</ul>}{error && <p role="alert" className="px-3 text-xs text-destructive">{error}</p>}
  </section>;
});

// The queue list scrolls and clips its rows; a row's popover goes to the page instead, fixed beside the row (above it when
// there is room, as the queue sits over the composer), the way the item menu does.
function RowPopover({ anchor, label, className, onClose, children }: { anchor: HTMLElement | null; label: string; className: string; onClose: () => void; children: ReactNode }) {
  const [at, setAt] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const place = () => { const r = anchor?.getBoundingClientRect(); if (r) setAt({ right: Math.max(8, window.innerWidth - r.right + 8), ...(r.top > 220 ? { bottom: window.innerHeight - r.top + 4 } : { top: r.bottom + 4 }) }); };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchor]);
  return at && createPortal(<div role="dialog" aria-label={label} className={`fixed z-[100] space-y-2 rounded-lg border border-border bg-background p-2 shadow-lg ${className}`} style={at} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>{children}</div>, document.body);
}
// A dragged row moves only up and down and stays inside the visible queue list: pulled past its bottom it would stretch
// the list and add a scroll that is not there.
export const keepInList: Modifier = ({ transform, draggingNodeRect, scrollableAncestorRects }) => {
  const box = scrollableAncestorRects[0];
  if (!draggingNodeRect || !box) return { ...transform, x: 0 };
  return { ...transform, x: 0, y: Math.min(Math.max(transform.y, box.top - draggingNodeRect.top), box.bottom - draggingNodeRect.bottom) };
};
// Only the owner's own words come back as a chat message; a bb notice, another thread's or plugin's message never does, so holding it would leave it hanging.
const landsInChat = (row: QueueRow) => !row.systemNotice && !row.senderThreadId && (!row.originPluginId || ['agent-hub', 'answers'].includes(row.originPluginId));
const isScheduled = (row: QueueRow) => !!row.sendAt && row.sendAt > Date.now();
const RETIME_MINUTES = [3, 5, 10, 20, 40];
const span = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
// How far the message's own send time moves (or, unscheduled, how soon it will go), not the step from its new neighbour.
const shift = (row: QueueRow, at: number) => { if (!isScheduled(row)) return `in ${span(Math.max(1, Math.round((at - Date.now()) / 60000)))}`; const minutes = Math.round((at - row.sendAt!) / 60000); return `${minutes < 0 ? '−' : '+'}${span(Math.abs(minutes))}`; };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const QueueCard = memo(function QueueCard({ rows, sourceName, sourceBrand, waitReason, projectId, edit, onEdit, onFinish, onSend, onDelete, onSchedule, onReorder }: { rows: QueueRow[]; sourceName: (row: QueueRow) => string | null; sourceBrand: (row: QueueRow) => { id: string; name: string; icon: string | null } | null; waitReason: (row: QueueRow) => { icon: ReactNode; text: string } | null; projectId?: string | null; edit: QueueEdit | null; onEdit: (row: QueueRow, update?: Partial<QueueEdit>) => void; onFinish: (row: QueueRow, save: boolean) => void; onSend: (row: QueueRow) => void; onDelete: (row: QueueRow) => void; onSchedule: (row: QueueRow, sendAt: number) => void; onReorder: (row: QueueRow, previousQueuedMessageId: string | null, nextQueuedMessageId: string | null) => void }) {
  // The bottom fade only hints at rows hidden below; with nothing to scroll it would just shade the last row.
  const list = useRef<HTMLDivElement>(null), [more, setMore] = useState(false);
  const rowNode = (id: string) => list.current?.querySelector<HTMLElement>(`[data-queue-row="${id}"]`) ?? null;
  const measure = () => { const node = list.current; setMore(!!node && node.scrollHeight - node.scrollTop - node.clientHeight > 1); };
  useLayoutEffect(measure, [rows.length, edit]);
  const [collapsed, setCollapsed] = useStoredState('bb-plugin-answers:page:queue-collapsed', false);
  const [later, setLater] = useState<string | null>(null), [date, setDate] = useState(''), [dateError, setDateError] = useState('');
  // The dropped order shows at once instead of snapping back until the reordered queue arrives.
  const [order, setOrder] = useState<string[] | null>(null), ids = rows.map(row => row.id).join(' ');
  useEffect(() => setOrder(null), [ids]);
  if (order) rows = [...rows].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  // Scheduled messages line up by send time after the ones that go as soon as the thread is free.
  rows = [...rows.filter(row => !isScheduled(row)), ...rows.filter(isScheduled).sort((a, b) => a.sendAt! - b.sendAt!)];
  // A row dropped among scheduled ones is held at its drop place while the owner picks a time, and after Yes until the new
  // time arrives (then the time sort keeps it there); Cancel lets it go back.
  const [retime, setRetime] = useState<{ row: QueueRow; options: { minutes: number; at: number }[] } | null>(null), [retimeMenu, setRetimeMenu] = useState(false);
  const [held, setHeld] = useState<{ id: string; to: number; was: number | null } | null>(null);
  const heldRow = held && rows.find(row => row.id === held.id), heldSince = heldRow?.sendAt ?? null;
  if (held && heldRow) { const others = rows.filter(row => row.id !== held.id); rows = [...others.slice(0, held.to), heldRow, ...others.slice(held.to)]; }
  // Rows that change place glide there (FLIP): their tops are taken just before the change and played back after it.
  const tops = useRef<Map<string, number> | null>(null);
  const snapshot = () => { const map = new Map<string, number>(); list.current?.querySelectorAll<HTMLElement>('[data-queue-row]').forEach(node => map.set(node.dataset.queueRow!, node.getBoundingClientRect().top)); tops.current = map; };
  useLayoutEffect(() => {
    const before = tops.current; tops.current = null;
    if (!before || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    list.current?.querySelectorAll<HTMLElement>('[data-queue-row]').forEach(node => { const was = before.get(node.dataset.queueRow!), delta = was === undefined ? 0 : was - node.getBoundingClientRect().top; if (Math.abs(delta) > 1) node.animate?.([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }); });
  });
  const release = () => { snapshot(); setHeld(null); };
  useEffect(() => {
    if (!held || retime) return;
    if (!heldRow || heldSince !== held.was) { release(); return; }
    const timer = setTimeout(release, 8000); // the new time never came (the update failed): let the row go back
    return () => clearTimeout(timer);
  }, [held, retime, heldRow, heldSince]);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  // Dropping a message among scheduled ones moves it in time, not in the queue: the owner confirms a new send time
  // a few minutes after the scheduled message it now follows (or before the one it now leads).
  const place = (row: QueueRow, to: number, dragged = false) => {
    const others = rows.filter(item => item.id !== row.id), before = others[to - 1], after = others.slice(to).find(isScheduled);
    const base = before && isScheduled(before) ? { at: before.sendAt!, sign: 1 } : isScheduled(row) && after ? { at: after.sendAt!, sign: -1 } : null;
    if (!base) { if (isScheduled(row)) return; if (dragged) setOrder([...others.slice(0, to), row, ...others.slice(to)].map(item => item.id)); move(row, to); return; }
    // The new time must land strictly between the new neighbours, or the time sort puts the message back where it was.
    const now = Date.now(), low = base.sign > 0 ? base.at : now + 30000, high = base.sign > 0 ? after?.sendAt ?? Infinity : base.at;
    const options = RETIME_MINUTES.map(minutes => ({ minutes, at: base.at + base.sign * minutes * 60000 })).filter(option => option.at > Math.max(low, now + 30000) && option.at < high);
    // A gap narrower than any step gets one time in its middle, on a whole minute when one fits.
    if (!options.length && high - Math.max(low, now) > 2000) { const middle = (Math.max(low, now) + high) / 2, minute = Math.floor(middle / 60000) * 60000, at = minute > Math.max(low, now) ? minute : middle; options.push({ minutes: Math.max(1, Math.round(Math.abs(at - base.at) / 60000)), at }); }
    if (options.length) { snapshot(); setHeld({ id: row.id, to, was: row.sendAt ?? null }); setRetime({ row, options }); setRetimeMenu(false); }
  };
  const drop = ({ active, over }: DragEndEvent) => { const row = rows.find(item => item.id === active.id), to = rows.findIndex(item => item.id === over?.id); if (!row || to < 0 || row.id === over!.id) return; place(row, to, true); };
  const action = 'inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:bg-state-hover';
  const move = (row: QueueRow, index: number) => { const others = rows.filter(item => item.id !== row.id); onReorder(row, others[index - 1]?.id ?? null, others[index]?.id ?? null); };
  const schedule = (row: QueueRow) => { const sendAt = new Date(date).getTime(); if (!(sendAt > Date.now())) { setDateError('Pick a time in the future'); return; } onSchedule(row, sendAt); setLater(null); setDateError(''); };
  return <section aria-label="Queued messages" className={`relative z-10 flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface-raised-solid shadow-lift ${collapsed ? 'mb-1' : '-mb-[11px] rounded-b-none border-b-0 pb-3'}`}>
    <header className="shrink-0"><button type="button" aria-label="Toggle queued messages" aria-expanded={!collapsed} className="answers-hit flex min-h-8 w-full min-w-0 cursor-pointer items-center gap-1.5 px-3 py-1.5 text-xs text-foreground hover:bg-state-hover focus-visible:bg-state-hover" onClick={() => setCollapsed(!collapsed)}><span>Queue</span><span className="ml-auto mr-px flex w-6 shrink-0 items-center justify-center"><span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-surface-recessed px-1 text-2xs leading-none tabular-nums text-subtle-foreground">{rows.length}</span></span></button></header>
    {!collapsed && <><div className="relative min-h-0 flex-1"><div ref={list} onScroll={measure} className="max-h-64 min-w-0 overflow-y-auto overflow-x-hidden overscroll-contain"><DndContext sensors={sensors} modifiers={[keepInList]} onDragEnd={drop}><SortableContext items={rows.map(row => row.id)} strategy={verticalListSortingStrategy}><ul className="group/queue pt-1">{rows.map((row, index) => {
      const scheduled = row.sendAt && row.sendAt > Date.now(), wait = waitReason(row);
      const distance = scheduled ? Math.max(1, Math.ceil((row.sendAt! - Date.now()) / 60000)) : 0;
      const relative = distance >= 1440 ? `${Math.ceil(distance / 1440)}d` : distance >= 60 ? `${Math.ceil(distance / 60)}h` : `${distance}m`;
      const queueText = row.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      // A plugin's row shows its icon in place of bb's [bb message from plugin:…] header and the From line, to stay short.
      const brand = sourceBrand(row), shown = landsInChat(row) ? queueText : unlabel(queueText), source = brand ? null : sourceName(row), files = row.content.filter(part => part.type !== 'text').length;
      return edit?.id === row.id ? <li key={row.id} data-queued-message-inline-editor className="relative z-10 border-b border-border/35 px-2.5 py-1"><div className="mb-1.5 flex min-h-7 items-center gap-1.5 pl-1 text-xs text-subtle-foreground"><Icon name="Edit" aria-hidden className="size-3.5 shrink-0" /><span>Editing queued message {index + 1}</span><button type="button" aria-label="Stop editing queued message" className={`answers-hit ${action} ml-auto size-6`} onClick={() => onFinish(row, false)}><Icon name="X" aria-hidden className="size-3" /></button></div><Composer editMode label="Edit queued message" sendLabel="Confirm queued message edit" placeholder="Ask for a follow-up…" autoFocus value={editBody(edit.text).body} onChange={text => { const { quote } = editBody(edit.text); onEdit(row, { text: quote ? `${quote}\n\n${text}` : text }); }} header={editBody(edit.text).quote && <div className="px-4 pt-3"><div className="max-h-32 overflow-auto border-l-2 border-border-seam pl-2 text-sm text-muted-foreground [&_*]:text-muted-foreground [&_p]:m-0"><Markdown content={editBody(edit.text).quote.replace(/^>[ \t]?/gm, '')} /></div></div>} attachments={edit.files} onAttachments={update => onEdit(row, { files: update(edit.files) })} projectId={projectId} onSend={() => onFinish(row, true)} onCancel={() => onFinish(row, false)} /></li> : <SortableRow key={row.id} id={row.id} lifted={retime?.row.id === row.id}>{handle => <>
        <div className="flex items-center gap-1.5"><button type="button" ref={handle.ref} {...handle.props} aria-label={`Reorder queued message ${index + 1}`} className={`answers-hit ${action} cursor-grab touch-none active:cursor-grabbing`} onKeyDown={event => { if (event.key === 'ArrowUp' && index > 0) { event.preventDefault(); place(row, index - 1); } if (event.key === 'ArrowDown' && index < rows.length - 1) { event.preventDefault(); place(row, index + 1); } }}><Icon name="DragDropVertical" aria-hidden className={`size-3.5 shrink-0 opacity-60 transition-opacity group-hover/dispatch-row:opacity-100 focus:opacity-100 ${handle.dragging ? 'opacity-100' : ''}`} /></button>
          <div className="min-w-0 flex-1 py-1.5"><div className="flex min-w-0 items-center gap-1">{brand && <span role="img" aria-label={`From ${brand.name}`} title={`From ${brand.name}`} className="inline-flex shrink-0"><PluginIcon pluginId={brand.id} icon={brand.icon} className="size-3.5 shrink-0 text-muted-foreground" /></span>}{(() => { const parts = quoteSegments(shown), quote = parts.filter(part => part.quote).map(part => part.text).join(' '), body = parts.filter(part => !part.quote).map(part => part.text).join('\n');
            // A quoted reply gets its quote and its own text on separate lines, so the message is not cut off behind the quote.
            return row.systemNotice ? <div data-queued-message-system-notice className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-foreground" title={noticeText(row.systemNotice)}><Icon name={noticeIcons[row.systemNotice.kind]} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden /><span className="block min-w-0 truncate !text-xs !leading-4">{noticeText(row.systemNotice)}</span></div> : quote && body ? <div className="min-w-0 flex-1" title={queueText}><div className={`${queuePreview.replace('text-foreground', 'text-muted-foreground')} border-l-2 border-surface-selected-border pl-2`}><Markdown content={quote} /></div><div className={`mt-0.5 ${queuePreview}`}><Markdown content={body} /></div></div> : <div className={`min-w-0 flex-1 ${queuePreview}`} title={queueText}><Markdown content={shown} /></div>; })()}{files > 0 && <span data-queued-message-attachment role="img" aria-label={files === 1 ? '1 attachment' : `${files} attachments`} className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-2xs text-subtle-foreground opacity-70 transition-opacity group-hover/dispatch-row:opacity-0 group-focus-within/dispatch-row:opacity-0"><Icon name="FileAttachment" aria-hidden className="size-3.5" /><span aria-hidden>{files}</span></span>}</div>{wait && <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-2xs text-subtle-foreground" title={wait.text}>{wait.icon}<span className="min-w-0 truncate">{wait.text}</span></div>}{(source || scheduled) && <div className="mt-0.5 flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-2xs text-subtle-foreground">{source && <><span className="inline-flex min-w-0 max-w-[40%] shrink-0 items-center gap-1"><span className="shrink-0">From</span><span className="min-w-0 truncate">{source}</span></span>{scheduled && <span className="shrink-0">·</span>}</>}{scheduled && <span className="flex min-w-0 items-center gap-1"><Icon name="TimeSchedule" aria-hidden className="size-3 shrink-0" /><span className="truncate">Scheduled for {new Date(row.sendAt!).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: false })}</span><span className="shrink-0 tabular-nums">· in {relative}</span></span>}</div>}</div>
          <div className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center bg-surface-raised-solid opacity-0 before:pointer-events-none before:absolute before:inset-y-0 before:right-full before:w-4 before:bg-gradient-to-r before:from-transparent before:to-surface-raised-solid before:content-[''] group-hover/dispatch-row:pointer-events-auto group-hover/dispatch-row:opacity-100 group-focus-within/dispatch-row:pointer-events-auto group-focus-within/dispatch-row:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100"><button type="button" className={action} aria-label={`Send queued message ${index + 1} now`} onClick={() => onSend(row)}><Icon name="Sent" aria-hidden className="size-4" /></button><button type="button" className={action} aria-label={`Edit queued message ${index + 1}`} onClick={() => onEdit(row)}><Icon name="Edit" aria-hidden className="size-4" /></button><button type="button" className={action} aria-label={`Change when queued message ${index + 1} sends`} onClick={() => { setLater(row.id); setDate(row.sendAt ? localInput(row.sendAt) : ''); }}><Icon name="Calendar" aria-hidden className="size-4" /></button><button type="button" className={action} aria-label={`Delete queued message ${index + 1}`} onClick={() => onDelete(row)}><Icon name="Trash2" aria-hidden className="size-4" /></button></div>
        </div>
        {retime?.row.id === row.id && <RowPopover anchor={rowNode(row.id)} label="Change send time" className="w-60" onClose={() => { setRetime(null); release(); }}>
          <p className="px-1 text-sm text-foreground">Change send time?</p>
          <div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => { setRetime(null); release(); }}>Cancel</Button>
            <div className="relative flex"><Button size="sm" autoFocus className="rounded-r-none" onClick={() => { onSchedule(row, retime.options[0]!.at); setRetime(null); }}>Yes, {clock(retime.options[0]!.at)} <span className="opacity-70">{shift(row, retime.options[0]!.at)}</span></Button>{retime.options.length > 1 && <Button size="sm" className="w-6 rounded-l-none border-l border-background/25 px-0" aria-label="Other send times" aria-haspopup="menu" aria-expanded={retimeMenu} onClick={() => setRetimeMenu(!retimeMenu)}><Icon name="ChevronDown" aria-hidden className="size-3.5" /></Button>}
              {retimeMenu && <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-44 rounded-lg border border-border bg-background p-1 shadow-lg">{retime.options.slice(1).map(option => <button key={option.minutes} type="button" role="menuitem" className="answers-hit flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover" onClick={() => { onSchedule(row, option.at); setRetime(null); }}><span>{clock(option.at)}</span><span className="text-xs text-muted-foreground">{shift(row, option.at)}</span></button>)}</div>}</div></div>
        </RowPopover>}
        {later === row.id && <RowPopover anchor={rowNode(row.id)} label="Schedule queued message" className="w-56" onClose={() => setLater(null)}><input type="datetime-local" aria-label="Send at" autoFocus className="w-full rounded-md border border-border-seam bg-transparent px-2 py-1 text-sm" value={date} onChange={event => setDate(event.target.value)} />{dateError && <p role="alert" className="text-xs text-destructive">{dateError}</p>}<div className="flex justify-end gap-1"><Button size="sm" variant="ghost" onClick={() => setLater(null)}>Cancel</Button><Button size="sm" disabled={!date} onClick={() => schedule(row)}>Schedule</Button></div></RowPopover>}
      </>}</SortableRow>;
    })}</ul></SortableContext></DndContext></div>{more && <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-gradient-to-b from-transparent to-surface-raised-solid" />}</div><div className="shrink-0"><button type="button" aria-label="Collapse queued messages" className="answers-hit -mb-3 flex min-h-[1.875rem] w-full cursor-pointer items-center justify-center rounded-none pb-3 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setCollapsed(true)}><Icon name="ChevronUp" aria-hidden className="size-3.5" /></button></div></>}
  </section>;
});
function HistoryPage({ threadId, cursor, index, depth, receive, unread = 0 }: { threadId: string; cursor?: string; index: number; depth: number; receive: (threadId: string, index: number, data: ListResult) => void; unread?: number }) {
  // The newest page only needs the unread messages and a little context above them; Load earlier fetches the rest.
  // Frozen at mount so reading (which lowers the unread count) does not refetch it.
  const [limit] = useState(() => index === 0 ? Math.min(50, Math.max(20, unread + 5)) : 50);
  const [settled, setSettled] = useState(false), [olderData, setOlderData] = useState<ListResult | null>(null);
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view: 'all', threadId, order: 'activity', limit, ...(cursor ? { cursor } : {}) }, enabled: index === 0 || !settled });
  // The first delivery skips cached data while a refetch runs, so the open position and New divider see current read state;
  // later ones pass straight through, or back-to-back refetches on a slow link would keep the conversation empty.
  const delivered = useRef(false);
  useEffect(() => { if (!result.data || (!delivered.current && result.isFetching)) return; delivered.current = true; receive(threadId, index, result.data); if (index > 0 && !settled) { setOlderData(result.data); setSettled(true); } }, [result.data, result.isFetching, threadId, index, receive, settled]);
  const page = olderData ?? result.data;
  const error = useSteadyError(result.error);
  return <>{error && <p role="alert">{error.message}<Button onClick={() => void result.refetch()}>Retry</Button></p>}{page?.nextCursor && index + 1 < depth && <HistoryPage key={page.nextCursor} {...{ threadId, depth, receive }} index={index + 1} cursor={page.nextCursor} />}</>;
}
// Recomputed groups are fresh arrays over mostly unchanged items, so rows compare their items, not the arrays.
const sameItems = (a: Item[], b: Item[]) => a === b || (a.length === b.length && a.every((item, i) => item === b[i]));
type RowProps = { group: Item[]; part?: Entry['part']; updates?: true; late?: Item[]; live: boolean; lit: boolean; reveal: string | null; isNew: boolean; settled: boolean; onJump: (id: string) => void };
const HistoryRow = memo(function HistoryRow({ group, part, updates, late, live, lit, reveal, isNew, settled, onJump }: RowProps) {
  const ids = [...group.map(member => part === 'answer' ? `${member.id}:answer` : member.id), ...(late ?? []).map(member => `${member.id}:answer`)];
  return <>{isNew && <li data-new className="border-b-0 flex items-center gap-3 py-2 text-xs font-medium text-muted-foreground"><span className="h-px flex-1 bg-border" />New<span className="h-px flex-1 bg-border" /></li>}<div data-history-ids={ids.join(' ')} data-flash={lit || undefined} className={`transition-colors duration-[1500ms] ${lit ? 'bg-state-active' : ''}`}>{updates ? <UpdateGroup items={group} reveal={reveal}>{member => <ItemCard item={member} chat autoRead={settled} seenOnly replyToOwn={false} />}</UpdateGroup> : <ItemCard item={group.at(-1)!} members={group.length > 1 ? group : undefined} part={part} late={late} live={live} onJump={onJump} chat autoRead={settled} seenOnly replyToOwn={false} />}</div></>;
}, (a, b) => sameItems(a.group, b.group) && sameItems(a.late ?? [], b.late ?? []) && a.part === b.part && a.updates === b.updates && a.live === b.live && a.lit === b.lit && a.reveal === b.reveal && a.isNew === b.isNew && a.settled === b.settled && a.onJump === b.onJump);
// The conversation history; memoised so composer typing, polls and sidebar updates in Inbox do not re-render every card.
export const History = memo(function History({ threadId, groups, flash, markId, settled, onJump }: { threadId?: string; groups: Entry[]; flash: string | null; markId: string | null; settled: boolean; onJump: (id: string) => void }) {
  // Rows the agent adds at the end once the chat has loaded slide in; earlier pages and the owner's own sends do not.
  const seen = useRef<Set<string> | null>(null), keys = groups.map(({ group, part, updates, late }) => updates ? [...group.map(member => member.id), ...(late ?? []).map(member => `${member.id}:answer`)][0]! : group.at(-1)!.id + (part === 'answer' ? ':answer' : ''));
  const animated = useRef(new Set<string>());
  const lastSeen = seen.current ? keys.reduce((at, key, i) => seen.current!.has(key) ? i : at, -1) : keys.length;
  // A switched chat mounts while the previous chat's rows are still shown; counting those as seen would slide in all of this one's.
  useEffect(() => { if (groups.length && (!threadId || groups[0]!.group[0]?.threadId === threadId)) seen.current = new Set([...(seen.current ?? []), ...keys]); });
  // The scroll bar sits inside the column's right edge; the right inset gives its width back, so both sides read 1rem.
  return <ul className="divide-y divide-border-seam pl-4 pr-[max(0px,calc(1rem-var(--scrollbar,0px)))] [&>:has(+[data-new])]:border-b-0" aria-label="History">{groups.map(({ group, part, updates, late }, i) => { const ids = [...group.map(member => part === 'answer' ? `${member.id}:answer` : member.id), ...(late ?? []).map(member => `${member.id}:answer`)], lit = flash !== null && ids.includes(flash); const row = <HistoryRow key={keys[i]} {...{ group, part, updates, late, lit, settled, onJump }} live={i === groups.length - 1} reveal={lit ? flash : null} isNew={part !== 'question' && group.some(member => member.id === markId)} />; if (i > lastSeen && group.at(-1)!.kind !== 'mine') animated.current.add(keys[i]!); return animated.current.has(keys[i]!) ? <Reveal key={keys[i]} show>{row}</Reveal> : row; })}</ul>;
});
// Compact relative time, like chat lists: now, 5m, 3h, 2d.
export const ago = (at: number) => { const m = Math.max(0, Math.floor((Date.now() - at) / 60000)); return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
export function Avatar({ id, title, provider }: { id: string; title: string | null; provider?: { id: string; displayName?: string } }) {
  let hue = 0; for (const c of id) hue = (hue * 31 + c.charCodeAt(0)) % 360;
  return <span className="relative flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white" style={{ background: `hsl(${hue} 35% 38%)` }}><span aria-hidden>{(title ?? '?').trim().charAt(0).toUpperCase() || '?'}</span>
    {/* The thread's agent provider, as a badge over the avatar's lower-right edge; the avatar's white text would hide currentColor icons. */}
    {provider && <span title={provider.displayName ?? provider.id} className="absolute -bottom-1 -right-1 flex size-4 items-center justify-center rounded-full bg-background text-foreground ring-1 ring-border"><ProviderIcon providerKind="agent" provider={provider} className="size-3" aria-label={provider.displayName ?? provider.id} /></span>}
  </span>;
}
// The page owns search state; desktop header controls portal into its toolbar.
type InboxProps = { contactsHidden?: boolean; onBulkRead?: (result: { batch: string | null; count: number }) => void; bbChat?: boolean; search?: boolean; onSearch?: (open: boolean) => void; onChat?: (open: boolean) => void; toolbarTargets?: { title: HTMLElement | null; search: HTMLElement | null; actions: HTMLElement | null } };
export function Inbox(props: InboxProps) {
  const { selected, select } = useContactSelection(), contacts = useContacts(selected);
  const [kept, setKept] = useState<string[]>([]);
  const next = selected ? [...kept.filter(id => id !== selected), selected].slice(-5) : kept;
  if (next.join('\n') !== kept.join('\n')) setKept(next);
  const grid = useRef<HTMLDivElement>(null), [contactsWidth, setContactsWidth] = useStoredState('bb-plugin-answers:page:contacts-width', CONTACTS_DEFAULT);
  const resize = (width: number) => setContactsWidth(Math.round(Math.max(CONTACTS_MIN, Math.min(CONTACTS_MAX, (grid.current?.clientWidth || Infinity) - 320, width))));
  const { contactsHidden = false, onBulkRead } = props;
  useEffect(() => { props.onChat?.(!!selected); }, [selected, props.onChat]);
  return <div ref={grid} className={`relative grid h-full grid-cols-[minmax(0,1fr)] ${contactsHidden ? '' : 'min-[640px]:grid-cols-[var(--contacts-width)_minmax(0,1fr)]'}`} style={{ '--contacts-width': `${contactsWidth}px` } as CSSProperties}>
    <div role="separator" aria-orientation="vertical" aria-label="Resize contacts" aria-valuenow={contactsWidth} aria-valuemin={CONTACTS_MIN} aria-valuemax={CONTACTS_MAX} tabIndex={0} title="Drag to resize; double-click to reset"
      className={`absolute inset-y-0 z-[3] w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-border focus-visible:bg-border focus-visible:outline-none max-[639px]:hidden ${contactsHidden ? 'min-[640px]:hidden' : ''}`} style={{ left: contactsWidth }}
      onPointerDown={event => { event.preventDefault(); const handle = event.currentTarget, left = grid.current!.getBoundingClientRect().left; handle.setPointerCapture(event.pointerId); const move = (e: PointerEvent) => resize(e.clientX - left); const up = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', up); }; handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', up); }}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resize(contactsWidth + (event.key === 'ArrowLeft' ? -16 : 16)); } }}
      onDoubleClick={() => setContactsWidth(CONTACTS_DEFAULT)} />
    <div data-contacts-column className={`flex min-h-0 min-w-0 flex-col ${contactsHidden ? 'min-[640px]:hidden' : ''} min-[640px]:border-r min-[640px]:border-border-seam ${selected ? 'max-[639px]:hidden' : ''}`}><ContactsList model={contacts} selected={selected} onSelect={select} onBulkRead={onBulkRead} /></div>
    <div className={`relative min-h-0 min-w-0 ${selected ? '' : 'max-[639px]:hidden'}`}>
      {!selected && <InboxChat {...props} contactsHidden threadId={undefined} />}
      {/* A fixed DOM order: React moves a keyed child that changes place, and a moved scroller reads scrollTop 0 until its offset is put back. */}
      {[...next].sort().map(id => <Activity key={id} mode={id === selected ? 'visible' : 'hidden'}><div inert={id !== selected} className="h-full"><KeptChat {...props} threadId={id} contactsHidden /></div></Activity>)}
    </div>
  </div>;
}
const KeptChat = memo(InboxChat);
function InboxChat({ onBulkRead, bbChat = false, search: searchProp, onSearch, toolbarTargets, threadId }: InboxProps & { threadId?: string }) {
  const rpc = useRpc<AgentHubRpcContract>(), sdk = useSdk(), { refresh } = experimental_useRpcRefresh(), panel = experimental_useAppPanel();
  const [documentVisible, setDocumentVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => { const update = () => setDocumentVisible(document.visibilityState !== 'hidden'); document.addEventListener('visibilitychange', update); return () => document.removeEventListener('visibilitychange', update); }, []);
  // This page is outside panel tabs; Activity pauses hidden chats and document visibility pauses polling.
  const visible = documentVisible;
  const sidebar = experimental_useSidebarThreads(), sidebarThreads = sidebar.threads, projects = sidebar.projects;
  const grid = useRef<HTMLDivElement>(null);
  // A plain send to a thread whose turn is running joins its queue (queue-if-active), so it shows there, not as a chat bubble.
  const willQueue = (threadId: string, options?: SendOptions) => options?.mode !== 'steer' && ['active', 'pending', 'starting', 'stopping'].includes(sidebarThreads.find(t => t.id === threadId)?.status ?? '');
  const { select: setSelected, setWorking } = useContactSelection();
  const selected = threadId;
  const contacts = useContacts(selected), { recipients, statusOf, descendants, ownWorking } = contacts;
  // Archiving or deleting the open thread (here or in bb) drops it from the sidebar; the chat closes with it.
  const seenOpen = useRef<string | null>(null);
  useEffect(() => { if (!selected) return; if (sidebarThreads.some(t => t.id === selected)) seenOpen.current = selected; else if (seenOpen.current === selected) { seenOpen.current = null; setSelected(undefined); } }, [selected, sidebarThreads]);

  // Once a thread's reply pool holds an entry, quote replies keep collecting into it (see poolFirst).
  const pools = useQuery({ contract: rpcContract, method: 'pools', input: {} });
  const [replyDraft, setReplyDraft] = useStoredState<Draft | null>('bb-plugin-answers:page:draft', null), [text, setText] = useStoredState('bb-plugin-answers:page:draft-text', ''), [files, setFiles] = useStoredState<Attachment[]>('bb-plugin-answers:page:draft-files', []), [error, setError] = useState(''), [pending, setPending] = useState(false);
  // While a quote reply is open over a message, the chat holds still: new messages and a growing composer do not scroll
  // the message (and the popup on it) away from the reader's eyes.
  const preferences = usePreferences().data;
  const [selectionBar, setSelectionBar] = useState<Draft | null>(null);
  useEffect(() => { if (preferences?.selectionActions === false) setSelectionBar(null); }, [preferences?.selectionActions]);
  const draft = selectionBar ?? replyDraft;
  const setDraft: typeof setReplyDraft = update => { if (selectionBar) setSelectionBar(update); else setReplyDraft(update); };
  const [selectionFeedback, setSelectionFeedback] = useTransientText();
  useEffect(() => setSelectionBar(null), [selected]);
  const quoting = useRef(false); quoting.current = !!draft;
  // The quote popup's live selection and the spot it was last placed from it; the popup follows it as the chat changes.
  const anchor = useRef<Range | null>(null), placed = useRef<{ top: number; above: number; left: number } | null>(null);
  const scroll = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), selectedRef = useRef(selected); selectedRef.current = selected;
  const [transcriptOf, setTranscriptOf] = useState<string | null>(null), transcriptScroll = useRef(0);
  const transcript = !!selected && transcriptOf === selected;
  const openTranscript = useCallback(() => { if (selected) { release(); transcriptScroll.current = scroll.current?.scrollTop ?? 0; setTranscriptOf(selected); } }, [selected]);
  const closeTranscript = () => { setTranscriptOf(null); requestAnimationFrame(() => { if (scroll.current) scroll.current.scrollTop = transcriptScroll.current; }); };

  // Where the reader was in the open conversation, so leaving the screen and coming back keeps the place.
  const restore = useRef(useState(() => { const saved = selected ? readScrolls()[selected] : undefined; return saved && selected ? { threadId: selected, ...saved } : null; })[0]);
  const [depth, setDepth] = useState(() => restore.current && restore.current.threadId === selected ? restore.current.depth : 1), [loaded, setLoaded] = useState<{ threadId?: string; pages: ListResult[] }>({ pages: [] });
  // The previous conversation stays on screen until the new one's first page arrives, then both swap in one frame.
  const [historyWindow, setHistoryWindow] = useState<{threadId:string; page:ListResult} | null>(null), [windowLoading, setWindowLoading] = useState(false);
  const activeWindow = historyWindow?.threadId === selected ? historyWindow : null;
  const windowRequest = useRef(0), jumpOffset = useRef<number | null>(null);
  const loadedPages = useMemo(() => unbroken(loaded.pages), [loaded.pages]), pages = useMemo(() => activeWindow ? [{...activeWindow.page, items: activeWindow.page.newerCursor ? activeWindow.page.items : [...loadedPages.flatMap(p => p.items), ...activeWindow.page.items]}] : loaded.threadId === selected ? loadedPages : NO_PAGES, [activeWindow, loaded.threadId, selected, loadedPages]);
  const [optimistic, setOptimistic] = useState<{ threadId: string; text: string; id: number; seenIds: string[]; steer?: boolean }[]>([]), [queue, setQueue] = useState<Awaited<ReturnType<typeof sdk.threads.queuedMessages.list>>>([]), [queueOf, setQueueOf] = useState<string | null>(null), [queueError, setQueueError] = useState(''), [queueVersion, setQueueVersion] = useState(0), [context, setContext] = useState<{ threadId: string; usage: ContextUsage } | null>(null), contexts = useRef(new Map<string, { usage: ContextUsage; at: number }>());

  const pluginBrands = usePluginBrands(queue.some(row => !!row.originPluginId || row.waitingOn?.kind === 'plugin'));
  // Why a queued message is held, worded and iconed as bb's own queue does (a plain wait behind the running turn, or a
  // schedule already shown as such, says nothing).
  const queueWait = (row: QueueRow): { icon: ReactNode; text: string } | null => {
    const on = row.waitingOn, icon = (name: IconName) => <Icon name={name} aria-hidden className="size-3 shrink-0" />;
    if (row.failureReason) return { icon: icon('AlertCircle'), text: row.failureReason };
    if (!on) return null;
    switch (on.kind) {
      case 'plugin': { const brand = pluginBrands.find(b => b.id === on.pluginId); return { icon: brand ? <PluginIcon pluginId={brand.id} icon={brand.icon} className="size-3 shrink-0" /> : icon('Puzzle'), text: `Held by ${brand?.name ?? on.pluginId} · ${on.reason}` }; }
      case 'turn-starting': return { icon: icon('TimeSchedule'), text: 'Waiting for turn to start' };
      case 'stopping': return { icon: icon('TimeSchedule'), text: 'Sending when the thread stops' };
      case 'provisioning': return { icon: icon('Folder'), text: 'Waiting for workspace' };
      case 'host-offline': return { icon: icon('CloudOff'), text: `Waiting for ${on.hostName} to be ready` };
      case 'interaction': return { icon: icon('CircleQuestion'), text: 'Waiting for your reply' };
      case 'app-update': return { icon: icon('Download'), text: 'Sending after bb restarts to update' };
      case 'superseded': return { icon: icon('AlertCircle'), text: 'Superseded' };
      default: return null;
    }
  };
  const [compose, setCompose] = useState<ComposeDraft>(() => selected ? composeDrafts()[selected] ?? { text: '', files: [] } : { text: '', files: [] }), [composeError, setComposeError] = useState(''), [composePending, setComposePending] = useState(false), [ownSearch, setOwnSearch] = useState(false), [query, setQuery] = useState(''), [matches, setMatches] = useState<Item[]>([]), [searchError, setSearchError] = useState(''), [jump, setJump] = useState<string | null>(null), [older, setOlder] = useState(false), [flash, setFlash] = useState<string | null>(null);
  const search = searchProp ?? ownSearch, setSearch = onSearch ?? setOwnSearch;

  const [drafts] = useState(composeDrafts), draftTimer = useRef<ReturnType<typeof setTimeout>>(undefined), scrollTimer = useRef<ReturnType<typeof setTimeout>>(undefined), scrollPending = useRef<({ threadId: string } & Scroll) | null>(null);
  // Empty drafts are dropped and only the 50 most recently edited threads kept (key order is edit order, see updateCompose).
  const saveDrafts = () => { clearTimeout(draftTimer.current); const current = composeDrafts(); if (selected) { if (drafts[selected]) current[selected] = drafts[selected]; else delete current[selected]; } const ids = Object.keys(current), kept = ids.filter(id => current[id]?.text.trim() || current[id]?.files.length || current[id]?.execution).slice(-50); for (const id of ids) if (!kept.includes(id)) delete current[id]; try { localStorage.setItem(COMPOSE_KEY, JSON.stringify(current)); window.dispatchEvent(new Event(DRAFTS_EVENT)); } catch { /* storage unavailable */ } };
  const saveScroll = () => { clearTimeout(scrollTimer.current); scrollTimer.current = undefined; if (scrollPending.current) { const { threadId, ...at } = scrollPending.current, all = readScrolls(); delete all[threadId]; all[threadId] = at; try { localStorage.setItem(SCROLL_KEY, JSON.stringify(Object.fromEntries(Object.entries(all).slice(-50)))); } catch { /* storage unavailable */ } scrollPending.current = null; } };
  useEffect(() => { saveDrafts(); return () => { saveDrafts(); saveScroll(); }; }, []);
  // A jump still looking for its message belongs to the chat it was asked in.

  useEffect(() => {
    if (!selected || !search || !query.trim()) { setMatches([]); setSearchError(''); return; }
    let active = true; const timer = setTimeout(() => { void rpc.call('list', { view: 'all', threadId: selected, query: query.trim(), limit: 20 }).then(data => { if (active) { setMatches(data.items); setSearchError(''); } }).catch(e => { if (active) setSearchError(errorText(e)); }); }, 200);
    return () => { active = false; clearTimeout(timer); };
  }, [selected, search, query, rpc]);
  const jumpTo = useCallback((token: string, offset?: number) => {
    if (!selected) return;
    const request = ++windowRequest.current; jumpOffset.current = offset ?? null;
    release(); position.current.bottom = false; position.current.fresh = false; setOlder(false);
    if (scroll.current?.querySelector(`[data-history-ids~="${CSS.escape(token)}"]`)) { setJump(token); return; }
    const seq = token.startsWith('seq:') ? Number(token.slice(4)) : undefined;
    const existing = pages.flatMap(p => p.items).find(item => item.id === token || (seq !== undefined && [item.questionSeq,item.answerSeq,item.interimSeq,item.candidateSeq].includes(seq)));
    if (existing) { setJump(existing.id); return; }
    setWindowLoading(true);
    void (async () => {
      if (seq !== undefined) await sdk.threads.message({threadId:selected,seq,before:0,after:0});
      const page = await rpc.call('list', {view:'all',threadId:selected,order:'activity',limit:20,anchor:seq ?? token.replace(/:answer$/, '')});
      if (windowRequest.current !== request) return;
      if (!page.items.length) { setOlder(true); return; }
      setHistoryWindow({threadId:selected,page}); setJump(token.endsWith(':answer') ? token : page.items[0]!.id);
    })().catch(e => { if (windowRequest.current === request) { setOlder(true); setSearchError(errorText(e)); } }).finally(() => { if (windowRequest.current === request) setWindowLoading(false); });
  }, [selected,pages,rpc,sdk]);
  const loadWindow = async (newer: boolean) => {
    if (!activeWindow || windowLoading || !selected) return;
    const cursor = newer ? activeWindow.page.newerCursor : activeWindow.page.nextCursor;
    if (!cursor) return;
    const request = ++windowRequest.current; setWindowLoading(true);
    try {
      const page = await rpc.call('list', {view:'all',threadId:selected,order:'activity',limit:50,...(newer ? {after:cursor} : {cursor})});
      if (windowRequest.current !== request) return;
      position.current.prepend = !newer;
      setHistoryWindow({threadId:selected,page:{items:newer ? [...page.items,...activeWindow.page.items] : [...activeWindow.page.items,...page.items],nextCursor:newer ? activeWindow.page.nextCursor : page.nextCursor,newerCursor:newer ? page.newerCursor : activeWindow.page.newerCursor}});
    } catch(e) { setSearchError(errorText(e)); } finally { if (windowRequest.current === request) setWindowLoading(false); }
  };
  const initialJump = useRef<string | null>(null), permalink = useRef(new URLSearchParams(window.location.search).get('msg'));
  useEffect(() => {
    if (!selected || !pages.length || initialJump.current === selected) return;
    initialJump.current = selected;
    const seq = takeJump(selected)?.toString() ?? permalink.current, saved = restore.current?.threadId === selected ? restore.current.anchor : null;
    permalink.current = null;
    if (seq && /^\d+$/.test(seq)) jumpTo(`seq:${seq}`); else if (saved && !pages.some(p => p.items.some(item => item.id === saved))) jumpTo(saved, restore.current?.offset);
  }, [selected,pages,jumpTo]);
  // A message link clicked while its chat is already open and loaded jumps at once; otherwise the effect above takes it.
  useEffect(() => {
    const jump = () => { const seq = selected && pages.length && initialJump.current === selected ? takeJump(selected) : null; if (seq !== null) jumpTo(`seq:${seq}`); };
    window.addEventListener(JUMP_EVENT, jump); return () => window.removeEventListener(JUMP_EVENT, jump);
  }, [selected,pages,jumpTo]);
  const receive = useRef((threadId: string, index: number, data: ListResult) => setLoaded(old => receivePage(old, threadId, index, data))).current;
  // fresh: just opened, start at the top; prepend: Load earlier grew the top, keep the reader's place.
  const position = useRef({ height: 0, top: 0, bottom: false, fresh: true, prepend: false, shown: 0 });
  // First unread message when the conversation opened; it keeps its divider after the thread is marked read.
  const mark = useRef<string | null>(null);
  // Where the open landed (the New divider, or null for the newest); held while messages above finish rendering and grow.
  const pin = useRef<{ target: HTMLElement | null; selector?: string; until: number; offset?: number } | null>(null);
  // Reads count only once the open position settled: while messages above grow, the list briefly jumps past unread ones.
  const [settled, setSettled] = useState(false), settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const release = () => { clearTimeout(settle.current); pin.current = null; setSettled(true); };
  // Re-inserting moves an edited thread to the end, so key order is edit order for saveDrafts.
  function updateCompose(threadId: string, value: ComposeDraft) { delete drafts[threadId]; drafts[threadId] = value; clearTimeout(draftTimer.current); draftTimer.current = setTimeout(saveDrafts, 300); if (threadId === selectedRef.current) setCompose(value); }
  const recall = useRef<{threadId:string; index:number; draft:ComposeDraft; entries:HistoryInput[]; loading:boolean} | null>(null);
  function recallPrompt(direction: 'up' | 'down') {
    if (!selected) return false;
    let state=recall.current;
    if (!state || state.threadId!==selected) {
      if (direction!=='up' || compose.text) return false;
      state={threadId:selected,index:-1,draft:compose,entries:[],loading:true}; recall.current=state;
      const pending=state;
      void sdk.threads.promptHistory({threadId:selected,limit:'100'}).then(rows => {
        if(recall.current!==pending || selectedRef.current!==pending.threadId) return;
        pending.entries=rows.map(row=>row.input); pending.loading=false; showPrompt(pending,0);
      }).catch(e=>{ if(recall.current===pending) { recall.current=null; setComposeError(errorText(e)); } });
      return true;
    }
    if(state.loading) return true;
    showPrompt(state,state.index+(direction==='up'?1:-1)); return true;
  }
  function showPrompt(state: NonNullable<typeof recall.current>, index:number) {
    if(index<0) { updateCompose(state.threadId,state.draft); recall.current=null; return; }
    const input=state.entries[index]; if(!input) return; state.index=index;
    const text=input.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    const files:Attachment[]=input.flatMap<Attachment>(part=>part.type==='localFile'? [{...part,name:part.name ?? part.path.split('/').at(-1)!}] : part.type==='localImage' ? [{...part,name:part.path.split('/').at(-1)!}] : []);
    updateCompose(state.threadId,{...state.draft,text,files,historyInput:input});
  }
  useEffect(() => {
    const root=grid.current; if(!root || !selected) return;
    return bindChatCommands(root,{
      focus:()=>root.querySelector<HTMLElement>('[aria-label="Send message"][role="textbox"]')?.focus(),
      search:()=>setSearch(true),
      actions:()=>(toolbarTargets?.actions ?? root).querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')?.click(),
    });
  },[selected,toolbarTargets]);
  const toInput = (draft: ComposeDraft) => draft.historyInput ?? [...(draft.text.trim() ? [{ type: 'text' as const, mentions: mentionsForText(draft.text, id => { const thread = sidebarThreads.find(t => t.id === id); return thread ? { label: thread.displayTitle, projectId: thread.projectId } : undefined; }), text: draft.text }] : []), ...draft.files.map(f => f.type === 'localImage' ? { type: 'localImage' as const, path: f.path, ...(f.sourceProjectId ? { sourceProjectId: f.sourceProjectId } : {}) } : { type: 'localFile' as const, path: f.path, name: f.name, ...(f.mimeType ? { mimeType: f.mimeType } : {}), ...(f.sizeBytes ? { sizeBytes: f.sizeBytes } : {}), ...(f.sourceProjectId ? { sourceProjectId: f.sourceProjectId } : {}) })];
  // Editing a sent message, as in bb: the thread rewinds to before it and runs again with the new text (threads.editMessage).
  const [sentEdit, setSentEdit] = useState<ComposeDraft & { threadId: string; seq: number } | null>(null), [editPending, setEditPending] = useState(false);
  const editing = sentEdit?.threadId === selected ? sentEdit : null;
  const startSentEdit = useCallback((item: Item) => { setComposeError(''); setSentEdit({ threadId: item.threadId, seq: item.questionSeq!, text: item.question, files: item.attachments.map(a => ({ type: a.type, path: a.path, name: a.name ?? a.path.split('/').pop() ?? a.path, ...(a.mimeType ? { mimeType: a.mimeType } : {}), ...(a.sizeBytes ? { sizeBytes: a.sizeBytes } : {}), ...(a.sourceProjectId ? { sourceProjectId: a.sourceProjectId } : {}) })) }); }, []);
  async function submitSentEdit() {
    const edit = editing;
    if (!edit || editPending || (!edit.text.trim() && !edit.files.length)) return;
    setEditPending(true); setComposeError('');
    try { await sdk.threads.editMessage({ threadId: edit.threadId, operationId: crypto.randomUUID(), expectedRequestSequence: edit.seq, input: toInput(edit) }); setSentEdit(current => current === edit ? null : current); refresh(); }
    catch (e) { setComposeError(errorText(e)); }
    finally { setEditPending(false); }
  }
  async function poolCompose() {
    if (!selected || composePending || (!compose.text.trim() && !compose.files.length)) return;
    const threadId = selected, sent = compose;
    setComposePending(true); setComposeError('');
    try {
      await rpc.call('poolAdd', { threadId, quote: '', note: sent.text, attachments: sent.files });
      const cleared = { ...sent, text: '', files: [], historyInput: undefined };
      if (JSON.stringify(drafts[threadId]) === JSON.stringify(sent)) { drafts[threadId] = cleared; saveDrafts(); }
      if (selectedRef.current === threadId) setCompose(current => JSON.stringify(current) === JSON.stringify(sent) ? cleared : current);
      panel.openTab({ tab: poolsTab });
    } catch (e) { if (selectedRef.current === threadId) setComposeError(errorText(e)); }
    finally { setComposePending(false); }
  }
  async function sendCompose(options?: SendOptions) {
    if (!selected || composePending || (!compose.text.trim() && !compose.files.length)) return;
    const threadId = selected, sent = compose;
    setComposePending(true); setComposeError('');
    const optimisticId = Date.now() + Math.random(), showBubble = !handoff && options?.mode !== 'draft' && !options?.sendAt && !!sent.text.trim() && !willQueue(threadId, options);
    if (showBubble) setOptimistic(old => [...old, { threadId, text: sent.text.trim(), id: optimisticId, seenIds: pages.flatMap(page => page.items.map(item => item.id)), steer: options?.mode === 'steer' }]);
    try {
      const input = toInput(sent);
      let result: Awaited<ReturnType<typeof sdk.threads.send>> | undefined;
      let newThreadId: string | undefined;
      if (handoff && composeExecution) {
        if (!openThread?.projectId || !openThread.environment?.id) throw new Error('The source thread environment is unavailable. Open the native chat to hand off.');
        const token=`@thread:${threadId}`, prefix=`Continue from ${token}\n\n`;
        const first=input[0]?.type==='text' ? input[0] : undefined;
        const handoffInput: HistoryInput=[{ type:'text', text:prefix+(first?.text ?? ''), mentions:[{start:14,end:14+token.length,resource:{kind:'thread',threadId,projectId:openThread.projectId,label:openThread.displayTitle ?? openThread.title ?? 'Untitled thread'}}, ...(first?.mentions ?? []).map(mention=>({...mention,start:mention.start+prefix.length,end:mention.end+prefix.length}))] }, ...input.slice(first ? 1 : 0)];
        const created=await sdk.threads.spawn({ projectId:openThread.projectId, environment:{type:'reuse',environmentId:openThread.environment.id}, ...composeExecution, ...(composePermission ? {permissionMode:composePermission} : {}), input:handoffInput, ...(options?.sendAt ? {sendAt:options.sendAt} : {}), ...(options?.mode==='draft' ? {pluginSubmission:{pluginId:'agent-hub',data:{kind:'draft'}}} : {}) });
        newThreadId=created.id;
      } else result = await sdk.threads.send({ threadId, ...(composePermission ? { permissionMode: composePermission } : {}), ...(composeExecution ? { model: composeExecution.model, reasoningLevel: composeExecution.reasoningLevel, serviceTier: composeExecution.serviceTier } : {}), mode: options?.mode === 'steer' ? 'steer-if-active' : 'queue-if-active', input, ...(options?.sendAt ? { sendAt: options.sendAt } : {}), ...(options?.mode === 'draft' ? { pluginSubmission: { pluginId: 'agent-hub', data: { kind: 'draft' } } } : {}) });
      // A queued message lives in the queue card until bb delivers it, as in bb's own chat; a bubble would show it twice.
      if (result?.ok && result.delivery === 'queued') { setOptimistic(old => old.filter(b => b.id !== optimisticId)); setQueueVersion(n => n + 1); }
      const cleared:ComposeDraft={text:'',files:[],...(handoff ? {} : sent.execution ? {execution:sent.execution} : {}),...(sent.permissionMode ? {permissionMode:sent.permissionMode} : {})};
      if (JSON.stringify(drafts[threadId]) === JSON.stringify(sent)) { drafts[threadId] = cleared; saveDrafts(); }
      if (selectedRef.current === threadId) setCompose(current => JSON.stringify(current) === JSON.stringify(sent) ? cleared : current);
      setQueueVersion(n => n + 1); refresh();
      if(newThreadId) setSelected(newThreadId);
    } catch (e) { setOptimistic(old => old.filter(b => b.id !== optimisticId)); if (selectedRef.current === threadId) setComposeError(deliveryError(e)); }
    finally { setComposePending(false); }
  }
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => { if (!optimistic.length) return; const timer = setTimeout(() => setOptimistic(old => old.filter(b => Date.now() - b.id < 30000)), 30000); return () => clearTimeout(timer); }, [optimistic]);
  // The server bumps this stamp on bb's queue events, so rows queued from bb's chat or by agents show up at once.
  const queueStamp = useQuery({ contract: rpcContract, method: 'queueStamp', input: { threadId: selected ?? 'thr_none' }, enabled: !!selected }).data?.stamp;
  useEffect(() => { if (!selected || !visible) return; let active = true; void sdk.threads.queuedMessages.list({ threadId: selected }).then(rows => { if (active) { setQueue(old => { const gone = old.filter(row => row.threadId === selected && landsInChat(row) && !rows.some(next => next.id === row.id) && !dropped.current.has(row.id)); if (gone.length) setLeaving(current => [...current.filter(l => !gone.some(g => g.id === l.row.id)), ...gone.map(row => ({ row, at: Date.now() }))]); return rows; }); setQueueOf(selected); setQueueError(''); } }).catch(e => { if (active) setQueueError(errorText(e)); }); return () => { active = false; }; }, [sdk, selected, visible, queueVersion, queueStamp, sidebarThreads.find(t => t.id === selected)?.queuedWork]);
  // A scheduled row needs the 5 s tick (its due time and "in Nm" label); other rows only change when bb's chat sends or
  // deletes them, which queuedWork may not reflect, so they get a slow 30 s check.
  const scheduledQueue = queue.some(row => !!row.sendAt && row.sendAt > Date.now());
  useEffect(() => { if (!selected || !visible || !queue.length) return; const timer = setInterval(() => setQueueVersion(n => n + 1), scheduledQueue ? 5000 : 30000); return () => clearInterval(timer); }, [selected, visible, queue.length > 0, scheduledQueue]);
  const openThread = sidebarThreads.find(t => t.id === selected);
  const current = recipients?.recipients.find(r => r.threadId === selected) ?? { threadTitle: openThread?.title ?? pages.flatMap(page => page.items).find(item => item.threadId === selected)?.threadTitle, projectId: openThread?.projectId, projectName: projects.find(p => p.id === openThread?.projectId)?.name, unread: 0 };
  const working = openThread ? statusOf(openThread).isWorking : false;
  // bb's composer offers Stop only while the chat's own turn runs; background commands, workflows and sub-threads keep the robot, not the button.
  const turnRunning = ['active', 'provisioning', 'starting', 'stopping', 'waiting-for-host'].includes(openThread?.runtimeStatus ?? '');
  const cost = useThreadCost(selected, working);
  useEffect(() => setWorking(working), [selected, working]);
  // What the agent does right now picks the robot's scene (thinking, typing, terminal, fixing, searching, reading, waiting).
  // Its turn over while sub-sessions still run, the agent is waiting on them, not resting.
  const agent = useAgentActivity(selected, working, visible), waitingOnSubs = agent.activity === 'rest' && !!openThread && descendants(openThread.id).some(ownWorking), activity = waitingOnSubs ? 'wait' : agent.activity, activityLabel = waitingOnSubs ? 'Waiting for subagents' : agent.label;
  // The model of the open chat, as bb's composer shows it: the thread keeps none, each turn request carries its execution.
  const [execution, setExecution] = useState<{ threadId: string; value: ExperimentalProviderModelPickerValue } | null>(null);
  const [permission, setPermission] = useState<{ threadId: string; value: ExperimentalPermissionModePickerProps['value'] } | null>(null);
  const composePermission = compose.permissionMode ?? (permission?.threadId === selected ? permission?.value : undefined);
  const routing = openThread?.environment?.id ? { kind: 'environment' as const, environmentId: openThread.environment.id } : openThread?.host?.id ? { kind: 'host' as const, hostId: openThread.host.id } : undefined;
  useEffect(() => {
    if (!selected) return; let live = true;
    void Promise.resolve().then(() => sdk.threads.defaultExecutionOptions({ threadId: selected })).then(value => { if (live) setPermission(value ? { threadId: selected, value: value.permissionMode } : null); }).catch(() => { if (live) setPermission(null); });
    return () => { live = false; };
  }, [sdk, selected, working]);
  const composeExecution = compose.execution ?? (execution?.threadId === selected ? execution?.value : undefined);
  const handoff = !!composeExecution && !!openThread && composeExecution.providerId !== openThread.providerId;
  useEffect(() => {
    const providerId = openThread?.providerId; if (!selected || !providerId) return; let live = true;
    void Promise.resolve().then(() => sdk.threads.events.list({ threadId: selected, order: 'desc', limit: '1', types: ['client/turn/requested'] })).then(async rows => {
      const run = (rows[0] as { data?: { execution?: { model?: string; reasoningLevel?: string; serviceTier?: string } } } | undefined)?.data?.execution;
      let value: ExperimentalProviderModelPickerValue | undefined = run?.model ? { providerId, model: run.model, reasoningLevel: run.reasoningLevel as ExperimentalProviderModelPickerValue['reasoningLevel'], ...(run.serviceTier ? { serviceTier: run.serviceTier as ExperimentalProviderModelPickerValue['serviceTier'] } : {}) } : undefined;
      if (!value) {
        const catalog = await sdk.providers.models({ providerId, ...(openThread?.environment?.id ? { environmentId: openThread.environment.id } : openThread?.host?.id ? { hostId: openThread.host!.id } : {}) });
        const model = catalog.models.find(model => model.isDefault) ?? catalog.models[0];
        if (model) value = { providerId, model: model.model, reasoningLevel: model.defaultReasoningEffort as ExperimentalProviderModelPickerValue['reasoningLevel'] };
      }
      if (live) setExecution(value ? { threadId: selected, value } : null);
    }).catch(() => {});
    return () => { live = false; };
  }, [sdk, selected, openThread?.providerId, openThread?.environment?.id, openThread?.host?.id, working]);
  // A read that fails, or comes back without a usage (mid-turn, while compacting), keeps the thread's last ring instead of
  // dropping it; each thread shows only its own ring, the last one known at once on return.
  // bb's context-usage events (through the server's stamp) and turn changes trigger the reread; no timer.
  const contextStamps = useQuery({ contract: rpcContract, method: 'contextStamp', input: { threadId: selected ?? 'thr_none' }, enabled: !!selected }).data, contextStamp = contextStamps?.stamp, compactedAt = contextStamps?.compactedAt ?? null;
  useEffect(() => { if (!selected) { setContext(null); return; } const known = contexts.current.get(selected); setContext(known ? { threadId: selected, usage: known.usage } : null); if (!visible) return; let active = true;
    const keep = (usage: ContextUsage, at: number) => { contexts.current.set(selected, { usage, at }); setContext({ threadId: selected, usage }); };
    // After a compaction bb may report no usage (or only a breakdown) until the next turn, or the last one from before it;
    // the ring then winds down to 0 on the window it had, and the next real reading takes over.
    const read = () => { void sdk.threads.context({ threadId: selected }).then(value => {
      if (!active) return;
      const usage = value?.usage, valid = !!usage && usage.modelContextWindow > 0 && Number.isFinite(usage.usedTokens), last = contexts.current.get(selected);
      const compacted = compactedAt !== null && !!last && compactedAt > last.at && (!valid || usage!.usedTokens === last.usage.usedTokens);
      if (compacted) keep({ ...last!.usage, usedTokens: 0, snapshot: undefined }, compactedAt!);
      else if (valid) keep(usage!, Date.now());
    }).catch(() => {}); };
    read(); return () => { active = false; }; }, [sdk, selected, visible, working, contextStamp, compactedAt]);
  // Every action rereads the queue, failed ones too: a row bb already sent or deleted answers 404 and must leave the card.
  // Deleting such a row already got what the owner wanted, so that 404 is not an error.
  async function queueAction(action: () => Promise<unknown>, goneIsDone = false) { try { await action(); } catch (e) { if (!(goneIsDone && (e as { status?: number }).status === 404)) setQueueError(errorText(e)); } finally { setQueueVersion(n => n + 1); } }
  const [queueEdit, setQueueEdit] = useState<QueueEdit | null>(null);
  const editHold = useRef<{ threadId: string; queuedMessageId: string } | null>(null), editLease = useRef(120000);
  const releaseEditHold = async () => { const target = editHold.current; editHold.current = null; if (target) await sdk.threads.queuedMessages.experimental_releaseEditHold(target); };
  useEffect(() => () => { void releaseEditHold(); }, [selected]);
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
  // A failed send's error belongs to its chat.
  useEffect(() => setComposeError(''), [selected]);
  const queueText = (row: typeof queue[number]) => row.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
  // A queued message bb has just delivered stays in the queue card until the chat shows it as a recorded message (a
  // matching owner message with its turn sequence), then both swap at once: no gap, no half-built card. Rows the owner
  // deleted leave at once; a row whose message never shows up leaves after 20 s.
  const [leaving, setLeaving] = useState<{ row: typeof queue[number]; at: number }[]>([]), dropped = useRef(new Set<string>());
  const leavingText = (entry: { row: typeof queue[number] }) => queueText(entry.row).trim();
  // The recorded message may spell a mention or line break differently from its queued row, so both compare without them.
  const sameSent = (a: string, b: string) => { const plain = (text: string) => text.replace(/@thread:thr_[A-Za-z0-9_-]+(?:#msg=\d+)?/g, ' ').replace(/\s+/g, ' ').trim(); return plain(a) === plain(b); };
  const landed = (entry: { row: typeof queue[number] }, list: Item[]) => list.some(item => item.kind === 'mine' && item.threadId === entry.row.threadId && item.questionSeq !== null && sameSent(item.question, leavingText(entry)));
  // Send now (a steer into a running turn, or a scheduled row sent early) answers at once like the composer: the row
  // leaves the queue and the chat shows the message while bb records it. If bb keeps it queued or refuses, it comes back.
  const [sentNow, setSentNow] = useState<string[]>([]);
  async function sendQueued(row: typeof queue[number]) {
    const text = queueText(row).trim(), optimisticId = Date.now() + Math.random();
    dropped.current.add(row.id); setSentNow(old => [...old, row.id]);
    if (text) setOptimistic(old => [...old, { threadId: row.threadId, text, id: optimisticId, seenIds: pages.flatMap(page => page.items.map(item => item.id)) }]);
    const restore = () => { dropped.current.delete(row.id); setSentNow(old => old.filter(id => id !== row.id)); setOptimistic(old => old.filter(b => b.id !== optimisticId)); };
    // A 404 means bb already sent or deleted the row: it stays out of the queue, and the chat shows what bb recorded.
    await queueAction(async () => { try { const result = await sdk.threads.queuedMessages.send({ threadId: row.threadId, queuedMessageId: row.id, mode: 'auto' }); if (result.delivery === 'queued') restore(); } catch (e) { if ((e as { status?: number }).status === 404) setOptimistic(old => old.filter(b => b.id !== optimisticId)); else restore(); throw e; } }, true);
  }
  useEffect(() => { if (!leaving.length) return; const timer = setTimeout(() => setLeaving(current => current.filter(entry => Date.now() - entry.at < 20000)), 20000); return () => clearTimeout(timer); }, [leaving]);
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
  useEffect(() => { if (!jump || !pages.length) return; const node = scroll.current, card = node?.querySelector<HTMLElement>(`[data-history-ids~="${jump}"]`); if (card && node) { release(); const header = node.querySelector<HTMLElement>('[data-conversation-header]')?.offsetHeight ?? 0; node.scrollTop += card.getBoundingClientRect().top - node.getBoundingClientRect().top - (jumpOffset.current ?? header); jumpOffset.current = null; setFlash(jump); setTimeout(() => setFlash(current => current === jump ? null : current), 1500); setJump(null); setOlder(false); } else { setOlder(true); setJump(null); } }, [jump, pages]);
  useLayoutEffect(() => {
    const node = scroll.current; if (!node || !pages.length) return;
    const old = position.current, shownPages = Math.min(pages.length, depth);
    if (old.fresh) {
      const saved = restore.current?.threadId === selected ? restore.current : null, keep = saved?.bottom ? null : saved;
      if (keep && pages.length < depth && pages.at(-1)?.nextCursor) return; // wait for the remembered pages
      // Open where the reader left off when they left scrolled up (the New divider still marks what came since, and Scroll to
      // latest is offered); otherwise at the newest message, with Jump to unread offered for the rows above it.
      const anchor = keep?.anchor ? node.querySelector<HTMLElement>(`[data-history-ids~="${CSS.escape(keep.anchor)}"]`) : null;
      node.scrollTop = anchor ? node.scrollTop + anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - (keep!.offset ?? 0) : keep ? keep.top : node.scrollHeight; restore.current = null;
      // Hold the place while the conversation finishes rendering: the remembered message, or the newest.
      pin.current = !keep ? { target: null, until: Date.now() + 3000 } : anchor ? { target: anchor, selector: rowOf(keep!.anchor!), offset: keep!.offset ?? 0, until: Date.now() + 3000 } : null;
      clearTimeout(settle.current); settle.current = setTimeout(release, pin.current ? 3000 : 0);
    // Older pages render above, so one more shown page (Load earlier, or the reach back over quiet updates) grew the top: keep the place.
    } else if (old.prepend || shownPages > old.shown) node.scrollTop = old.top + node.scrollHeight - old.height;
    // While a quote popup is open (anchored in the chat) nothing follows new messages: the owner is writing about this spot.
    else if (old.bottom && !quoting.current) node.scrollTop = followTo(node.scrollTop, node.scrollHeight, node.clientHeight, old.height, covered(node));
    position.current = { height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM, fresh: false, prepend: false, shown: shownPages };
  }, [pages, depth]);
  useEffect(() => {
    const node = scroll.current, list = node?.querySelector('[aria-label=History]');
    if (!node || !list) return;
    const hold = () => {
      const held = pin.current; if (!held || Date.now() > held.until) { if (held) release(); return; }
      const header = node.querySelector<HTMLElement>('.sticky')?.offsetHeight ?? 0;
      const target = held.selector ? live(node, held.target, held.selector) : null;
      if (held.selector && !target) return;
      node.scrollTop = target ? node.scrollTop + target.getBoundingClientRect().top - node.getBoundingClientRect().top - (held.offset ?? header) : node.scrollHeight;
    };
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(hold); observer?.observe(list);
    for (const name of events) node.addEventListener(name, release, { passive: true });
    return () => { observer?.disconnect(); for (const name of events) node.removeEventListener(name, release); };
  }, [selected]);
  // As in bb's chat the conversation scrolls under the composer to the bottom of the window: the composer stack floats over
  // its end, and the column's bottom padding follows the stack's height, so a growing stack still pushes the chat up. The stack stops short of the scrollbar.
  const stack = useRef<HTMLDivElement>(null), [scrollbar, setScrollbar] = useState(0);
  const covered = (node: HTMLElement) => (node.querySelector<HTMLElement>('[data-conversation-header]')?.offsetHeight ?? 0) + (stack.current?.offsetHeight ?? 0) + 24;
  // Scrolled up past the last message (its top below the composer stack): offer bb's "Scroll to latest" button.
  // Scroll events come every frame while the window or a sidebar resizes the chat, and any geometry read in one forces a
  // layout of the whole conversation at a size about to change. So the chat's scroll handler reads once a frame, the saved
  // anchor once scrolling settles, and the other scroll listeners skip a resize (its own observer keeps them right).
  const [farFromEnd, setFarFromEnd] = useState(false), [unreadAbove, setUnreadAbove] = useState(false), latestFrame = useRef(0), resizedAt = useRef(0);
  // Already at the very end, the newest is in view whatever the last row's geometry says (a stack still settling).
  const checkLatest = () => { const node = scroll.current, last = node?.querySelector('[aria-label=History]')?.lastElementChild; setFarFromEnd(!!node && !!last && node.scrollHeight - node.scrollTop - node.clientHeight > AT_BOTTOM + 1 && last.getBoundingClientRect().top > node.getBoundingClientRect().bottom - (stack.current?.offsetHeight ?? 0));
    // The first unread row's New divider is out of sight above (under the header or further up).
    const divider = node?.querySelector<HTMLElement>('[aria-label=History] [data-new]'); setUnreadAbove(!!node && !!divider && node.clientHeight > 0 && divider.getBoundingClientRect().bottom <= node.getBoundingClientRect().top + (node.querySelector<HTMLElement>('.sticky')?.offsetHeight ?? 0)); };
  useEffect(() => { const frame = requestAnimationFrame(checkLatest); return () => cancelAnimationFrame(frame); }, [selected, pages]);
  // The scroll handler skips resizes, so content growing or settling (a streamed reply, a card sliding in) rechecks here.
  useEffect(() => {
    const list = scroll.current?.querySelector('[aria-label=History]'); if (!list || typeof ResizeObserver === 'undefined') return;
    let frame = 0; const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(checkLatest); }); observer.observe(list);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [selected, pages.length > 0]);
  useEffect(() => {
    const node = scroll.current, box = stack.current; if (!node || !box || typeof ResizeObserver === 'undefined') return;
    // A reader at the bottom stays there as the stack grows or shrinks; one scrolled up even a little keeps their place.
    const fit = () => {
      if (!node.clientHeight) return; // hidden: every size reads 0
      const column = node.querySelector<HTMLElement>('[data-chat-column]');
      if (column) {
        // Shrinking the padding by more than the reader is scrolled up would make the browser clamp the scroll and move the
        // chat, so above the bottom it shrinks only that far; the rest goes once the reader reaches the bottom.
        const gap = node.scrollHeight - node.scrollTop - node.clientHeight, bottom = gap <= AT_BOTTOM;
        const padding = `${bottom ? box.offsetHeight : Math.max(box.offsetHeight, (parseFloat(column.style.paddingBottom) || 0) - gap)}px`;
        if (column.style.paddingBottom !== padding) { column.style.paddingBottom = padding; if (bottom && !pin.current && !quoting.current) node.scrollTop = node.scrollHeight - node.clientHeight - gap; }
      }
      setScrollbar(node.offsetWidth - node.clientWidth);
    };
    const observer = new ResizeObserver(fit); observer.observe(box); observer.observe(node); fit(); const scrolled = () => { if (Date.now() - resizedAt.current >= 500) fit(); }; node.addEventListener('scroll', scrolled, { passive: true });
    return () => { observer.disconnect(); node.removeEventListener('scroll', scrolled); };
  }, [selected]);
  // The conversation moves by itself only for a reader at the very bottom: it follows new messages there, and keeps the
  // bottom edge when the visible area shrinks or grows (the phone keyboard, the window resized). A reader scrolled up even a
  // little keeps their place: messages grow below and nothing above moves.
  useEffect(() => {
    const node = scroll.current; if (!node || typeof ResizeObserver === 'undefined') return;
    // The distance from the bottom is kept from the last scroll; by the time the observer runs the browser may already
    // have clamped scrollTop, so it cannot be derived then.
    let height = node.clientHeight, width = node.clientWidth, gap = node.scrollHeight - node.scrollTop - height, content = node.scrollHeight;
    // A narrower or wider chat rewraps every card; the card at the top of the view (and its offset), noted on each scroll,
    // is put back where it was so the reader keeps their place (the browser's own scroll anchoring is off here).
    // Kept by its first id too: a card re-rendered under the same id (an answer split from its question) is found again.
    let anchor: { el: HTMLElement; id: string; offset: number } | null = null;
    const remember = () => { const view = node.getBoundingClientRect().top, el = Array.from(node.querySelectorAll<HTMLElement>('[aria-label=History] [data-history-ids]')).find(row => row.getBoundingClientRect().bottom > view + 1); anchor = el ? { el, id: el.dataset.historyIds!.split(' ')[0]!, offset: el.getBoundingClientRect().top - view } : null; };
    const anchored = () => anchor && live(node, anchor.el, rowOf(anchor.id));
    let anchorFrame = 0;
    const track = () => { if (!node.clientHeight || Date.now() - resizedAt.current < 500) return; if (node.clientHeight === height) gap = node.scrollHeight - node.scrollTop - node.clientHeight; content = node.scrollHeight; if (!anchorFrame) anchorFrame = requestAnimationFrame(() => { anchorFrame = 0; remember(); }); };
    // The conversation also grows at its end after a send (the bubble, the robot, the actions render a moment later):
    // a reader who was at the bottom stays there.
    // Every frame of a resize (a sidebar opening, the window dragged) rewraps the whole conversation, which made the UI lag.
    // While it lasts, cards out of view skip layout at the height they had (content-visibility); when it settles they are
    // laid out once at the new width and the reader's card is put back in place.
    let settle: ReturnType<typeof setTimeout> | undefined;
    const cards = () => Array.from(node.querySelectorAll<HTMLElement>('[aria-label=History] > *'));
    const settled = () => {
      settle = undefined; remember(); for (const card of cards()) card.style.contentVisibility = card.style.containIntrinsicSize = '';
      resizedAt.current = Date.now(); // cards laid out again settle a moment later (embeds report their height); keep the anchor that long
      if (pin.current) return;
      const el = gap > AT_BOTTOM ? anchored() : null;
      if (el) node.scrollTop += el.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor!.offset;
      else if (gap <= AT_BOTTOM && !quoting.current) node.scrollTop = node.scrollHeight - node.clientHeight;
    };
    // Hidden (display: none while bb shows another page) every size reads 0 and the browser may drop the scroll offset, so
    // nothing is noted then; on return the reader's card, or the bottom, is put back.
    let hidden = false;
    const observer = new ResizeObserver(() => {
      const next = node.clientHeight;
      if (!next && !node.clientWidth) { hidden = true; return; }
      if (hidden) { hidden = false; if (!pin.current && node.clientWidth === width) { const el = gap > AT_BOTTOM ? anchored() : null; if (el) node.scrollTop += el.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor!.offset; else if (gap <= AT_BOTTOM && !quoting.current) node.scrollTop = node.scrollHeight - next; height = next; content = node.scrollHeight; return; } }
      if (node.clientWidth !== width) {
        width = node.clientWidth; resizedAt.current = Date.now();
        if (!settle) { const measured = cards().map(card => { const style = getComputedStyle(card); return { card, height: card.offsetHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth) - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) }; }); for (const { card, height } of measured) { card.style.containIntrinsicSize = `auto ${height}px`; card.style.contentVisibility = 'auto'; } }
        clearTimeout(settle); settle = setTimeout(settled, 500);
      }
      // A reader scrolled up keeps the card at the top of the view where it was, whatever changed height above it (a robot
      // gone, a work log folded, an update joining its group, a rewrap); growth below it moves nothing.
      if (!pin.current) {
        const el = gap > AT_BOTTOM ? anchored() : null;
        if (el) node.scrollTop += el.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor!.offset;
        else if (gap <= AT_BOTTOM && !quoting.current) node.scrollTop = followTo(node.scrollTop, node.scrollHeight, next, content, covered(node));
      }
      height = next; content = node.scrollHeight; if (Date.now() - resizedAt.current >= 500) gap = node.scrollHeight - node.scrollTop - next;
    });
    observer.observe(node); if (node.firstElementChild) observer.observe(node.firstElementChild); node.addEventListener('scroll', track, { passive: true }); remember();
    return () => { cancelAnimationFrame(anchorFrame); observer.disconnect(); node.removeEventListener('scroll', track); if (settle) { clearTimeout(settle); for (const card of cards()) card.style.contentVisibility = card.style.containIntrinsicSize = ''; } };
  }, [selected]);
  // Flip the popup above the selection when it would be clipped by the bottom of the scroll area.
  useLayoutEffect(() => {
    const node = popup.current, box = scroll.current; if (!draft || draft.above === undefined || !node || !box) return;
    const flip = () => { const height = node.offsetHeight, top = draft.above! - height; if (draft.top + height > box.scrollTop + box.clientHeight && top >= box.scrollTop) setDraft(old => old === draft ? { ...old, top, above: undefined } : old); };
    flip();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(flip); observer?.observe(node);
    return () => observer?.disconnect();
  }, [draft, !!selectionBar]);
  useEffect(() => {
    if (!draft) return;
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setDraft(null); else if (selectionBar && e.key === 'Tab' && !e.shiftKey && !e.defaultPrevented && !popup.current?.contains(e.target as Node)) { e.preventDefault(); popup.current?.querySelector<HTMLElement>('button')?.focus(); } };
    const outside = (e: PointerEvent) => { if ((e.target as Element).closest?.('[role=option]')) return; if (popup.current && !popup.current.contains(e.target as Node)) setDraft(null); };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    // The popup follows its selection: new messages, questions or queue rows move the text (a selection in the composer
    // stack does not scroll with the chat), so every scroll, resize or change of the chat re-places it. A selection whose
    // text was re-rendered falls back to the bottom of its message; one whose message is gone leaves the popup where it is.
    let frame = 0;
    const place = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      const box = scroll.current, range = anchor.current; if (!box) return;
      setDraft(old => {
        if (!old) return old;
        const width = Math.max(0, Math.min(560, box.clientWidth - 16));
        if (selectionBar && range && box.clientHeight) { const r = range.getBoundingClientRect(), b = box.getBoundingClientRect(); if (r.bottom < b.top || r.top > b.bottom) return null; }
        let pos: { top: number; above: number; left: number } | null = null;
        if (range && range.startContainer.isConnected && range.endContainer.isConnected && range.getClientRects().length) pos = selectionPosition(range, box, width);
        else { const body = box.parentElement?.querySelector<HTMLElement>(`[data-agent-body][data-item="${old.itemId}"]`); if (body) { const r = body.getBoundingClientRect(), b = box.getBoundingClientRect(); pos = { top: r.bottom - b.top + box.scrollTop + 6, above: r.top - b.top + box.scrollTop - 6, left: old.left }; } }
        const left = Math.max(8, Math.min(pos?.left ?? old.left, box.clientWidth - (width + 8)));
        // Unchanged since the last placing (which the flip below the selection may have adjusted): keep the popup as is.
        if (pos && placed.current && placed.current.top === pos.top && placed.current.above === pos.above && left === old.left && width === old.width) return old;
        if (!pos) return left === old.left && width === old.width ? old : { ...old, left, width };
        placed.current = pos; return { ...old, top: pos.top, above: pos.above, left, width };
      });
    }); };
    const box = scroll.current, area = box?.parentElement;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place), mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(place);
    if (box) { observer?.observe(box); box.addEventListener('scroll', place); }
    if (area) mutations?.observe(area, { childList: true, subtree: true, characterData: true });
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); observer?.disconnect(); mutations?.disconnect(); box?.removeEventListener('scroll', place); };
  }, [!!draft, !!selectionBar]);
  function capture(event?: React.SyntheticEvent) {
    if (preferences?.selectionActions === false) { setSelectionBar(null); return; }
    if (event && (event.target as Element).closest('[data-selection-bar]')) return;
    const selection = window.getSelection(), target = event?.target as Node | undefined ?? selection?.anchorNode;
    const body = (target instanceof Element ? target : target?.parentElement)?.closest<HTMLElement>('[data-agent-body]');
    if (!body || !scroll.current?.contains(body) || !selected || !selection || selection.rangeCount !== 1 || selection.isCollapsed || !scroll.current) { setSelectionBar(null); return; }
    const range = clipSelection(selection.getRangeAt(0), body); if (!range) return;
    const quote = selectionMarkdown(range, body); if (!quote.trim()) return;
    anchor.current = range; placed.current = null;
    setSelectionBar({ threadId: selected, projectId: current?.projectId ?? null, itemId: body.dataset.item!, quote, quoteSeq: body.dataset.seq ? Number(body.dataset.seq) : undefined, ...selectionPosition(range, scroll.current, Math.min(560, scroll.current.clientWidth - 16)), width: Math.min(560, scroll.current.clientWidth - 16) });

  }
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const change = () => { clearTimeout(timer); timer = setTimeout(() => { if (popup.current?.getAttribute('role') !== 'dialog' || !popup.current.contains(document.activeElement)) capture(); }, 250); };
    document.addEventListener('selectionchange', change);
    return () => { clearTimeout(timer); document.removeEventListener('selectionchange', change); };
  }, [selected, current?.projectId, preferences?.selectionActions]);
  async function selectionAction(action: string) {
    if (!selectionBar) return;
    const value = selectionBar;
    if (action === 'Comment') { setSelectionBar(null); setReplyDraft({ ...value, ...selectionPosition(anchor.current!, scroll.current!, value.width) }); setText(''); setFiles([]); setError(value.quote.length > 20000 ? 'Quote exceeds 20,000 characters' : ''); return; }
    if (value.quote.length > 20000) { setError('Quote exceeds 20,000 characters'); return; }
    setSelectionBar(null);
    try {
      if (action === 'Add to chat') {
        const old = drafts[value.threadId] ?? compose;
        updateCompose(value.threadId, { ...old, text: `${old.text}${old.text ? '\n\n' : ''}${value.quote.split('\n').map(line => `> ${line}`).join('\n')}\n\n` });
        stack.current?.querySelector<HTMLElement>('[role="textbox"][aria-label="Send message"]')?.focus();
      } else if (action === 'Add to reply pool') { await rpc.call('poolAdd', { threadId: value.threadId, itemId: value.itemId, quote: value.quote, note: '', ...(value.quoteSeq === undefined ? {} : { quoteSeq: value.quoteSeq }) }); panel.openTab({ tab: poolsTab }); }
      else { await rpc.call('save', { threadId: value.threadId, seq: value.quoteSeq!, role: 'assistant', text: value.quote }); setSelectionFeedback('Saved'); }
    } catch (e) { setError(errorText(e)); }
  }
  async function send(pool: boolean, options?: SendOptions) {
    if (!draft || pending || draft.quote.length > 20000) return;
    setPending(true); setError('');
    // Like the composer: show the sent quote reply at once instead of waiting for the thread's events to be ingested.
    const optimisticId = Date.now() + Math.random(), threadId = draft.threadId, bubble = !pool && options?.mode !== 'draft' && !options?.sendAt && !willQueue(threadId, options) ? buildReplyMessage([{ quote: draft.quote, note: text }]).trim() : '';
    if (bubble) setOptimistic(old => [...old, { threadId, text: bubble, id: optimisticId, seenIds: pages.flatMap(page => page.items.map(item => item.id)) }]);
    try {
      if (pool) { await rpc.call('poolAdd', { threadId: draft.threadId, quote: draft.quote, itemId: draft.itemId, ...(draft.quoteSeq === undefined ? {} : { quoteSeq: draft.quoteSeq }), note: text, ...(files.length ? { attachments: files } : {}) }); panel.openTab({ tab: poolsTab }); }
      else { const result = await rpc.call('quoteReply', { threadId, quote: draft.quote, itemId: draft.itemId, text, ...(files.length ? { attachments: files } : {}), ...(options ? { send: options } : {}) }); if (result.delivery === 'queued') { setOptimistic(old => old.filter(b => b.id !== optimisticId)); setQueueVersion(n => n + 1); } }
      setDraft(null); setFiles([]);
    } catch (e) { setOptimistic(old => old.filter(b => b.id !== optimisticId)); setError(pool ? errorText(e) : deliveryError(e)); }
    finally { setPending(false); }
  }
  const shown = pages === NO_PAGES ? loadedPages : pages.slice(0, depth);
  // The chat records a sent message before the queue reread drops its row, so the row leaves the card as the message
  // lands. Each chat message hides one row, so a repeat of the same text still queued stays.
  const landedRows = useMemo(() => { const mine = pages.flatMap(page => page.items).filter(item => item.kind === 'mine' && item.questionSeq !== null), used = new Set<string>(), hidden = new Set<string>(); for (const row of [...queue, ...leaving.map(entry => entry.row)]) { const hit = mine.find(item => !used.has(item.id) && item.threadId === row.threadId && item.createdAt >= row.createdAt && sameSent(item.question, queueText(row))); if (hit) { used.add(hit.id); hidden.add(row.id); } } return hidden; }, [pages, queue, leaving]);
  const shownQueue = [...queue.filter(row => !sentNow.includes(row.id)), ...leaving.filter(entry => !queue.some(row => row.id === entry.row.id)).map(entry => entry.row)].filter(row => !landedRows.has(row.id));
  const held = leaving.filter(entry => entry.row.threadId === selected).map(leavingText);
  const items = useMemo(() => { const seen = new Set<string>(); return shown.flatMap(page => page.items).filter(item => (item.kind !== 'for_me' || item.status !== 'open') && !(item.kind === 'mine' && item.questionSeq === null && held.includes(item.question.trim())) && !seen.has(item.id) && !!seen.add(item.id)).reverse(); }, [pages, loadedPages, depth, held.join('\n')]);
  // A steer joins the running turn's card once ingested; placing it there at once keeps the bubble from jumping up later.
  const steerHost = [...items].reverse().find(item => item.kind === 'mine' && item.threadId === selected && item.turnId && item.status === 'waiting' && item.dismissedAt === null);
  const joined = optimistic.filter(b => b.steer && b.threadId === selected && steerHost);
  const chatItems = useMemo(() => joined.length ? [...items, ...joined.map(b => ({ ...sendingItem(b, recipients?.recipients.find(r => r.threadId === b.threadId)), turnId: steerHost!.turnId, answerSeq: steerHost!.answerSeq, interimSeq: steerHost!.interimSeq }))] : items, [items, joined.map(b => b.id).join(), steerHost?.id]);
  // Checked on new leavers too: the chat may record the message before the queue read that notices it gone.
  useEffect(() => { const list = pages.flatMap(page => page.items); setLeaving(current => { const next = current.filter(entry => !landed(entry, list)); return next.length === current.length ? current : next; }); }, [pages, leaving]);
  // A queued row whose message the chat already recorded after it was queued may be a stale read (bb sent it between
  // reads, its event missed); reread the queue once for it rather than wait for the 30 s check.
  const recheckedRows = useRef(new Set<string>());
  useEffect(() => { const stale = queue.filter(row => !recheckedRows.current.has(row.id) && landedRows.has(row.id)); if (!stale.length) return; stale.forEach(row => recheckedRows.current.add(row.id)); setQueueVersion(n => n + 1); }, [landedRows, queue]);
  // Folding a long last update back when a turn starts (a queued message sent) would cut the chat's end under a reader
  // near it and drop them to the bottom, so the one shown in full stays so until a newer message takes its place.
  const fullTail = useRef<string | null>(null);
  if (position.current.fresh && pages.length) mark.current = items.find(isUnread)?.id ?? null;
  const unreadCount = items.filter(isUnread).length;
  const historyGroups = useMemo(() => { const entries = conversation(groupItems(chatItems), !!shown.at(-1)?.nextCursor, [], !working, fullTail.current, preferences?.groupBackgroundUpdates !== false, mark.current).entries, last = entries.at(-1); fullTail.current = last && !last.updates && !last.part && last.group.length === 1 && last.group[0]!.kind === 'update' ? last.group[0]!.id : null; return entries; }, [chatItems, pages, loadedPages, depth, working, preferences?.groupBackgroundUpdates, mark.current]);
  // The robot walks at the end of the chat unless the last card is itself a pending owner message (its robot is the one);
  // cards further up carry none (ItemCard's live).
  const lastPending = (() => { const entry = historyGroups.at(-1); return !!entry && entry.part !== 'answer' && entry.group.some(item => item.dismissedAt === null && ((item.kind === 'mine' && (item.status === 'waiting' || item.status === 'deferred')) || (item.kind === 'update' && item.status === 'waiting'))); })();
  // An incoming message's card walks its own robot while the turn works (see Row), so the bottom one stays hidden.
  // A loaded window of only quiet updates collapses to a single row; reach back (up to 5 pages) to the last real exchange.
  useEffect(() => { if (selected && shown.length === depth && depth < 5 && shown.at(-1)?.nextCursor && !historyGroups.some(entry => !entry.updates && !quietUpdate(entry))) setDepth(d => d + 1); }, [historyGroups]);
  useEffect(() => { if (!selected || !pages.length) return; const questions = [...pages.flatMap(page => page.items)].filter(item => item.threadId === selected); setOptimistic(old => { const remaining = [...questions], matched = new Set<number>(); for (const b of [...old].reverse()) { if (b.threadId !== selected) continue; const index = remaining.findIndex(item => !b.seenIds.includes(item.id) && item.question.trim() === b.text); if (index >= 0) { remaining.splice(index, 1); matched.add(b.id); } } return matched.size ? old.filter(b => !matched.has(b.id)) : old; }); }, [selected, pages]);
  const openUnread = current?.unread ?? 0;
  // bb's chat has no per-message read marks, so an open conversation counts as read.
  useEffect(() => { if (bbChat && selected && openUnread) void rpc.call('markThreadRead', { threadId: selected }).catch(() => {}); }, [bbChat, selected, openUnread]);
  const [desktop, setDesktop] = useState(() => window.matchMedia?.('(min-width: 640px)').matches ?? true);
  useEffect(() => { const media = window.matchMedia?.('(min-width: 640px)'); if (!media) return; const change = () => setDesktop(media.matches); media.addEventListener('change', change); return () => media.removeEventListener('change', change); }, []);
  const mergedHeader = desktop && toolbarTargets?.title && toolbarTargets.search && toolbarTargets.actions;
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(57);
  useLayoutEffect(() => {
    const node = headerRef.current;
    if (mergedHeader) { setHeaderHeight(0); return; }
    if (!node) return;
    const measure = () => setHeaderHeight(mergedHeader ? 0 : node.offsetHeight);
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); observer?.observe(node);
    return () => observer?.disconnect();
  }, [selected, mergedHeader]);
  const searchControls = <div className="relative flex min-w-0 items-center gap-1"><Button size="sm" variant="ghost" className="text-xs" aria-label="Full transcript" {...{ title: "Full transcript" }} onClick={openTranscript}><Icon name="FileText" aria-hidden /></Button>{search && <input aria-label="Search conversation" autoFocus className="w-32 min-w-0 rounded border border-border-seam bg-background px-2 text-sm max-[639px]:min-w-0 max-[639px]:w-20" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') { setSearch(false); setQuery(''); setOlder(false); } }} />}{search && query.trim() && <div role="listbox" aria-label="Search results" className="absolute right-3 top-full z-10 max-h-64 w-72 overflow-auto rounded border border-border-seam bg-background shadow-lg">{searchError && <p role="alert">{searchError}</p>}{matches.map(match => <button key={match.id} role="option" aria-selected={false} className="answers-hit block w-full border-b border-border-seam p-2 text-left text-xs hover:bg-state-hover" onClick={() => { jumpTo(match.id); setSearch(false); }}>{(match.answer || match.question).slice(0, 160)} <time className="block text-muted-foreground">{new Date(match.updatedAt).toLocaleDateString()}</time></button>)}</div>}{selected && <ConversationOutline key={selected} threadId={selected} onJump={seq => jumpTo(`seq:${seq}`)} />}<Button size="sm" variant="ghost" aria-label="Search conversation" {...{ title: `Search conversation (${chatShortcut('f')})` }} aria-pressed={search} onClick={() => { setSearch(!search); setOlder(false); }}><Icon name="Search" aria-hidden /></Button></div>;
  const headerTitle = selected && <><ThreadHeader thread={openThread} parent={sidebarThreads.find(thread => thread.id === openThread?.parentThreadId)} title={current?.threadTitle ?? 'Untitled thread'} onSelect={setSelected} actionsTarget={mergedHeader ? toolbarTargets!.actions : null} trailing={mergedHeader ? undefined : searchControls} /></>;
  const mobileHeader = selected && (mergedHeader ? <>{createPortal(headerTitle, toolbarTargets!.title!)}{createPortal(searchControls, toolbarTargets!.search!)}</> : <div ref={headerRef} className="sticky top-0 z-[2] flex items-center gap-2.5 border-b border-border-seam bg-background px-4 py-2"><Button size="sm" variant="ghost" className="min-[640px]:hidden" aria-label="Back" onClick={() => setSelected(undefined)}><Icon name="ArrowLeft" aria-hidden /></Button>{headerTitle}</div>);
  const queueCard = useMemo(() => (<QueueCard rows={shownQueue.filter(row => row.threadId === selected)} waitReason={queueWait} sourceBrand={row => !row.senderThreadId && row.originPluginId && !['agent-hub', 'answers'].includes(row.originPluginId) ? pluginBrands.find(brand => brand.id === row.originPluginId) ?? null : null} sourceName={row => row.senderThreadId ? sidebarThreads.find(thread => thread.id === row.senderThreadId)?.title ?? null : (row.originPluginId ? pluginBrands.find(brand => brand.id === row.originPluginId)?.name ?? row.originPluginId : null) ?? (row.origin === 'cli' ? 'CLI' : null)} projectId={current?.projectId} edit={queueEdit} onEdit={(row, update) => update ? setQueueEdit(current => current?.id === row.id ? { ...current, ...update } : current) : void startQueueEdit(row)} onFinish={(row, save) => void finishQueueEdit(row, save)} onSend={row => void sendQueued(row)} onDelete={row => { dropped.current.add(row.id); void queueAction(() => sdk.threads.queuedMessages.delete({ threadId: row.threadId, queuedMessageId: row.id }), true); }} onSchedule={(row, sendAt) => void queueAction(() => sdk.threads.queuedMessages.update({ threadId: row.threadId, queuedMessageId: row.id, expectedUpdatedAt: row.updatedAt, sendAt }))} onReorder={(row, previousQueuedMessageId, nextQueuedMessageId) => void queueAction(() => sdk.threads.queuedMessages.reorder({ threadId: row.threadId, queuedMessageId: row.id, previousQueuedMessageId, nextQueuedMessageId }))} />), [queue, sentNow, leaving, selected, queueEdit, openThread?.providerId, openThread?.environment?.id, openThread?.host?.id, sidebarThreads, pluginBrands, current?.projectId, sdk, rpc]);
  // Activity uses display:none, so restore the offset before the first visible paint.
  const keptTop = useRef<number | null>(null);
  useLayoutEffect(() => {
    const node = scroll.current;
    if (node && keptTop.current !== null) node.scrollTop = keptTop.current;
    return () => { if (node) keptTop.current = node.scrollTop; };
  }, []);
  return <FullTranscriptContext.Provider value={openTranscript}><EditSentContext.Provider value={startSentEdit}><ComposerThread.Provider value={selected ?? null}><div ref={grid} className="relative grid h-full grid-cols-[minmax(0,1fr)]">
    {bbChat && selected ? <div className="flex min-h-0 min-w-0 flex-col">{mobileHeader}<ThreadChat key={selected} threadId={selected} variant="full" className="min-h-0 flex-1" /></div> :
    <div className={`relative flex min-h-0 min-w-0 flex-col ${!selected ? 'max-[639px]:hidden' : ''}`}><div ref={scroll} inert={transcript || undefined} aria-hidden={transcript || undefined} style={transcript ? {visibility:'hidden'} : undefined} className="relative min-h-0 flex-1 overflow-auto [overflow-anchor:none]" onMouseUp={capture} onKeyUp={event => { if (event.key !== 'Escape' && event.key !== 'Tab') capture(event); }} onKeyDown={event => { if (event.key === 'Tab' && selectionBar && !event.shiftKey) { event.preventDefault(); popup.current?.querySelector<HTMLElement>('button')?.focus(); } }} onScroll={event => { const node = event.currentTarget; if (!node.clientHeight || latestFrame.current || Date.now() - resizedAt.current < 500) return; latestFrame.current = requestAnimationFrame(() => { latestFrame.current = 0; checkLatest(); position.current = { ...position.current, height: node.scrollHeight, top: node.scrollTop, bottom: node.scrollHeight - node.scrollTop - node.clientHeight < AT_BOTTOM }; if (selected && !position.current.fresh) { scrollPending.current = { threadId: selected, top: node.scrollTop, depth, ...(atEnd(node) ? { bottom: true as const } : {}) }; if (!scrollTimer.current) scrollTimer.current = setTimeout(() => { const pending = scrollPending.current; if (pending && pending.threadId === selected) { const view = node.getBoundingClientRect().top, first = Array.from(node.querySelectorAll<HTMLElement>('[aria-label=History] [data-history-ids]')).find(el => el.getBoundingClientRect().bottom > view + 1); if (first) Object.assign(pending, { anchor: first.dataset.historyIds!.split(' ')[0], offset: first.getBoundingClientRect().top - view }); } saveScroll(); }, 200); } }); }}>
      {!selected && <EmptyState icon="MessageQuestion" title="Pick a conversation">Answers are grouped by thread. Open one to read it from the start and reply with quotes.</EmptyState>}
      {/* A column at least as tall as the view, so a short chat still keeps the composer at the bottom, as bb's chat does; clip (not hidden, which would break sticky) cuts bb's hidden voice textarea that hangs 7px below the composer and made short chats scroll. */}
      {selected && <div data-chat-column className="flex min-h-full flex-col overflow-clip" style={{ '--scrollbar': `${scrollbar}px`, '--answers-header-height': `${headerHeight}px` } as CSSProperties}>{mobileHeader}{older && <p role="status" className="px-4 text-xs">Message is outside stored Agent Hub history — <button type="button" className="underline" onClick={openTranscript}>Full transcript</button></p>}<HistoryPage key={selected} threadId={selected} index={0} unread={current?.unread} {...{ depth, receive }} />{pages.at(-1)?.nextCursor && <EarlierLoader loading={windowLoading || pages.length < depth} enabled={settled} onLoad={() => { if (activeWindow) { void loadWindow(false); return; } position.current.prepend = true; setDepth(d => Math.max(d, pages.length + 1)); }} />}<ActivityContext.Provider value={activity}><ActivityLabelContext.Provider value={activityLabel}><History key={selected} threadId={selected} groups={historyGroups} flash={flash} markId={mark.current} settled={settled && !transcript} onJump={jumpTo} /></ActivityLabelContext.Provider></ActivityContext.Provider>{activeWindow?.page.newerCursor && <EarlierLoader loading={windowLoading} label="Load newer" enabled={settled} onLoad={() => void loadWindow(true)} />}{optimistic.some(b => b.threadId === selected && !joined.includes(b)) && <ul inert aria-label="Sending" className="pl-4 pr-[max(0px,calc(1rem-var(--scrollbar,0px)))] [&>li]:border-t [&>li]:border-border-seam">{optimistic.filter(b => b.threadId === selected && !joined.includes(b)).map(b => <ItemCard key={b.id} item={sendingItem(b, recipients?.recipients.find(r => r.threadId === b.threadId))} chat markable={false} replyToOwn={false} />)}</ul>}
        {/* The agent works on its own (woken by a child, a plugin, a script): the robot walks at the end of the chat, unless
            a pending owner message already shows it. */}
        {selected && <ThreadPlan key={`plan:${selected}`} threadId={selected} />}
        {working && !optimistic.some(b => b.threadId === selected) && !lastPending && <div className="px-6 pb-3 text-muted-foreground opacity-60"><ActivityLabelContext.Provider value={activityLabel}><WorkLog key={selected} threadId={selected} live><RobotLoader className="h-8" activity={activity} label="The agent is working" /></WorkLog></ActivityLabelContext.Provider></div>}</div>}
      {selectionFeedback && <span role="status" className="absolute right-3 top-3 text-xs">{selectionFeedback}</span>}
      {preferences?.selectionActions !== false && selectionBar && <div ref={popup} data-selection-bar role="toolbar" aria-label="Selected passage" className="absolute z-10 flex max-w-full items-center gap-0.5 overflow-x-auto rounded-md border border-border bg-popover p-0.5 text-popover-foreground shadow-md" style={{ maxWidth: selectionBar.width, top: selectionBar.top, left: selectionBar.left }} onMouseDown={event => event.preventDefault()}>
        {(['Add to chat', 'Add to reply pool', 'Comment', ...(selectionBar.quoteSeq === undefined ? [] : ['Save'])]).map((action, i) => <button key={action} type="button" className="answers-hit inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-xs text-foreground transition-colors hover:bg-surface-recessed focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring select-none" onClick={() => void selectionAction(action)}><Icon name={(['MessageSquarePlus', 'ListEnd', 'MessageSquare', 'Star'] as const)[i]!} aria-hidden className="size-3.5 text-muted-foreground" />{action}</button>)}
      </div>}
      {draft && !selectionBar && <div ref={popup} role="dialog" aria-label="Quote reply" className="absolute z-10" style={{ width: draft.width, top: draft.top, left: draft.left }} onBlur={event => { if (event.relatedTarget && !(event.relatedTarget as Element).closest?.('[role=option]') && !event.currentTarget.contains(event.relatedTarget as Node)) setDraft(null); }}>
        <Composer label="Quote reply text" className="shadow-lg" autoFocus value={text} onChange={setText} attachments={files} onAttachments={update => setFiles(update)} projectId={draft.projectId} pending={pending} sendDisabled={draft.quote.length > 20000} onSend={options => void send(false, options)}
          header={<div className="flex items-start gap-2 pl-4 pr-2 pt-2"><div className="mt-1 max-h-32 min-w-0 flex-1 overflow-auto border-l-2 border-border-seam pl-2 text-sm text-muted-foreground"><Markdown content={draft.quote} /></div><Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" aria-label="Close" onClick={() => setDraft(null)}><Icon name="X" aria-hidden /></Button></div>}
          onPool={draft.quote.length > 20000 ? undefined : () => void send(true)} poolFirst={!!pools.data?.pools.some(pool => pool.threadId === draft.threadId && pool.entries.length)} />
        {error && <p role="alert" className="mt-1 rounded-md bg-background px-2 text-xs text-destructive">{error}</p>}
      </div>}
      {!draft && error && <p role="alert">{error}</p>}
    </div>{/* The reader opened at the newest: the unread rows above stay unread until seen, and this jumps to the first of them (set at once, so no row in between is passed over and counted as read). */}{selected && !transcript && !activeWindow && <div className="pointer-events-none absolute inset-x-0 z-20 flex justify-center" style={{ top: headerHeight + 8, right: scrollbar }}><button type="button" aria-label="Jump to unread" aria-hidden={!(unreadAbove && unreadCount > 0)} tabIndex={unreadAbove && unreadCount > 0 ? 0 : -1} className={`answers-hit pointer-events-auto flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs font-medium transition-all duration-200 hover:bg-accent ${unreadAbove && unreadCount > 0 ? 'translate-y-0 opacity-100' : 'pointer-events-none invisible -translate-y-2 opacity-0'}`} onClick={() => { const node = scroll.current, divider = node?.querySelector<HTMLElement>('[aria-label=History] [data-new]'); if (!node || !divider) return; release(); node.scrollTop = divider.offsetTop - (node.querySelector<HTMLElement>('.sticky')?.offsetHeight ?? 0); }}><Icon name="ArrowUp" aria-hidden className="size-4" />{unreadCount} unread</button></div>}{selected && <div ref={stack} inert={transcript || undefined} aria-hidden={transcript || undefined} data-composer-stack className="absolute bottom-0 left-0 z-[1] bg-background pb-2 pl-4" style={{ visibility: transcript ? 'hidden' : undefined, right: scrollbar, paddingRight: Math.max(0, 16 - scrollbar) }}>{/* bb's own "Scroll to latest" button, over the composer, once the last message is out of sight below; centred on the whole column, scroll bar included. The stack itself keeps the history's 1rem on both sides. */}<div className="pointer-events-none absolute left-0 -top-11 flex justify-center" style={{ right: -scrollbar }}><button type="button" aria-label="Scroll to latest" aria-hidden={!farFromEnd} tabIndex={farFromEnd ? 0 : -1} className={`answers-hit pointer-events-auto z-20 flex size-8 cursor-pointer items-center justify-center rounded-full border border-border bg-background transition-all duration-200 hover:bg-accent ${farFromEnd ? 'translate-y-0 opacity-100' : 'pointer-events-none invisible translate-y-2 opacity-0'}`} onClick={() => { release(); if (activeWindow) { setHistoryWindow(null); position.current.bottom = true; } scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' }); }}><Icon name="ArrowDown" aria-hidden className={`size-4 ${working && farFromEnd ? 'animate-shine-icon' : ''}`} /></button></div><QuestionStack key={selected} threadId={selected}><Reveal key={`pending:${selected}`} id={`pending:${selected}`} show={!!openThread?.hasPendingInteraction}><div data-promptbox-shell className={stackShell}><PendingInteractions key={selected} threadId={selected} projectId={openThread?.projectId} pending={!!openThread?.hasPendingInteraction} status={openThread?.status} stacked /></div></Reveal><ThreadQuestions key={selected} threadId={selected} shell={stackShell} /></QuestionStack><OwedCard key={`owed:${selected}`} threadId={selected} newest={historyGroups.at(-1)} working={working} onJump={jumpTo} /><Reveal key={`queue:${selected}`}  id={`queue:${selected}`} show={queueOf === selected ? shownQueue.some(row => row.threadId === selected) : null}>{queueCard}</Reveal>{queueError && <p role="alert" className="text-xs text-destructive">{queueError}</p>}<div className="relative z-20">{editing ? <Composer key={`edit:${editing.seq}`} editMode autoFocus label="Edit message" sendLabel="Submit edit" placeholder="Edit message" header={<div data-sent-message-edit-cap className="flex min-h-7 items-center gap-1.5 px-3 pt-1.5 text-xs text-subtle-foreground"><Icon name="Edit" aria-hidden className="size-3.5 shrink-0" /><span>Editing message</span><button type="button" aria-label="Stop editing sent message" className="answers-hit ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => setSentEdit(null)}><Icon name="X" aria-hidden className="size-3" /></button></div>} value={editing.text} onChange={text => setSentEdit(current => current && { ...current, text })} attachments={editing.files} onAttachments={update => setSentEdit(current => current && { ...current, files: update(current.files) })} projectId={current?.projectId} pending={editPending} onSend={() => void submitSentEdit()} onCancel={() => setSentEdit(null)} /> : <Composer key={selected} header={handoff ? <div className="flex min-h-7 items-center gap-1.5 px-3 pt-1.5 text-xs text-subtle-foreground"><Icon name="MessageSquarePlus" aria-hidden className="size-3.5 shrink-0" /><span>Handoff to new thread</span><Button type="button" size="sm" variant="ghost" className="ml-auto size-6 shrink-0" aria-label="Exit handoff" onClick={() => updateCompose(selected, { ...compose, execution: execution?.threadId === selected ? execution.value : undefined, permissionMode: undefined })}><Icon name="X" aria-hidden className="size-3" /></Button></div> : undefined} onHistory={recallPrompt} permissionPicker={composePermission && openThread?.providerId ? { providerId: composeExecution?.providerId ?? openThread.providerId, value: composePermission, onChange: permissionMode => updateCompose(selected, { ...compose, permissionMode }), routing, className: 'h-8 text-xs' } : undefined} modelPicker={composeExecution ? { value: composeExecution, onChange: execution => updateCompose(selected, { ...compose, execution }), allowProviderChange: true, routing: openThread?.environment?.id ? { kind: 'environment', environmentId: openThread.environment.id } : openThread?.host?.id ? { kind: 'host', hostId: openThread.host!.id } : undefined, className: 'min-w-0 max-w-48 h-8 text-xs' } : undefined} editableWhilePending label="Send message" sendLabel="Send message" placeholder="Message…" value={compose.text} onChange={text => { recall.current=null; updateCompose(selected, { ...drafts[selected], historyInput:undefined, text, files: drafts[selected]?.files ?? [] }); }} attachments={compose.files} onAttachments={update => { const current = drafts[selected] ?? { text: '', files: [] }; recall.current=null; updateCompose(selected, { ...current, historyInput:undefined, files: update(current.files) }); }} projectId={current?.projectId} pending={composePending} onPool={!composePending && (compose.text.trim() || compose.files.length) ? () => void poolCompose() : undefined} onSend={options => void sendCompose(options)} onStop={turnRunning ? () => { setComposeError(''); void sdk.threads.stop({ threadId: selected }).catch(e => setComposeError(errorText(e))); } : undefined} />}</div>{composeError && <p role="alert" className="px-1 pt-1 text-xs text-destructive">{composeError}</p>}<div className="mt-1 flex min-h-6 max-h-6 items-center justify-between gap-2 overflow-hidden pl-[15px]"><div className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden">{openThread && <span className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1 text-xs leading-tight text-muted-foreground"><Icon name="Folder" aria-hidden className="size-4 shrink-0" /><span className="truncate">{projects.find(p => p.id === openThread.projectId)?.name ?? 'No project'}</span></span>}{(openThread?.environment?.branchName || openThread?.environment?.name) && <span className="inline-flex h-6 min-w-0 items-center gap-1.5 px-1 text-xs leading-tight text-muted-foreground" title={openThread!.environment!.isWorktree ? 'Worktree' : 'Branch'}><Icon name="GitBranch" aria-hidden className="size-4 shrink-0" /><span className="truncate">{openThread!.environment!.branchName ?? openThread!.environment!.name}</span></span>}</div><div className="flex shrink-0 items-center gap-1">{/* The chat's cost (opens Tokenomos), Idle Compact's Compact, then the context ring. */}<ThreadCostLabel cost={cost} />{openThread && <CompactButton threadId={openThread.id} status={openThread.status} onError={setQueueError} />}{context?.threadId === selected && <ContextRing usage={context.usage} />}</div></div></div>}{transcript && selected && <FullTranscript threadId={selected} onBack={closeTranscript} />}</div>}
  </div></ComposerThread.Provider></EditSentContext.Provider></FullTranscriptContext.Provider>;
}

type Editor = { flush: () => Promise<void> };
function PoolNote({ entry, projectId, editors, autoFocus, pending, onSend }: { entry: PoolEntry; projectId: string | null; editors: Map<string, Editor>; autoFocus?: boolean; pending: boolean; onSend: (id: string, options?: SendOptions) => void }) {
  const rpc = useRpc<AgentHubRpcContract>(), { refresh } = experimental_useRpcRefresh();
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
    state.flight = rpc.call('poolUpdate', { id: entry.id, note: saving, attachments: savingFiles, revision: state.revision }).then(result => { state.revision = result.revision; state.saved = saving; state.savedFiles = savingFiles; setStatus('Saved'); }).catch(e => { setStatus(`Not saved: ${errorText(e)}`); refresh(); throw e; }).finally(() => { state.flight = null; });
    await state.flight;
    if (state.note !== state.saved || JSON.stringify(state.files) !== JSON.stringify(state.savedFiles)) await flush();
  }
  editors.set(entry.id, { flush });
  useEffect(() => () => { editors.delete(entry.id); }, [entry.id, editors]);
  useEffect(() => { if (note === local.current.saved && JSON.stringify(files) === JSON.stringify(local.current.savedFiles)) return; const timer = setTimeout(() => { void flush().catch(() => {}); }, 800); return () => clearTimeout(timer); }, [note, files]);
  // Autosave is silent: pending and in-flight states would add a line and make the card jump; only failures show.
  const problem = !['Saved', 'Saving…', 'Not saved'].includes(status);
  const remove = async () => { try { await rpc.call('poolRemove', { id: entry.id }); } catch (e) { setStatus(errorText(e)); } };
  return <li className="space-y-2">
    <Composer label="Pool note" sendLabel="Send entry" autoFocus={autoFocus} placeholder={entry.quote ? 'Your reply to this quote…' : 'Your message…'} value={note} onChange={value => { local.current.note = value; setNote(value); setStatus('Not saved'); }} attachments={files} onAttachments={update => { const next = update(local.current.files); local.current.files = next; setFiles(next); setStatus('Not saved'); }} projectId={projectId} pending={pending} onBlur={() => void flush().catch(() => {})} onSend={options => onSend(entry.id, options)} actions={<Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="Remove" onClick={() => void remove()}><Icon name="Trash2" aria-hidden className="size-3.5" /></Button>} header={entry.quote && <div className="px-4 pt-3"><div className="border-l-2 border-border-seam pl-2 text-sm text-muted-foreground [&_*]:text-muted-foreground [&_p]:m-0"><div ref={quote} className={expanded ? '' : 'line-clamp-3'}><Markdown content={entry.quote} /></div>{(clamped || expanded) && <button type="button" className="answers-hit mt-0.5 text-xs text-muted-foreground underline-offset-2 hover:underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show more'}</button>}</div></div>} />
    {problem && <p role="status" className={`text-[11px] ${status.startsWith('Not saved:') ? 'text-destructive' : 'text-muted-foreground'}`}>{status}</p>}
  </li>;
}
function ReplyPool({ pool, setFeedback }: { pool: Pool; setFeedback: (text: string) => void }) {
  const rpc = useRpc<AgentHubRpcContract>(), sdk = useSdk();
  const [dragging, setDragging] = useState(false);
  const editors = useRef(new Map<string, Editor>()).current;
  const [pending, setPending] = useState(false);
  const [focusId, setFocusId] = useState<string>();
  async function dropFiles(files: File[]) {
    if (!files.length || pending) return;
    setPending(true); setFeedback('');
    try {
      if (!pool.projectId) throw new Error('Attachments need a thread in a project');
      if (files.length > 10) throw new Error('At most 10 attachments');
      const attachments: Attachment[] = [];
      for (const file of files) attachments.push(await uploadAttachment(sdk, pool.projectId, file));
      const { id } = await rpc.call('poolAdd', { threadId: pool.threadId, quote: '', note: '', attachments });
      setFocusId(id);
    } catch (e) { setFeedback(`Not added — ${errorText(e)}`); }
    finally { setPending(false); }
  }
  async function addMessage() {
    try { const { id } = await rpc.call('poolAdd', { threadId: pool.threadId, quote: '', note: '' }); setFocusId(id); } catch (e) { setFeedback(`Not added — ${errorText(e)}`); }
  }
  async function sendAll(options?: SendOptions, id?: string) {
    setPending(true); setFeedback('');
    try {
      try { await Promise.all((id ? [editors.get(id)!] : [...editors.values()]).map(editor => editor.flush())); } catch (e) { setFeedback(`Not sent — ${errorText(e)}`); return; }
      const result = await rpc.call('poolSend', { threadId: pool.threadId, ...(id ? { ids: [id] } : {}), ...(options ? { send: options } : {}) });
      setFeedback(`${options?.mode === 'draft' ? 'Draft saved' : options?.sendAt ? 'Scheduled' : result.delivery === 'sent' ? 'Sent' : 'Queued'}${result.keptEdited ? ` — ${result.keptEdited} edited entries were not sent` : ''}`);
    } catch (e) { setFeedback(deliveryError(e)); }
    finally { setPending(false); }
  }
  return <section data-file-drop onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDragging(true); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); setDragging(false); void dropFiles(Array.from(event.dataTransfer.files)); }} className={`space-y-2 border-b border-border-seam px-3 py-3 last:border-b-0 ${dragging ? 'ring-1 ring-ring' : ''}`}>
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
  const result = useQuery({ contract: rpcContract, method: 'pools', input: {} }), poolsError = useSteadyError(result.error);
  const pools = result.data?.pools.filter(pool => !threadId || pool.threadId === threadId);
  const box = useRef<HTMLDivElement>(null), [more, setMore] = useState(false);
  const fit = (node: HTMLDivElement) => setMore(node.scrollHeight - node.scrollTop - node.clientHeight > 4);
  useLayoutEffect(() => { if (box.current) fit(box.current); }, [result.data, feedback]);
  if (threadId && !pools?.length && !feedback) return null;
  // In a thread tab the pool sits above the answers list, so it must not take the whole height;
  // a bottom fade shows that more of it scrolls under the list.
  return <div ref={box} onScroll={event => fit(event.currentTarget)} className={threadId ? `max-h-[50%] shrink-0 overflow-auto border-b border-border-seam ${more ? '[mask-image:linear-gradient(to_bottom,black_calc(100%-32px),transparent)]' : ''}` : 'h-full overflow-auto'}>
    {feedback && <p role="status" className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground"><Icon name={/uncertain|not sent/i.test(feedback) ? 'X' : 'Check'} aria-hidden className="size-3.5" />{feedback}</p>}
    {poolsError && <p role="alert" className="px-3 pt-2 text-xs text-destructive">{poolsError.message}</p>}
    {pools?.length === 0 && !threadId && <EmptyState icon="Sent" title="No reply pools yet">Select text in an answer and choose <span className="font-medium text-foreground">Add to reply pool</span> in the send menu. Collect quotes from one thread, then send them together.</EmptyState>}
    {pools?.map(pool => <ReplyPool key={pool.threadId} pool={pool} setFeedback={setFeedback} />)}
  </div>;
}
