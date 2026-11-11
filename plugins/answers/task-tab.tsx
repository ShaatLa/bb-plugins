import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { experimental_Icon as Icon, experimental_useAppPanel, experimental_useFixedTabTarget, experimental_useRpcQuery as useQuery, Markdown, UrlLink } from '@get-bb/plugin-sdk/app';
import { rpcContract } from './contract';
import { EmptyState } from './empty';
import { ago } from './inbox';
import { Button } from './components/ui/button';
import { TASK_KEY_PATTERN, TASK_LINK } from './task-links';

// The Answers page's Task tab; a target names the task to preview (Work Board's own task tab lives only in threads).
export const TASK_TAB = {
  id: 'task', context: { kind: 'nav-panel', panelId: 'answers' }, availability: 'fixed',
  experimental_target: { validate: (value: unknown): value is { taskKey: string } => typeof value === 'object' && value !== null && typeof (value as { taskKey?: unknown }).taskKey === 'string' && TASK_KEY_PATTERN.test((value as { taskKey: string }).taskKey) },
} as const;
const taskHref = (key: string) => `/plugins/work-board/work-board/task/${encodeURIComponent(key)}`;

// Work Board's StatusIcon (components/status-icon.tsx) for its system statuses; custom statuses get its plain ring.
const STATUS_COLOR: Record<string, string> = { backlog: 'text-subtle-foreground', todo: 'text-subtle-foreground', in_progress: 'text-attention', in_review: 'text-timeline-accent', done: 'text-success', canceled: 'text-subtle-foreground' };
function StatusIcon({ status }: { status: string }) {
  const ring = (dashed: boolean) => <circle cx="7" cy="7" r="5.4" fill="none" stroke="currentColor" strokeWidth="1.6" {...(dashed ? { strokeDasharray: '1.8 2' } : {})} />, disc = <circle cx="7" cy="7" r="6" fill="currentColor" />;
  return <svg viewBox="0 0 14 14" aria-hidden data-status-icon={status} className={`size-3.5 shrink-0 ${STATUS_COLOR[status] ?? 'text-timeline-accent'}`}>
    {status === 'backlog' ? ring(true) : status === 'done' || status === 'canceled' ? disc : ring(false)}
    {status === 'in_progress' && <path d="M7 7 L7 2.4 A4.6 4.6 0 0 1 11.2 9.5 Z" fill="currentColor" />}
    {status === 'in_review' && <path d="M7 7 L7 2.4 A4.6 4.6 0 1 1 6.99 2.4 Z" fill="currentColor" />}
    {status === 'done' && <path d="M4.4 7.2 l1.8 1.8 3.4-3.8" fill="none" stroke="var(--background)" strokeWidth="1.5" strokeLinecap="round" />}
    {status === 'canceled' && <path d="M5 5 l4 4 M9 5 l-4 4" stroke="var(--background)" strokeWidth="1.4" strokeLinecap="round" />}
  </svg>;
}
// Work Board's PriorityIcon and PRIORITY_LABELS (views/detail/meta.tsx, views/list/lib.ts).
const PRIORITY_LABELS: Record<string, string> = { urgent: 'Urgent', high: 'High', medium: 'Medium', low: 'Low', none: 'No priority' };
function PriorityIcon({ priority }: { priority: string }) {
  if (priority === 'urgent') return <span aria-hidden className="flex size-3.5 shrink-0 items-center justify-center rounded-xs bg-warning text-2xs font-extrabold" style={{ color: 'var(--canvas)' }}>!</span>;
  const lit = ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[priority] ?? 0;
  return <svg viewBox="0 0 14 14" aria-hidden className={`size-3.5 shrink-0 ${lit ? '' : 'opacity-40'}`}>{[5, 8, 11].map((height, index) => <rect key={index} x={1.5 + index * 4.5} y={12.5 - height} width="3" height={height} rx="1" fill={index < lit ? 'var(--muted-foreground)' : 'var(--muted)'} />)}</svg>;
}
// Work Board's properties rail row and section heading, read-only.
const Row = ({ label, children }: { label: string; children: ReactNode }) => <div className="-mx-1.5 flex items-center gap-2 rounded-md px-1.5 py-1 text-sm" aria-label={label}>{children}</div>;
const Skeleton = ({ className }: { className: string }) => <div aria-hidden className={`animate-pulse rounded-md bg-muted motion-reduce:animate-none ${className}`} />;

function TaskPreview({ taskKey }: { taskKey: string }) {
  const result = useQuery({ contract: rpcContract, method: 'workBoardTask', input: { taskKey } }), task = result.data?.task;
  const updated = task ? ago(Date.parse(task.updatedAt)) : '';
  return <section aria-label="Task preview" className="flex h-full min-h-0 flex-col">
    {/* Header of Work Board's side-panel tab: key, then its icon actions. */}
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
      {task && <StatusIcon status={task.status} />}
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground">{task?.key ?? taskKey}</span>
      <Button className="size-6 shrink-0 px-0" size="icon" variant="ghost" aria-label="Refresh" disabled={result.isFetching} onClick={() => void result.refetch()}><Icon name="ArrowReloadHorizontal" aria-hidden className="size-4" /></Button>
      <Button asChild className="size-6 shrink-0 px-0" size="icon" variant="ghost"><UrlLink href={taskHref(task?.key ?? taskKey)} aria-label="Open in Work Board" title="Open in Work Board"><Icon name="ArrowUpRight" aria-hidden className="size-4" /></UrlLink></Button>
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto">
      {result.isLoading ? <div role="status" aria-label={`Loading task ${taskKey}`} className="space-y-3 p-4"><Skeleton className="h-7 w-3/4" /><Skeleton className="h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /><Skeleton className="h-24 w-full" /></div>
        : result.error ? <EmptyState icon="AlertCircle" title="Couldn't load this task">{result.error.message}</EmptyState>
        : !result.data?.available ? <EmptyState icon="AlertCircle" title="Work Board is unavailable">Install or enable Work Board to preview {taskKey} here.</EmptyState>
        : !task ? <EmptyState icon="FileQuestion" title={`Task ${taskKey} was not found`}>Deleted, or its key changed.</EmptyState>
        : <div className="p-4">
          <h1 className="mb-2.5 mt-1 break-words text-2xl font-semibold leading-tight">{task.title}</h1>
          <h2 className="mb-1.5 text-xs font-semibold text-muted-foreground">Properties</h2>
          <Row label="Status"><StatusIcon status={task.status} />{task.statusLabel}</Row>
          <Row label="Priority"><PriorityIcon priority={task.priority} />{PRIORITY_LABELS[task.priority] ?? task.priority}</Row>
          {task.projectName && <Row label="Project"><Icon name="Folder" aria-hidden className="size-3.5 text-muted-foreground" /><span className="truncate">{task.projectName}</span></Row>}
          <Row label="Updated"><Icon name="Clock" aria-hidden className="size-3.5 text-muted-foreground" /><time dateTime={task.updatedAt} className="text-muted-foreground">{updated === 'now' ? 'Updated just now' : `Updated ${updated} ago`}</time></Row>
          {task.labels.length > 0 && <><div className="mb-1 mt-3 text-2xs font-semibold text-muted-foreground">Labels</div>
            <div className="flex flex-wrap items-center gap-1 py-0.5">{task.labels.map(label => <span key={label.name} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-0.5 text-2xs text-muted-foreground"><span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: label.color }} />{label.name}</span>)}</div></>}
          {task.description.trim() && <div className="mt-4 border-t border-border-seam pt-4 text-sm"><Markdown content={task.description} /></div>}
        </div>}
    </div>
  </section>;
}

export function TaskTab() {
  // The target stays for the session, so the tab keeps showing the last task clicked.
  const target = experimental_useFixedTabTarget(TASK_TAB);
  return target ? <TaskPreview key={target.target.taskKey} taskKey={target.target.taskKey} /> : <EmptyState icon="ListTodo" title="No task selected">Click a task link to preview it here.</EmptyState>;
}

/** Task links clicked inside the Answers page open the Task tab; modified clicks and a declined open keep bb's navigation. */
export function useTaskLinkPreview(root: RefObject<HTMLElement | null>) {
  const panel = experimental_useAppPanel(), current = useRef(panel); current.current = panel;
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      const match = anchor && root.current?.contains(anchor) ? anchor.getAttribute('href')?.match(TASK_LINK) : null;
      if (!match) return;
      let taskKey: string;
      try { taskKey = decodeURIComponent(match[1]!); } catch { return; }
      if (!TASK_TAB.experimental_target.validate({ taskKey })) return;
      if (current.current.openTab({ tab: TASK_TAB, target: { taskKey } })) { event.preventDefault(); event.stopPropagation(); }
    };
    // Capture phase runs before bb's own link handling.
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [root]);
}
