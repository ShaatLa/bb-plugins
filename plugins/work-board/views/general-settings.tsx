import { useEffect, useId, useState } from "react";
import { useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTasksRpc } from "../shell/data.js";
import { errorMessage } from "../shared/errors.js";
import { BADGE_CRITERIA, BADGE_CRITERION_LABELS } from "../shared/badge.js";
import {
  BADGE_FIELDS, GLOBAL_SETTING_DEFAULTS, OPEN_THREADS_IN, OPEN_THREADS_IN_LABELS, START_SCREENS,
  type GlobalSettingKey, type GlobalSettingsPatch,
} from "../shared/global-settings.js";
import { SelectRow, SettingsCard, SwitchRow } from "./settings-card.js";
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
  const write = async (patch: GlobalSettingsPatch) => {
    const result = await rpc.call("globalSettings.set", { values: patch });
    setAcknowledged((current) => ({ ...current, ...result.values }));
  };
  // Writes wait for the host's values: a default shown meanwhile would overwrite a stored value.
  return { value, write, loaded: values !== undefined };
}

function useWrite(write: (patch: GlobalSettingsPatch) => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (patch: GlobalSettingsPatch) => {
    setBusy(true);
    setError(null);
    try { await write(patch); return true; } catch (failure) { setError(errorMessage(failure)); return false; } finally { setBusy(false); }
  };
  return { busy, error, run };
}

const Alert = ({ error }: { error: string | null }) => error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null;

function RunnerPaths({ value, write, loaded }: ReturnType<typeof useGlobalSettings>) {
  const id = useId();
  const { busy, error, run } = useWrite(write);
  const [drafts, setDrafts] = useState<{ checksBbCli?: string; checksRuntimePath?: string }>({});
  const dirty = Object.entries(drafts).some(([key, draft]) => draft !== value(key as "checksBbCli"));
  const fields = [
    ["checksBbCli", "BB CLI absolute path", "Empty: use the server environment. For example /opt/bin/bb."],
    ["checksRuntimePath", "Script PATH", "Empty: inherit the server PATH."],
  ] as const;
  return (
    <SettingsCard title="Repository-check runner" description="How every project's repository-check script is launched. These paths apply to all projects."
      actions={<>
        {dirty ? <Button size="sm" variant="ghost" className="h-7 px-2.5" disabled={busy} onClick={() => setDrafts({})}>Discard</Button> : null}
        <Button size="sm" className="h-7 px-2.5" disabled={busy || !dirty || !loaded}
          onClick={() => void run({ checksBbCli: drafts.checksBbCli ?? value("checksBbCli"), checksRuntimePath: drafts.checksRuntimePath ?? value("checksRuntimePath") })
            .then((saved) => { if (saved) setDrafts({}); })}>Save</Button>
      </>}>
      <div className="space-y-3">
        {fields.map(([key, label, hint]) => (
          <div key={key} className="space-y-1 text-sm">
            <label htmlFor={`${id}-${key}`}>{label}</label>
            <Input id={`${id}-${key}`} aria-describedby={`${id}-${key}-hint`} className="h-8 font-mono text-xs" value={drafts[key] ?? value(key)} disabled={busy || !loaded}
              onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} />
            <p id={`${id}-${key}-hint`} className="text-xs text-muted-foreground">{hint}</p>
          </div>
        ))}
      </div>
      <Alert error={error} />
    </SettingsCard>
  );
}

/** The global settings; they apply to every project and are shown whether or not a project exists. */
export function GeneralSettings() {
  const settings = useGlobalSettings();
  const { value, write, loaded } = settings;
  const links = useWrite(write);
  const badges = useWrite(write);
  return (
    <div className="space-y-4">
      <SettingsCard title="Start and links" description="Where Work Board opens and where thread links lead.">
        <SelectRow label="Start screen" value={value("startScreen")} disabled={links.busy || !loaded}
          options={START_SCREENS.map((screen) => [screen, START_SCREEN_LABELS[screen]] as const)}
          onChange={(startScreen) => void links.run({ startScreen })} hint="The screen Work Board shows when it opens." />
        <SelectRow label="Open thread links in" value={value("openThreadsIn")} disabled={links.busy || !loaded}
          options={OPEN_THREADS_IN.map((target) => [target, OPEN_THREADS_IN_LABELS[target]] as const)}
          onChange={(openThreadsIn) => void links.run({ openThreadsIn })} hint="Agent Hub falls back to bb chat when it is not installed." />
        <Alert error={links.error} />
      </SettingsCard>
      <SettingsCard title="Navigation badges" description="What the Work Board navigation badge counts; a task matching several counts once.">
        {BADGE_CRITERIA.map((criterion) => (
          <SwitchRow key={criterion} label={BADGE_CRITERION_LABELS[criterion]} checked={value(BADGE_FIELDS[criterion])} disabled={badges.busy || !loaded}
            onChange={(on) => void badges.run({ [BADGE_FIELDS[criterion]]: on })} hint="Counted in the navigation badge." />
        ))}
        <Alert error={badges.error} />
      </SettingsCard>
      <RunnerPaths {...settings} />
      <StorageSettings />
    </div>
  );
}
