import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { GateActivity } from "./activity";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { SettingsSection, SettingsWithControl } from "./components/ui/settings-section";

type Values = { enabled: boolean; method: "script" | "instruction"; instruction: string; script: string; ttlMinutes: number };
type Project = { id: string; name: string; values: Values };

function ProjectForm({ project, onSave }: { project: Project; onSave: (projectId: string, value: Values) => void }) {
  const [value, setValue] = useState(project.values);
  const form = useRef<HTMLFormElement>(null);
  const lastChange = useRef(value);
  const [invalid, setInvalid] = useState(false);
  const update = (patch: Partial<Values>) => setValue(current => ({ ...current, ...patch }));
  useEffect(() => {
    if (lastChange.current === value) return;
    lastChange.current = value;
    const valid = form.current?.checkValidity() ?? false;
    setInvalid(!valid);
    if (valid) onSave(project.id, value);
  }, [value, project.id, onSave]);
  return <form ref={form} onSubmit={event => event.preventDefault()} className="space-y-5">
      <SettingsWithControl label="Enable spawn gate for this project" description="New CLI and agent starts require admission. Your top-level starts from bb windows remain unrestricted.">
        <Switch aria-label="Enable spawn gate for this project" checked={value.enabled} onCheckedChange={enabled => update({ enabled })} />
      </SettingsWithControl>
      <SettingsWithControl label="Launch method">
        <Select value={value.method} onValueChange={method => update({ method: method as Values["method"] })}>
          <SelectTrigger aria-label="Launch method" className="w-full @min-[36rem]/settings:w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="script">Script</SelectItem><SelectItem value="instruction">Instruction</SelectItem></SelectContent>
        </Select>
      </SettingsWithControl>
      {value.method === "script" ? <>
        <SettingsWithControl label="Launch script" description="Repository-relative JSON builder. The plugin runs its latest remote-default-branch version, then admits and starts the session." controlPlacement="below">
          <Input aria-label="Launch script" value={value.script} required maxLength={500} onChange={e => update({ script: e.target.value })} />
        </SettingsWithControl>
      </> : <SettingsWithControl label="Launch instructions" description="Steps for the agent to follow before creating a child session." controlPlacement="below">
        <Textarea aria-label="Launch instructions" rows={6} maxLength={20_000} required={value.enabled} value={value.instruction} onChange={e => update({ instruction: e.target.value, method: "instruction" })} />
      </SettingsWithControl>}
      <SettingsWithControl label="Admission lifetime, minutes" description="Time to use a newly issued one-use admission before it expires (1–60 minutes).">
        <Input aria-label="Admission lifetime, minutes" className="w-24" type="number" min={1} max={60} required value={Number.isNaN(value.ttlMinutes) ? "" : value.ttlMinutes} onChange={e => update({ ttlMinutes: e.target.valueAsNumber })} />
      </SettingsWithControl>
      <p role="status" className="min-h-4 text-xs text-muted-foreground">{invalid ? "Enter valid values to save these changes." : "Changes are saved automatically for the selected project."}</p>
  </form>;
}

function GateProjectView({ showActivity = false }: { showActivity?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [selected, setSelected] = useState("");
  const [days, setDays] = useState("7");
  const [error, setError] = useState("");
  const [saveError, setSaveError] = useState("");
  const writes = useRef(Promise.resolve());
  const save = useCallback((projectId: string, values: Values) => {
    setProjects(current => current!.map(p => p.id === projectId ? { ...p, values } : p));
    setSaveError("");
    // Keep edits in order without disabling or replacing the controls.
    writes.current = writes.current.then(() => rpc.call("settings.write", { projectId, values })).then(
      () => {},
      error => { setSaveError(`Could not save settings: ${error instanceof Error ? error.message : String(error)}. Edit the setting to retry.`); },
    );
  }, [rpc]);
  useEffect(() => {
    let active = true;
    rpc.call("settings.read", null).then(result => {
      if (!active) return;
      setProjects(result.projects);
      setSelected(result.projects[0]?.id ?? "");
    }, error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [rpc]);
  if (error) return <p role="alert">{error}</p>;
  if (!projects) return <p>Loading projects…</p>;
  if (!projects.length) return <p>Create a project in bb first.</p>;
  const project = projects.find(p => p.id === selected)!;
  return <div className="space-y-6">
    <SettingsSection title="Project">
      <SettingsWithControl label="Project" description="Settings and gate state are saved separately for each project.">
        <Select value={selected} onValueChange={setSelected}>
          <SelectTrigger aria-label="Project" className="w-full @min-[36rem]/settings:w-56"><SelectValue /></SelectTrigger>
          <SelectContent>{projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}{p.values.enabled ? " — on" : " — off"}</SelectItem>)}</SelectContent>
        </Select>
      </SettingsWithControl>
    </SettingsSection>
    {showActivity ? <>
      <GateActivity key={selected} projectId={selected} days={days} onDaysChange={setDays} />
      <details className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer text-sm font-medium">Project settings</summary>
        <div className="pt-4"><ProjectForm key={selected} project={project} onSave={save} /></div>
      </details>
    </> : <SettingsSection title="Session launches">
      <ProjectForm key={selected} project={project} onSave={save} />
    </SettingsSection>}
    <p role="alert" className="min-h-4 text-xs text-destructive">{saveError}</p>
  </div>;
}

export function GateSettings() {
  return <GateProjectView />;
}

function GatePage() {
  return <div className="h-full overflow-y-auto">
    <main className="mx-auto w-full max-w-4xl space-y-5 p-4 md:p-6">
      <h1 className="text-xl font-semibold">Spawn Gate</h1>
      <GateProjectView showActivity />
    </main>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "project-settings", component: GateSettings });
  app.slots.navPanel({ id: "spawn-gate", title: "Spawn Gate", icon: "Lock", path: "activity", component: GatePage });
});
