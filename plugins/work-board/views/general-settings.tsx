import { useEffect, useId, useRef, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTasksRpc } from "../shell/data.js";
import { errorMessage } from "../shared/errors.js";
import { BADGE_CRITERIA, BADGE_CRITERION_LABELS } from "../shared/badge.js";
import {
  BADGE_FIELDS, GLOBAL_SETTING_DEFAULTS, OPEN_THREADS_IN, OPEN_THREADS_IN_LABELS, STALE_GLOBAL_SETTING, START_SCREENS,
  type GlobalSettingKey, type GlobalSettingsPatch,
} from "../shared/global-settings.js";
import { NOT_SAVED, SelectRow, SettingsCard, SwitchRow, useSaveStatus } from "./settings-card.js";
import { StorageSettings } from "./storage-settings.js";

const START_SCREEN_LABELS: Record<(typeof START_SCREENS)[number], string> = {
  "last-project-board": "Last project: board",
  "last-project-list": "Last project: list",
  all: "All tasks",
  active: "Active tasks",
};

/** Native field values as the host reports them, with this page's acknowledged writes on top until the host catches up. */
function useGlobalSettings() {
  const rpc = useTasksRpc();
  const { values } = useSettings();
  const [acknowledged, setAcknowledged] = useState<GlobalSettingsPatch>({});
  useEffect(() => setAcknowledged({}), [values]);
  const value = <K extends GlobalSettingKey>(key: K) => (acknowledged[key] ?? values?.[key] ?? GLOBAL_SETTING_DEFAULTS[key]) as NonNullable<GlobalSettingsPatch[K]>;
  // `expected`: the stored values the change was built on; the server refuses the write when they changed meanwhile.
  const write = async (patch: GlobalSettingsPatch, expected?: GlobalSettingsPatch) => {
    const result = await rpc.call("globalSettings.set", { values: patch, ...(expected ? { expected } : {}) });
    setAcknowledged((current) => ({ ...current, ...result.values }));
  };
  /** Rereads the stored value of `key` only, e.g. after its write was refused; other fields keep what they show. */
  const reload = async (key: GlobalSettingKey) => {
    const { values: stored } = await rpc.call("globalSettings.get", {});
    setAcknowledged((current) => ({ ...current, [key]: stored[key] }));
  };
  // Writes wait for the host's values: a default shown meanwhile would overwrite a stored value.
  return { value, write, reload, loaded: values !== undefined };
}

type RunnerKey = "checksBbCli" | "checksRuntimePath";
const RUNNER_FIELDS = [
  ["checksBbCli", "BB CLI absolute path", "Empty: use the server environment. For example /opt/bin/bb."],
  ["checksRuntimePath", "Script PATH", "Empty: inherit the server PATH."],
] as const;
// The server checks the bb path with node's isAbsolute, which the browser lacks; a path it still refuses is a failed save.
const runnerError = (key: RunnerKey, text: string) => key === "checksBbCli" && text !== "" && !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(text)
  ? "Enter the absolute path to bb (for example /opt/bin/bb), or clear it to use the server environment." : null;

/**
 * The runner paths of every project's repository checks. A field saves when it loses focus or on Enter, never while
 * typing, over the stored value it was edited from: a value changed in another window meanwhile is a conflict with
 * Reload. A field is disabled while its own write or Reload is in flight, so nothing is committed over it.
 */
export function RunnerPaths({ save }: { save: ReturnType<typeof useSaveStatus> }) {
  const { value, write, reload, loaded } = useGlobalSettings();
  const id = useId();
  const [drafts, setDrafts] = useState<Partial<Record<RunnerKey, string>>>({});
  const [conflicts, setConflicts] = useState<Partial<Record<RunnerKey, boolean>>>({});
  const [busy, setBusy] = useState<Partial<Record<RunnerKey, boolean>>>({});
  // The ref guards a second commit in the same event (Enter, then the blur it causes).
  const busyRef = useRef<Partial<Record<RunnerKey, boolean>>>({});
  const setFieldBusy = (key: RunnerKey, on: boolean) => {
    busyRef.current = { ...busyRef.current, [key]: on };
    setBusy(busyRef.current);
  };
  // The stored value each field's edit started from, sent as `expected`.
  const bases = useRef<Partial<Record<RunnerKey, string>>>({});
  const drop = (key: RunnerKey) => {
    setDrafts(({ [key]: _done, ...rest }) => rest);
    bases.current[key] = undefined;
  };
  // An invalid draft stays on screen with its error and is never sent; a failed one stays too, with Retry.
  const send = async (key: RunnerKey, text: string) => {
    if (busyRef.current[key] || conflicts[key] || runnerError(key, text)) return;
    const base = bases.current[key] ?? value(key);
    // Back at the stored value: nothing to write, and nothing left to retry.
    if (text === base) {
      save.forget(key);
      return drop(key);
    }
    setFieldBusy(key, true);
    const saved = await save.track(async () => {
      try {
        await write({ [key]: text }, { [key]: base });
      } catch (failure) {
        if (!errorMessage(failure).includes(STALE_GLOBAL_SETTING)) throw failure;
        setConflicts((current) => ({ ...current, [key]: true }));
        return NOT_SAVED;
      }
    }, () => retry(key), key);
    setFieldBusy(key, false);
    if (saved) drop(key);
  };
  // Retry sends the field's current draft over the value it was first edited from.
  const latestDrafts = useRef(drafts);
  latestDrafts.current = drafts;
  const retry = (key: RunnerKey) => {
    const draft = latestDrafts.current[key];
    if (draft !== undefined) void send(key, draft);
  };
  const reloadField = async (key: RunnerKey) => {
    setFieldBusy(key, true);
    try {
      await reload(key);
      drop(key);
      setConflicts((current) => ({ ...current, [key]: false }));
      save.forget(key);
    } finally {
      setFieldBusy(key, false);
    }
  };
  return (
    <div className="space-y-3">
      {RUNNER_FIELDS.map(([key, label, hint]) => {
        const draft = drafts[key];
        const error = draft === undefined ? null : runnerError(key, draft);
        return (
          <div key={key} className="space-y-1 text-sm">
            <label htmlFor={`${id}-${key}`}>{label}</label>
            <Input id={`${id}-${key}`} aria-describedby={`${id}-${key}-hint`} aria-invalid={error ? true : undefined} className="h-8 font-mono text-xs"
              value={draft ?? value(key)} disabled={!loaded || busy[key]}
              onChange={(event) => {
                const text = event.target.value;
                // The base is the value read before the edit started, not whatever is stored when it is sent.
                if (draft === undefined) bases.current[key] = value(key);
                setDrafts((current) => ({ ...current, [key]: text }));
                // A Retry would write a value that is no longer in the field; an invalid one hides it.
                if (runnerError(key, text)) save.forget(key);
              }}
              // Moving to this field's own Reload commits nothing, so the write cannot disable that button under the click.
              onBlur={(event) => {
                const next = event.relatedTarget as Node | null;
                if (draft !== undefined && !(next && event.currentTarget.parentElement?.contains(next))) void send(key, draft);
              }}
              onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing && draft !== undefined) void send(key, draft); }} />
            <p id={`${id}-${key}-hint`} className="text-xs text-muted-foreground">{hint}</p>
            {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
            {conflicts[key] ? (
              <p role="alert" className="text-xs text-destructive" data-testid="runner-conflict">
                Changed elsewhere, so nothing was written. Reload shows the stored value and discards this edit.
                <Button size="sm" variant="ghost" className="ml-1 h-7 px-2" disabled={busy[key]} onClick={() => void reloadField(key).catch(() => undefined)}>Reload</Button>
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/** The global settings; they apply to every project and are shown whether or not a project exists. */
export function GeneralSettings() {
  const { value, write, loaded } = useGlobalSettings();
  const links = useSaveStatus();
  const badges = useSaveStatus();
  return (
    <div className="space-y-4">
      <SettingsCard title="Start and links" description="Where Work Board opens and where thread links lead." save={links.status}>
        <SelectRow label="Start screen" value={value("startScreen")} disabled={links.busy || !loaded}
          options={START_SCREENS.map((screen) => [screen, START_SCREEN_LABELS[screen]] as const)}
          onChange={(startScreen) => void links.track(() => write({ startScreen }), undefined, "startScreen")} hint="The screen Work Board shows when it opens." />
        <SelectRow label="Open thread links in" value={value("openThreadsIn")} disabled={links.busy || !loaded}
          options={OPEN_THREADS_IN.map((target) => [target, OPEN_THREADS_IN_LABELS[target]] as const)}
          onChange={(openThreadsIn) => void links.track(() => write({ openThreadsIn }), undefined, "openThreadsIn")} hint="Agent Hub falls back to bb chat when it is not installed." />
      </SettingsCard>
      <SettingsCard title="Navigation badges" save={badges.status}
        description="Tasks matching a switch that is on are counted in the Work Board navigation badge; a task matching several counts once.">
        {BADGE_CRITERIA.map((criterion) => (
          <SwitchRow key={criterion} label={BADGE_CRITERION_LABELS[criterion]} checked={value(BADGE_FIELDS[criterion])} disabled={badges.busy || !loaded}
            onChange={(on) => void badges.track(() => write({ [BADGE_FIELDS[criterion]]: on }), undefined, BADGE_FIELDS[criterion])} />
        ))}
      </SettingsCard>
      <StorageSettings />
    </div>
  );
}
