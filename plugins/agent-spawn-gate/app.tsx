import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { GateActivity } from "./activity";
import { Button } from "./components/ui/button";
import { Icon } from "./components/ui/icon";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Textarea } from "./components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { SettingsSection, SettingsWithControl } from "./components/ui/settings-section";

type Values = { enabled: boolean; method: "script" | "instruction"; instruction: string; script: string; ttlMinutes: number };
type Project = { id: string; name: string; values: Values };

type LaunchValues = Omit<Values, "enabled">;

function ProjectForm({ project, onSave }: { project: Project; onSave: (projectId: string, value: LaunchValues) => void }) {
  const { enabled, ...settings } = project.values;
  const [value, setValue] = useState(settings);
  const form = useRef<HTMLFormElement>(null);
  const lastChange = useRef(value);
  const [invalid, setInvalid] = useState(false);
  const update = (patch: Partial<LaunchValues>) => setValue(current => ({ ...current, ...patch }));
  useEffect(() => {
    if (lastChange.current === value) return;
    lastChange.current = value;
    const valid = form.current?.checkValidity() ?? false;
    setInvalid(!valid);
    if (valid) onSave(project.id, value);
  }, [value, project.id, onSave]);
  return <form ref={form} onSubmit={event => event.preventDefault()} className="space-y-5">
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
        <Textarea aria-label="Launch instructions" rows={6} maxLength={20_000} required={enabled} value={value.instruction} onChange={e => update({ instruction: e.target.value, method: "instruction" })} />
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
  const [savingGate, setSavingGate] = useState(false);
  const writes = useRef(Promise.resolve());
  const save = useCallback((projectId: string, values: Partial<Values>) => {
    const update = () => setProjects(current => current!.map(p => p.id === projectId ? { ...p, values: { ...p.values, ...values } } : p));
    const toggling = values.enabled !== undefined;
    if (!toggling) update();
    setSaveError("");
    // Keep edits in order and show the gate state only after it is saved.
    writes.current = writes.current.then(() => rpc.call("settings.write", { projectId, values })).then(
      () => { if (toggling) update(); },
      error => { setSaveError(`Could not save settings: ${error instanceof Error ? error.message : String(error)}. Edit the setting to retry.`); },
    );
    return writes.current;
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
  const controls = <div className="flex flex-wrap items-center gap-3">
    <Select value={selected} onValueChange={setSelected}>
      <SelectTrigger aria-label="Project" className="w-56 max-w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{projects.map(p => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
    </Select>
    <label className="flex items-center gap-2 text-sm">
      Gate
      <Switch
        aria-label="Enable spawn gate for this project"
        checked={project.values.enabled}
        disabled={savingGate}
        onCheckedChange={async enabled => {
          if (enabled && project.values.method === "instruction" && !project.values.instruction.trim()) {
            setSaveError("Add launch instructions before enabling Spawn Gate.");
            return;
          }
          setSavingGate(true);
          await save(project.id, { enabled });
          setSavingGate(false);
        }}
      />
    </label>
  </div>;
  return <div className="space-y-5">
    {showActivity ? <header className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-xl font-semibold">Spawn Gate</h1>
      {controls}
    </header> : <SettingsSection title="Project">
      <SettingsWithControl label="Project">{controls}</SettingsWithControl>
    </SettingsSection>}
    <p role="alert" className="text-xs text-destructive empty:hidden">{saveError}</p>
    {showActivity ? <>
      <GateActivity key={selected} projectId={selected} days={days} onDaysChange={setDays} />
      <details className="group">
        <Button asChild variant="outline" className="w-full cursor-pointer list-none justify-between px-3 font-normal [&::-webkit-details-marker]:hidden">
          <summary>
            Project settings
            <Icon name="ChevronDown" className="size-4 opacity-50 group-open:rotate-180" />
          </summary>
        </Button>
        <div className="@container/settings rounded-md border border-border p-4 mt-2">
          <ProjectForm key={selected} project={project} onSave={save} />
        </div>
      </details>
    </> : <SettingsSection title="Session launches">
      <ProjectForm key={selected} project={project} onSave={save} />
    </SettingsSection>}
  </div>;
}

export function GateSettings() {
  return <GateProjectView />;
}

function GatePage() {
  return <div className="h-full overflow-y-auto">
    <main className="mx-auto w-full max-w-4xl p-4 md:p-6">
      <GateProjectView showActivity />
    </main>
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "project-settings", component: GateSettings });
  app.slots.navPanel({ id: "spawn-gate", title: "Spawn Gate", icon: "agent-spawn-gate/entry", path: "activity", component: GatePage });
});
