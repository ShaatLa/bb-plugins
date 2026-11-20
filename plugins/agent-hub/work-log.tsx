import { FullTranscriptContext } from './full-transcript';
import { useContext, useEffect, useState, type ReactNode } from 'react';
import { ActivityLabelContext } from './robot-loader';
import { experimental_Icon as Icon, UrlLink, useSdk } from '@get-bb/plugin-sdk/app';
import { AgentMarkdown } from './inline-vis';
import type { IconName } from './empty';

type Sdk = ReturnType<typeof useSdk>;
type Page = Awaited<ReturnType<Sdk['threads']['timelineTurnSummaryDetails']>>;
export type Row = Page['rows'][number];
type Work = Extract<Row, { kind: 'work' }>;
type Turn = Extract<Row, { kind: 'turn' }>;
const cache = new Map<string, { page?: Page; pending?: Promise<Page>; finished: boolean; lastRead?: number; turn?: { turnId: string; sourceSeqStart: number; sourceSeqEnd: number; startedAt?: number } }>();
export function duration(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m ${seconds % 60}s` : seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}
const count = (n: number, noun: string, plural = `${noun}s`) => `${n} ${n === 1 ? noun : plural}`;

// Preserve conversation boundaries, including across nested turn rows.
export function groupRows(rows: Row[], answerSeq?: number | null, answer?: string | null): (Work[] | Extract<Row, { kind: 'conversation' }>)[] {
  const groups: ReturnType<typeof groupRows> = [], flat: Row[] = [];
  const flatten = (rows: Row[]) => { for (const row of rows) row.kind === 'turn' ? flatten(row.children ?? []) : flat.push(row); };
  flatten(rows);
  // Like bb's chat, the messages written in a row just before the answer are its reply, shown below the log; one is hidden only if its text is in the answer.
  const isAssistant = (row?: Row): row is Extract<Row, { kind: 'conversation' }> => row?.kind === 'conversation' && row.role === 'assistant';
  const hidden = new Set<Row>(), end = flat.findIndex(row => isAssistant(row) && row.messageSeq === answerSeq);
  if (end >= 0) { hidden.add(flat[end]!); for (let i = end - 1; answer && isAssistant(flat[i]) && answer.includes((flat[i] as { text: string }).text); i--) hidden.add(flat[i]!); }
  for (const row of flat) {
    if (row.kind === 'work' && !('presentation' in row && row.presentation?.suppress)) {
      const last = groups.at(-1); if (Array.isArray(last)) last.push(row); else groups.push([row]);
    } else if (isAssistant(row) && !hidden.has(row)) groups.push(row);
  }
  return groups;
}

export function summarize(rows: Work[]) {
  const categories = new Map<string, number>(), files = new Set<string>(), edits = new Set<string>();
  const add = (key: string, n = 1) => categories.set(key, (categories.get(key) ?? 0) + n);
  for (const row of rows) {
    switch (row.workKind) {
      case 'command': {
        if (row.activityIntents.length && row.activityIntents.every(i => i.type !== 'unknown')) {
          for (const intent of row.activityIntents) { if (intent.type === 'read' && intent.path) { if (files.has(intent.path)) continue; files.add(intent.path); } add(intent.type === 'read' ? 'file' : intent.type === 'list_files' ? 'list' : 'search'); }
        } else add('command'); break;
      }
      case 'file-read': if (!files.has(row.path)) { files.add(row.path); add('file'); } break;
      case 'search': add(row.mode === 'list' ? 'list' : 'search'); break;
      case 'file-change': if (!edits.has(row.change.path)) { edits.add(row.change.path); add('edit'); } break;
      case 'web-search': add('query', Math.max(1, row.queries.length)); break;
      case 'web-fetch': add('page'); break;
      case 'image-view': add('view'); break;
      case 'image-generation': add('image'); break;
      case 'delegation': add('subagent'); break;
      case 'plan-steps': add('plan'); break;
      case 'extension': add('plugin step'); break;
      default: add('tool');
    }
  }
  const seen = new Set<string>();
  const parts = [...categories].map(([key, n]) => {
    const family = ['file', 'list', 'search'].includes(key) ? 'exploration' : ['query', 'page'].includes(key) ? 'research' : key;
    if (seen.has(family)) return null; seen.add(family);
    if (family === 'exploration') return `Explored ${[...categories].filter(([k]) => ['file', 'list', 'search'].includes(k)).map(([k, v]) => count(v, k, k === 'search' ? 'searches' : undefined)).join(', ')}`;
    if (family === 'research') return `Researched ${[...categories].filter(([k]) => ['query', 'page'].includes(k)).map(([k, v]) => count(v, k === 'query' ? 'search query' : 'web page', k === 'query' ? 'search queries' : undefined)).join(', ')}`;
    switch (key) {
      case 'file': case 'list': case 'search': return `Explored ${count(n, key, key === 'search' ? 'searches' : undefined)}`;
      case 'edit': return `Edited ${count(n, 'file')}`;
      case 'query': return `Researched ${count(n, 'search query', 'search queries')}`;
      case 'page': return `Researched ${count(n, 'web page')}`;
      case 'view': return `Viewed ${count(n, 'image')}`;
      case 'image': return `Generated ${count(n, 'image')}`;
      case 'plan': return `Updated plan ${count(n, 'time')}`;
      default: return `Ran ${count(n, key)}`;
    }
  }).filter((part): part is string => part !== null);
  return { text: parts.map((s, i) => i ? s[0]!.toLowerCase() + s.slice(1) : s).join(', '), errors: rows.filter(r => r.status === 'error').length };
}
function workLabel(row: Work) {
  const presentation = 'presentation' in row ? row.presentation : undefined;
  if (presentation) return `${presentation.label[row.status === 'pending' ? 'pending' : 'completed']}${presentation.title ? ` ${presentation.title}` : ''}`;
  switch (row.workKind) {
    case 'command': return `${row.status === 'pending' ? 'Running' : 'Ran'} ${row.command}`;
    case 'tool': return `${row.status === 'pending' ? 'Running' : 'Ran'} ${row.toolName}`;
    case 'file-read': return `${row.status === 'pending' ? 'Reading' : 'Read'} ${row.path}`;
    case 'search': return `${row.mode === 'list' ? 'Listed' : 'Searched'} ${row.path ?? ''}`;
    case 'file-change': return `Edited ${row.change.path}`;
    case 'web-search': return `Ran web search: ${row.queries.join(', ')}`;
    case 'web-fetch': return `Fetched: ${row.url}`;
    case 'image-view': return `Viewed image: ${row.path}`;
    default: return row.workKind.replaceAll('-', ' ');
  }
}
function WorkGroup({ rows, threadId }: { rows: Work[]; threadId: string }) {
  const [open, setOpen] = useState(false), summary = summarize(rows);
  return <div className="text-xs text-muted-foreground">
    <button type="button" aria-expanded={open} className="max-w-full text-left" onClick={() => setOpen(!open)}>{summary.text}{summary.errors > 0 && <span className="ml-2 font-mono">{count(summary.errors, 'error')}</span>} <Icon name={open ? 'ChevronDown' : 'ChevronRight'} aria-hidden className="inline size-3" /></button>
    {open && rows.map(row => <WorkStep key={row.id} row={row} threadId={threadId} />)}
  </div>;
}

function WorkStep({ row, threadId }: { row: Work; threadId: string }) {
  const openTranscript = useContext(FullTranscriptContext);
  const sdk = useSdk(), [open, setOpen] = useState(false), [detail, setDetail] = useState<Work>(), [error, setError] = useState('');
  useEffect(() => {
    if (!open || detail || !row.turnId) return;
    let live = true;
    void sdk.threads.timelineTurnSummaryDetails({ threadId, turnId: row.turnId, sourceSeqStart: String(row.sourceSeqStart), sourceSeqEnd: String(row.sourceSeqEnd), itemId: row.id, deferContent: 'false' }).then(page => {
      const found = page.rows.find((r): r is Work => r.kind === 'work' && r.id === row.id);
      if (live) { if (found) setDetail(found); else setError('Step detail is unavailable'); }
    }).catch(e => { if (live) setError(String(e)); });
    return () => { live = false; };
  }, [sdk, threadId, row, open, detail]);
  const content = detail ?? (!row.turnId ? row : undefined);
  const text = content?.workKind === 'command' ? [content.command, content.cwd, content.output, content.exitCode == null ? '' : `Exit code: ${content.exitCode}`].filter(Boolean).join('\n') : content?.workKind === 'tool' ? [JSON.stringify(content.toolArgs, null, 2), content.output].filter(Boolean).join('\n') : content?.workKind === 'file-change' ? content.change.diff : undefined;
  return <div className="min-w-0 py-0.5">
    <button type="button" aria-expanded={open} className="flex w-full min-w-0 items-center gap-1.5 text-left" onClick={() => setOpen(!open)}><Icon name={open ? 'ChevronDown' : 'ChevronRight'} aria-hidden className="size-3 shrink-0" /><span className="truncate">{workLabel(row)}</span>{(row.status === 'error' || row.status === 'interrupted') && <span>{row.status}</span>}{'completedAt' in row && row.completedAt != null && <span className="shrink-0 text-subtle-foreground">{duration(row.completedAt - row.startedAt)}</span>}</button>
    {open && <div className="ml-4 rounded-md border border-border-seam p-2">{error ? <p role="alert">{error}</p> : !content ? <span>Loading detail…</span> : text ? <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">{text}</pre> : <span>Detail is available in the full transcript.</span>}{openTranscript ? <button type="button" className="mt-1 block text-xs underline" onClick={openTranscript}>Full transcript</button> : <UrlLink data-bb-chat className="mt-1 block text-xs" href={`/threads/${threadId}?msg=${row.sourceSeqStart}`}>Full transcript</UrlLink>}</div>}
  </div>;
}

export function ThreadPlan({ threadId }: { threadId: string }) {
  const sdk = useSdk(), [todos, setTodos] = useState<Awaited<ReturnType<typeof sdk.status.get>>['pendingTodos']>(null);
  useEffect(() => {
    let live = true, timer: ReturnType<typeof setTimeout> | undefined, unsubscribe: (() => void) | undefined;
    const read = async () => { try {
      const result = await sdk.status.get({ threadId });
      if (!live) return;
      setTodos(result.pendingTodos);
      unsubscribe ??= sdk.subscribe({ event: 'thread:changed', threadId, callback: () => { if (!timer) timer = setTimeout(() => { timer = undefined; void read(); }, 2000); } });
    } catch { /* No plan is available. */ } };
    void read();
    return () => { live = false; clearTimeout(timer); unsubscribe?.(); };
  }, [sdk, threadId]);
  return todos?.items.length ? <ul aria-label="Agent plan" className="px-6 py-2 text-xs text-muted-foreground">{todos.items.map(item => <li key={item.id} className="flex items-center gap-2 py-0.5"><Icon name={item.status === 'completed' ? 'Check' : item.status === 'in_progress' ? 'CircleDot' : 'Circle'} aria-hidden className="size-3 shrink-0" /><span className={item.status === 'completed' ? 'line-through' : ''}>{item.text}</span><span className="sr-only">{item.status}</span></li>)}</ul> : null;
}

type Props = { threadId: string; turnId?: string | null; sourceSeqStart?: number | null; sourceSeqEnd?: number | null; startedAt?: number; completedAt?: number | null; answerSeq?: number | null; answer?: string | null; live?: boolean; children?: ReactNode };
// shortcut: an autonomous turn is timed from mount until expanded; use a shared turn clock when the SDK exposes one without fetching.
export function WorkLog(props: Props) {
  const [open, setOpen] = useState(false), [mountedAt] = useState(Date.now);
  const log = useTurnLog(props, open);
  return <div className="flow-root text-sm leading-relaxed">
    {props.children && <div className="float-left mr-2 flex">{props.children}</div>}
    {/* The figure fills the lower part of the robot's 32 px box (head at 9 px, feet at its bottom), so the line centres on the figure, not the box. */}
    <ElapsedToggle props={props} startedAt={log.startedAt} mountedAt={mountedAt} open={open} onToggle={() => setOpen(!open)} />
    {open && <LogDetails {...log} threadId={props.threadId} answerSeq={props.answerSeq} answer={props.answer} />}
  </div>;
}
function ElapsedToggle({ props, startedAt, mountedAt, open, onToggle }: { props: Props; startedAt?: number; mountedAt: number; open: boolean; onToggle: () => void }) {
  // The words come from the same events as the robot's scene (useAgentActivity), so they change together and cost no request.
  const doing = useContext(ActivityLabelContext), [now, setNow] = useState(Date.now);
  useEffect(() => { if (!props.live) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [props.live]);
  const took = duration((props.live ? now : props.completedAt ?? props.startedAt ?? mountedAt) - (props.startedAt ?? startedAt ?? mountedAt));
  const label = !props.live ? `Worked for ${took}` : doing ? `${doing} · ${took}` : `Working for ${took}`;
  return <button type="button" title={label} className={`flex min-w-0 max-w-full items-center gap-1 overflow-hidden text-left text-xs text-muted-foreground ${props.children ? 'h-8 pt-[9px]' : 'py-1'}`} aria-expanded={open} onClick={onToggle}><span className="min-w-0 truncate">{label}</span><Icon name={open ? 'ChevronDown' : 'ChevronRight'} aria-hidden className="size-3 shrink-0" /></button>
}
function useTurnLog({ threadId, turnId, sourceSeqStart, sourceSeqEnd, live }: Props, enabled: boolean) {
  const sdk = useSdk(), key = `${threadId}:${turnId ?? 'active'}`;
  const [page, setPage] = useState(() => cache.get(key)?.page), [error, setError] = useState(''), [loading, setLoading] = useState(false), [startedAt, setStartedAt] = useState(() => cache.get(key)?.turn?.startedAt);
  useEffect(() => {
    if (!enabled) return;
    let active = true, timer: ReturnType<typeof setTimeout> | undefined;
    const entry: NonNullable<ReturnType<typeof cache.get>> = cache.get(key) ?? { finished: false }; cache.set(key, entry);
    setPage(entry.page); setStartedAt(entry.turn?.startedAt);
    const read = async () => {
      entry.lastRead = Date.now(); setError('');
      try {
        if (!entry.pending) entry.pending = (async () => {
          let id = turnId, start = sourceSeqStart, end = sourceSeqEnd, started: number | undefined;
          if (!id || start == null || end == null) {
            // The newest segments hold the live turn. summaryOnly now returns no rows, and a running turn has no 'turn' row
            // yet, only its own steps: those give its id and first seq, and its end stays open.
            const timeline = await sdk.threads.timeline({ threadId, segmentLimit: '3' });
            const current = id ?? timeline.rows.filter(r => 'turnId' in r && r.turnId).at(-1)?.turnId as string | undefined;
            const turn = timeline.rows.find((r): r is Turn => r.kind === 'turn' && r.turnId === current);
            const steps = timeline.rows.filter(r => 'turnId' in r && r.turnId === current);
            if (turn) { id = turn.turnId; start = turn.sourceSeqStart; end = turn.sourceSeqEnd; started = turn.startedAt; }
            else if (current && steps.length) { id = current; start ??= Math.min(...steps.map(r => r.sourceSeqStart)); end = Number.MAX_SAFE_INTEGER; started = Math.min(...steps.map(r => r.startedAt ?? Infinity)); if (!Number.isFinite(started)) started = undefined; }
            else throw new Error('Turn details are not available yet');
          }
          entry.turn = { turnId: id, sourceSeqStart: start, sourceSeqEnd: end, startedAt: started ?? entry.turn?.startedAt };
          return sdk.threads.timelineTurnSummaryDetails({ threadId, turnId: id, sourceSeqStart: String(start), sourceSeqEnd: String(end), deferContent: 'true' });
        })();
        const next = await entry.pending;
        if (entry.page && live) { const ids = new Set(next.rows.map(r => r.id)); next.rows = [...entry.page.rows.filter(r => !ids.has(r.id) && r.sourceSeqEnd < (next.rows[0]?.sourceSeqStart ?? 0)), ...next.rows]; next.olderCursor = entry.page.olderCursor; }
        entry.page = next; entry.finished = !live;
        if (active) { setPage(entry.page); setStartedAt(entry.turn?.startedAt); }
      } catch (cause) { if (active) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { entry.pending = undefined; }
    };
    const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = undefined; void read(); }, Math.max(0, 2000 - (Date.now() - (entry.lastRead ?? 0)))); };
    if (!entry.page || !entry.finished) { if (!entry.lastRead || !live) void read(); else schedule(); }
    const unsubscribe = live ? sdk.subscribe({ event: 'thread:changed', threadId, callback: schedule }) : undefined;
    return () => { active = false; clearTimeout(timer); unsubscribe?.(); };
  }, [sdk, key, live, enabled]);
  const earlier = async () => {
    const turn = cache.get(key)?.turn;
    if (!page?.olderCursor || !turn || loading) return;
    setLoading(true); setError('');
    try {
      const older = await sdk.threads.timelineTurnSummaryDetails({ threadId, turnId: turn.turnId, sourceSeqStart: String(turn.sourceSeqStart), sourceSeqEnd: String(turn.sourceSeqEnd), beforeCursor: page.olderCursor, deferContent: 'true' });
      const next = { ...older, rows: [...older.rows, ...page.rows] }; cache.get(key)!.page = next; setPage(next);
    } catch (cause) { setError(String(cause)); } finally { setLoading(false); }
  };
  return { page, error, loading, earlier, startedAt };
}
function LogDetails({ page, error, loading, earlier, threadId, answerSeq, answer }: ReturnType<typeof useTurnLog> & { threadId: string; answerSeq?: number | null; answer?: string | null }) {
  return <div className="ml-1 space-y-2 border-l border-border-seam pl-3">
    {!page && !error && <div aria-label="Loading work log" className="space-y-2 py-1"><div className="h-2 w-36 rounded bg-muted" /><div className="h-2 w-24 rounded bg-muted" /></div>}
    {page?.olderCursor && <button type="button" className="text-xs text-muted-foreground" disabled={loading} onClick={() => void earlier()}>Earlier</button>}
    {page && groupRows(page.rows, answerSeq, answer).map(group => Array.isArray(group) ? <WorkGroup key={group[0]!.id} rows={group} threadId={threadId} /> : <div key={group.id} className="text-sm leading-relaxed"><AgentMarkdown content={group.text} threadId={threadId} /></div>)}
    {error && <p role="alert" className="text-xs text-muted-foreground">{error}</p>}
  </div>;
}
