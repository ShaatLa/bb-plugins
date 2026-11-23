import { usePreferences } from './use-preferences';
import { threadTarget } from './thread-target';
import { Fragment, useEffect, useRef, useState, type ComponentProps } from 'react';
import { useFlip } from './flip';
import { useDraftThreads } from './drafts';
import { useRpc, useBbNavigate, experimental_useSidebarNavigation, experimental_useSidebarNavigationSplit, experimental_useSidebarThreadSplit, experimental_useSidebarThreads, experimental_useProviders, experimental_useRpcQuery as useQuery, experimental_Icon as Icon, experimental_ProviderIcon as ProviderIcon, experimental_ThreadActionsContextMenu as ThreadActionsContextMenu, experimental_THREAD_ACTION_GROUPS as THREAD_ACTION_GROUPS, experimental_copyToClipboard as copyToClipboard, experimental_ThreadStatusGlyph as ThreadStatusGlyph, experimental_resolveThreadStatus as resolveThreadStatus, type PluginThreadListProps } from '@get-bb/plugin-sdk/app';
import { rpcContract, type AgentHubRpcContract } from './contract';
import { useStoredState } from './lib/stored-state';
import { Avatar, ago } from './inbox';
import { useSteadyError } from './app';
import { EmptyState } from './empty';
import { beginContactDrag, mountSidebarContacts, selectContact, useSelectedContact } from './open-chat';
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
// bb refetches plugin queries on focus only while its realtime socket is down, so the list polls itself; one clock per key is shared by all mounts.
const POLL_MS = 3000, HUNG_MS = 15000, readClock = new Map<string, { settledAt: number; startedAt: number | null; mounts: number }>();
export function useContacts(selected: string | undefined) {
  const rpc = useRpc<AgentHubRpcContract>(), sidebar = experimental_useSidebarThreads(), sidebarThreads = sidebar.threads;
  const providers = experimental_useProviders().providers;
  const bbReadKey = sidebarThreads.filter(t => !t.isUnread).map(t => t.id).join(' '), firstBbRead = useRef(true);
  const [error, setError] = useState('');
  // Like a collapsed row in bb's sidebar, a contact counts its sub-threads' work, so a manager shows busy while its leads run.
  const children = new Map<string, typeof sidebarThreads[number][]>();
  for (const t of sidebarThreads) if (t.parentThreadId) children.set(t.parentThreadId, [...(children.get(t.parentThreadId) ?? []), t]);
  const descendants = (id: string): typeof sidebarThreads[number][] => (children.get(id) ?? []).flatMap(t => [t, ...descendants(t.id)]);
  const drafts = useDraftThreads();
  const statusOf = (thread: typeof sidebarThreads[number]) => resolveThreadStatus({ thread, hiddenThreads: descendants(thread.id), hasUnsubmittedDraft: drafts.has(thread.id) || descendants(thread.id).some(sub => drafts.has(sub.id)), rowStatus: null });
  const ownWorking = (thread: typeof sidebarThreads[number]) => resolveThreadStatus({ thread, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus: null }).isWorking;
  // A contact with sub-sessions previews their tally instead of the last message: direct and deeper ones, working and idle.
  const subTally = (id: string) => {
    const direct = children.get(id)?.length ?? 0, all = descendants(id);
    if (!all.length) return null;
    const working = all.filter(ownWorking).length;
    return [`${direct} sub${all.length > direct ? ` + ${all.length - direct} nested` : ''}`, working && `${working} working`, all.length > working && `${all.length - working} idle`].filter(Boolean).join(' · ');
  };
  type SidebarThread = typeof sidebarThreads[number];
  // rails[k]: whether the node on this row's path at depth k+1 has a later sibling, so the guide line of that level runs on.
  const subTree = (id: string, depth = 1, rails: boolean[] = []): [SidebarThread, number, boolean[]][] => { const kids = children.get(id) ?? []; return kids.flatMap((t, i) => { const own = [...rails, i < kids.length - 1]; return [[t, depth, own] as [SidebarThread, number, boolean[]], ...subTree(t.id, depth + 1, own)]; }); };
  const [openSubs, setOpenSubs] = useStoredState<string[]>('bb-plugin-answers:page:open-subs', []);
  const result = useQuery({ contract: rpcContract, method: 'recipients', input: selected ? { selected } : {} }), recipientsError = useSteadyError(result.error);
  // A thread read in bb drops its unread mark there; refetching recipients lets the server mark the same answers read here,
  // and the server's invalidation refreshes the rest when that changed something.
  useEffect(() => { if (firstBbRead.current) { firstBbRead.current = false; return; } void result.refetch(); }, [bbReadKey]);
  const refetchRef = useRef(result.refetch); refetchRef.current = result.refetch;
  const clockKey = selected ?? '';
  // Poll when the data is older than POLL_MS, and restart a read that has run for HUNG_MS; the reissue resets the shared start so other mounts leave it alone.
  useEffect(() => {
    const clock = readClock.get(clockKey) ?? { settledAt: Date.now(), startedAt: null, mounts: 0 }; readClock.set(clockKey, clock); clock.mounts++;
    const tick = () => {
      const now = Date.now();
      if (document.visibilityState !== 'visible' || now - clock.settledAt <= POLL_MS || (clock.startedAt !== null && now - clock.startedAt <= HUNG_MS)) return;
      const mine = clock.startedAt = now;
      void refetchRef.current().catch(() => {}).finally(() => { if (clock.startedAt === mine) { clock.startedAt = null; clock.settledAt = Date.now(); } });
    };
    const timer = setInterval(tick, POLL_MS); document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); if (--clock.mounts === 0) readClock.delete(clockKey); };
  }, [clockKey]);
  // The clock moves only when a read starts or ends, never on re-renders, so streaming sidebar updates cannot hold the poll off.
  useEffect(() => { const clock = readClock.get(clockKey); if (!clock) return; if (result.isFetching) clock.startedAt ??= Date.now(); else { clock.startedAt = null; clock.settledAt = Date.now(); } }, [result.isFetching, clockKey]);
  // Each selection has its own cache entry, and a revisited one holds old unread counts until its refetch lands.
  // Show the last settled list instead, so switching neither blanks the list nor flashes stale unread badges.
  const lastRecipients = useRef(result.data); if (result.data && !result.isFetching) lastRecipients.current = result.data; const settledRecipients = lastRecipients.current ?? result.data;
  // bb's sidebar threads are live, so a rename shows at once instead of on the next recipients refetch.
  const liveTitles = new Map(sidebarThreads.flatMap(t => t.title ? [[t.id, t.title] as const] : []));
  const recipients = settledRecipients && { ...settledRecipients, recipients: settledRecipients.recipients.map(r => ({ ...r, threadTitle: liveTitles.get(r.threadId) ?? r.threadTitle })) };
  // Optional project headers. bb's sidebar keeps its own (client-local) project order in Custom mode and offers no way
  // to read it, so Agent Hub keeps its order in plugin settings; projects missing from it follow in bb's project order.
  const prefs = usePreferences().data, byProject = prefs?.groupByProject === true, grouped = new Map<string | null, NonNullable<typeof recipients>['recipients']>();
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

  return { sidebar, sidebarThreads, providers, recipients, recipientsError, descendants, statusOf, ownWorking, subTally, subTree, openSubs, setOpenSubs, groups, order, drag, setDrag, moveProject, error, setError };
}
function ContactRow({ threadId, split, ...props }: ComponentProps<'button'> & { threadId: string; split: boolean }) {
  const item = experimental_useSidebarNavigation().items.find(item => item.action.kind === 'open-plugin-panel' && item.action.pluginId === 'agent-hub' && item.action.panelId === 'agent-hub');
  const navigation = experimental_useSidebarNavigationSplit(item?.id ?? '', { onDragStart: () => beginContactDrag(threadId) });
  const thread = experimental_useSidebarThreadSplit(threadId), splitProps = item && navigation.isAvailable ? navigation.splitProps : thread.splitProps;
  return <button {...props} {...(split ? splitProps : {})} />;
}
export function ContactsList({ model, selected, activeThreadId, onSelect, onBulkRead, onNavigate }: { model: ReturnType<typeof useContacts>; selected?: string; activeThreadId?: string | null; onSelect: (id: string) => void; onBulkRead?: (result: { batch: string | null; count: number }) => void; onNavigate?: () => void }) {
  const rpc = useRpc<AgentHubRpcContract>();
  const { sidebarThreads, providers, recipients, recipientsError, statusOf, subTally, subTree, descendants, openSubs, setOpenSubs, groups, order, drag, setDrag, moveProject, error, setError } = model;
  const list = useRef<HTMLDivElement>(null); useFlip(list);
  // A sub-session asking the owner (an Agent Hub question or bb's own question or approval) stays visible under a collapsed parent.
  const asking = new Set(recipients?.asking ?? []), asks = (t: typeof sidebarThreads[number]) => asking.has(t.id) || resolveThreadStatus({ thread: t, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus: null }).indicator === 'waiting-for-input';
  return (    <div ref={list} role="listbox" aria-label="Recipients" className="relative flex min-h-0 flex-1 flex-col space-y-0.5 overflow-auto p-2 [&>*]:shrink-0">
      {/* With a list already shown, a failed refresh (e.g. while the plugin restarts) floats over it instead of pushing the rows down. */}
      {error && <p role="alert" className="px-2 py-1 text-xs text-destructive">{error}</p>}
      {recipientsError && <p role="alert" className={recipients ? 'absolute inset-x-2 top-2 z-10 rounded-md border border-border bg-background px-2 py-1 text-xs text-destructive shadow-lift' : 'px-2 py-1 text-xs text-destructive'}>{recipientsError.message}</p>}
      {recipients?.recipients.length === 0 && <EmptyState icon="MailOpen" title="All caught up">New answers from your threads will show up here.</EmptyState>}
      {groups.map(([group, list]) => { const movable = !!group && order.includes(group), over = drag?.over === group && drag.id !== group; return <div key={group ?? ''} role={group !== null ? 'group' : undefined} aria-label={group !== null ? list[0]?.projectName ?? 'No project' : undefined}
        className={`space-y-0.5 ${over ? (drag!.after ? 'shadow-[0_2px_0_0_var(--color-ring,currentColor)]' : 'shadow-[0_-2px_0_0_var(--color-ring,currentColor)]') : ''} ${drag?.id === group ? 'opacity-50' : ''}`}
        onDragOver={event => { if (!drag || !movable || drag.id === group) return; event.preventDefault(); const r = event.currentTarget.getBoundingClientRect(), after = event.clientY > r.top + r.height / 2; if (drag.over !== group || drag.after !== after) setDrag({ ...drag, over: group!, after }); }}
        onDrop={event => { if (!drag || !movable || drag.id === group) return; event.preventDefault(); moveProject(drag.id, group!, !!drag.after); setDrag(null); }}>
        {group !== null && <p data-flip={`group:${group}`} draggable={movable} title={movable ? 'Drag to reorder projects' : undefined} className={`px-2 pb-0.5 pt-2 text-xs font-medium text-muted-foreground ${movable ? 'cursor-grab active:cursor-grabbing' : ''}`}
          onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', group); setDrag({ id: group }); }} onDragEnd={() => setDrag(null)}>{list[0]?.projectName ?? 'No project'}</p>}{list.map(recipient => { const thread = sidebarThreads.find(t => t.id === recipient.threadId), status = thread ? statusOf(thread) : null, tally = subTally(recipient.threadId), busy = !!status && (status.isWorking || status.indicator === 'waiting-for-input'); const rowSelected = selected === recipient.threadId && !subTree(recipient.threadId).some(([sub]) => sub.id === activeThreadId), row = <ContactRow threadId={recipient.threadId} split={!!onNavigate} role="option" aria-selected={rowSelected} className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] leading-5 ${rowSelected ? 'bg-state-active' : 'hover:bg-state-hover'} transition-opacity duration-300 ${recipient.unread ? '' : busy ? 'opacity-80' : 'opacity-50'}`} onKeyDown={event => { const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0; if (!step) return; const options = Array.from(event.currentTarget.closest('[role=listbox]')?.querySelectorAll<HTMLElement>('[role=option]') ?? []); options[options.indexOf(event.currentTarget) + step]?.focus(); }} onClick={async () => {
        if (selected === recipient.threadId) { try { const result = await rpc.call('markThreadRead', { threadId: recipient.threadId }); onBulkRead?.(result); } catch (e) { setError(errorText(e)); } }
        onSelect(recipient.threadId); onNavigate?.();
      }}><span className="relative shrink-0"><Avatar id={recipient.threadId} title={recipient.threadTitle} provider={(id => id ? providers.find(p => p.id === id) ?? { id } : undefined)(thread?.providerId)} />{thread?.hasPendingInteraction && <Icon name="CircleQuestion" aria-label="Needs input" className="absolute -top-1 -left-1 size-3.5 rounded-full bg-background text-attention" />}{recipient.unread - (recipient.questions ?? 0) > 0 && <span aria-label={`${recipient.unread - (recipient.questions ?? 0)} unread`} className="absolute -top-1.5 -right-1.5 min-w-4 rounded-full bg-foreground/85 px-1 text-center text-[10px] font-medium leading-4 text-background ring-2 ring-background">{recipient.unread - (recipient.questions ?? 0)}</span>}</span><span className="min-w-0 flex-1"><span className="flex items-baseline gap-2"><span className={`min-w-0 flex-1 truncate ${recipient.unread ? 'font-medium' : 'font-normal text-muted-foreground'}`}>{recipient.threadTitle ?? 'Untitled thread'}</span><span className="flex shrink-0 items-center text-[11px] text-muted-foreground">{(recipient.questions ?? 0) > 0 || (thread && (asks(thread) || descendants(thread.id).some(asks))) ? <span role="img" aria-label="Asking you" className="inline-flex"><ThreadStatusGlyph indicator="waiting-for-input" size="compact" /></span> : busy || status?.indicator === 'draft' ? <ThreadStatusGlyph indicator={status!.indicator} size="compact" /> : ago(recipient.lastAt)}</span></span><span className={`flex items-center gap-2 ${tally ? 'pr-6' : ''}`}><span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{tally ?? (recipient.preview || recipient.projectName || 'No project')}</span></span></span></ContactRow>
        // bb's own thread menu on right-click (Archive, Pin, Rename, Delete); threads bb does not list keep a plain row.
        const menu = thread ? <ThreadActionsContextMenu thread={threadTarget(thread)}>{row}</ThreadActionsContextMenu> : row;
        if (!tally) return <div key={recipient.threadId} data-flip={recipient.threadId}>{menu}</div>;
        const name = recipient.threadTitle ?? 'Untitled thread';
        // bb's sidebar child rows: 8px plus 24px a level, the provider icon, the title, the status glyph only while working.
        const shownSubs = openSubs.includes(recipient.threadId) ? subTree(recipient.threadId) : subTree(recipient.threadId).filter(([sub]) => asks(sub)).map(([sub], i, all) => [sub, 1, [i < all.length - 1]] as const);
        return <Fragment key={recipient.threadId}><div data-flip={recipient.threadId} className="relative">{menu}<button type="button" aria-label={openSubs.includes(recipient.threadId) ? 'Hide sub-sessions' : 'Show sub-sessions'} aria-expanded={openSubs.includes(recipient.threadId)} className="absolute bottom-1.5 right-[5px] flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-state-hover" onClick={() => setOpenSubs(openSubs.includes(recipient.threadId) ? openSubs.filter(id => id !== recipient.threadId) : [...openSubs, recipient.threadId])}><Icon name={openSubs.includes(recipient.threadId) ? 'ChevronDown' : 'ChevronRight'} className="size-3.5" /></button></div>{shownSubs.length > 0 && <ul data-flip={`${recipient.threadId}:subs`} aria-label={`Sub-sessions of ${name}`} className="pb-1">{shownSubs.map(([sub, depth, rails]) => { const own = resolveThreadStatus({ thread: sub, hiddenThreads: [], hasUnsubmittedDraft: false, rowStatus: null }), info = providers.find(p => p.id === sub.providerId), provider = sub.providerId ? info ?? { id: sub.providerId } : null, providerName = info?.displayName ?? sub.providerId;
          return <li key={sub.id}><ThreadActionsContextMenu thread={threadTarget(sub)} inline={[{ key: 'answers-copy-id', group: THREAD_ACTION_GROUPS.open, action: { label: 'Copy ID', icon: 'Copy', run: () => void copyToClipboard({ text: sub.id }) } }]}>
            <ContactRow split threadId={sub.id} type="button" aria-current={(selected === sub.id || activeThreadId === sub.id) ? 'page' : undefined} onClick={() => { onSelect(sub.id); onNavigate?.(); }} className={`relative flex h-[var(--bb-sidebar-row-height,28px)] w-full items-center gap-2 rounded-md pr-2 text-left text-sm text-sidebar-foreground ${(selected === sub.id || activeThreadId === sub.id) ? 'bg-state-active' : 'hover:bg-state-hover'} has-[[data-state=open]]:bg-sidebar-accent data-[state=open]:bg-sidebar-accent transition-opacity duration-300 ${asks(sub) ? '' : own.isWorking ? 'opacity-80' : 'opacity-50'}`} style={{ paddingLeft: 8 + depth * 24 }}>
              {/* bb's hairline guides, unbroken: each level's line runs under its parent's icon (the contact's avatar for the first)
                  down to its last child, ending at that row's middle. */}
              {rails.map((more, k) => (more || k === depth - 1) && <span key={k} data-guide={k + 1} aria-hidden className={`pointer-events-none absolute top-0 w-px bg-border-hairline opacity-70 ${more ? 'bottom-0' : 'h-1/2'}`} style={{ left: k ? 16 + k * 24 : 24 }} />)}
              <span className="flex min-w-0 flex-1 items-center">{provider && <span role="img" aria-label={providerName ?? undefined} className="mr-2 flex size-4 shrink-0 items-center justify-center text-muted-foreground"><ProviderIcon providerKind="agent" provider={provider} className="size-3.5" /></span>}<span className="min-w-0 truncate">{sub.title ?? 'Untitled thread'}</span></span>
              {asks(sub) ? <span role="img" aria-label="Asking you" className="inline-flex size-4 shrink-0 items-center justify-center text-subtle-foreground"><ThreadStatusGlyph indicator="waiting-for-input" /></span>
                : own.isWorking && <span role="img" aria-label="Working" className="inline-flex size-4 shrink-0 items-center justify-center text-subtle-foreground"><ThreadStatusGlyph indicator={own.indicator} /></span>}
            </ContactRow>
          </ThreadActionsContextMenu></li>; })}</ul>}</Fragment>; })}</div>; })}</div> );
}
export function AgentHubContacts({ activeThreadId, onNavigate }: PluginThreadListProps) {
  const selected = useSelectedContact(), navigate = useBbNavigate(), model = useContacts(selected);
  useEffect(mountSidebarContacts, []);
  return <div className="flex h-full min-h-0 flex-col"><ContactsList model={model} activeThreadId={activeThreadId} selected={selected ?? activeThreadId ?? undefined} onNavigate={onNavigate} onSelect={id => { const mounted = selectContact(id); if (!mounted && window.location.pathname !== '/plugins/agent-hub/agent-hub') navigate.toPluginPanel('agent-hub', { subPath: `?thread=${encodeURIComponent(id)}` }); }} /></div>;
}
