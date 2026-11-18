import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { contract, Config } from './server';
import { overviewPath, SweepOverview, SweepSidebar } from './overview';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Switch } from './components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select';
import { Summary } from './components/ui/summary';
import { SettingsSection, SettingsWithControl } from './components/ui/settings-section';

type Data = { projects: { id: string; name: string; hasRepository: boolean; config: Config | null }[]; threads: { id: string; title: string; projectId: string }[]; environment: { bbCli: string; runtimePath: string } };
const defaults: Config = { enabled: false, branch: 'main', script: '', args: [], manager: '', intervalMinutes: 10, timeoutSeconds: 300, snapshots: false };
const controlWidth = 'w-full @min-[36rem]/settings:w-72';
function Field({ label, hint, children, below = false }: { label: string; hint?: string; children: ReactNode; below?: boolean }) {
  return <SettingsWithControl label={label} description={hint} controlPlacement={below ? 'below' : 'inline'}>{children}</SettingsWithControl>;
}

// Match CI Dashboard's host-field decoration: keep the CLI settings, replace their raw UI.
function hideRawSettings() {
  const previous = new Map<HTMLElement, { hidden: boolean; display: string }>();
  const sync = () => {
    const labels = ['Script PATH (empty inherits server)', 'BB CLI absolute path', 'Project sweeps (JSON)'];
    const fields = labels.map(label => document.querySelector<HTMLElement>(`[aria-label="${label}"]`));
    if (fields.some(field => !field)) return;
    let parent = fields[0]!.parentElement;
    while (parent && !fields.every(field => parent!.contains(field))) parent = parent.parentElement;
    if (!parent || parent === document.body || parent.querySelector('[data-sweep-settings]')) return;
    let section = parent;
    while (section.parentElement && section.parentElement !== document.body && !section.parentElement.querySelector('[data-sweep-settings]')) section = section.parentElement;
    if (!section.querySelector('h1')) parent = section;
    const heading = Array.from(document.querySelectorAll<HTMLElement>('h2, h3, [role="heading"]')).find(node => node.textContent === 'Configuration');
    for (const element of [parent, heading].filter((node): node is HTMLElement => !!node)) {
      if (!previous.has(element)) previous.set(element, { hidden: element.hidden, display: element.style.display });
      element.hidden = true; element.style.display = 'none';
    }
  };
  sync(); const observer = new MutationObserver(sync); observer.observe(document.body, { childList: true, subtree: true });
  return () => { observer.disconnect(); previous.forEach((value, element) => { element.hidden = value.hidden; element.style.display = value.display; }); };
}

function ProjectSettings({ projectId, initial, hasRepository, threads, onSave }: { projectId: string; initial: Config; hasRepository: boolean; threads: Data['threads']; onSave: (id: string, config: Config, previous: Config) => void }) {
  const [value, setValue] = useState(initial), [invalid, setInvalid] = useState(false);
  const last = useRef(value), lastValid = useRef(value), form = useRef<HTMLFormElement>(null);
  const update = (patch: Partial<Config>) => setValue(current => ({ ...current, ...patch }));
  useEffect(() => {
    if (last.current === value) return;
    last.current = value;
    const valid = form.current?.checkValidity() ?? false;
    setInvalid(!valid);
    if (valid) {
      const previous = lastValid.current;
      lastValid.current = value;
      onSave(projectId, value, previous);
    }
  }, [value, projectId, onSave]);
  return <form ref={form} className="space-y-6" onSubmit={e => e.preventDefault()}>
    <SettingsSection bodyClassName="space-y-5" title="Scheduled checks">
      <SettingsWithControl label="Enable scheduled checks" description="Send results to the manager and a heartbeat once an hour."><Switch aria-label="Enable scheduled checks" checked={value.enabled} onCheckedChange={enabled => update({ enabled })} /></SettingsWithControl>
      <Field label="Manager" hint="The thread that receives check results.">
        <Select value={value.manager || 'none'} onValueChange={manager => update({ manager: manager === 'none' ? '' : manager })}>
          <SelectTrigger aria-label="Manager" className={controlWidth}><SelectValue placeholder="Choose a manager thread" /></SelectTrigger>
          <SelectContent><SelectItem value="none">Choose a manager thread</SelectItem>{value.manager && !threads.some(t => t.id === value.manager) && <SelectItem value={value.manager}>{value.manager}</SelectItem>}{threads.filter(t => t.projectId === projectId || t.id === value.manager).map(t => <SelectItem key={t.id} value={t.id}>{t.title}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      <SettingsWithControl label="Run every, minutes"><Input aria-label="Run every, minutes" className="w-24" type="number" required min={1} max={1440} value={Number.isNaN(value.intervalMinutes) ? '' : value.intervalMinutes} onChange={e => update({ intervalMinutes: e.target.valueAsNumber })} /></SettingsWithControl>
    </SettingsSection>
    <SettingsSection bodyClassName="space-y-5" title="Repository and script">
      {!hasRepository && <p className="text-sm text-muted-foreground">Set a Git remote URL in the bb project settings to run checks.</p>}
      <Field label="Branch"><Input aria-label="Branch" className={controlWidth} required value={value.branch} onChange={e => update({ branch: e.target.value })} /></Field>
      <Field label="Check script" hint="Path relative to the repository."><Input aria-label="Check script" className={controlWidth} required value={value.script} onChange={e => update({ script: e.target.value })} /></Field>
      <Field label="Arguments" hint="One argument per line. {manager} uses the selected manager thread." below><Textarea aria-label="Arguments" rows={3} value={value.args.join('\n')} onChange={e => update({ args: e.target.value === '' ? [] : e.target.value.split('\n') })} /></Field>
    </SettingsSection>
    <SettingsSection title="Advanced" bodyClassName="space-y-5">
      <SettingsWithControl label="Timeout, seconds"><Input aria-label="Timeout, seconds" className="w-24" type="number" required min={1} max={300} value={Number.isNaN(value.timeoutSeconds) ? '' : value.timeoutSeconds} onChange={e => update({ timeoutSeconds: e.target.valueAsNumber })} /></SettingsWithControl>
      <SettingsWithControl label="Acknowledge script snapshots" description="Requires a script that supports the Sweep acknowledgement protocol."><Switch aria-label="Acknowledge script snapshots" checked={value.snapshots} onCheckedChange={snapshots => update({ snapshots })} /></SettingsWithControl>
    </SettingsSection>
    <p role="status" className="text-xs text-muted-foreground">{invalid ? 'Enter valid values to save these changes.' : 'Changes are saved automatically for this project.'}</p>
  </form>;
}

export function SweepSettings() {
  const rpc = useRpc<typeof contract>();
  const [data, setData] = useState<Data | null>(null), [selected, setSelected] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Config>>({});
  const [environment, setEnvironment] = useState({ bbCli: '', runtimePath: '' });
  const [error, setError] = useState('');
  const writes = useRef(Promise.resolve());
  const unsaved = useRef(new Map<string, Set<keyof Config>>());
  const enqueue = useCallback((action: () => Promise<unknown>) => {
    writes.current = writes.current.then(() => {
      setError('');
      return action();
    }).then(() => {}, e => { setError(`Could not save settings: ${String(e)}. Edit the setting to retry.`); });
  }, []);
  const saveProject = useCallback((projectId: string, config: Config, previous: Config) => {
    setDrafts(current => ({ ...current, [projectId]: config }));
    const changed = (Object.keys(config) as (keyof Config)[]).filter(key => config[key] !== previous[key]);
    if (!previous.script && !changed.includes('branch')) changed.push('branch');
    enqueue(async () => {
      const pending = unsaved.current.get(projectId) ?? new Set<keyof Config>();
      for (const key of changed) pending.add(key);
      unsaved.current.set(projectId, pending);
      const keys: (keyof Config)[] = [...pending].filter(key => key !== 'enabled');
      if (pending.has('enabled')) keys.push('enabled');
      for (const key of keys) {
        await rpc.call('config.set', { projectId, key, value: config[key] });
        pending.delete(key);
      }
      unsaved.current.delete(projectId);
    });
  }, [rpc, enqueue]);
  useEffect(() => { let active = true; rpc.call('settings.read', null).then(result => { if (!active) return; setData(result); setEnvironment(result.environment); setSelected(result.projects.find(p => p.config)?.id ?? result.projects[0]?.id ?? ''); setDrafts(Object.fromEntries(result.projects.map(p => [p.id, p.config ?? { ...defaults }]))); }, e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [rpc]);
  useEffect(() => { if (data) return hideRawSettings(); }, [data]);
  if (!data) return <p role={error ? 'alert' : 'status'}>{error || 'Loading Sweep settings…'}</p>;
  if (!selected) return <p>Create a project in bb first.</p>;
  return <div data-sweep-settings className="min-w-0 space-y-6">
    <SettingsSection title="Project">
      <Field label="Project" hint="Settings are saved separately for each project."><Select value={selected} onValueChange={setSelected}><SelectTrigger aria-label="Project" className={controlWidth}><SelectValue /></SelectTrigger><SelectContent>{data.projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent></Select></Field>
    </SettingsSection>
    <ProjectSettings key={selected} projectId={selected} initial={drafts[selected]} hasRepository={data.projects.some(p => p.id === selected && p.hasRepository)} threads={data.threads} onSave={saveProject} />
    <SettingsSection title="Execution environment">
      <details><Summary className="text-sm">Advanced environment settings · all projects</Summary><div className="mt-5 space-y-5">
        <Field label="BB executable" hint="Absolute path to bb. Leave empty to use the server environment." below><Textarea aria-label="BB executable" rows={2} value={environment.bbCli} onChange={e => setEnvironment(current => ({ ...current, bbCli: e.target.value }))} onBlur={() => enqueue(() => rpc.call('environment.write', environment))} /></Field>
        <Field label="Executable search directories" hint="One directory per line. Leave empty to inherit the server PATH." below><Textarea aria-label="Executable search directories" rows={5} className="break-all font-mono text-xs" value={environment.runtimePath.split(':').join('\n')} onChange={e => setEnvironment(current => ({ ...current, runtimePath: e.target.value.split(/\r?\n/).filter(Boolean).join(':') }))} onBlur={() => enqueue(() => rpc.call('environment.write', environment))} /></Field>
      </div></details>
    </SettingsSection>
    <p role="alert" className="text-sm text-destructive">{error}</p>
  </div>;
}
export default definePluginApp(app => {
  app.slots.settingsSection({ id: 'sweep-settings', component: SweepSettings });
  app.slots.navPanel({ id: 'sweep', title: 'Sweep', icon: 'Activity', path: overviewPath, component: SweepOverview, experimental_sidebar: SweepSidebar });
});
