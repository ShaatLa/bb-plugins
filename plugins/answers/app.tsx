import { useEffect, useRef, useState } from 'react';
import { definePluginApp, experimental_Icon as Icon, Markdown, UrlLink, useRpc, experimental_useRpcQuery as useQuery, experimental_useSidebarThreads, experimental_useAppPanel, experimental_usePanelTabs, experimental_useRpcRefresh } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type View, type Attachment, type SendOptions } from './contract';
import { Inbox, Pools } from './inbox';
import { Composer } from './composer';
import { EmptyState, type IconName } from './empty';
import { Button } from './components/ui/button';
import { useStoredState } from './lib/stored-state';

const emptyCopy: Record<View, [IconName, string, string]> = {
  unread: ['MailOpen', 'All caught up', 'New answers will show up here.'],
  waiting: ['Clock', 'Nothing waiting', 'Questions still waiting for an answer show up here.'],
  for_me: ['MessageQuestion', 'No questions for you', 'When an agent asks you something without blocking, it shows up here.'],
  pinned: ['Pin', 'Nothing pinned', 'Pin an answer to keep it at hand.'],
  saved: ['Star', 'Nothing saved', 'Use “Save to Answers” on any chat message to keep it here.'],
  all: ['MessageQuestion', 'No answers yet', 'Your questions and the agents’ answers show up here.'],
};
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useAnswersBadge() {
  const { data } = useQuery({ contract: rpcContract, method: 'counts', input: {} });
  const count = data ? data.inbox : 0;
  return count ? { count, label: `${count} unread answers and questions for you` } : null;
}

// chat: render as a conversation exchange (no thread header); markable: offer Mark read (the Inbox marks on open).
export function ItemCard({ item, chat = false, markable = !chat }: { item: Item; chat?: boolean; markable?: boolean }) {
  const rpc = useRpc<AnswersRpcContract>();
  // Refresh reads after our own writes instead of relying only on the server's realtime invalidation.
  const { refresh } = experimental_useRpcRefresh();
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
  const [text, setText] = useState(''), [files, setFiles] = useState<Attachment[]>([]);
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  async function act(write: () => Promise<unknown>) {
    setError('');
    try { await write(); refresh(); } catch (cause) { setError(message(cause)); }
  }
  async function reply(options?: SendOptions) {
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setPending(true); setError(''); setFeedback('');
    try {
      const result = await rpc.call('reply', { id: item.id, text, ...(files.length ? { attachments: files } : {}), ...(options ? { send: options } : {}) });
      refresh(); setFeedback(options?.mode === 'draft' ? 'Draft saved' : options?.sendAt ? 'Scheduled' : result.delivery === 'sent' ? 'Sent' : 'Queued'); setText(''); setFiles([]); setReplying(false);
    } catch (cause) {
      setError(`Delivery uncertain — check the thread before retrying. ${message(cause)}`);
    } finally { sending.current = false; setPending(false); }
  }
  const seq = item.answerSeq ?? item.questionSeq;
  // BB's message routes use the project prefix when the thread belongs to a project.
  const href = `${item.projectId ? `/projects/${encodeURIComponent(item.projectId)}` : ''}/threads/${encodeURIComponent(item.threadId)}${seq === null ? '' : `?msg=${seq}`}`;
  const minutes = Math.max(0, Math.floor((Date.now() - item.createdAt) / 60000));
  const age = minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  // Same look as bb chat: my message is a recessed bubble on the right, the agent's text has no background.
  const userBubble = 'max-w-full rounded-xl border border-border-seam bg-surface-recessed px-4 py-2.5 text-sm leading-relaxed text-foreground';
  const agentText = 'w-full px-2 text-sm leading-relaxed';
  const iconProps = (text: string) => ({ 'aria-label': text, title: text, variant: 'ghost' as const, className: 'size-8 px-0' });
  const unread = item.readAt === null && ((item.kind === 'mine' && item.status === 'answered') || (item.kind === 'for_me' && item.status === 'open'));
  // "Done" said different things per item; name what dismissing actually does, and offer it only where it does something.
  const dismiss: [string, IconName] | null = item.dismissedAt !== null ? null
    : item.kind === 'mine' && (item.status === 'waiting' || item.status === 'deferred') ? ['Stop waiting', 'X']
    : item.kind === 'for_me' && item.status === 'open' ? ['Won’t reply', 'X']
    : item.kind === 'saved' ? ['Remove from Saved', 'Trash2'] : null;
  const isQuestion = item.kind === 'mine' && /[?？]/.test(item.question);
  const time = <time className="text-xs text-muted-foreground" dateTime={new Date(item.createdAt).toISOString()}>{age}</time>;
  const agentBody = (content: string, seq: number | null) => <div className={agentText} data-agent-body data-item={item.id} data-seq={seq ?? undefined}><Markdown content={content} /></div>;
  return <li className={chat ? 'group space-y-3 py-5' : 'group space-y-3 rounded-xl border border-border-seam p-4'}>
    {!chat && <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-2 text-xs text-muted-foreground">
      <h2 className="min-w-0 truncate text-sm font-medium text-foreground">{item.threadTitle ?? 'Untitled thread'}</h2>
      {item.projectName && <span>{item.projectName}</span>}
      <span className="flex-1" />
      {item.status !== 'answered' && <span>{item.status}</span>}
      {unread && <span className="size-1.5 self-center rounded-full bg-foreground/70" aria-label="Unread" />}
      {time}
      {item.threadDeleted && <span>Thread deleted</span>}
    </div>}
    {item.kind === 'for_me' ? <div className="space-y-1">
      <div className="flex items-center gap-2 px-2 text-xs text-muted-foreground"><Icon name="MessageQuestion" aria-hidden />Question for you{chat && <>{' · '}{time}</>}</div>
      <div ref={question} className={expanded ? '' : 'line-clamp-6'}>{agentBody(item.question, item.questionSeq)}</div>
    </div> : <div className="ml-auto flex w-fit max-w-[70%] flex-col items-end gap-1">
      {(chat || isQuestion) && <div className="flex items-center gap-2 text-xs text-muted-foreground">{isQuestion && <span className="flex items-center gap-1"><Icon name="MessageQuestion" aria-hidden className="size-3.5" />Question</span>}{chat && unread && <span className="size-1.5 rounded-full bg-foreground/70" aria-label="Unread" />}{chat && time}</div>}
      <div className={userBubble}><div ref={question} className={`whitespace-pre-wrap break-words ${expanded ? '' : 'line-clamp-6'}`}>{item.question}</div></div>
    </div>}
    {(clamped || expanded) && <Button variant="ghost" size="sm" className={chat ? 'ml-auto flex h-6 px-2 text-xs text-muted-foreground' : undefined} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{chat ? (expanded ? 'Show less' : 'Show more') : (expanded ? 'Collapse question' : 'Expand question')}</Button>}
    {item.answer && agentBody(item.answer, item.answerSeq)}
    {item.interim && <div className="space-y-1"><h3 className="px-2 text-xs font-medium text-muted-foreground">Interim reply</h3>{agentBody(item.interim, item.interimSeq)}</div>}
    {item.note && <p className="px-2 text-sm text-muted-foreground whitespace-pre-wrap">{item.note}</p>}
    <div className="flex items-center gap-0.5 px-1 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {!item.threadDeleted && <Button asChild size="sm" {...iconProps('Open in chat')}><UrlLink href={href} onClick={() => { void act(() => rpc.call('markRead', { ids: [item.id] })); }}><Icon name="ExternalLink" aria-hidden /></UrlLink></Button>}
      {markable && unread && <Button size="sm" {...iconProps('Mark read')} onClick={() => void act(() => rpc.call('markRead', { ids: [item.id] }))}><Icon name="MailOpen" aria-hidden /></Button>}
      {item.kind !== 'saved' && <Button size="sm" {...iconProps(item.pinned ? 'Remove from Saved' : 'Save')} aria-pressed={item.pinned} onClick={() => void act(() => rpc.call('setPinned', { id: item.id, pinned: !item.pinned }))}><Icon name="Star" aria-hidden className={item.pinned ? 'fill-current' : undefined} /></Button>}
      {dismiss && <Button size="sm" {...iconProps(dismiss[0])} onClick={() => void act(() => rpc.call('setDismissed', { id: item.id, dismissed: true }))}><Icon name={dismiss[1]} aria-hidden /></Button>}
      {item.kind !== 'saved' && !item.threadDeleted && <Button size="sm" {...iconProps('Reply')} disabled={pending || (item.kind === 'for_me' && item.status === 'replied')} aria-expanded={replying} onClick={() => setReplying(!replying)}><Icon name="ArrowTurnBackward" aria-hidden /></Button>}
      {chat && item.status !== 'answered' && <span className="ml-1 text-xs">{item.status}</span>}
    </div>
    {replying && <Composer label="Reply text" sendLabel="Send reply" autoFocus value={text} onChange={setText} attachments={files} onAttachments={update => setFiles(update)} projectId={item.projectId} pending={pending} sendDisabled={!text.trim()} onSend={options => void reply(options)} />}
    {feedback && <p role="status">{feedback}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </li>;
}

function Page({ threadId, view, projectId, query, questions, cursor }: { threadId?: string; view: View; projectId?: string; query: string; questions?: boolean; cursor?: string }) {
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view, ...(questions ? { questions } : {}), ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}), query, ...(cursor ? { cursor } : {}), limit: 50 } });
  const [next, setNext] = useState(false);
  return <>
    {result.isLoading && <p role="status" className="px-2 text-xs text-muted-foreground">Loading answers…</p>}
    {result.error && <div role="alert">{result.error.message} <Button variant="outline" onClick={() => void result.refetch()}><Icon name="ArrowReloadHorizontal" aria-hidden />Retry</Button></div>}
    {result.data && <>
      {!cursor && !result.data.items.length && <EmptyState icon={emptyCopy[view][0]} title={emptyCopy[view][1]}>{query ? 'Nothing matches this search.' : emptyCopy[view][2]}</EmptyState>}
      <ul aria-label="Answers" className={threadId ? 'divide-y divide-border-seam' : 'space-y-3'}>{result.data.items.map(item => <ItemCard key={item.id} item={item} chat={!!threadId} markable />)}</ul>
      {result.data.nextCursor && (next ? <Page key={result.data.nextCursor} {...{ threadId, view, projectId, query, questions }} cursor={result.data.nextCursor} /> : <Button variant="outline" onClick={() => setNext(true)}>Load more</Button>)}
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
  const [projectId, setProjectId] = useStoredState(threadId ? null : 'bb-plugin-answers:page:project', '');
  const [questions, setQuestions] = useStoredState(threadId ? null : 'bb-plugin-answers:page:questions', false);
  const [error, setError] = useState('');
  const list = view === 'saved' || view === 'all';
  return <section className="flex h-full flex-col">
    {threadId && <Pools threadId={threadId} />}
    <div className="space-y-2 border-b border-border-seam px-3 py-2">
      <div className="flex items-center gap-1">
        <ViewPicker options={viewOptions(!!threadId)} value={view} onChange={setView} />
        <span className="flex-1" />
        {view !== 'for_me' && <Button size="sm" variant="ghost" className={`h-7 gap-1.5 px-2 text-xs ${questions ? 'bg-state-active text-foreground' : 'text-muted-foreground'}`} aria-pressed={questions} aria-label="Questions only" onClick={() => setQuestions(!questions)}><Icon name="MessageQuestion" aria-hidden className="size-3.5" />Questions</Button>}
        {(view === 'inbox' || view === 'unread') && <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-xs text-muted-foreground" onClick={async () => { setError(''); try { await rpc.call('markRead', { all: true, ...(threadId ? { threadId } : {}) }); refresh(); } catch (cause) { setError(message(cause)); } }}><Icon name="MailOpen" aria-hidden className="size-3.5" />Mark all read</Button>}
      </div>
      {list && <div className="flex gap-2">
        <input aria-label="Search answers" type="search" placeholder={view === 'saved' ? 'Search saved' : 'Search history'} maxLength={4000} className="min-w-0 flex-1 rounded-md border border-border-seam bg-transparent px-2.5 py-1 text-sm outline-none focus:border-ring" value={query} onChange={event => setQuery(event.target.value)} />
        {!threadId && <select aria-label="Project" className="max-w-40 rounded-md border border-border-seam bg-background px-2 py-1 text-sm" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>}
      </div>}
    </div>
    {error && <p role="alert" className="px-4 pt-2 text-sm text-destructive">{error}</p>}
    {view === 'inbox' ? <div className="min-h-0 flex-1"><Inbox questions={questions} /></div> : <div className="min-h-0 flex-1 overflow-auto p-4"><Page key={JSON.stringify([threadId, view, query, projectId, questions])} {...{ threadId, view, questions }} query={list ? query : ''} projectId={list ? projectId || undefined : undefined} /></div>}
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
  app.slots.messageAction({ id: 'save', title: 'Save to Answers', icon: 'Star', async run({ threadId, message, selectedText }) {
    const input = rpcContract.save.input.parse({ threadId, seq: message.experimental_messageSeq, role: message.role, text: selectedText ?? message.text });
    // Message actions have no React hook context; use the public plugin RPC endpoint.
    const response = await fetch('/api/v1/plugins/answers/rpc/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok || body?.ok !== true) throw new Error(body?.error?.message ?? `Unable to save to Answers (${response.status})`);
    rpcContract.save.output.parse(body.result);
  } });
});
