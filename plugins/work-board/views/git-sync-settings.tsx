import { useEffect, useId, useRef, useState } from "react";
import { useOrderClock, useTasksQuery, useTasksRpc } from "../shell/data";
import { STALE_GIT_CONFIG, gitSyncConfigSchema, overlapEnabled, type GitSyncConfig } from "../shared/git-sync";
import { errorMessage } from "../shared/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import { TagInput } from "../components/tag-input";
import { DisclosureSummary } from "../components/disclosure";
import { SettingsCard, SwitchRow } from "./settings-card";

type OverlapRule = NonNullable<GitSyncConfig["overlapRules"]>[number];
/** What the section's Save writes: the text fields and the edited lists. */
type Draft = {
  pollMinutes: number; lookbackDays: number; postMergeDays: number;
  repositories: string[]; requiredChecks: string[]; prWaitIgnoredChecks: string[]; postMergeWorkflows: string[];
  overlapRules: OverlapRule[];
};
/** The stored configuration the form was loaded from (with when that read started), and the edits made on it. */
type Form = { saved: GitSyncConfig; draft: Draft; readAt: number };

const stable = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
const lines = (value: string) =>
  value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
const draftOf = (config: GitSyncConfig): Draft => ({
  pollMinutes: config.pollMinutes, lookbackDays: config.lookbackDays, postMergeDays: config.postMergeDays,
  repositories: config.repositories, requiredChecks: config.requiredChecks, prWaitIgnoredChecks: config.prWaitIgnoredChecks,
  postMergeWorkflows: config.postMergeWorkflows, overlapRules: config.overlapRules ?? [],
});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function GitSyncSettings({ projectId }: { projectId: string }) {
  const rpc = useTasksRpc();
  const stamp = useOrderClock();
  const query = useTasksQuery(
    (rpc) => { const readAt = stamp(); return rpc.call("getGitSyncConfig", { projectId }).then((data) => ({ ...data, readAt })); },
    ["projects:changed"],
    [projectId],
  );
  const id = useId();
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const [form, setForm] = useState<Form>();
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Reads and writes are ordered: after a write the form waits for a read that started after it and adopts it whole.
  const [verifyAfter, setVerifyAfter] = useState(0);
  const adoptNext = useRef(false);
  // A write refused because the stored settings changed meanwhile, stamped; it clears once the form adopts a read
  // started after it.
  const [conflictAt, setConflictAt] = useState<number | null>(null);
  const conflict = conflictAt !== null;
  const adopt = (config: GitSyncConfig, readAt: number) => {
    setForm({ saved: config, draft: draftOf(config), readAt });
    setConflictAt((at) => (at !== null && readAt > at ? null : at));
  };
  const saved = form?.saved;
  const draft = form?.draft ?? draftOf(gitSyncConfigSchema.parse({}));
  const setDraft = (change: (draft: Draft) => Partial<Draft>) =>
    setForm((current) => (current ? { ...current, draft: { ...current.draft, ...change(current.draft) } } : current));
  const overlapOn = saved ? overlapEnabled(saved) : false;
  // What Save writes. One rule for the switch: a stored value is kept, an absent key stays absent while the switch
  // matches what the rules being saved imply (non-empty means on), and otherwise the choice is written explicitly.
  const rulesToSave = draft.overlapRules.filter((rule) => rule.pattern.trim());
  const formConfig = (stored: GitSyncConfig): GitSyncConfig => ({
    ...stored,
    pollMinutes: draft.pollMinutes, lookbackDays: draft.lookbackDays, postMergeDays: draft.postMergeDays,
    repositories: draft.repositories, requiredChecks: draft.requiredChecks,
    postMergeWorkflows: draft.postMergeWorkflows, prWaitIgnoredChecks: draft.prWaitIgnoredChecks,
    ...(stored.overlapEnabled === undefined && overlapOn !== rulesToSave.length > 0 ? { overlapEnabled: overlapOn } : {}),
    // Rows without a pattern are not rules yet.
    overlapRules: rulesToSave,
  });
  // Compared the way Save stores it (trimmed, normalized), with the effective switch.
  const canonical = (value: GitSyncConfig) => {
    const parsed = gitSyncConfigSchema.safeParse(value);
    const normal = parsed.success ? parsed.data : value;
    return stable({ ...normal, overlapEnabled: overlapEnabled(normal), overlapRules: normal.overlapRules ?? [] });
  };
  const unsaved = saved !== undefined && canonical(formConfig(saved)) !== canonical(saved);
  // A new rule row is a draft even while its pattern is blank, though Save would drop it.
  const dirty = unsaved || draft.overlapRules.some((rule) => !rule.pattern.trim());
  const verified = form !== undefined && form.readAt > verifyAfter;
  // A clean form follows the latest successful read, also when it turns clean again; a dirty one keeps what it was
  // loaded from until Save or Discard; the first read after a write replaces the form whatever it holds (it is locked).
  useEffect(() => {
    if (!query.data || query.data.readAt <= verifyAfter || (form && dirty && !adoptNext.current)) return;
    if (form?.readAt === query.data.readAt && !adoptNext.current) return;
    adoptNext.current = false;
    adopt(query.data.config, query.data.readAt);
  }, [query.data, verifyAfter, dirty]);
  // Immediate controls write one stored key built on the stored rows: only on a clean form that applied the latest read.
  const immediate = !busy && verified && !dirty && !conflict && saved !== undefined && form?.readAt === query.data?.readAt;
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await action();
    } catch (error) {
      if (errorMessage(error).includes(STALE_GIT_CONFIG)) setConflictAt(stamp());
      else setError(errorMessage(error));
    } finally {
      setBusy(false);
      setSyncing(false);
    }
  };
  const verify = async () => {
    setVerifyAfter(stamp());
    adoptNext.current = true;
    await query.refresh();
  };
  const write = <K extends keyof GitSyncConfig>(key: K, value: (stored: GitSyncConfig) => GitSyncConfig[K]) => run(async () => {
    if (!saved) return;
    // A list is replaced whole, so it is written only over the list it was built on.
    const expected = key === "repositories" || key === "overlapRules" ? { expected: saved[key] ?? null } : {};
    await rpc.call("config.set", { projectId, key: `git.${key}`, value: value(saved), ...expected });
    await verify();
  });
  const save = () => run(async () => {
    if (!saved) return;
    await rpc.call("setGitSyncConfig", { projectId, config: gitSyncConfigSchema.parse(formConfig(saved)), baseConfig: saved });
    setMessage("Git/PR settings saved.");
    await verify();
  });
  // Reload drops the draft and takes the next read whole.
  const reload = () => run(verify);
  const discard = () => {
    // After a conflict the form's snapshot is outdated: discarding means taking a fresh read.
    if (conflict) return void reload();
    if (query.data && query.data.readAt > verifyAfter) adopt(query.data.config, query.data.readAt);
    else if (form) adopt(form.saved, form.readAt);
  };
  const sync = () => {
    setSyncing(true);
    return run(async () => {
      const result = await rpc.call("syncGit", { projectId });
      setMessage(`Checked ${result.checked} PRs.${result.errors.length ? ` ${result.errors.join("; ")}` : ""}`);
    });
  };
  const addRepository = (value: string) => {
    setDraft((current) => ({ repositories: [...new Set([...current.repositories, ...lines(value)])] }));
    setRepositoryDraft("");
  };
  const setRules = (change: (rules: OverlapRule[]) => OverlapRule[]) => setDraft((current) => ({ overlapRules: change(current.overlapRules) }));
  const available = query.data?.availableRepositories ?? [];
  const linkedBbProject = query.data?.linkedBbProject ?? false;
  const otherRepositories = draft.repositories.filter(
    (repository) => !available.includes(repository),
  );
  const overlapRules = draft.overlapRules;
  return (
    <SettingsCard title="Git and pull requests" description="Track pull requests and CI for this project. Task statuses stay unchanged."
      status={<p className="text-xs text-muted-foreground" data-testid="git-summary">
        {saved
          ? `${saved.enabled ? "Sync on" : "Sync off"} · ${saved.repositories.length === 1 ? "1 repository" : `${saved.repositories.length} repositories`}${unsaved ? " · unsaved changes" : ""}`
          : query.error ? "Unavailable" : "Loading…"}
      </p>}>
      {conflict ? (
        <p role="alert" className="text-xs text-destructive" data-testid="git-conflict">
          Settings changed elsewhere, so nothing was written. Reload shows the stored settings and discards any unsaved edits.
          <Button size="sm" variant="ghost" className="ml-1 h-7 px-2" disabled={busy} onClick={() => void reload()}>Reload</Button>
        </p>
      ) : null}
      {dirty ? <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="git-dirty">Save or discard your changes first: the switches, repositories and rule matches below save at once and wait for a clean form.</p> : null}
      <fieldset
        disabled={busy || !verified}
        className="min-w-0 space-y-3 text-xs"
      >
        <div className="divide-y divide-border-hairline rounded-md border border-border">
          <div className="px-3 py-3">
            <SwitchRow label="Periodic synchronization" checked={saved?.enabled ?? false} disabled={!immediate}
              onChange={(enabled) => void write("enabled", () => enabled)} hint="Refresh PR and CI status automatically." />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <label htmlFor={`${id}-interval`}>Refresh interval</label>
            <div className="flex items-center gap-2 text-muted-foreground">
              <Input
                id={`${id}-interval`}
                type="number"
                min={1}
                max={60}
                aria-label="Interval (minutes)"
                className="h-7 w-16 px-2 text-xs text-foreground"
                value={draft.pollMinutes}
                onChange={(event) => setDraft(() => ({ pollMinutes: Number(event.target.value) }))}
              />
              <span>minutes</span>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-border">
          <div className="space-y-1 px-3 pt-3 pb-2">
            <h4 className="text-sm font-medium">Repositories</h4>
            <p className="text-muted-foreground">
              {linkedBbProject
                ? "The linked BB project's repository; the switch saves at once."
                : "Repositories from your BB projects; each switch saves at once."}
            </p>
          </div>
          {available.length ? (
            <div
              role="group"
              aria-label="BB repositories"
              className="max-h-60 space-y-2 overflow-y-auto px-3 pb-3"
            >
              {available.map((repository) => (
                <SwitchRow key={repository} label={repository} checked={saved?.repositories.includes(repository) ?? false} disabled={!immediate}
                  hint="Track this repository's pull requests."
                  onChange={(on) => void write("repositories", (stored) => (on ? [...new Set([...stored.repositories, repository])] : stored.repositories.filter((entry) => entry !== repository)))} />
              ))}
            </div>
          ) : (
            <p className="px-3 pb-3 text-muted-foreground">
              {linkedBbProject
                ? "Could not find a GitHub repository for the linked BB project. Add it under Other repositories."
                : "No GitHub repositories found in BB projects."}
            </p>
          )}
          <details className="border-t border-border-hairline">
            <DisclosureSummary className="px-3 py-2.5">
              Other repositories
              {otherRepositories.length ? ` · ${otherRepositories.length}` : ""}
            </DisclosureSummary>
            <div className="space-y-2 px-3 pb-3">
              {otherRepositories.length ? (
                <ul
                  aria-label="Other repositories"
                  className="divide-y divide-border-hairline"
                >
                  {otherRepositories.map((repository) => (
                    <li
                      key={repository}
                      className="flex items-center gap-2 py-1"
                    >
                      <span className="min-w-0 flex-1 break-all font-mono text-xs">
                        {repository}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0 text-muted-foreground"
                        aria-label={`Remove repository ${repository}`}
                        onClick={() => setDraft((current) => ({ repositories: current.repositories.filter((entry) => entry !== repository) }))}
                      >
                        <Icon name="Trash2" className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="flex gap-2">
                <Input
                  id={`${id}-repository`}
                  aria-label="Git repositories"
                  placeholder="owner/repository"
                  className="h-7 min-w-0 flex-1 px-2 text-xs"
                  value={repositoryDraft}
                  onChange={(event) => setRepositoryDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addRepository(repositoryDraft);
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2.5"
                  disabled={!repositoryDraft.trim()}
                  onClick={() => addRepository(repositoryDraft)}
                >
                  Add
                </Button>
              </div>
              <p className="text-muted-foreground">Added and removed here until you press Save.</p>
            </div>
          </details>
        </div>
        <div className="rounded-md border border-border px-3 py-3">
          <SwitchRow label="Discover task links" checked={saved?.titleDiscovery ?? false} disabled={!immediate}
            onChange={(titleDiscovery) => void write("titleDiscovery", () => titleDiscovery)} hint="Suggest links when a task key appears in a PR title." />
        </div>
        <details className="rounded-md border border-border">
          <DisclosureSummary className="px-3 py-2.5 font-medium">Advanced settings</DisclosureSummary>
          <div className="space-y-3 border-t border-border-hairline p-3">
            <div className="divide-y divide-border-hairline">
              {(
                [
                  [
                    "lookbackDays",
                    "Discovery lookback (days)",
                    "Discovery lookback",
                    365,
                  ],
                  [
                    "postMergeDays",
                    "Post-merge observation (days)",
                    "Observe after merge",
                    90,
                  ],
                ] as const
              ).map(([key, label, title, max]) => (
                <div
                  key={key}
                  className="flex flex-wrap items-center justify-between gap-3 py-2 first:pt-0"
                >
                  <label htmlFor={`${id}-${key}`}>{title}</label>
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Input
                      id={`${id}-${key}`}
                      type="number"
                      min={1}
                      max={max}
                      aria-label={label}
                      className="h-7 w-16 px-2 text-xs text-foreground"
                      value={draft[key]}
                      onChange={(event) => setDraft(() => ({ [key]: Number(event.target.value) }))}
                    />
                    <span>days</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-checks`} className="font-medium">
                Required checks
              </label>
              <p id={`${id}-checks-help`} className="text-muted-foreground">
                Press Enter to add each name. Leave empty to use available GitHub rules.
              </p>
              <TagInput
                id={`${id}-checks`}
                label="Required GitHub checks"
                describedBy={`${id}-checks-help`}
                values={draft.requiredChecks}
                onChange={(requiredChecks) => setDraft(() => ({ requiredChecks }))}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-ignored`} className="font-medium">
                Checks outside CI
              </label>
              <p id={`${id}-ignored-help`} className="text-muted-foreground">
                Required checks a gate posts after CI. PR wait reports them but does not wait for them.
              </p>
              <TagInput
                id={`${id}-ignored`}
                label="Checks outside CI"
                describedBy={`${id}-ignored-help`}
                values={draft.prWaitIgnoredChecks}
                onChange={(prWaitIgnoredChecks) => setDraft(() => ({ prWaitIgnoredChecks }))}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-workflows`} className="font-medium">
                Post-merge workflows
              </label>
              <p id={`${id}-workflows-help`} className="text-muted-foreground">
                Push workflow names or numeric IDs.
              </p>
              <TagInput
                id={`${id}-workflows`}
                label="Post-merge workflows"
                describedBy={`${id}-workflows-help`}
                values={draft.postMergeWorkflows}
                onChange={(postMergeWorkflows) => setDraft(() => ({ postMergeWorkflows }))}
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-3">
                <label htmlFor={`${id}-overlap`} className="font-medium">
                  Highlight shared files
                </label>
                <Switch
                  id={`${id}-overlap`}
                  aria-label="Highlight shared files between PRs"
                  aria-describedby={`${id}-overlap-help`}
                  checked={overlapOn}
                  disabled={!immediate}
                  onCheckedChange={(on) => void write("overlapEnabled", () => on)}
                />
              </div>
              <p id={`${id}-overlap-help`} className="text-muted-foreground">
                Mark files that open PRs of different tasks both touch when they match a rule. Other shared files are still listed. A pattern supports *, ** and ?; Changed matches the same path, Added matches new files even with different names. Turning it off keeps the rules.
              </p>
              {overlapOn ? (
                <ul aria-label="Overlap rules" className="space-y-1.5">
                  {overlapRules.map((rule, index) => (
                    <li key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        aria-label={`Rule ${index + 1} pattern`}
                        placeholder="migrations/**"
                        className="h-7 min-w-0 flex-1 px-2 font-mono text-xs"
                        value={rule.pattern}
                        onChange={(event) => setRules((rules) => rules.map((entry, at) => (at === index ? { ...entry, pattern: event.target.value } : entry)))}
                      />
                      {/* A match is written at once on the stored rules, so only on a clean form; a new rule's waits for Save. */}
                      <Select
                        value={rule.match}
                        disabled={!immediate}
                        onValueChange={(match) => void write("overlapRules", (stored) => (stored.overlapRules ?? []).map((entry, at) => (at === index ? { ...entry, match: match as OverlapRule["match"] } : entry)))}
                      >
                        <SelectTrigger aria-label={`Rule ${index + 1} match`} className="h-7 w-28 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="changed">Changed</SelectItem>
                          <SelectItem value="added">Added</SelectItem>
                        </SelectContent>
                      </Select>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-6 shrink-0 text-muted-foreground"
                        aria-label={`Remove rule ${index + 1}`}
                        onClick={() => setRules((rules) => rules.filter((_, at) => at !== index))}
                      >
                        <Icon name="Trash2" className="size-3.5" />
                      </Button>
                    </li>
                  ))}
                  <li>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2.5"
                      disabled={overlapRules.length >= 50}
                      onClick={() => setRules((rules) => [...rules, { pattern: "", match: "changed" }])}
                    >
                      Add rule
                    </Button>
                  </li>
                </ul>
              ) : null}
            </div>
            <p className="text-muted-foreground">
              Authentication uses GH_TOKEN, GITHUB_TOKEN or gh on the BB server.
            </p>
          </div>
        </details>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-7 px-2.5"
            disabled={!unsaved || !verified || conflict}
            onClick={() => void save()}
          >
            Save
          </Button>
          {dirty ? <Button size="sm" variant="ghost" className="h-7 px-2.5" onClick={discard}>Discard</Button> : null}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2.5"
            disabled={unsaved}
            onClick={() => void sync()}
            aria-busy={syncing}
          >
            <Icon name="RotateCcw" className={`size-3.5${syncing ? " animate-spin" : ""}`} />
            Sync now
          </Button>
          {unsaved ? <span className="text-muted-foreground">Unsaved changes</span> : null}
        </div>
      </fieldset>
      {saved && !verified ? (
        <p className="text-xs text-muted-foreground" data-testid="git-verifying">
          Checking the stored settings…
          {query.error ? <Button size="sm" variant="ghost" className="ml-1 h-7 px-2" disabled={query.isFetching} onClick={() => void query.refresh()}>Reload</Button> : null}
        </p>
      ) : null}
      {error || query.error ? (
        <p role="alert" className="text-xs text-destructive">
          {error ?? query.error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
    </SettingsCard>
  );
}
