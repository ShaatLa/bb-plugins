import { useEffect, useState, type ReactNode } from 'react';
import { definePluginApp, useRpc } from '@get-bb/plugin-sdk/app';
import type { contract, Config } from './server';
import { Input } from './components/ui/input';
import { Textarea } from './components/ui/textarea';
import { Switch } from './components/ui/switch';
import { Button } from './components/ui/button';
import { SettingsSection, SettingsWithControl } from './components/ui/settings-section';

type Data = { projects: { id: string; name: string; config: Config | null }[]; threads: { id: string; title: string; projectId: string }[]; environment: { bbCli: string; runtimePath: string } };
const defaults: Config = { enabled: false, remote: '', branch: 'main', script: '', args: [], manager: '', intervalMinutes: 10, timeoutSeconds: 300, snapshots: false };
const selectClass = 'h-9 w-full min-w-0 rounded-md border border-input bg-background px-3 text-sm';
function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <SettingsWithControl label={label} description={hint} controlPlacement="below">{children}</SettingsWithControl>;
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

export function SweepSettings() {
  const rpc = useRpc<typeof contract>();
  const [data, setData] = useState<Data | null>(null), [selected, setSelected] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Config>>({});
  const [environment, setEnvironment] = useState({ bbCli: '', runtimePath: '' });
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { let active = true; rpc.call('settings.read', null).then(result => { if (!active) return; setData(result); setEnvironment(result.environment); setSelected(result.projects.find(p => p.config)?.id ?? result.projects[0]?.id ?? ''); setDrafts(Object.fromEntries(result.projects.map(p => [p.id, p.config ?? { ...defaults }]))); }, e => { if (active) setError(String(e)); }); return () => { active = false; }; }, [rpc]);
  useEffect(() => { if (data) return hideRawSettings(); }, [data]);
  if (!data) return <p role={error ? 'alert' : 'status'}>{error || 'Loading Sweep settings…'}</p>;
  if (!selected) return <p>Create a project in bb first.</p>;
  const value = drafts[selected];
  const update = (patch: Partial<Config>) => { setDrafts(current => ({ ...current, [selected]: { ...current[selected], ...patch } })); setNotice('Unsaved changes'); };
  async function save(action: () => Promise<unknown>) { setSaving(true); setError(''); setNotice(''); try { await action(); setNotice('Settings saved'); } catch (e) { setError(String(e)); } finally { setSaving(false); } }
  return <div data-sweep-settings className="min-w-0 space-y-6">
    <SettingsSection bodyClassName="space-y-5" title="Project" description="Each project has its own manager and check schedule.">
      <Field label="Project"><select aria-label="Project" className={selectClass} disabled={saving} value={selected} onChange={e => { setSelected(e.target.value); setError(''); setNotice(''); }}>{data.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
    </SettingsSection>
    <form onSubmit={e => { e.preventDefault(); void save(() => rpc.call('configure', { projectId: selected, config: value })); }} className="space-y-6"><fieldset disabled={saving} className="min-w-0 space-y-6 border-0 p-0">
      <SettingsSection bodyClassName="space-y-5" title="Scheduled checks">
        <SettingsWithControl label="Enable scheduled checks" description={value.enabled ? 'Checks run on the interval below.' : 'Paused. The saved configuration is retained.'}><Switch aria-label="Enable scheduled checks" checked={value.enabled} onCheckedChange={enabled => update({ enabled })} /></SettingsWithControl>
        <Field label="Manager" hint="This thread receives check results and the hourly heartbeat."><select aria-label="Manager" className={selectClass} value={value.manager} required={value.enabled} onChange={e => update({ manager: e.target.value })}><option value="">Choose a manager thread…</option>{value.manager && !data.threads.some(t => t.id === value.manager) && <option value={value.manager}>{value.manager}</option>}{data.threads.filter(t => t.projectId === selected || t.id === value.manager).map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        <SettingsWithControl label="Run every, minutes"><Input aria-label="Run every, minutes" className="w-24" type="number" required min={1} max={1440} value={Number.isNaN(value.intervalMinutes) ? '' : value.intervalMinutes} onChange={e => update({ intervalMinutes: e.target.valueAsNumber })} /></SettingsWithControl>
      </SettingsSection>
      <SettingsSection bodyClassName="space-y-5" title="Repository and script" description="Sweep refreshes its own checkout before running the script.">
        <Field label="Repository URL"><Input aria-label="Repository URL" required value={value.remote} onChange={e => update({ remote: e.target.value })} /></Field>
        <Field label="Branch"><Input aria-label="Branch" required value={value.branch} onChange={e => update({ branch: e.target.value })} /></Field>
        <Field label="Check script" hint="Path relative to the repository, for example checks/sweep.py."><Input aria-label="Check script" required value={value.script} onChange={e => update({ script: e.target.value })} /></Field>
        <Field label="Arguments" hint="One argument per line. {manager} is replaced with the selected manager thread."><Textarea aria-label="Arguments" rows={3} value={value.args.join('\n')} onChange={e => update({ args: e.target.value === '' ? [] : e.target.value.split('\n') })} /></Field>
      </SettingsSection>
      <details className="rounded-md border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Advanced check options</summary><div className="mt-4 space-y-4">
        <SettingsWithControl label="Timeout, seconds"><Input aria-label="Timeout, seconds" className="w-24" type="number" required min={1} max={300} value={Number.isNaN(value.timeoutSeconds) ? '' : value.timeoutSeconds} onChange={e => update({ timeoutSeconds: e.target.valueAsNumber })} /></SettingsWithControl>
        <SettingsWithControl label="Acknowledge script snapshots" description="Enable only when the script supports the committed-state and candidate-snapshot protocol."><Switch aria-label="Acknowledge script snapshots" checked={value.snapshots} onCheckedChange={snapshots => update({ snapshots })} /></SettingsWithControl>
      </div></details>
      <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save project settings'}</Button>
    </fieldset></form>
    <details className="rounded-md border border-border p-4"><summary className="cursor-pointer text-sm font-medium">Execution environment · all projects</summary>
      <form className="mt-4 space-y-4" onSubmit={e => { e.preventDefault(); void save(() => rpc.call('environment.write', environment)); }}><fieldset disabled={saving} className="min-w-0 space-y-4 border-0 p-0">
        <Field label="BB executable" hint="Absolute path to bb. Leave empty to use the server environment."><Textarea aria-label="BB executable" rows={2} value={environment.bbCli} onChange={e => { setEnvironment(current => ({ ...current, bbCli: e.target.value })); setNotice('Unsaved changes'); }} /></Field>
        <Field label="Executable search directories" hint="One directory per line. Leave empty to inherit the server PATH."><Textarea aria-label="Executable search directories" rows={5} className="break-all font-mono text-xs" value={environment.runtimePath.split(':').join('\n')} onChange={e => { setEnvironment(current => ({ ...current, runtimePath: e.target.value.split(/\r?\n/).filter(Boolean).join(':') })); setNotice('Unsaved changes'); }} /></Field>
        <Button type="submit" variant="outline" disabled={saving}>Save execution environment</Button>
      </fieldset></form>
    </details>
    <p role="status" className="text-xs text-muted-foreground">{notice}</p><p role="alert" className="text-sm text-destructive">{error}</p>
  </div>;
}
export default definePluginApp(app => { app.slots.settingsSection({ id: 'sweep-settings', component: SweepSettings }); });
