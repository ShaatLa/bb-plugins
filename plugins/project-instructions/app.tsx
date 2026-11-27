import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { definePluginApp, experimental_Icon as Icon, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { Switch } from "./components/ui/switch";
import type { rpcContract } from "./server";
import { SettingsDraft } from "./settings-draft";
import { fieldValues, type ConfigValues, type ProjectStatus, type StatusProject } from "./status-contract";

const title = "Project Instructions";
const card = "min-w-0 rounded-lg border border-border bg-card px-4 py-3.5";
const muted = "text-sm text-muted-foreground";
const button = "rounded-md border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
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

const settingRow = "grid gap-1.5 py-1.5 first:pt-0 last:pb-0 min-[400px]:grid-cols-[8rem_minmax(0,1fr)]";
const settingLabel = "self-center text-sm font-medium";

function TextSetting({ label, value, version, draft, save }: {
  label: string; value: string; version: number; draft: SettingsDraft; save: (value: string) => Promise<string>;
}) {
  const id = useId();
  const composing = useRef(false);
  const state = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  useEffect(() => { draft.reconcile(value, version); }, [draft, value, version]);

  return <div className={settingRow}>
    <label htmlFor={id} className={settingLabel}>{label}</label>
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-2 rounded-md border border-input bg-background px-2.5 focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
        <input id={id} className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
          value={state.text}
          aria-invalid={state.status === "invalid" || undefined}
          aria-describedby={state.error ? `${id}-error` : undefined}
          onChange={event => draft.edit(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onBlur={event => {
            const page = event.currentTarget.ownerDocument;
            const staysOnPage = event.relatedTarget?.ownerDocument === page || page.hasFocus();
            if (!composing.current && page.visibilityState !== "hidden" && staysOnPage) draft.commit(save);
          }}
          onKeyDown={event => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && !composing.current) draft.commit(save);
          }} />
        <span role="status" className="shrink-0 text-xs text-muted-foreground">
          {state.status === "saving" && "Saving…"}
          {state.status === "saved" && <>
            <Icon name="Check" className="size-4" aria-hidden />
            <span className="sr-only">Saved</span>
          </>}
          {state.status === "failed" && "Not saved"}
        </span>
        {state.status === "failed" && <button type="button" aria-label={`Retry saving ${label}`}
          className="shrink-0 rounded px-1.5 py-1 text-xs font-medium hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
          onFocus={draft.stopRetry}
          onClick={event => {
            event.currentTarget.parentElement?.querySelector("input")?.focus();
            draft.commit(save, true);
          }}>Retry</button>}
      </div>
      {state.error && <p id={`${id}-error`} role="alert" className="mt-1 break-words text-xs text-destructive">{state.error}</p>}
    </div>
  </div>;
}

function BooleanSetting({ label, value, save }: {
  label: string; value: boolean; save: (value: boolean) => Promise<unknown>;
}) {
  const id = useId();
  const [saved, setSaved] = useState(value);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function apply(next: boolean) {
    if (pending) return;
    setError(undefined);
    setPending(true);
    try {
      await save(next);
      setSaved(next);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }

  return <div className={settingRow}>
    <label htmlFor={id} className={settingLabel}>{label}</label>
    <div className="min-w-0">
      <div className="flex h-7 items-center gap-2">
        <Switch id={id} checked={saved} onCheckedChange={apply}
          aria-disabled={pending || undefined} className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50" />
        {pending && <span role="status" className="text-xs text-muted-foreground">Saving…</span>}
      </div>
      {error && <Notice error={error} />}
    </div>
  </div>;
}

function ProjectSettings({ projectId, drafts, diagnosticsRevision, refreshDiagnostics }: {
  projectId: string; drafts: Map<string, SettingsDraft>; diagnosticsRevision: number; refreshDiagnostics: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [revision, setRevision] = useState(0);
  const { data, error } = useRead(useCallback(async () => {
    return Promise.all(fields.map(async key => {
      const draftKey = JSON.stringify([projectId, key]);
      const version = drafts.get(draftKey)?.version ?? 0;
      const result = await rpc.call("config.get", { projectId, key });
      const value = fieldValues[key].parse(result);
      return { key, value, version, draftKey };
    }));
  }, [rpc, projectId, drafts]), revision);

  async function apply(key: keyof ConfigValues, value: string | boolean) {
    const result = await rpc.call("config.set", { projectId, key, value });
    refreshDiagnostics();
    return result;
  }

  return <>
    <section aria-label="Project settings" className={`${card} divide-y divide-border`}>
      {data ? data.map(({ key, value, version, draftKey }) => {
        const label = fieldLabels[key];
        if (key === "enabled" || key === "allowSync") {
          return <BooleanSetting key={key} label={label} value={fieldValues[key].parse(value)}
            save={async next => fieldValues[key].parse(await apply(key, next))} />;
        }
        const saved = fieldValues[key].parse(value) ?? "";
        let draft = drafts.get(draftKey);
        if (!draft) {
          draft = new SettingsDraft(projectId, key, saved);
          drafts.set(draftKey, draft);
        }
        return <TextSetting key={key} label={label} value={saved} version={version} draft={draft}
          save={async next => fieldValues[key].parse(await apply(key, next)) ?? ""} />;
      }) : error ? <div className="space-y-2">
        <Notice error={error} />
        <button type="button" className={button} onClick={() => setRevision(n => n + 1)}>Retry settings</button>
      </div> : <Notice>Loading settings…</Notice>}
    </section>
    <section aria-label="Source check" className={`${card} space-y-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Source check</h2>
        <button type="button" className={button} onClick={refreshDiagnostics}>Check source</button>
      </div>
      <Diagnostics projectId={projectId} revision={diagnosticsRevision} />
    </section>
  </>;
}

function Settings() {
  const [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [drafts] = useState(() => new Map<string, SettingsDraft>());
  const [diagnosticsRevision, setDiagnosticsRevision] = useState(0);
  const refreshDiagnostics = useCallback(() => setDiagnosticsRevision(n => n + 1), []);
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
        <Select value={current.id} onValueChange={setSelected}>
          <SelectTrigger aria-label="Project" className="w-56 max-w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            {projects?.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <ProjectSettings key={current.id} projectId={current.id} drafts={drafts}
        diagnosticsRevision={diagnosticsRevision} refreshDiagnostics={refreshDiagnostics} />
    </>}
  </div>;
}

export default definePluginApp(app => {
  app.slots.settingsSection({ id: "project-instructions-settings", title, component: Settings });
  app.slots.navPanel({ id: "project-instructions", title, icon: "FileText", path: "project-instructions", component: StatusPage });
});
