import { useEffect, useState } from "react";
import { UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { Config, rpcContract } from "./contract";
import { reviewRunsPath } from "./paths";

const input = "min-w-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = `${input} hover:bg-muted disabled:opacity-50`;
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed";
type ScheduleKey = "scheduleTime" | "scheduleSkill" | "scheduleEnabled";

export function ScheduleSettings({ projectId, managers }: {
  projectId: string; managers: { id: string; name: string }[];
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<Config>();
  const [time, setTime] = useState("");
  const [skill, setSkill] = useState("");
  const [busy, setBusy] = useState<ScheduleKey>();
  const [error, setError] = useState<{ key?: ScheduleKey; message: string }>();
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    rpc.call("config.get", { projectId }).then(raw => {
      if (!active) return;
      const current = raw as Config;
      if (typeof current?.scheduleEnabled !== "boolean") throw new Error("Schedule settings are unavailable.");
      setConfig(current);
      setTime(current.scheduleTime);
      setSkill(current.scheduleSkill ?? "");
    }).catch(cause => { if (active) setError({ message: message(cause) }); });
    return () => { active = false; };
  }, [rpc, projectId, attempt]);

  async function save<K extends ScheduleKey>(key: K, value: Config[K]) {
    if (busy || !config) return;
    setBusy(key);
    setError(undefined);
    setNotice("");
    try {
      await rpc.call("config.set", { projectId, key, value });
      setConfig(current => current && { ...current, [key]: value });
      if (key === "scheduleSkill") setSkill(String(value ?? ""));
      setNotice(key === "scheduleEnabled" ? (value ? "Self-compound enabled." : "Self-compound disabled.") : "Saved self-compound setting.");
    } catch (cause) {
      setError({ key, message: message(cause) });
    } finally {
      setBusy(undefined);
    }
  }

  const manager = config?.scheduleManager ?? config?.defaultManager;
  const managerName = managers.find(candidate => candidate.id === manager)?.name ?? manager;
  function fieldError(key?: ScheduleKey) {
    return error && error.key === key ? <p role="alert" className="text-xs text-destructive">{error.message}</p> : null;
  }

  return <section aria-label="Self-compound" className="space-y-3 rounded-lg border border-border bg-card p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-semibold">Self-compound</h2>
      <UrlLink href={reviewRunsPath(projectId)} className="text-sm underline">Review runs</UrlLink>
    </div>
    {fieldError()}
    {!config && (error
      ? <button className={button} type="button" onClick={() => setAttempt(value => value + 1)}>Reload schedule</button>
      : <p className="text-sm text-muted-foreground">Loading schedule…</p>)}
    {config && <>
      <dl className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <div><dt className="text-xs text-muted-foreground">Project timezone</dt><dd>{config.timeZone}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Run manager</dt><dd className="break-all">{managerName ?? "Unassigned"}</dd></div>
      </dl>
      <form className="space-y-1" onSubmit={event => { event.preventDefault(); void save("scheduleTime", time); }}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">Daily local time
            <input className={input} type="time" required disabled={!!busy} value={time} onChange={event => setTime(event.target.value)} />
          </label>
          <button type="submit" className={button} disabled={!!busy || time === config.scheduleTime}>Save time</button>
        </div>
        {fieldError("scheduleTime")}
      </form>
      <form className="space-y-1" onSubmit={event => { event.preventDefault(); void save("scheduleSkill", skill.trim() || null); }}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">Project skill
            <input className={input} disabled={!!busy} value={skill} onChange={event => setSkill(event.target.value)} />
          </label>
          <button type="submit" className={button} disabled={!!busy || (skill.trim() || null) === config.scheduleSkill}>Save skill</button>
        </div>
        <p className="text-xs text-muted-foreground">The named project skill supplies the launch instructions.</p>
        {fieldError("scheduleSkill")}
      </form>
      <div className="space-y-1">
        <button type="button" className={button} disabled={!!busy || !config.scheduleEnabled && !(config.scheduleSkill && manager)}
          onClick={() => void save("scheduleEnabled", !config.scheduleEnabled)}>
          {config.scheduleEnabled ? "Disable scheduled runs" : "Enable scheduled runs"}
        </button>
        {!config.scheduleEnabled && <p className="text-xs text-muted-foreground">
          {config.scheduleSkill && manager ? "Enabling can queue the latest eligible run immediately." : "Save a project skill and configure a run manager before enabling."}
        </p>}
        {fieldError("scheduleEnabled")}
      </div>
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    </>}
  </section>;
}
