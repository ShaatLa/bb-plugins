import { useCallback, useEffect, useState, type ReactNode } from "react";
import { definePluginApp, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { fieldValues, type ConfigValues, type ProjectStatus, type StatusProject } from "./status-contract";

const title = "Project Instructions";
const card = "min-w-0 rounded-lg border border-border bg-card px-4 py-3.5";
const muted = "text-sm text-muted-foreground";
const button = "rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const input = "min-w-0 rounded-md border border-input bg-background px-2.5 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const fieldLabels = {
  clonePath: "Clone path",
  branch: "Branch",
  rootFile: "Root file",
  skillsDir: "Skills directory",
  enabled: "Enabled",
  allowSync: "Allow sync",
} satisfies Record<keyof ConfigValues, string>;
const fields = Object.keys(fieldLabels) as (keyof ConfigValues)[];

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function useRead<T>(load: () => Promise<T>, revision: number) {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let active = true;
    setState(previous => ({ data: previous.data }));
    void load().then(
      data => { if (active) setState({ data }); },
      error => { if (active) setState({ error: errorText(error) }); },
    );
    return () => { active = false; };
  }, [load, revision]);
  return state;
}

function useProjects(revision: number) {
  const rpc = useRpc<typeof rpcContract>();
  return useRead(useCallback(() => rpc.call("status.projects", {}), [rpc]), revision);
}

function Notice({ error, children }: { error?: string; children?: ReactNode }) {
  return error === undefined
    ? <p role="status" className={muted}>{children}</p>
    : <p role="alert" className="break-words text-sm text-destructive">{error}</p>;
}

function SourceCheck({ detail, preview = false }: { detail: ProjectStatus; preview?: boolean }) {
  const { source, enabled, skills } = detail;
  return <div className="space-y-4 text-sm">
    <div className="space-y-1">
      <h3 className="font-medium">Root file</h3>
      <p className={muted}>
        {detail.rootFile ?? "No root file set"}
        {source.rootLength !== null && <span className="ml-2 tabular-nums">{source.rootLength.toLocaleString()} / {source.cap.toLocaleString()} characters</span>}
      </p>
      {source.ok
        ? <p className={muted}>{enabled ? "Ready for injection" : "Injection disabled"}</p>
        : <Notice error={source.reason} />}
      {preview && detail.preview !== null && <details className="pt-1">
        <summary className="cursor-pointer font-medium">Preview {detail.rootFile}</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">{detail.preview}</pre>
      </details>}
    </div>
    <div className="space-y-1">
      <h3 className="font-medium">Process skills</h3>
      {skills?.selectable.length
        ? <ul className="flex flex-wrap gap-1.5" aria-label="Selectable skills">
          {skills.selectable.map(skill => <li key={skill} className="rounded border border-border px-2 py-0.5 text-xs">{skill}</li>)}
        </ul>
        : <p className={muted}>{enabled ? "No process skills selectable" : "Skill selection disabled"}</p>}
      {!!skills?.skipped.length && <details>
        <summary className="cursor-pointer">Skipped skills ({skills.skipped.length + skills.moreSkipped})</summary>
        <ul className="mt-1 space-y-1 break-words text-muted-foreground">
          {skills.skipped.map(({ name, reason }) => <li key={name}>{name} · {reason}</li>)}
          {skills.moreSkipped > 0 && <li>{skills.moreSkipped} more</li>}
        </ul>
      </details>}
    </div>
  </div>;
}

const outcomeLabels = { updated: "Updated", up_to_date: "Up to date", blocked: "Blocked", failed: "Failed" };

function Timestamp({ at }: { at: number }) {
  const date = new Date(at);
  return <time dateTime={date.toISOString()}>{date.toLocaleString()}</time>;
}

function SyncStatus({ detail }: { detail: ProjectStatus }) {
  const { sync, allowSync } = detail;
  return <div className="space-y-1 border-t border-border pt-4 text-sm">
    <h3 className="font-medium">Last sync</h3>
    <p className={muted}>{allowSync ? "Sync allowed" : "Sync disabled in settings"}</p>
    {sync ? <>
      <p>{outcomeLabels[sync.lastAttempt.outcome]} · <Timestamp at={sync.lastAttempt.at} /></p>
      {sync.lastAttempt.reason && <p className="break-words text-muted-foreground">{sync.lastAttempt.reason}</p>}
      {sync.lastUpdate && <p className={muted}>
        Last update · <Timestamp at={sync.lastUpdate.at} /> · <code title={sync.lastUpdate.from}>{sync.lastUpdate.from.slice(0, 7)}</code>
        {" → "}<code title={sync.lastUpdate.to}>{sync.lastUpdate.to.slice(0, 7)}</code>
      </p>}
    </> : <p className={muted}>No sync recorded yet.</p>}
  </div>;
}

function Diagnostics({ projectId, revision, status = false }: { projectId: string; revision: number; status?: boolean }) {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error } = useRead(
    useCallback(() => rpc.call("status.detail", { projectId }), [rpc, projectId]),
    revision,
  );
  if (!data) return <Notice error={error}>Checking source…</Notice>;
  return <>
    <SourceCheck detail={data} preview={status} />
    {status && <SyncStatus detail={data} />}
  </>;
}

const projectState = (project: StatusProject) => project.available
  ? project.enabled ? "Enabled" : "Disabled"
  : "Unavailable";

function StatusPage() {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string>();
  const { data, error } = useProjects(revision);
  const projects = data?.filter(project => project.configured);
  const current = projects?.find(project => project.available && project.id === selected)
    ?? projects?.find(project => project.available);

  return <main className="h-full overflow-auto">
    <div className="mx-auto max-w-5xl space-y-5 px-4 py-5 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        <button type="button" className={button} onClick={() => setRevision(n => n + 1)}>Refresh</button>
      </header>
      {!projects ? <Notice error={error}>Loading projects…</Notice> : projects.length === 0
        ? <section className={`${card} space-y-3`}>
          <p className={muted}>No projects are configured.</p>
          <UrlLink className={`${button} inline-block`} href="/settings/plugins/project-instructions">Open plugin settings</UrlLink>
        </section>
        : <div className="grid items-start gap-4 md:grid-cols-[minmax(13rem,1fr)_minmax(0,2fr)]">
          <section aria-label="Projects" className={`${card} space-y-2`}>
            <h2 className="mb-2 text-sm font-semibold">Projects</h2>
            {projects.map(project => <button
              type="button" key={project.id} disabled={!project.available} aria-pressed={current?.id === project.id}
              className="flex w-full items-start justify-between gap-2 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted disabled:opacity-60"
              onClick={() => setSelected(project.id)}
            >
              <span className="min-w-0 break-words font-medium">{project.name}</span>
              <span className="shrink-0 text-right text-xs text-muted-foreground">
                {projectState(project)}<br />{project.allowSync ? "Sync allowed" : "Sync off"}
              </span>
            </button>)}
          </section>
          <section aria-label="Project status" className={`${card} space-y-4`}>
            {current ? <>
              <header className="flex flex-wrap items-center gap-x-2">
                <h2 className="break-words font-semibold">{current.name}</h2>
                <span className={muted}>{projectState(current)}</span>
              </header>
              <Diagnostics key={current.id} projectId={current.id} revision={revision} status />
            </> : <p className={muted}>The configured projects are unavailable.</p>}
            <UrlLink className={`${button} inline-block`} href="/settings/plugins/project-instructions">Open plugin settings</UrlLink>
          </section>
        </div>}
    </div>
  </main>;
}

function SettingRow({ label, value, save }: {
  label: string; value: ConfigValues[keyof ConfigValues]; save: (value: string | boolean) => Promise<ConfigValues[keyof ConfigValues]>;
}) {
  const [saved, setSaved] = useState(value);
  const [draft, setDraft] = useState(typeof value === "string" ? value : "");
  const [feedback, setFeedback] = useState<{ pending?: boolean; saved?: boolean; error?: string }>({});
  async function apply(next: string | boolean) {
    setFeedback({ pending: true });
    try {
      const stored = await save(next);
      setSaved(stored);
      if (typeof stored === "string") setDraft(stored);
      setFeedback({ saved: true });
    } catch (cause) {
      setFeedback({ error: errorText(cause) });
    }
  }

  return <form className="grid gap-2 py-3 first:pt-0 last:pb-0 sm:grid-cols-[8rem_minmax(0,1fr)]"
    onSubmit={event => { event.preventDefault(); if (!feedback.pending && typeof saved !== "boolean" && draft !== (saved ?? "")) void apply(draft); }}>
    <div className="flex items-start pt-1.5 text-sm font-medium">{label}</div>
    <div className="min-w-0 space-y-1">
      {typeof saved === "boolean"
        ? <button
          type="button" role="switch" aria-label={label} aria-checked={saved} disabled={feedback.pending}
          className={button} onClick={() => void apply(!saved)}
        >{saved ? "On" : "Off"}</button>
        : <div className="flex gap-2">
          <input aria-label={label} className={`${input} flex-1`} value={draft} disabled={feedback.pending}
            onChange={event => { setDraft(event.target.value); setFeedback({}); }} />
          <button type="submit" className={button} aria-label={`Save ${label.toLowerCase()}`}
            disabled={feedback.pending || draft === (saved ?? "")}>Save</button>
        </div>}
      {feedback.error && <Notice error={feedback.error} />}
      {feedback.pending && <Notice>Saving…</Notice>}
      {feedback.saved && <Notice>Saved</Notice>}
    </div>
  </form>;
}

function ProjectSettings({ projectId, revision }: { projectId: string; revision: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const [edits, setEdits] = useState(0);
  const { data, error } = useRead(useCallback(async () => {
    return Promise.all(fields.map(async key => {
      const result = await rpc.call("config.get", { projectId, key });
      return { key, value: fieldValues[key].parse(result) };
    }));
  }, [rpc, projectId]), revision);

  return <>
    <section aria-label="Project settings" className={`${card} divide-y divide-border`}>
      {data ? data.map(({ key, value }) => <SettingRow key={key} label={fieldLabels[key]} value={value}
        save={async next => {
          const result = await rpc.call("config.set", { projectId, key, value: next });
          const saved = fieldValues[key].parse(result);
          setEdits(n => n + 1);
          return saved;
        }} />) : <Notice error={error}>Loading settings…</Notice>}
    </section>
    <section aria-label="Source check" className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Source check</h2>
        <button type="button" className={button} onClick={() => setEdits(n => n + 1)}>Check source</button>
      </div>
      <Diagnostics projectId={projectId} revision={edits} />
    </section>
  </>;
}

function Settings() {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string>();
  const { data, error } = useProjects(revision);
  const projects = data?.filter(project => project.available);
  const current = projects?.find(project => project.id === selected)
    ?? projects?.find(project => project.configured) ?? projects?.[0];

  return <div className="space-y-4">
    {error && <div className="space-y-2">
      <Notice error={error} />
      <button type="button" className={button} onClick={() => setRevision(n => n + 1)}>Retry</button>
    </div>}
    {!projects && !error && <Notice>Loading projects…</Notice>}
    {projects?.length === 0 && <Notice>No projects available.</Notice>}
    {current && <>
      <label className="flex flex-wrap items-center gap-2 text-sm font-medium">
        Project
        <select className={input} value={current.id} onChange={event => setSelected(event.target.value)}>
          {projects?.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </label>
      <ProjectSettings key={current.id} projectId={current.id} revision={revision} />
    </>}
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "project-instructions-settings", title, component: Settings });
  app.slots.navPanel({ id: "project-instructions", title, icon: "FileText", path: "project-instructions", component: StatusPage });
});
