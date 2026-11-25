import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRealtime, useRpc, useSdk, type StandardSchemaV1 } from "@get-bb/plugin-sdk/app";
import { SLOTS_CHANGED, type SettingKey, type SettingsFormView, type RpcMethods } from "./contract";
import { Button } from "./components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import { SettingsRowList, SettingsSection, SettingsWithControl } from "./components/ui/settings-section";
import { Input } from "./components/ui/input";
import { Switch } from "./components/ui/switch";
import { Summary } from "./components/ui/summary";
import { LoadingSkeleton } from "./components/ui/skeleton";
import { ThreadPickerDialog } from "./thread-picker-dialog";
import { debounce, useStatus } from "./use-status";

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
  ["idle-lease", "Idle heavy lease", "A heavy slot was held while its checkout stayed idle for the configured minutes."],
] as const;
const row = "py-3 first:pt-0 last:pb-0";
const body = "rounded-lg border border-border bg-card px-4 py-3.5";
const minutes = (value: number) => value % 60 ? `${value} min` : `${value / 60} h`;

function Row({ label, badge, description, children }: { label: string; badge?: string; description?: ReactNode; children: ReactNode }) {
  return <div className={row}><SettingsWithControl label={label} labelBadge={badge} description={description}>{children}</SettingsWithControl></div>;
}

// Rarely changed groups stay closed; the summary line shows their current values.
function Collapsible({ title, summary, children }: { title: string; summary: string; children: ReactNode }) {
  return <details className="space-y-3">
    <Summary className="min-w-0 gap-2"><h2 className="shrink-0 text-sm font-semibold text-foreground">{title}</h2><span className="min-w-0 truncate text-xs text-subtle-foreground/75">{summary}</span></Summary>
    <div className={body}><SettingsRowList>{children}</SettingsRowList></div>
  </details>;
}

function Nested({ title, children }: { title: string; children: ReactNode }) {
  return <details className={row}><Summary className="text-sm">{title}</Summary><div className="mt-3 border-t border-border pt-3"><SettingsRowList>{children}</SettingsRowList></div></details>;
}

function ResetButton({ label, onReset }: { label: string; onReset: () => void }) {
  return <Button type="button" size="sm" variant="ghost" aria-label={`Reset ${label} to default`} onMouseDown={event => event.preventDefault()} onClick={onReset}>Reset</Button>;
}

// Keeps typing local; commits on blur or Enter so each keystroke does not save config.
function NumberField({ label, value, fallback, min, max, step = 1, onCommit, onReset }: {
  label: string; value: number | string; fallback?: number | string; min: number; max: number; step?: number;
  onCommit: (value: number) => Promise<void>; onReset?: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const committing = useRef(false);
  async function commit() {
    if (draft === null || committing.current) return;
    const next = draft === "" ? NaN : Number(draft);
    if (!Number.isFinite(next) || next < min || next > max || (step === 1 && !Number.isInteger(next)) || next === Number(value)) { setDraft(null); return; }
    committing.current = true;
    try { await onCommit(next); } finally { committing.current = false; setDraft(null); }
  }
  return <div className="flex items-center justify-end gap-2">
    {onReset && Number(value) !== Number(fallback) && <ResetButton label={label} onReset={() => { setDraft(null); onReset(); }} />}
    <Input aria-label={label} type="number" min={min} max={max} step={step} className="w-24" value={draft ?? value}
      onChange={event => setDraft(event.target.value)} onBlur={() => { void commit(); }} onKeyDown={event => { if (event.key === "Enter") void commit(); }} />
  </div>;
}

function Choice({ label, value, fallback, options, onChange }: { label: string; value: string; fallback: string; options: [string, string][]; onChange: (value: string | null) => void }) {
  return <div className="flex items-center justify-end gap-2">
    {value !== fallback && <ResetButton label={label} onReset={() => onChange(null)} />}
    <Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} className="w-56 max-w-full"><SelectValue /></SelectTrigger>
      <SelectContent>{options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}</SelectContent></Select>
  </div>;
}

export function SlotsSettings() {
  const rpc = useRpc<Contract>(), sdk = useSdk(), navigate = useBbNavigate();
  const { view } = useStatus({ clock: false });
  const [data, setData] = useState<SettingsFormView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [observerTitle, setObserverTitle] = useState("Observer thread");
  const eventRef = useRef<() => void>(() => {});
  useRealtime(SLOTS_CHANGED, () => eventRef.current());
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let again = false;
    let stale = false;
    async function read(initial = false) {
      // An event received while hidden is remembered and refetched when visible.
      if (!initial && document.visibilityState === "hidden") { stale = true; return; }
      if (pending) { again = true; return; }
      pending = true;
      stale = false;
      try {
        const result = await rpc.call("settingsRead", {});
        if (disposed) return;
        if (result.ok) setData(result.data); else if (initial) setError(result.error.message);
      } catch (cause) { if (!disposed && initial) setError(String(cause)); }
      pending = false;
      if (!disposed && again) { again = false; void read(); }
    }
    const events = debounce(() => { void read(); });
    eventRef.current = events.call;
    const onVisibility = () => { if (stale && document.visibilityState !== "hidden") { events.cancel(); void read(); } };
    document.addEventListener("visibilitychange", onVisibility);
    void read(true);
    return () => {
      disposed = true;
      events.cancel();
      eventRef.current = () => {};
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [rpc]);
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
  const { values, defaults, cores } = data;
  const latest = view?.gates[view.localHostId]?.latest;
  const number = (key: SettingKey, label: string, min: number, max: number, hint?: string, step = 1) =>
    <Row key={key} label={label} description={[key === "heavyCapacityWithModel" ? "Default: heavy jobs capacity" : `Default ${defaults[key]}`, hint].filter(Boolean).join(" · ")}>
      <NumberField label={label} value={values[key]} fallback={key === "heavyCapacityWithModel" ? values.heavyCapacity : defaults[key]} min={min} max={max} step={step}
        onCommit={value => save(key, value).catch(() => {})} onReset={() => apply(key, null)} />
    </Row>;
  const selected = String(values.observerEvents).split(",").filter(Boolean);
  const machines = String(values.remoteHosts ?? "").split(",").map(entry => entry.trim()).filter(Boolean).map(entry => entry.split("=") as [string, string]);
  const withModels = Object.fromEntries(String(values.remoteHostsWithModel ?? "").split(",").filter(Boolean).map(e => e.split("=")));
  const deviceHosts: Record<string, string> = Object.fromEntries(String(values.deviceHosts ?? "").split(",").filter(Boolean).map(e => e.split("=")));
  const saveMap = (key: "remoteHostsWithModel" | "deviceHosts", map: Record<string, string>) => apply(key, Object.entries(map).map(([k, v]) => `${k}=${v}`).join(","));
  const toolsByHost = Object.fromEntries(String(values.machineTools ?? "").split(";").map(e => e.trim()).filter(Boolean).map(e => e.split("=") as [string, string]));
  const writeTools = (id: string, tools: string) => { const next = { ...toolsByHost, [id]: tools }; apply("machineTools", Object.entries(next).map(([host, value]) => `${host}=${value}`).join(";")); };
  const writeMachines = (next: [string, string | number][]) => apply("remoteHosts", next.length ? next.map(([id, capacity]) => `${id}=${capacity}`).join(",") : null);
  const known = (data.hosts ?? []).filter(host => host.id !== view?.localHostId);
  const addable = known.filter(host => !machines.some(([id]) => id === host.id));
  return <div className="max-w-2xl space-y-6">
    <p className="text-xs text-muted-foreground">Changes apply immediately.</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {view?.settingsWarnings?.map(message => <p key={message} role="alert" className="text-sm text-amber-700 dark:text-amber-400">{message}</p>)}
    <fieldset disabled={busy} aria-busy={busy} className="space-y-6">
      <SettingsSection title="Slots" description="How many heavy jobs and local model runs may hold a slot at once."><SettingsRowList>
        {number("heavyCapacity", "Heavy jobs capacity", 0, cores, `max ${cores} (CPU cores). Zero disables the pool.`)}
        {number("heavyCapacityWithModel", "Heavy jobs with a local model", 0, cores, "Reset follows heavy jobs capacity")}
        {number("modelHoldMinutes", "Model hold (minutes)", 1, 10080, "After this time heavy capacity returns to its high value")}
        {number("localModelCapacity", "Local model capacity (this Mac)", 0, data.maxima.localModelCapacity ?? 16, `max ${data.maxima.localModelCapacity ?? 16}. Zero disables the pool.`)}
        <Row label="Other machines" description="Threads there lease that machine; slots-run --spill runs heavy work there when this Mac is full. No machine check there.">
          <div className="flex items-center justify-end gap-2">
            {machines.length > 0 && <ResetButton label="Other machines" onReset={() => apply("remoteHosts", null)} />}
            {addable.length > 0 ? <Select value="" onValueChange={id => writeMachines([...machines, [id, 2]])}>
              <SelectTrigger aria-label="Add machine" className="w-44 max-w-full"><SelectValue placeholder="Add machine" /></SelectTrigger>
              <SelectContent>{addable.map(host => <SelectItem key={host.id} value={host.id}>{host.name ?? host.id}</SelectItem>)}</SelectContent>
            </Select> : <span className="text-xs text-muted-foreground">No other machines</span>}
          </div>
        </Row>
        {machines.map(([id, capacity], index) => {
          const host = known.find(item => item.id === id), name = host?.name ?? id;
          return <Row key={id} label={name} badge={host?.connected === false ? "offline" : undefined} description="Heavy jobs capacity on that machine.">
            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" aria-label={`Remove ${name}`} onClick={() => writeMachines(machines.filter((_, other) => other !== index))}>Remove</Button>
              <Input aria-label={`${name} model device`} placeholder="Model device" defaultValue={Object.keys(deviceHosts).find(device => deviceHosts[device] === id) ?? ""} onBlur={event => { const next = Object.fromEntries(Object.entries(deviceHosts).filter(([, host]) => host !== id)); if (event.target.value.trim()) next[event.target.value.trim()] = id; saveMap("deviceHosts", next); }} />
              <NumberField label={`${name} with model`} value={withModels[id] ?? capacity} fallback={capacity} min={0} max={9999} onCommit={value => save("remoteHostsWithModel", Object.entries({ ...withModels, [id]: String(value) }).map(([host, n]) => `${host}=${n}`).join(",")).catch(() => {})} onReset={() => { const next = { ...withModels }; delete next[id]; saveMap("remoteHostsWithModel", next); }} />
              <Input aria-label={`${name} Installed`} placeholder="Installed: go,docker" defaultValue={toolsByHost[id] ?? ""} key={`${id}:${toolsByHost[id] ?? ""}`} onBlur={event => writeTools(id, event.target.value.trim())} />
              <NumberField label={`${name} heavy jobs capacity`} value={capacity} min={0} max={9999}
                onCommit={value => save("remoteHosts", machines.map(([other, n]) => `${other}=${other === id ? value : n}`).join(",")).catch(() => {})} />
            </div>
          </Row>;
        })}
      </SettingsRowList></SettingsSection>
      <SettingsSection title="Machine check" description="Work starts only while this Mac has enough free memory and its load stays under the limit."><SettingsRowList>
        {number("memFreeMinPct", "Memory free minimum (%)", 0, 100, latest ? `now ${Math.round(latest.memFreePct)}% free` : "waiting for a machine reading", 0.1)}
        {number("loadMax", "Load limit", 0.1, cores, `max ${cores} (CPU cores)${latest ? ` · now ${latest.load1.toFixed(1)}` : ""}`, 0.1)}
        <Nested title="Advanced">{number("gateSamples", "Checks in a row", 1, 100)}{number("gateIntervalSeconds", "Seconds between checks", 1, 3600)}</Nested>
      </SettingsRowList></SettingsSection>
      <Collapsible title="Load watch" summary={values.watchPolicy === "off" ? "Off" : `Warn · ${values.watchCores} cores for ${values.watchWindowSeconds} s · idle notice ${minutes(Number(values.idleLeaseMinutes))}`}>
        <Row label="Policy" description="Warns when processes in a session's checkout use many cores for a while without a heavy slot. Reads only process ids, start times, CPU time and working directories.">
          <Choice label="Load watch policy" value={String(values.watchPolicy)} fallback={String(defaults.watchPolicy)} options={[["off", "Off"], ["warn", "Warn"]]} onChange={value => apply("watchPolicy", value)} />
        </Row>
        {number("watchCores", "Cores threshold", 1, cores, `max ${cores} (CPU cores)`)}
        {number("watchWindowSeconds", "Window (seconds)", 60, 900)}
        {number("idleLeaseMinutes", "Idle lease notice (minutes)", 10, 240)}
      </Collapsible>
      <Collapsible title="Leases" summary={`${minutes(Number(values.leaseTtlMinutes))} · heartbeat ${minutes(Number(values.heartbeatIntervalMinutes))} · longest ${minutes(Number(values.maxEstimateMinutes))}`}>
        {number("leaseTtlMinutes", "Lease time (minutes)", 2, 10080, "a lease lasts the longer of this or its estimate + 15 minutes")}
        {number("heartbeatIntervalMinutes", "Heartbeat interval (minutes)", 1, 10079, "idle holders are warned this long before expiry")}
        {number("maxEstimateMinutes", "Longest estimate (minutes)", 10, 10080, "longer estimates are refused")}
        <Row label="Grant mode" description="Automatic grants follow queue order and passing machine checks. Manual grants wait for the manager.">
          <Choice label="Grant mode" value={String(values.grantMode)} fallback={String(defaults.grantMode)} options={[["auto", "Automatic"], ["manual", "Manual (manager grants)"]]} onChange={value => apply("grantMode", value)} />
        </Row>
      </Collapsible>
      <Collapsible title="Notifications" summary={`${observer ? observerTitle : "No observer"} · ${selected.length} of ${events.length} events on`}>
        <Row label="Observer thread" description="Receives manager notifications.">
          <div className="flex flex-wrap items-center justify-end gap-2 text-sm">{observer ? <Button variant="link" className="h-auto p-0" onClick={() => navigate.toThread(observer)}>{observerTitle}</Button> : <span className="text-muted-foreground">None</span>}
            <Button size="sm" variant="outline" onClick={() => setPicking(true)}>Choose thread…</Button>{observer && <Button size="sm" variant="ghost" onClick={() => apply("observerThreadId", "")}>Clear</Button>}
          </div>
        </Row>
        <Nested title={`Events · ${selected.length} of ${events.length} on`}>{events.map(([event, label, explanation]) => [
          <Row key={event} label={label} description={explanation}>
            <Switch aria-label={label} checked={selected.includes(event)} onCheckedChange={checked => apply("observerEvents", (checked ? [...selected, event] : selected.filter(item => item !== event)).join(","))} />
          </Row>,
          event === "queue-wait" && number("observerQueueWaitMinutes", "Request wait threshold (minutes)", 1, 10080),
          event === "gate-hold" && number("observerGateHoldMinutes", "Machine busy threshold (minutes)", 1, 10080),
        ])}</Nested>
      </Collapsible>
      <Collapsible title="Dev-server ports" summary={`${values.portFrom}–${values.portTo}`}>{number("portFrom", "From port", 1, 65535)}{number("portTo", "To port", 1, 65535)}</Collapsible>
    </fieldset>
    {picking && <ThreadPickerDialog projectId={null} problemTitle="Machine Slots observer" onClose={() => setPicking(false)} onSelect={id => save("observerThreadId", id)} />}
  </div>;
}
