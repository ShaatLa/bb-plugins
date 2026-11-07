import { useEffect, useState, type ReactNode } from "react";
import { useBbNavigate, useRealtime, useRpc, useSdk, type StandardSchemaV1 } from "@get-bb/plugin-sdk/app";
import { SLOTS_CHANGED, type SettingKey, type SettingsFormView, type RpcMethods } from "./contract";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Summary } from "./components/ui/summary";
import { LoadingSkeleton } from "./components/ui/skeleton";
import { ThreadPickerDialog } from "./thread-picker-dialog";
import { useStatus } from "./use-status";

type Contract = { [K in "settingsRead" | "settingsWrite"]: { input: StandardSchemaV1<RpcMethods[K]["input"]>; output: StandardSchemaV1<RpcMethods[K]["output"]> } };
const events = [
  ["warn", "Expiry warning", "An idle lease is approaching expiry."],
  ["expire", "Lease expired", "A lease expired and its slot was freed."],
  ["revoke", "Lease revoked", "A manager revoked a lease."],
  ["queue-wait", "Request waiting too long", "Queued work has exceeded the wait threshold."],
  ["gate-hold", "Machine busy too long", "The machine check has failed for too long."],
  ["grant", "Slot granted", "A thread received a slot."],
  ["release", "Slot released", "A thread freed its slot."],
  ["transfer", "Slot transferred", "A lease changed holders."],
  ["capacity", "Capacity changed", "A pool capacity was changed."],
  ["unleased-load", "Unleased load", "A checkout used many cores without a heavy slot."],
  ["idle-lease", "Idle heavy lease", "A heavy lease was idle for a while."],
] as const;
function Group({ title, children }: { title: string; children: ReactNode }) {
  return <Card role="region" aria-label={title} className="space-y-4 p-4"><h3 className="text-sm font-medium">{title}</h3>{children}</Card>;
}

export function SlotsSettings() {
  const rpc = useRpc<Contract>(), sdk = useSdk(), navigate = useBbNavigate();
  const { view } = useStatus();
  const [data, setData] = useState<SettingsFormView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [observerTitle, setObserverTitle] = useState("Observer thread");
  useEffect(() => {
    let disposed = false;
    rpc.call("settingsRead", {}).then(result => {
      if (disposed) return;
      if (result.ok) setData(result.data); else setError(result.error.message);
    }).catch(cause => { if (!disposed) setError(String(cause)); });
    return () => { disposed = true; };
  }, [rpc]);
  useRealtime(SLOTS_CHANGED, () => {
    void rpc.call("settingsRead", {}).then(result => { if (result.ok) setData(result.data); }).catch(() => {});
  });
  const observer = String(data?.values.observerThreadId ?? "");
  useEffect(() => {
    let disposed = false;
    setObserverTitle("Observer thread");
    if (observer) void sdk.threads.get({ threadId: observer }).then(thread => { if (!disposed) setObserverTitle(thread.title || thread.titleFallback || "Observer thread"); }).catch(() => {});
    return () => { disposed = true; };
  }, [sdk, observer]);
  async function save(key: SettingKey, value: number | string | null) {
    setBusy(true); setError(null);
    try {
      const result = await rpc.call("settingsWrite", value === null ? { unset: [key] } : { values: { [key]: value } });
      if (!result.ok) throw new Error(result.error.message);
      setData(result.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    finally { setBusy(false); }
  }
  const apply = (key: SettingKey, value: number | string | null) => { void save(key, value).catch(() => {}); };
  if (!data) return <>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <LoadingSkeleton label="Loading Slots settings…" />}</>;
  const { values, cores, heavyDefault } = data;
  const latest = view?.gates[view.localHostId]?.latest;
  const number = (key: SettingKey, label: string, min: number, max: number, hint?: string, reset = false, step = 1) => <div className="space-y-1" key={key}>
    <label className="flex flex-wrap items-center justify-between gap-3 text-sm"><span>{label}</span><Input aria-label={label} type="number" min={min} max={max} step={step} className="w-24" value={values[key]} onChange={event => {
      if (event.target.value === "") return;
      const value = event.target.valueAsNumber;
      if (Number.isFinite(value) && value >= min && value <= max && (step !== 1 || Number.isInteger(value))) apply(key, value);
    }} /></label>
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">{hint && <p>{hint}</p>}{reset && <Button type="button" size="sm" variant="link" className="h-auto p-0 text-xs" aria-label={`Reset ${label} to default`} onClick={() => apply(key, null)}>Reset to default</Button>}</div>
  </div>;
  const selected = String(values.observerEvents).split(",").filter(Boolean);
  return <div className="max-w-2xl space-y-3">
    <p className="text-xs text-muted-foreground">Changes apply immediately.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {view?.settingsWarnings?.map(message => <p key={message} role="alert" className="text-sm text-amber-700 dark:text-amber-400">{message}</p>)}
    <fieldset disabled={busy} aria-busy={busy} className="space-y-3">
      <Group title="Slots">
        {number("heavyCapacity", "Heavy jobs capacity", 0, cores, `Default ${heavyDefault} · max ${cores} (CPU cores). Zero disables the pool.`, true)}
        {number("localModelCapacity", "Local model capacity", 0, 10000, "Default 1 · max 10000. Zero disables the pool.", true)}
      </Group>
      <Group title="Machine check">
        {number("memFreeMinPct", "Memory free minimum (%)", 0, 100, latest ? `now ${Math.round(latest.memFreePct)}% free` : "Waiting for a machine reading", false, 0.1)}
        {number("loadMax", "Load limit", 0.1, cores, `Default ${cores} · max ${cores} (CPU cores)${latest ? ` · now ${latest.load1.toFixed(1)}` : ""}`, true, 0.1)}
        <details className="border-t border-border pt-3"><Summary className="text-sm">Advanced</Summary><div className="mt-3 space-y-3">
          {number("gateSamples", "Checks in a row", 1, 100)}{number("gateIntervalSeconds", "Seconds between checks", 1, 3600)}
        </div></details>
      </Group>
      <Group title="Load watch">
        <label className="flex items-center justify-between gap-3 text-sm">Policy<select aria-label="Load watch policy" className="h-9 rounded-md border border-input bg-background px-2" value={values.watchPolicy} onChange={event => apply("watchPolicy", event.target.value)}><option value="off">Off</option><option value="warn">Warn</option></select></label>
        <p className="text-xs text-muted-foreground">Warns when processes in a session&apos;s checkout use many cores for a while without a heavy slot. Reads only process ids, start times, CPU time and working directories.</p>
        {number("watchCores", "Cores threshold", 1, cores, `Default ${Math.min(3, Math.max(1, cores - 1))} · max ${cores} (CPU cores).`, true)}
        {number("watchWindowSeconds", "Window (seconds)", 60, 900)}
        {number("idleLeaseMinutes", "Idle lease notice (minutes)", 10, 240)}
      </Group>
      <Group title="Leases">
        <p className="text-xs text-muted-foreground">Leases last the longer of lease time or estimate + 15 minutes; idle holders are warned one heartbeat interval before expiry.</p>
        {number("leaseTtlMinutes", "Lease time (minutes)", 2, 10080)}{number("heartbeatIntervalMinutes", "Heartbeat interval (minutes)", 1, 10079)}
      </Group>
      <Group title="Manager / observer">
        <div className="flex flex-wrap items-center gap-3 text-sm">{observer ? <Button variant="link" className="h-auto p-0" onClick={() => navigate.toThread(observer)}>{observerTitle}</Button> : <span className="text-muted-foreground">No observer selected</span>}
          <Button size="sm" variant="outline" onClick={() => setPicking(true)}>Choose thread…</Button>{observer && <Button size="sm" variant="ghost" onClick={() => apply("observerThreadId", "")}>Clear</Button>}
        </div>
        {events.map(([event, label, explanation]) => <div key={event} className="space-y-2">
          <label className="flex items-center justify-between gap-4"><span><span className="block text-sm">{label}</span><span className="block text-xs text-muted-foreground">{explanation}</span></span>
            <Switch aria-label={label} checked={selected.includes(event)} onCheckedChange={checked => apply("observerEvents", (checked ? [...selected, event] : selected.filter(item => item !== event)).join(","))} />
          </label>
          {event === "queue-wait" && number("observerQueueWaitMinutes", "Request wait threshold (minutes)", 1, 10080)}
          {event === "gate-hold" && number("observerGateHoldMinutes", "Machine busy threshold (minutes)", 1, 10080)}
        </div>)}
      </Group>
      <Group title="Grant mode"><label className="flex items-center justify-between gap-3 text-sm">Grant mode<select aria-label="Grant mode" className="h-9 rounded-md border border-input bg-background px-2" value={values.grantMode} onChange={event => apply("grantMode", event.target.value)}><option value="auto">Automatic</option><option value="manual">Manual (manager grants)</option></select></label><p className="text-xs text-muted-foreground">Automatic grants follow queue order and passing machine checks. Manual grants wait for the manager.</p></Group>
      <Group title="Dev-server ports">{number("portFrom", "From port", 1, 65535)}{number("portTo", "To port", 1, 65535)}</Group>
    </fieldset>
    {picking && <ThreadPickerDialog projectId={null} problemTitle="Machine Slots observer" onClose={() => setPicking(false)} onSelect={id => save("observerThreadId", id)} />}
  </div>;
}
