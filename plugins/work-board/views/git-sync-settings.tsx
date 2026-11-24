import { useEffect, useId, useRef, useState, type FocusEvent } from "react";
import type { z } from "zod";
import { useOrderClock, useTasksQuery, useTasksRpc } from "../shell/data";
import { STALE_GIT_CONFIG, gitSyncConfigSchema, overlapEnabled, type GitSyncConfig } from "../shared/git-sync";
import { errorMessage } from "../shared/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Icon } from "@/components/ui/icon";
import { TagInput } from "../components/tag-input";
import { DisclosureSummary } from "../components/disclosure";
import { NOT_SAVED, SettingsCard, SwitchRow, useSaveStatus } from "./settings-card";

type OverlapRule = NonNullable<GitSyncConfig["overlapRules"]>[number];
/**
 * `base`: the stored configuration as this page last knew it (read, or written by this page, with when). `draft`: the
 * owner's whole intended configuration, every control included.
 */
type Form = { base: GitSyncConfig; draft: GitSyncConfig; readAt: number };

const stable = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
const lines = (value: string) =>
  value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
const FIELD_NAMES: Record<string, string> = {
  pollMinutes: "Refresh interval", lookbackDays: "Discovery lookback", postMergeDays: "Observe after merge", repositories: "Repositories",
  requiredChecks: "Required checks", prWaitIgnoredChecks: "Checks outside CI", postMergeWorkflows: "Post-merge workflows", overlapRules: "Highlight shared files",
};
const describe = (error: z.ZodError) => error.issues.map((issue) => `${FIELD_NAMES[String(issue.path[0])] ?? "Settings"}: ${issue.message}`).join("; ");
// Compared the way the server stores it (trimmed, normalized), with the effective switch.
const canonical = (value: GitSyncConfig) => {
  const parsed = gitSyncConfigSchema.safeParse(value);
  const normal = parsed.success ? parsed.data : value;
  return stable({ ...normal, overlapEnabled: overlapEnabled(normal), overlapRules: normal.overlapRules ?? [] });
};
/**
 * What the draft stores over `stored`. Rows without a pattern are not rules yet. The shared-file switch: a chosen or
 * stored value is kept; an absent key stays absent while the switch matches what the rules imply (non-empty means on),
 * and is otherwise written explicitly.
 */
const toStore = (stored: GitSyncConfig, draft: GitSyncConfig): GitSyncConfig => {
  const rules = (draft.overlapRules ?? []).filter((rule) => rule.pattern.trim());
  const { overlapEnabled: chosen, ...rest } = draft;
  const shown = chosen ?? overlapEnabled(stored);
  return { ...rest, overlapRules: rules, ...(chosen !== undefined || shown !== rules.length > 0 ? { overlapEnabled: shown } : {}) };
};

/**
 * Every control edits one draft. A text field commits on Enter or when focus leaves the card (the card's own blur),
 * any other control at once. A write sends the
 * whole draft with `baseConfig` = the base; while it (or a Reload) is in flight the card's controls are disabled, so
 * nothing is committed meanwhile, and on success the base and the draft are exactly what was sent. A change made
 * elsewhere is caught by the server's `baseConfig` refusal, shown with Reload.
 */
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
  // A write, Reload or sync in flight; the ref guards a second commit in the same event (Enter, then the blur it causes).
  const [locked, setLocked] = useState(false);
  const lockRef = useRef(false);
  const lock = (on: boolean) => { lockRef.current = on; setLocked(on); };
  const [conflict, setConflict] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const { status: saveStatus, track, forget } = useSaveStatus();
  const base = form?.base;
  const draft = form?.draft ?? gitSyncConfigSchema.parse({});
  const setDraft = (edit: (draft: GitSyncConfig) => Partial<GitSyncConfig>) =>
    setForm((current) => (current ? { ...current, draft: { ...current.draft, ...edit(current.draft) } } : current));
  const overlapOn = draft.overlapEnabled ?? (base ? overlapEnabled(base) : false);
  const intended = base ? toStore(base, draft) : undefined;
  const validation = intended ? gitSyncConfigSchema.safeParse(intended) : undefined;
  const invalid = validation && !validation.success ? describe(validation.error) : null;
  const unsaved = base !== undefined && canonical(intended!) !== canonical(base);
  // A new rule row is a draft even while its pattern is blank, though a save would drop it: nothing saves until it has one.
  const blankRule = (draft.overlapRules ?? []).some((rule) => !rule.pattern.trim());
  const dirty = unsaved || blankRule;
  // A clean, idle form follows reads that started after its base.
  useEffect(() => {
    if (!query.data || (form && (dirty || locked || query.data.readAt <= form.readAt))) return;
    setForm({ base: query.data.config, draft: query.data.config, readAt: query.data.readAt });
  }, [query.data, dirty, locked]);
  // A draft back at the stored values has nothing left to retry.
  useEffect(() => { if (!dirty) forget("form"); }, [dirty]);
  /** Writes `edits` (by default the draft) when it is complete, valid and differs from the base. */
  const save = async (edits: GitSyncConfig = draft) => {
    if (lockRef.current || conflict || !base) return;
    if ((edits.overlapRules ?? []).some((rule) => !rule.pattern.trim())) return;
    const parsed = gitSyncConfigSchema.safeParse(toStore(base, edits));
    if (!parsed.success || canonical(parsed.data) === canonical(base)) return;
    const config = parsed.data;
    lock(true);
    setMessage("");
    await track(async () => {
      try {
        await rpc.call("setGitSyncConfig", { projectId, config, baseConfig: base });
      } catch (failure) {
        if (!errorMessage(failure).includes(STALE_GIT_CONFIG)) throw failure;
        setConflict(true);
        return NOT_SAVED;
      }
      setForm({ base: config, draft: config, readAt: stamp() });
      // A read started now shows the clean form what others changed meanwhile.
      void query.refresh();
    }, () => void latestSave.current(), "form");
    lock(false);
  };
  const latestSave = useRef(save);
  latestSave.current = save;
  const commit = () => void save();
  const run = async (action: () => Promise<void>) => {
    lock(true);
    setError(null);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      lock(false);
      setSyncing(false);
    }
  };
  // Reload drops the draft and takes a fresh read whole; the card is locked until it lands.
  const reload = () => {
    forget("form");
    return run(async () => {
      const readAt = stamp();
      const data = await rpc.call("getGitSyncConfig", { projectId });
      setForm({ base: data.config, draft: data.config, readAt });
      setConflict(false);
      void query.refresh();
    });
  };
  const discard = () => {
    forget("form");
    if (conflict) return void reload();
    setForm((current) => current && { ...current, draft: current.base });
  };
  const sync = () => {
    setSyncing(true);
    return run(async () => {
      const result = await rpc.call("syncGit", { projectId });
      setMessage(`Checked ${result.checked} PRs.${result.errors.length ? ` ${result.errors.join("; ")}` : ""}`);
    });
  };
  /** A discrete edit of the draft: it saves at once. */
  const change = (edit: (draft: GitSyncConfig) => Partial<GitSyncConfig>) => {
    if (lockRef.current) return;
    const next = { ...draft, ...edit(draft) };
    setForm((current) => current && { ...current, draft: next });
    void save(next);
  };
  const onEnter = (event: { key: string; nativeEvent: { isComposing: boolean } }) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) commit();
  };
  // The draft as edited so far, ahead of the render: the card's blur sees a tag name kept on that same blur.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Focus is "inside" by the React tree, so the match menus, rendered in a portal outside the section, count as inside:
  // React focus events bubble from them to the section. A blur becomes a leave only if no focus came back by the next
  // tick.
  const focusInside = useRef(false);
  const leaveCheck = useRef<ReturnType<typeof setTimeout>>(undefined);
  // A pointer pressed inside the card (a portal menu included): a click that takes no focus, like a button in Safari or
  // the heading, blurs to nowhere. That blur is held, and re-checked once the click settles: Discard has reverted and a
  // switch has saved by then, and focus left on the page commits as leaving would.
  const pointerInside = useRef(false);
  const heldBlur = useRef(false);
  const onPointerDown = () => {
    pointerInside.current = true;
    const clear = () => {
      window.removeEventListener("pointerup", clear, true);
      window.removeEventListener("pointercancel", clear, true);
      setTimeout(() => {
        pointerInside.current = false;
        if (!heldBlur.current) return;
        heldBlur.current = false;
        if (!focusInside.current) void latestSave.current(draftRef.current);
      });
    };
    window.addEventListener("pointerup", clear, true);
    window.addEventListener("pointercancel", clear, true);
  };
  const onCardFocus = () => {
    focusInside.current = true;
    clearTimeout(leaveCheck.current);
  };
  // Text commits on Enter or when focus leaves the card. Moving inside it commits nothing, so no write disables the card
  // under the next click: a switch or rule match saves the whole draft (the edited text included), Discard reverts it,
  // Add rule adds its row, Reload rereads.
  const onCardBlur = () => {
    clearTimeout(leaveCheck.current);
    leaveCheck.current = setTimeout(() => {
      focusInside.current = false;
      if (pointerInside.current) heldBlur.current = true;
      else void latestSave.current(draftRef.current);
    });
  };
  /** A tag list edit: saves at once, except a name kept on blur, which the card's own blur commits if focus leaves. */
  const tags = (key: "requiredChecks" | "prWaitIgnoredChecks" | "postMergeWorkflows") => (values: string[], blur?: FocusEvent<HTMLInputElement>) => {
    if (!blur) return change(() => ({ [key]: values }));
    draftRef.current = { ...draftRef.current, [key]: values };
    setDraft(() => ({ [key]: values }));
  };
  const addRepository = (value: string) => {
    change((current) => ({ repositories: [...new Set([...current.repositories, ...lines(value)])] }));
    setRepositoryDraft("");
  };
  const setRules = (edit: (rules: OverlapRule[]) => OverlapRule[]) => setDraft((current) => ({ overlapRules: edit(current.overlapRules ?? []) }));
  const available = query.data?.availableRepositories ?? [];
  const linkedBbProject = query.data?.linkedBbProject ?? false;
  const otherRepositories = draft.repositories.filter(
    (repository) => !available.includes(repository),
  );
  const overlapRules = draft.overlapRules ?? [];
  return (
    <SettingsCard title="Git and pull requests" description="Track pull requests and CI for this project. Task statuses stay unchanged." save={saveStatus} onFocus={onCardFocus} onBlur={onCardBlur} onPointerDown={onPointerDown}
      status={<p className="text-xs text-muted-foreground" data-testid="git-summary">
        {base
          ? `${base.enabled ? "Sync on" : "Sync off"} · ${base.repositories.length === 1 ? "1 repository" : `${base.repositories.length} repositories`}${unsaved ? " · unsaved changes" : ""}`
          : query.error ? "Unavailable" : "Loading…"}
      </p>}>
      {conflict ? (
        <p role="alert" className="text-xs text-destructive" data-testid="git-conflict">
          Settings changed elsewhere, so nothing was written. Reload shows the stored settings and discards any unsaved edits.
          <Button size="sm" variant="ghost" className="ml-1 h-7 px-2" disabled={locked} onClick={() => void reload()}>Reload</Button>
        </p>
      ) : null}
      {invalid ? (
        <p role="alert" className="text-xs text-destructive" data-testid="git-invalid">Not saved: {invalid}. Correct the value or discard the change.</p>
      ) : blankRule ? (
        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="git-dirty">Enter the new rule's pattern or remove the rule; nothing saves until then.</p>
      ) : null}
      {/* Locked while a write or Reload is in flight: nothing can be committed over it. */}
      <fieldset
        disabled={form === undefined || locked}
        className="min-w-0 space-y-3 text-xs"
      >
        <div className="divide-y divide-border-hairline rounded-md border border-border">
          <div className="px-3 py-3">
            <SwitchRow label="Periodic synchronization" checked={draft.enabled} disabled={!base}
              onChange={(enabled) => change(() => ({ enabled }))} hint="Refresh PR and CI status automatically." />
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
                onKeyDown={onEnter}
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
                <SwitchRow key={repository} label={repository} checked={draft.repositories.includes(repository)} disabled={!base}
                  hint="Track this repository's pull requests."
                  onChange={(on) => change((current) => ({ repositories: on ? [...new Set([...current.repositories, repository])] : current.repositories.filter((entry) => entry !== repository) }))} />
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
                        onClick={() => change((current) => ({ repositories: current.repositories.filter((entry) => entry !== repository) }))}
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
            </div>
          </details>
        </div>
        <div className="rounded-md border border-border px-3 py-3">
          <SwitchRow label="Discover task links" checked={draft.titleDiscovery} disabled={!base}
            onChange={(titleDiscovery) => change(() => ({ titleDiscovery }))} hint="Suggest links when a task key appears in a PR title." />
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
                onKeyDown={onEnter}
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
                onChange={tags("requiredChecks")}
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
                onChange={tags("prWaitIgnoredChecks")}
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
                onChange={tags("postMergeWorkflows")}
              />
            </div>
            <div className="space-y-1.5">
              <SwitchRow label="Highlight shared files" checked={overlapOn} disabled={!base}
                onChange={(on) => change(() => ({ overlapEnabled: on }))}
                hint="Mark files that open PRs of different tasks both touch when they match a rule. Turning it off keeps the rules.">
                <details>
                  <DisclosureSummary className="py-1 text-muted-foreground">Pattern syntax</DisclosureSummary>
                  <p className="pl-5 text-muted-foreground">A pattern supports *, ** and ?. Changed matches the same path; Added matches new files even with different names. Other shared files are still listed without a highlight.</p>
                </details>
              </SwitchRow>
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
                onKeyDown={onEnter}
                      />
                      {/* A match is written at once on the stored rules, so only on a clean form; a new rule's waits for its pattern to save. */}
                      <Select
                        value={rule.match}
                        disabled={!base}
                        onValueChange={(match) => change((current) => ({ overlapRules: (current.overlapRules ?? []).map((entry, at) => (at === index ? { ...entry, match: match as OverlapRule["match"] } : entry)) }))}
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
                        onClick={() => change((current) => ({ overlapRules: (current.overlapRules ?? []).filter((_, at) => at !== index) }))}
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
          {dirty
            ? <Button size="sm" variant="ghost" className="h-7 px-2.5" onClick={discard}>Discard</Button> : null}
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
        </div>
      </fieldset>
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
