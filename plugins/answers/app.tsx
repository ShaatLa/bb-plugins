import { useEffect, useRef, useState } from 'react';
import { definePluginApp, experimental_Icon as Icon, Markdown, UrlLink, useRpc, experimental_useRpcQuery as useQuery, experimental_useSidebarThreads, experimental_useAppPanel, experimental_usePanelTabs, experimental_useRpcRefresh } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AnswersRpcContract, type Item, type View } from './contract';
import { Inbox, Pools } from './inbox';
import { Button } from './components/ui/button';

const views: [View, string][] = [['waiting', 'Waiting'], ['for_me', 'For me'], ['pinned', 'Pinned'], ['saved', 'Saved'], ['all', 'All']];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function useAnswersBadge() {
  const { data } = useQuery({ contract: rpcContract, method: 'counts', input: {} });
  const count = data ? data.inbox : 0;
  return count ? { count, label: `${count} unread answers and questions for you` } : null;
}

export function ItemCard({ item }: { item: Item }) {
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
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const sending = useRef(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  async function act(write: () => Promise<unknown>) {
    setError('');
    try { await write(); refresh(); } catch (cause) { setError(message(cause)); }
  }
  async function reply() {
    if (sending.current || !text.trim()) return;
    sending.current = true;
    setPending(true); setError(''); setFeedback('');
    try {
      const result = await rpc.call('reply', { id: item.id, text });
      refresh(); setFeedback(result.delivery === 'sent' ? 'Sent' : 'Queued'); setText(''); setReplying(false);
    } catch (cause) {
      setError(`Delivery uncertain — check the thread before retrying. ${message(cause)}`);
    } finally { sending.current = false; setPending(false); }
  }
  const seq = item.answerSeq ?? item.questionSeq;
  // BB's message routes use the project prefix when the thread belongs to a project.
  const href = `${item.projectId ? `/projects/${encodeURIComponent(item.projectId)}` : ''}/threads/${encodeURIComponent(item.threadId)}${seq === null ? '' : `?msg=${seq}`}`;
  const minutes = Math.max(0, Math.floor((Date.now() - item.createdAt) / 60000));
  const age = minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
  return <li className="rounded-lg border p-4 space-y-3">
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <h2 className="font-medium text-foreground">{item.threadTitle ?? 'Untitled thread'}</h2>
      {item.projectName && <span>{item.projectName}</span>}
      <span className="rounded border px-1.5 py-0.5">{item.status}</span>
      <time dateTime={new Date(item.createdAt).toISOString()}>{age}</time>
      {item.threadDeleted && <span>Thread deleted</span>}
    </div>
    <div ref={question} className={`rounded-lg p-3 whitespace-pre-wrap break-words ${item.kind === 'for_me' ? 'bg-muted' : 'ml-auto max-w-[90%] border'} ${expanded ? '' : 'line-clamp-2'}`}>{item.kind === 'for_me' ? <><span>Question for you</span><div className="rounded-lg bg-muted p-3" data-agent-body data-item={item.id} data-seq={item.questionSeq ?? undefined}><Markdown content={item.question} /></div></> : item.question}</div>
    {(clamped || expanded) && <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? 'Collapse question' : 'Expand question'}</Button>}
    {item.answer && <div className="rounded-lg bg-muted p-3" data-agent-body data-item={item.id} data-seq={item.answerSeq ?? undefined}><Markdown content={item.answer} /></div>}
    {item.interim && <div><h3 className="text-sm font-medium">Interim reply</h3><div className="rounded-lg bg-muted p-3" data-agent-body data-item={item.id} data-seq={item.interimSeq ?? undefined}><Markdown content={item.interim} /></div></div>}
    {item.note && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{item.note}</p>}
    <div className="flex flex-wrap gap-2">
      {!item.threadDeleted && <Button asChild size="sm" variant="outline"><UrlLink href={href} onClick={() => { void act(() => rpc.call('markRead', { ids: [item.id] })); }}><Icon name="ExternalLink" aria-hidden />Open in chat</UrlLink></Button>}
      <Button size="sm" variant="outline" onClick={() => void act(() => rpc.call('markRead', { ids: [item.id] }))}><Icon name="MailOpen" aria-hidden />Mark read</Button>
      <Button size="sm" variant="outline" aria-pressed={item.pinned} onClick={() => void act(() => rpc.call('setPinned', { id: item.id, pinned: !item.pinned }))}><Icon name={item.pinned ? 'PinOff' : 'Pin'} aria-hidden />{item.pinned ? 'Unpin' : 'Pin'}</Button>
      <Button size="sm" variant="outline" disabled={item.dismissedAt !== null} onClick={() => void act(() => rpc.call('setDismissed', { id: item.id, dismissed: true }))}><Icon name="Check" aria-hidden />Done</Button>
      {item.kind !== 'saved' && !item.threadDeleted && <Button size="sm" variant="outline" disabled={pending || (item.kind === 'for_me' && item.status === 'replied')} aria-expanded={replying} onClick={() => setReplying(!replying)}><Icon name="ArrowTurnBackward" aria-hidden />Reply</Button>}
    </div>
    {replying && <form className="space-y-2" onSubmit={event => { event.preventDefault(); void reply(); }}>
      <textarea aria-label="Reply text" className="w-full rounded border bg-transparent p-2 text-sm" maxLength={8000} value={text} disabled={pending} onChange={event => setText(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void reply(); } }} />
      <Button type="submit" size="sm" disabled={pending || !text.trim()}><Icon name="Sent" aria-hidden />{pending ? 'Sending…' : 'Send reply'}</Button>
    </form>}
    {feedback && <p role="status">{feedback}</p>}{error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </li>;
}

function Page({ threadId, view, projectId, query, cursor }: { threadId?: string; view: View; projectId?: string; query: string; cursor?: string }) {
  const result = useQuery({ contract: rpcContract, method: 'list', input: { view, ...(threadId ? { threadId } : {}), ...(projectId ? { projectId } : {}), query, ...(cursor ? { cursor } : {}), limit: 50 } });
  const [next, setNext] = useState(false);
  return <>
    {result.isLoading && <p role="status">Loading answers…</p>}
    {result.error && <div role="alert">{result.error.message} <Button variant="outline" onClick={() => void result.refetch()}><Icon name="ArrowReloadHorizontal" aria-hidden />Retry</Button></div>}
    {result.data && <>
      {!cursor && !result.data.items.length && <p className="text-muted-foreground">No answers in this view.</p>}
      <ul aria-label="Answers" className="space-y-3">{result.data.items.map(item => <ItemCard key={item.id} item={item} />)}</ul>
      {result.data.nextCursor && (next ? <Page key={result.data.nextCursor} {...{ threadId, view, projectId, query }} cursor={result.data.nextCursor} /> : <Button variant="outline" onClick={() => setNext(true)}>Load more</Button>)}
    </>}
  </>;
}

export function AnswersPanel({ threadId }: { threadId?: string }) {
  const rpc = useRpc<AnswersRpcContract>();
  // Refresh reads after our own writes instead of relying only on the server's realtime invalidation.
  const { refresh } = experimental_useRpcRefresh();
  const { projects } = experimental_useSidebarThreads();
  const [view, setView] = useState<View | 'inbox'>(threadId ? 'all' : 'inbox');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState('');
  const [error, setError] = useState('');
  return <section className="h-full overflow-auto p-4 space-y-4">
    <h1 className="text-lg font-semibold">{threadId ? 'My questions' : 'Answers'}</h1>
    {threadId && <Pools threadId={threadId} />}
    <nav aria-label="Answer views" className="flex flex-wrap gap-1"><Button size="sm" variant="ghost" aria-pressed={view === 'inbox'} onClick={() => setView('inbox')}>Inbox</Button>{views.map(([value, label]) => <Button key={value} size="sm" variant="ghost" aria-pressed={view === value} onClick={() => setView(value)}>{label}</Button>)}</nav>
    {view !== 'inbox' && <div className="flex flex-wrap gap-2">
      <input aria-label="Search answers" type="search" placeholder="Search answers" maxLength={4000} className="rounded border bg-transparent px-3 py-1 text-sm" value={query} onChange={event => setQuery(event.target.value)} />
      <select aria-label="Project" className="rounded border bg-background px-2 py-1 text-sm" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">All projects</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
      <Button size="sm" variant="outline" onClick={async () => { setError(''); try { await rpc.call('markRead', { all: true, ...(threadId ? { threadId } : {}) }); refresh(); } catch (cause) { setError(message(cause)); } }}><Icon name="MailOpen" aria-hidden />Mark all read</Button>
    </div>}
    {error && <p role="alert">{error}</p>}
    {view === 'inbox' ? <Inbox /> : <Page key={JSON.stringify([threadId, view, query, projectId])} {...{ threadId, view, query }} projectId={projectId || undefined} />}
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
