import { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, experimental_useQuestionFormHost, experimental_useRpcRefresh, UrlLink, useSdk } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';

type Row = Awaited<ReturnType<ReturnType<typeof useSdk>['threads']['interactions']['list']>>[number];
type Question = Extract<Row['payload'], { kind: 'user_question' }>['questions'][number];
type Answer = { selected: string[]; freeText?: string };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

const pendingOf = (list: Row[]) => list.filter(row => row.status === 'pending' || row.status === 'resolving');
// Pending bb interactions per thread, refetched whenever a sidebar thread's pending flag or status changes.
// The Questions section shares these rows with its cards, so each thread is fetched once; settle drops an answered row and refetches its thread.
export function usePendingInteractionRows(threads: readonly { id: string; hasPendingInteraction: boolean; status?: string }[]) {
  const sdk = useSdk(), [rows, setRows] = useState<Record<string, Row[]>>({});
  const key = threads.filter(thread => thread.hasPendingInteraction).map(thread => `${thread.id}:${thread.status}`).join(' ');
  useEffect(() => {
    let live = true;
    void Promise.all(threads.filter(thread => thread.hasPendingInteraction).map(async thread => [thread.id, pendingOf(await sdk.threads.interactions.list({ threadId: thread.id }))] as const)).then(found => { if (live) setRows(Object.fromEntries(found)); }).catch(() => {});
    return () => { live = false; };
  }, [sdk, key]);
  const settle = (threadId: string, rowId: string) => {
    setRows(old => ({ ...old, [threadId]: (old[threadId] ?? []).filter(row => row.id !== rowId) }));
    void sdk.threads.interactions.list({ threadId }).then(list => setRows(old => ({ ...old, [threadId]: pendingOf(list) }))).catch(() => {});
  };
  return { rows, settle };
}

export function PendingInteractions({ threadId, projectId, pending, status, stacked = false, shared, onAnswered }: { threadId: string; projectId?: string | null; pending: boolean; status?: string; stacked?: boolean; shared?: Row[]; onAnswered?: (rowId: string) => void }) {
  const sdk = useSdk(), { refresh } = experimental_useRpcRefresh();
  const [own, setOwn] = useState<Row[]>([]), [error, setError] = useState(''), [version, setVersion] = useState(0);
  // With shared rows (the Questions section) this card does not fetch; the owner settles them through onAnswered.
  const rows = shared ?? own;
  useEffect(() => {
    if (shared || !pending) { setOwn([]); setError(''); return; }
    let live = true;
    void sdk.threads.interactions.list({ threadId }).then(value => { if (live) { setOwn(pendingOf(value)); setError(''); } }).catch(e => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [sdk, threadId, pending, status, version, !!shared]);
  async function act(row: Row, action: () => Promise<unknown>) {
    setError('');
    try { await action(); setOwn(current => current.filter(item => item.id !== row.id)); refresh(); setVersion(v => v + 1); onAnswered?.(row.id); }
    catch (e) { setError(errorText(e)); }
  }
  if (!pending && !error) return null;
  return <div className={stacked ? 'space-y-2' : 'mb-2 space-y-2'}>{rows.map(row => {
    const payload = row.payload;
    if (payload.kind === 'user_question') return <QuestionCard key={row.id} stacked={stacked} questions={payload.questions} onSubmit={answers => act(row, () => sdk.threads.interactions.resolve({ threadId, interactionId: row.id, resolution: { kind: 'user_answer', answers } }))} onCancel={() => act(row, () => sdk.threads.stop({ threadId }))} />;
    if (payload.kind === 'approval') return <ApprovalForm key={row.id} row={row as ApprovalRow} onDecide={decision => act(row, () => sdk.threads.interactions.resolve({ threadId, interactionId: row.id, resolution: decision === 'deny' ? { decision } : { decision, grantedPermissions: payload.subject.kind === 'permission_grant' ? payload.subject.permissions : (payload.subject.kind === 'command' || payload.subject.kind === 'file_change') && decision === 'allow_for_session' ? payload.subject.sessionGrant : null } }))} />;
    return <div key={row.id} className="rounded-lg border border-border bg-card px-3 py-2 text-xs"><p className="font-medium text-foreground">{payload.title}</p><UrlLink href={`${projectId ? `/projects/${projectId}` : ''}/threads/${threadId}`}>Open in chat to answer</UrlLink></div>;
  })}{error && <p role="alert" className="rounded-md border border-surface-destructive-border bg-surface-destructive px-3 py-2 text-xs text-destructive-text">{error}</p>}</div>;
}

type Draft = { selected: string[]; other: boolean; text: string };
function QuestionCard({ stacked, ...props }: { stacked: boolean; questions: Question[]; onSubmit: (answers: Record<string, Answer>) => Promise<void>; onCancel: () => Promise<void> }) {
  const [expanded, setExpanded] = useState(true), label = props.questions.length === 1 ? 'Question' : `${props.questions.length} questions`;
  return <section data-pending-question-card aria-label={label} data-expanded={expanded || undefined} className={`@container flex min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-surface-recessed text-xs text-muted-foreground ${stacked ? '' : 'mb-2 rounded-lg border border-border'}`}><div className={`flex min-h-9 shrink-0 items-center gap-2 pl-3 pr-1.5 ${expanded ? 'border-b border-border-hairline py-1.5' : 'py-1'}`}><span aria-hidden className="size-2 shrink-0 rounded-full bg-attention ring-[3px] ring-surface-attention" /><button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="flex min-h-7 min-w-0 flex-1 items-center rounded-md text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"><span className="min-w-0 text-xs font-medium text-foreground">{label}</span></button><button type="button" aria-label={expanded ? 'Hide details' : 'Show details'} onClick={() => setExpanded(!expanded)} className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground"><Icon name="ChevronDown" className={`size-3.5 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`} aria-hidden /></button></div>{expanded && <div className="min-h-0 max-h-[min(32rem,50dvh)] touch-pan-y overflow-y-auto overscroll-contain px-3 pb-3 pt-2.5"><QuestionForm {...props} /></div>}</section>;
}
function QuestionForm({ questions, onSubmit, onCancel }: { questions: Question[]; onSubmit: (answers: Record<string, Answer>) => Promise<void>; onCancel: () => Promise<void> }) {
  const host = experimental_useQuestionFormHost();
  const [index, setIndex] = useState(0), [answers, setAnswers] = useState<Record<string, Draft>>({}), [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null), question = questions[index];
  const draft = (q: Question): Draft => answers[q.id] ?? { selected: [], other: !(q.options?.length), text: '' };
  const current = question && draft(question);
  const valid = questions.every(q => !q.required || draft(q).selected.length > 0 || draft(q).other && !!draft(q).text.trim());
  function update(q: Question, change: Partial<Draft>) { setAnswers(old => ({ ...old, [q.id]: { ...(old[q.id] ?? { selected: [], other: !(q.options?.length), text: '' }), ...change } })); }
  async function submit() {
    if (busy) return;
    if (index < questions.length - 1) { setIndex(index + 1); return; }
    if (!valid) return;
    const value: Record<string, Answer> = {};
    for (const q of questions) { const a = draft(q); if (!q.required && !a.selected.length && !(a.other && a.text.trim())) continue; value[q.id] = { selected: a.other && !q.multiSelect ? [] : a.selected, ...(a.other && a.text.trim() ? { freeText: a.text.trim() } : {}) }; }
    setBusy(true); try { await onSubmit(value); } finally { setBusy(false); }
  }
  async function cancel() { if (busy) return; setBusy(true); try { await onCancel(); } finally { setBusy(false); } }
  function choice(n: number) {
    if (!question || busy) return false;
    const option = question.options?.[n];
    if (option) { update(question, { selected: question.multiSelect ? current!.selected.includes(option.value) ? current!.selected.filter(v => v !== option.value) : [...current!.selected, option.value] : [option.value], other: question.multiSelect ? current!.other : false }); root.current?.focus(); return true; }
    if (n === (question.options?.length ?? 0) && question.allowFreeText && n > 0) { update(question, { other: !current!.other, selected: question.multiSelect ? current!.selected : [] }); root.current?.focus(); return true; }
    return false;
  }
  function action(name: string) { if (name === 'cancel') { void cancel(); return true; } if (busy) return false; if (name === 'previous' && index > 0) setIndex(index - 1); else if (name === 'next' && index < questions.length - 1) setIndex(index + 1); else if (name === 'submit') void submit(); else return false; root.current?.focus(); return true; }
  const handlers = useRef({ choice, action }); handlers.current = { choice, action };
  // Several forms can share a page (the Questions section); host shortcuts act only on the focused one.
  useEffect(() => { const a = host.registerChoiceHandler(n => root.current?.contains(document.activeElement) ? handlers.current.choice(n) : false), b = host.registerActionHandler(n => root.current?.contains(document.activeElement) ? handlers.current.action(n) : false); return () => { a(); b(); }; }, [host]);
  if (!question) return null;
  // bb binds option shortcuts only inside its thread pane; on the Answers page the form numbers options itself, as bb's default 1-9 does.
  const key = (n: number) => host.shortcuts.get(String(n))?.label ?? (host.shortcuts.size === 0 && n < 9 ? String(n + 1) : undefined);
  return <div ref={root} tabIndex={-1} data-question-form className="-m-1 flex min-h-0 flex-col rounded-md p-1 text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring" onKeyDown={e => { if (host.shortcuts.size === 0 && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey && !(e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) && choice(Number(e.key) - 1)) { e.preventDefault(); return; } if (e.target === e.currentTarget && e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); void submit(); } }}>
    {questions.length > 1 && <div className="mb-2 flex shrink-0 items-center gap-2"><div className="relative min-w-0 flex-1"><div data-question-tabs className="relative flex min-w-0 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{questions.map((q, n) => <div key={q.id} className={`relative inline-flex h-7 shrink-0 items-center rounded-md ${n === index ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-state-hover'}`}><button type="button" aria-pressed={n === index} title={q.prompt} onClick={() => setIndex(n)} className="flex h-full min-w-0 items-center rounded-md px-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"><span className="truncate text-xs" style={{ maxWidth: 180 }}>{q.shortLabel ?? `Question ${n + 1}`}</span></button></div>)}</div></div><span className="shrink-0 text-xs text-muted-foreground">{index + 1} of {questions.length}</span></div>}
    <div><fieldset disabled={busy} className="min-w-0"><legend className="sr-only">{question.prompt}</legend><div className="text-xs font-medium text-foreground">{question.prompt}</div>{!question.required && <div>Optional</div>}
      <div className="space-y-0.5 mt-1">{(question.options ?? []).map((option, n) => <div key={option.value}><button type="button" aria-pressed={current!.selected.includes(option.value)} aria-keyshortcuts={host.shortcuts.get(String(n))?.ariaKeyshortcuts ?? key(n)} onClick={() => choice(n)} className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${current!.selected.includes(option.value) ? 'bg-surface-selected' : 'hover:bg-state-hover'}`}><span className={`flex size-4 shrink-0 items-center justify-center border ${question.multiSelect ? 'rounded' : 'rounded-full'} ${current!.selected.includes(option.value) ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>{current!.selected.includes(option.value) && <Icon name="Check" className="size-3" aria-hidden />}</span><span className="min-w-0 flex-1"><span className="block text-xs text-foreground">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{option.description}</span>}</span>{key(n) && <kbd aria-hidden className="shrink-0 text-xs font-normal text-subtle-foreground">{key(n)}</kbd>}</button></div>)}
      {question.allowFreeText && !!question.options?.length && <button type="button" aria-pressed={current!.other} aria-keyshortcuts={host.shortcuts.get(String(question.options.length))?.ariaKeyshortcuts ?? key(question.options.length)} onClick={() => choice(question.options!.length)} className={`flex w-full items-start gap-2.5 rounded-md px-2.5 py-1.5 text-left transition-colors ${current!.other ? 'bg-surface-selected' : 'hover:bg-state-hover'}`}><span className={`flex size-4 shrink-0 items-center justify-center border ${question.multiSelect ? 'rounded' : 'rounded-full'} ${current!.other ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}`}>{current!.other && <Icon name="Check" className="size-3" aria-hidden />}</span><span className="min-w-0 flex-1"><span className="block text-xs text-foreground">Other…</span></span>{key(question.options.length) && <kbd aria-hidden className="shrink-0 text-xs font-normal text-subtle-foreground">{key(question.options.length)}</kbd>}</button>}
      {current!.other && <textarea aria-label={`${question.shortLabel ?? `Question ${index + 1}`} answer`} autoFocus value={current!.text} onChange={e => update(question, { text: e.target.value })} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} placeholder="Type your own answer…" className="mt-2 block w-full resize-none rounded-md border border-border bg-surface-raised px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground" />}</div>
    </fieldset></div><div className="flex shrink-0 items-center justify-between gap-2 mt-3"><Button type="button" size="sm" variant="ghost" aria-keyshortcuts={host.actionShortcuts.get('cancel')?.ariaKeyshortcuts} disabled={busy} onClick={() => void cancel()}>Cancel</Button><div className="flex items-center gap-2">{index > 0 && <Button type="button" size="sm" variant="outline" aria-keyshortcuts={host.actionShortcuts.get('previous')?.ariaKeyshortcuts} disabled={busy} onClick={() => setIndex(index - 1)}>Back</Button>}<Button type="button" size="sm" aria-keyshortcuts={host.actionShortcuts.get(index === questions.length - 1 ? 'submit' : 'next')?.ariaKeyshortcuts} disabled={busy || index === questions.length - 1 && !valid} onClick={() => void submit()}>{index === questions.length - 1 ? 'Submit answer' : 'Next'}</Button></div></div>
  </div>;
}

type ApprovalRow = Extract<Row, { payload: { kind: 'approval' } }>;
function ApprovalForm({ row, onDecide }: { row: ApprovalRow; onDecide: (decision: 'allow_once' | 'allow_for_session' | 'deny') => Promise<void> }) {
  const [busy, setBusy] = useState(false), subject = row.payload.subject;
  const title = row.payload.reason ?? (subject.kind === 'plan' ? 'Approve plan?' : subject.kind === 'command' ? subject.command : subject.kind === 'file_change' ? 'Do you want to make these changes?' : subject.kind === 'permission_grant' ? 'Do you want to grant this permission?' : subject.presentation.title ?? subject.presentation.label.pending);
  async function decide(decision: 'allow_once' | 'allow_for_session' | 'deny') { setBusy(true); try { await onDecide(decision); } finally { setBusy(false); } }
  return <div data-approval-banner className="rounded-lg border border-border bg-card px-3 py-2 text-xs"><div className="text-muted-foreground">Approval needed</div><p className="font-medium text-foreground">{title}</p>{subject.kind === 'plan' ? <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-card px-3 py-2">{subject.plan}</pre> : subject.kind === 'command' ? <p className="mt-2 break-all text-muted-foreground">Command: {subject.command}</p> : subject.kind === 'file_change' ? <p className="mt-2 text-muted-foreground">Write root: {subject.writeScope}</p> : subject.kind === 'permission_grant' ? <p className="mt-2 text-muted-foreground">Tool: {subject.toolName}</p> : <p className="mt-2 text-muted-foreground">{subject.presentation.detail}</p>}<div className="mt-3 flex flex-wrap gap-2">{row.payload.availableDecisions.map(decision => <Button key={decision} size="sm" variant={decision === 'allow_once' ? 'default' : decision === 'deny' ? 'ghost' : 'outline'} disabled={busy} onClick={() => void decide(decision)}>{subject.kind === 'plan' ? decision === 'deny' ? 'Keep planning' : 'Approve plan' : decision === 'allow_once' ? 'Allow once' : decision === 'allow_for_session' ? 'Allow for session' : 'Deny'}</Button>)}</div></div>;
}
