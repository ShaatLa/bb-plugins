import { useEffect, useId, useState } from 'react';
import { experimental_useRpcQuery as useQuery, UrlLink, useBbNavigate, useRpc, useSdk } from '@get-bb/plugin-sdk/app';
import type { contract } from './server';
import { overviewContract } from './overview-contract';
import { Button } from './components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';

export const overviewPath = 'overview';
const none = '__none__';
const ranges = [[1, '24 hours'], [7, '7 days'], [30, '30 days']] as const;
const muted = 'text-sm text-muted-foreground';

function ProjectPlaceholder({ error, ready, retry }: { error: boolean; ready: boolean; retry: () => void }) {
  if (error) return <div className="space-y-2">
    <p role="alert" className="text-sm text-destructive">Could not load Sweep projects.</p>
    <Button variant="outline" size="sm" onClick={retry}>Retry</Button>
  </div>;
  if (!ready) return <p role="status" className={muted}>Loading projects…</p>;
  return <div className="space-y-2">
    <p className={muted}>No projects configured for Sweep.</p>
    <UrlLink href="/settings/plugins/sweep" className="text-sm text-primary underline underline-offset-4">Open Sweep settings</UrlLink>
  </div>;
}

type Session = { id: string; title: string };

function RecipientPicker({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof contract>();
  const sdk = useSdk();
  const controlId = useId();
  const [sessions, setSessions] = useState<Session[]>();
  const [manager, setManager] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    async function listSessions() {
      const sessions = new Map<string, Session>();
      const limit = 100;
      for (let offset = 0; ; offset += limit) {
        const page = await sdk.threads.list({ projectId, archived: false, limit, offset, signal: controller.signal });
        for (const session of page) {
          if (!session.archivedAt && !session.deletedAt) sessions.set(session.id, { id: session.id, title: session.title || session.id });
        }
        if (page.length < limit) return [...sessions.values()];
      }
    }
    Promise.all([rpc.call('manager', { projectId }), listSessions()]).then(([current, choices]) => {
      if (controller.signal.aborted) return;
      setManager(current.manager ?? '');
      setSessions(choices);
    }, () => {
      if (!controller.signal.aborted) setError('Could not load notification sessions.');
    });
    return () => controller.abort();
  }, [attempt, projectId, rpc, sdk]);

  async function changeRecipient(value: string) {
    const next = value === none ? '' : value;
    setError('');
    setSaving(true);
    try {
      await rpc.call('config.set', { projectId, key: 'manager', value: next });
      setManager(next);
    } catch {
      setError('Could not save the notification session. Choose a session to retry.');
    } finally {
      setSaving(false);
    }
  }

  return <div className="space-y-2">
    <label htmlFor={controlId} className="block text-sm font-medium">Notification session</label>
    {sessions ? <Select value={manager || none} onValueChange={changeRecipient} disabled={saving}>
      <SelectTrigger id={controlId} className="w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={none}>No session</SelectItem>
        {manager && !sessions.some(session => session.id === manager) && <SelectItem value={manager}>{manager}</SelectItem>}
        {sessions.map(session => <SelectItem key={session.id} value={session.id}>{session.title}</SelectItem>)}
      </SelectContent>
    </Select> : !error && <p role="status" className={muted}>Loading sessions…</p>}
    {saving && <p role="status" className={muted}>Saving…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {error && !sessions && <Button variant="outline" size="sm" onClick={() => { setError(''); setAttempt(value => value + 1); }}>Retry</Button>}
  </div>;
}

const itemLabels: Record<string, string> = { ACTION: 'Action', ANSWER: 'Owner answer', WAIT: 'Waiting', STATE: 'State change' };
function itemLabel(kind: string) {
  const [tag, ...detail] = kind.split(' ');
  const name = itemLabels[tag] ?? tag;
  return detail.length ? `${name} · ${detail.join(' ').replaceAll('-', ' ')}` : name;
}

function Breakdown({ title, rows, empty }: { title: string; rows: [string, number][]; empty?: string }) {
  return <section className="min-w-0 rounded-lg border border-border p-4">
    <h2 className="text-sm font-semibold">{title}</h2>
    {rows.length ? <dl className="mt-2 divide-y divide-border text-sm">
      {rows.map(([label, value]) => <div key={label} className="flex items-baseline justify-between gap-4 py-2">
        <dt className="break-words text-muted-foreground">{label}</dt><dd className="shrink-0 tabular-nums">{value.toLocaleString()}</dd>
      </div>)}
    </dl> : <p className={`mt-3 ${muted}`}>{empty}</p>}
  </section>;
}

export function SweepOverview({ subPath }: { subPath: string }) {
  const projects = useQuery({ contract: overviewContract, method: 'overview.projects', input: null });
  const project = projects.data?.find(item => item.id === subPath) ?? projects.data?.[0];
  const navigate = useBbNavigate();
  const projectControlId = useId();
  const [days, setDays] = useState<number>(1);
  const stats = useQuery({ contract: overviewContract, method: 'stats', input: { projectId: project?.id ?? '', days }, enabled: !!project });
  const report = stats.data;

  return <div className="h-full min-h-0 overflow-y-auto p-4 md:p-5">
    <main className="mx-auto w-full max-w-4xl space-y-4">
      {!project ? <ProjectPlaceholder error={!!projects.error} ready={!!projects.data} retry={projects.refetch} /> : <>
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-lg font-semibold">Sweep</h1>
          <div className="flex flex-wrap items-center gap-2">
            <div role="group" aria-label="Statistics period" className="inline-flex h-8 items-center rounded-lg bg-muted p-0.5">
              {ranges.map(([value, label]) => (
                <Button
                  key={value}
                  size="sm"
                  variant="ghost"
                  className="h-7 text-muted-foreground aria-pressed:bg-background aria-pressed:shadow-xs aria-pressed:hover:bg-background"
                  aria-pressed={days === value}
                  onClick={() => setDays(value)}
                >
                  {label}
                </Button>
              ))}
            </div>
            <Button size="sm" variant="outline" disabled={stats.isFetching} onClick={stats.refetch}>Refresh</Button>
          </div>
        </header>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <label htmlFor={projectControlId} className="block text-sm font-medium">Project</label>
            <Select value={project.id} onValueChange={id => navigate.toPluginPanel(overviewPath, { subPath: id })}>
              <SelectTrigger id={projectControlId} className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{projects.data?.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
            {!project.enabled && <p className={muted}>Scheduled checks are disabled.</p>}
          </div>
          <RecipientPicker key={project.id} projectId={project.id} />
        </div>
        {stats.error && <p role="alert" className="text-sm text-destructive">Could not load Sweep statistics.</p>}
        {!report && !stats.error && <p role="status" className={muted}>Loading statistics…</p>}
        {report && (report.ticks === 0 ? <p className={muted}>No scheduled runs in this period.</p> : <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {([
              ['Checks run', report.executed], ['Deliveries', report.deliveries], ['Repeated items', report.repeats],
              ['Failures', report.refreshFailures + report.scriptFailures + report.deliveryFailures],
            ] as const).map(([label, value]) => <div key={label} className="rounded-lg border border-border bg-muted/30 p-4">
              <dt className="text-xs text-muted-foreground">{label}</dt><dd className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString()}</dd>
            </div>)}
          </dl>
          <div className="grid gap-3 sm:grid-cols-2">
            <Breakdown title="New items" rows={Object.entries(report.newItems).map(([kind, count]) => [itemLabel(kind), count])} empty="No new items in this period." />
            <Breakdown title="Report delivery" rows={[
              ['To manager', report.manager], ['To Answers', report.answers],
              ['Suppressed repeats', report.suppressedReports], ['Reminders queued', report.reminderReports],
            ]} />
            <Breakdown title="Scheduled activity" rows={[
              ['Scheduled ticks', report.ticks], ['Checkout failures', report.refreshFailures],
              ['Script failures', report.scriptFailures], ['Delivery failures', report.deliveryFailures],
            ]} />
          </div>
        </>)}
      </>}
    </main>
  </div>;
}
