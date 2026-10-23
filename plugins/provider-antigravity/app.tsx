import { useEffect, useState } from "react";
import { definePluginApp, useRpc, useSdk, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Diagnostics, settingsRpcContract } from "./settings-contract.ts";
import { Button, buttonVariants } from "./components/ui/button.tsx";
import { Switch } from "./components/ui/switch.tsx";
import "./app.css";

const date = (value: string | null) => value ? new Date(value).toLocaleString() : "Unknown";
const statusLabels = { ok: "Signed in", unauthenticated: "Sign in with agy", expired: "Sign-in expired", not_installed: "agy not installed", error: "Quota check unavailable" };

type DiagnosticsCache = Map<string, { data?: Diagnostics; fetchedAt?: number; pending?: Promise<Diagnostics> }>;

function AntigravitySettings({ cache }: { cache: DiagnosticsCache }) {
  const sdk = useSdk();
  const { call } = useRpc<typeof settingsRpcContract>();
  const [hosts, setHosts] = useState<{ id: string; name: string; status: string }[]>([]);
  const [hostId, setHostId] = useState("");
  const [request, setRequest] = useState({ sequence: 0, checkUpdates: false });
  const [view, setView] = useState<{ hostId: string; data: Diagnostics } | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    sdk.hosts.list().then(values => {
      if (!active) return;
      setHosts(values);
      setHostId(previous => values.some(host => host.id === previous && host.status === "connected") ? previous : values.find(host => host.status === "connected")?.id ?? "");
    }).catch(() => { if (active) setError("Machines could not be loaded."); });
    return () => { active = false; };
  }, [sdk, request.sequence]);
  useEffect(() => {
    if (!hostId) { setBusy(false); return; }
    let active = true;
    const entry = cache.get(hostId) ?? {};
    cache.set(hostId, entry);
    setError(null);
    if (entry.data) setView({ hostId, data: entry.data });
    if (!entry.pending && request.sequence === 0 && entry.fetchedAt !== undefined && Date.now() - entry.fetchedAt < 60_000) {
      setBusy(false); return;
    }
    setBusy(true);
    // Keep an in-flight read across route remounts, without repeating CLI commands.
    entry.pending ??= call("diagnostics", { hostId, checkUpdates: request.checkUpdates }).then(data => {
      entry.data = data; entry.fetchedAt = Date.now(); return data;
    }).finally(() => { entry.pending = undefined; });
    entry.pending.then(data => {
      if (active) setView({ hostId, data });
    }).catch(() => { if (active) setError("Diagnostics could not be refreshed. Check the machine connection and try again."); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [hostId, request, call, cache]);
  const data = view?.hostId === hostId ? view.data : cache.get(hostId)?.data ?? null;
  async function changeCredits(enabled: boolean) {
    if (!data?.nativeSettings.revision) return;
    setSaving(true); setError(null);
    try {
      const nativeSettings = await call("setCreditUsage", { hostId, enabled, expectedRevision: data.nativeSettings.revision });
      const entry = cache.get(hostId);
      if (entry?.data) entry.data = { ...entry.data, nativeSettings };
      setView(previous => previous?.hostId === hostId ? { ...previous, data: { ...previous.data, nativeSettings } } : previous);
    } catch { setError("The native setting could not be confirmed. Refresh before trying again; agy settings may have changed."); }
    finally { setSaving(false); }
  }
  return <div className="agy-settings">
    <div className="agy-toolbar">
      <label>Machine <span className="agy-machine-picker"><select className={buttonVariants({ variant: "outline", size: "sm" })} aria-label="Machine" value={hostId} disabled={saving} onChange={event => { setHostId(event.target.value); setRequest({ sequence: 0, checkUpdates: false }); }}>
        {!hostId && <option value="">No connected machine</option>}
        {hosts.map(host => <option key={host.id} value={host.id} disabled={host.status !== "connected"}>{host.name}{host.status !== "connected" ? " · Offline" : ""}</option>)}
      </select><Icon name="ChevronDown" className="agy-machine-chevron" aria-hidden="true" /></span></label>
      <div className="agy-actions">
        <Button variant="outline" size="sm" disabled={busy || saving} onClick={() => setRequest(previous => ({ sequence: previous.sequence + 1, checkUpdates: false }))}>{busy ? "Refreshing…" : "Refresh"}</Button>
        <Button variant="outline" size="sm" disabled={!hostId || busy || saving} onClick={() => setRequest(previous => ({ sequence: previous.sequence + 1, checkUpdates: true }))}>Check CLI updates</Button>
      </div>
    </div>
    {error && <p role="alert" className="agy-message">{error}</p>}
    {busy && <p role="status" className="agy-loading"><span className="agy-spinner" aria-hidden="true" />{data ? "Refreshing agy diagnostics…" : "Reading agy diagnostics…"}</p>}
    {!data && hostId && !busy && <p role="status">No diagnostics available.</p>}
    {data && <>
      <section className="agy-card bg-surface-recessed/70" aria-label="Connection">
        <h3>Connection</h3>
        <dl className="agy-facts">
          <dt>Account</dt><dd>{data.usage.status === "ok" || data.usage.status === "error" ? data.usage.accountEmail ?? "Unknown" : "Unknown"}</dd>
          <dt>Status</dt><dd>{statusLabels[data.usage.status]}</dd>
          <dt>agy version</dt><dd>{data.installation.currentVersion ?? "Unknown"}{data.installation.versionUnsupported && " · Unsupported"}</dd>
          <dt>Latest version</dt><dd>{data.installation.latestVersion ?? (request.checkUpdates ? "Unavailable" : "Not checked")}{data.installation.needsUpdate && " · Update available in BB provider updates"}</dd>
          <dt>Executable</dt><dd className="agy-path">{data.installation.executablePath ?? "Not found"}</dd>
        </dl>
      </section>
      <section className="agy-card bg-surface-recessed/70" aria-label="AI credits">
        <h3>AI credits</h3>
        <div className="agy-credit-row"><span>Remaining credits</span><strong>{data.credits.status === "ok" ? data.credits.remainingCredits?.toLocaleString() : "Unavailable"}</strong></div>
        <label className="agy-credit-row"><span>Use AI credits after plan quota runs out</span>
          <Switch aria-label="Use AI credits after plan quota runs out" aria-describedby="agy-credit-scope" checked={data.nativeSettings.useG1Credits ?? false}
            disabled={busy || saving || !data.installation.installed || !data.nativeSettings.editable || data.credits.status !== "ok"}
            onCheckedChange={enabled => { void changeCredits(enabled); }} />
        </label>
        <p id="agy-credit-scope" className="agy-muted">Global agy setting on this machine, including sessions outside BB. Enabling it permits spending AI credits. Not available for business accounts.{saving && " Saving…"}</p>
        {data.nativeSettings.message && <p className="agy-muted">{data.nativeSettings.message}</p>}
        {data.nativeSettings.useG1Credits === null && <p className="agy-muted">Current credit policy is unknown; editing is disabled.</p>}
        <p className="agy-path agy-muted">{data.nativeSettings.filePath}</p>
      </section>
      <section className="agy-card bg-surface-recessed/70" aria-label="Subscription quotas">
        <h3>Subscription quotas</h3>
        {data.usage.status === "ok" ? <table><thead><tr><th>Limit</th><th>Remaining</th><th>Resets</th></tr></thead>
          <tbody>{data.usage.windows.map((window, index) => <tr key={index}><td>{window.label}</td><td>{(100 - window.usedPercent).toFixed(1)}%</td><td>{date(window.resetsAt)}</td></tr>)}</tbody></table>
          : <p className="agy-muted">{data.usage.status === "error" ? data.usage.message : statusLabels[data.usage.status]}</p>}
      </section>
      <section className="agy-card bg-surface-recessed/70" aria-label="Google models">
        <h3>Google models</h3>
        {data.models.map(model => <div className="agy-model" key={model.id}><span>{model.displayName}</span><span className="agy-muted">{model.efforts.join(" · ")}</span></div>)}
        {data.modelsMessage && <p className="agy-muted">{data.modelsMessage}</p>}
      </section>
      <p className="agy-muted">Choose model, reasoning and permissions in the thread. Accept Edits uses the native sandbox; Full bypasses native confirmations. Native actions requiring approval are denied in headless mode. Steering interrupts and resumes the conversation. BB memory and applicable AGENTS.md instructions are passed to the agent.</p>
      <p className="agy-muted">Checked {date(data.observedAt)}. Refresh uses local CLI commands, without a model prompt.</p>
    </>}
  </div>;
}
export default definePluginApp(app => {
  const cache: DiagnosticsCache = new Map();
  app.slots.settingsSection({ id: "diagnostics", title: "Account and diagnostics", description: "Live account, CLI, credits and quota information for the selected machine.", component: () => <AntigravitySettings cache={cache} /> });
});
