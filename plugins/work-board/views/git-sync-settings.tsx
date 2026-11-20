import { useEffect, useId, useRef, useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { gitSyncConfigSchema, overlapEnabled, type GitSyncConfig } from "../shared/git-sync";
import { errorMessage } from "../shared/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import { TagInput } from "../components/tag-input";
import { DisclosureSummary } from "../components/disclosure";
import * as Checkbox from "@radix-ui/react-checkbox";

type OverlapRule = NonNullable<GitSyncConfig["overlapRules"]>[number];

const stable = (value: object) => JSON.stringify(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
const lines = (value: string) =>
  value
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean);
export function GitSyncSettings({ projectId }: { projectId: string }) {
  const rpc = useTasksRpc();
  const query = useTasksQuery(
    (rpc) => rpc.call("getGitSyncConfig", { projectId }),
    ["projects:changed"],
    [projectId],
  );
  const savedSignature = useRef("");
  const id = useId();
  const [repositoryDraft, setRepositoryDraft] = useState("");
  const [config, setConfig] = useState<GitSyncConfig>(() =>
    gitSyncConfigSchema.parse({}),
  );
  const [saved, setSaved] = useState<GitSyncConfig>();
  const [repositories, setRepositories] = useState("");
  const [checks, setChecks] = useState("");
  const [workflows, setWorkflows] = useState("");
  const [ignored, setIgnored] = useState("");
  const [overlapRules, setOverlapRules] = useState<OverlapRule[]>([]);
  const [overlapOn, setOverlapOn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Resets the whole form to a stored (normalized) configuration.
  const load = (stored: GitSyncConfig) => {
    savedSignature.current = JSON.stringify(stored);
    setConfig(stored);
    setSaved(stored);
    setRepositories(stored.repositories.join("\n"));
    setChecks(stored.requiredChecks.join("\n"));
    setWorkflows(stored.postMergeWorkflows.join("\n"));
    setIgnored(stored.prWaitIgnoredChecks.join("\n"));
    setOverlapRules(stored.overlapRules ?? []);
    setOverlapOn(overlapEnabled(stored));
  };
  useEffect(() => {
    if (query.data && savedSignature.current !== JSON.stringify(query.data.config)) load(query.data.config);
  }, [query.data]);
  // What Save writes. The switch is written only while it differs from the stored effective value, so a stored
  // configuration without the key stays derivable from its rules (a toggle reverted before Save counts as untouched);
  // switching rules off keeps the rows.
  const formConfig = (): GitSyncConfig => ({
    ...config,
    repositories: lines(repositories),
    requiredChecks: lines(checks),
    postMergeWorkflows: lines(workflows),
    prWaitIgnoredChecks: lines(ignored),
    ...(saved && overlapOn !== overlapEnabled(saved) ? { overlapEnabled: overlapOn } : {}),
    // Rows without a pattern are not rules yet.
    overlapRules: overlapRules.filter((rule) => rule.pattern.trim()),
  });
  // Compared the way Save stores it (trimmed, normalized), with the effective switch.
  const canonical = (value: GitSyncConfig) => {
    const parsed = gitSyncConfigSchema.safeParse(value);
    const normal = parsed.success ? parsed.data : value;
    return stable({ ...normal, overlapEnabled: overlapEnabled(normal), overlapRules: normal.overlapRules ?? [] });
  };
  const unsaved = saved !== undefined && canonical(formConfig()) !== canonical(saved);
  const act = async (save: boolean) => {
    setBusy(true);
    setSyncing(!save);
    setError(null);
    setMessage("");
    try {
      if (save) {
        const result = await rpc.call("setGitSyncConfig", {
          projectId,
          config: gitSyncConfigSchema.parse(formConfig()),
        });
        load(result.config);
        setMessage("Git/PR settings saved.");
        query.refresh();
      } else {
        const result = await rpc.call("syncGit", { projectId });
        setMessage(
          `Checked ${result.checked} PRs.${result.errors.length ? ` ${result.errors.join("; ")}` : ""}`,
        );
      }
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
      setSyncing(false);
    }
  };
  const addRepository = (value: string) => {
    setRepositories(
      [...new Set([...lines(repositories), ...lines(value)])].join("\n"),
    );
    setRepositoryDraft("");
  };
  const available = query.data?.availableRepositories ?? [];
  const selected = lines(repositories);
  const otherRepositories = selected.filter(
    (repository) => !available.includes(repository),
  );
  return (
    <section aria-label="Project Git and PR sync">
    <details className="rounded-md border border-border text-sm">
      <DisclosureSummary className="px-3 py-2.5">
        <span className="font-medium">Git and pull requests</span>
        <span className="text-xs text-muted-foreground" data-testid="git-summary">
          {saved
            ? `${saved.enabled ? "Sync on" : "Sync off"} · ${saved.repositories.length === 1 ? "1 repository" : `${saved.repositories.length} repositories`}${unsaved ? " · unsaved changes" : ""}`
            : query.error ? "Unavailable" : "Loading…"}
        </span>
      </DisclosureSummary>
    <div className="space-y-3 border-t border-border p-3">
      <p className="text-xs text-muted-foreground">
        Track pull requests and CI for this project. Task statuses stay
        unchanged.
      </p>
      <fieldset
        disabled={busy || !query.data}
        className="min-w-0 space-y-3 text-xs"
      >
        <div className="divide-y divide-border-hairline rounded-md border border-border">
          <div className="flex items-center justify-between gap-4 px-3 py-3">
            <div className="space-y-1">
              <label
                htmlFor={`${id}-enabled`}
                className="cursor-pointer font-medium"
              >
                Periodic synchronization
              </label>
              <p id={`${id}-enabled-help`} className="text-muted-foreground">
                Refresh PR and CI status automatically.
              </p>
            </div>
            <Switch
              id={`${id}-enabled`}
              aria-label="Enable periodic synchronization"
              aria-describedby={`${id}-enabled-help`}
              checked={config.enabled}
              onCheckedChange={(enabled) => setConfig({ ...config, enabled })}
            />
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
                value={config.pollMinutes}
                onChange={(event) =>
                  setConfig({
                    ...config,
                    pollMinutes: Number(event.target.value),
                  })
                }
              />
              <span>minutes</span>
            </div>
          </div>
        </div>
        <div className="rounded-md border border-border">
          <div className="space-y-1 px-3 pt-3 pb-2">
            <p className="font-medium">Repositories</p>
            <p className="text-muted-foreground">
              Select repositories from your BB projects.
            </p>
          </div>
          {available.length ? (
            <div
              role="group"
              aria-label="BB repositories"
              className="max-h-60 overflow-y-auto px-3 pb-2"
            >
              {available.map((repository) => (
                <label
                  key={repository}
                  className="flex cursor-pointer items-center gap-2.5 rounded px-1 py-2 hover:bg-state-hover"
                >
                  <Checkbox.Root
                    aria-label={repository}
                    checked={selected.includes(repository)}
                    onCheckedChange={(checked) =>
                      setRepositories(
                        (checked === true
                          ? [...new Set([...selected, repository])]
                          : selected.filter((entry) => entry !== repository)
                        ).join("\n"),
                      )
                    }
                    className="flex size-3.5 shrink-0 items-center justify-center rounded-sm border border-input outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 data-[state=checked]:border-foreground data-[state=checked]:bg-foreground data-[state=checked]:text-background"
                  >
                    <Checkbox.Indicator>
                      <Icon name="Check" className="size-3" />
                    </Checkbox.Indicator>
                  </Checkbox.Root>
                  <span className="min-w-0 break-all">{repository}</span>
                </label>
              ))}
            </div>
          ) : (
            <p className="px-3 pb-3 text-muted-foreground">
              No GitHub repositories found in BB projects.
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
                        onClick={() =>
                          setRepositories(
                            selected
                              .filter((entry) => entry !== repository)
                              .join("\n"),
                          )
                        }
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
        <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-3">
          <div className="space-y-1">
            <label
              htmlFor={`${id}-discovery`}
              className="cursor-pointer font-medium"
            >
              Discover task links
            </label>
            <p id={`${id}-discovery-help`} className="text-muted-foreground">
              Suggest links when a task key appears in a PR title.
            </p>
          </div>
          <Switch
            id={`${id}-discovery`}
            aria-label="Discover task keys in PR titles (suggested links)"
            aria-describedby={`${id}-discovery-help`}
            checked={config.titleDiscovery}
            onCheckedChange={(titleDiscovery) =>
              setConfig({ ...config, titleDiscovery })
            }
          />
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
                      value={config[key]}
                      onChange={(event) =>
                        setConfig({
                          ...config,
                          [key]: Number(event.target.value),
                        })
                      }
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
                values={lines(checks)}
                onChange={(values) => setChecks(values.join("\n"))}
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
                values={lines(ignored)}
                onChange={(values) => setIgnored(values.join("\n"))}
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
                values={lines(workflows)}
                onChange={(values) => setWorkflows(values.join("\n"))}
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
                  onCheckedChange={(on) => {
                    setOverlapOn(on);
                    if (on && !overlapRules.length) setOverlapRules([{ pattern: "", match: "changed" }]);
                  }}
                />
              </div>
              <p id={`${id}-overlap-help`} className="text-muted-foreground">
                Mark files that open PRs of different tasks both touch when they match a rule. Other shared files are still listed. A pattern supports *, ** and ?; Changed matches the same path, Added matches new files even with different names. Turning it off keeps the rules.
              </p>
              {overlapOn ? (
                <ul aria-label="Overlap rules" className="space-y-1.5">
                  {overlapRules.map((rule, index) => (
                    <li key={index} className="flex items-center gap-2">
                      <Input
                        aria-label={`Rule ${index + 1} pattern`}
                        placeholder="migrations/**"
                        className="h-7 min-w-0 flex-1 px-2 font-mono text-xs"
                        value={rule.pattern}
                        onChange={(event) => setOverlapRules(overlapRules.map((entry, at) => (at === index ? { ...entry, pattern: event.target.value } : entry)))}
                      />
                      <Select
                        value={rule.match}
                        onValueChange={(match) => setOverlapRules(overlapRules.map((entry, at) => (at === index ? { ...entry, match: match as OverlapRule["match"] } : entry)))}
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
                        onClick={() => setOverlapRules(overlapRules.filter((_, at) => at !== index))}
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
                      onClick={() => setOverlapRules([...overlapRules, { pattern: "", match: "changed" }])}
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
            onClick={() => void act(true)}
          >
            Save Git/PR settings
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 gap-1.5 px-2.5"
            disabled={unsaved}
            onClick={() => void act(false)}
            aria-busy={syncing}
          >
            <Icon name="RotateCcw" className={`size-3.5${syncing ? " animate-spin" : ""}`} />
            Sync now
          </Button>
          {unsaved ? <span className="text-muted-foreground">Unsaved changes</span> : null}
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
    </div>
    </details>
    </section>
  );
}
