import { useEffect, useId, useRef, useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { gitSyncConfigSchema, type GitSyncConfig } from "../shared/git-sync";
import { errorMessage } from "../shared/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/components/ui/icon";
import * as Checkbox from "@radix-ui/react-checkbox";

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
  const [repositories, setRepositories] = useState("");
  const [checks, setChecks] = useState("");
  const [workflows, setWorkflows] = useState("");
  const [overlapRules, setOverlapRules] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => {
    if (query.data) {
      const signature = JSON.stringify(query.data.config);
      if (savedSignature.current === signature) return;
      savedSignature.current = signature;
      setConfig(query.data.config);
      setRepositories(query.data.config.repositories.join("\n"));
      setChecks(query.data.config.requiredChecks.join("\n"));
      setWorkflows(query.data.config.postMergeWorkflows.join("\n"));
      setOverlapRules(JSON.stringify(query.data.config.overlapRules ?? [], null, 2));
    }
  }, [query.data]);
  const act = async (save: boolean) => {
    setBusy(true);
    setSyncing(!save);
    setError(null);
    setMessage("");
    try {
      if (save) {
        await rpc.call("setGitSyncConfig", {
          projectId,
          config: gitSyncConfigSchema.parse({
            ...config,
            repositories: lines(repositories),
            requiredChecks: lines(checks),
            postMergeWorkflows: lines(workflows),
            overlapRules: JSON.parse(overlapRules),
          }),
        });
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
    <section
      aria-label="Project Git and PR sync"
      className="max-w-2xl space-y-3 border-t border-border pt-4"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Git and pull requests</h3>
        <p className="text-xs text-muted-foreground">
          Track pull requests and CI for this project. Task statuses stay
          unchanged.
        </p>
      </div>
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
          <details className="group border-t border-border-hairline">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <Icon
                name="ChevronRight"
                className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
              />
              Other repositories
              {otherRepositories.length ? ` · ${otherRepositories.length}` : ""}
            </summary>
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
        <details className="group rounded-md border border-border">
          <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-3 py-2.5 font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <Icon
              name="ChevronRight"
              className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90"
            />
            Advanced settings
          </summary>
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
                One name per line. Leave empty to use available GitHub rules.
              </p>
              <Textarea
                id={`${id}-checks`}
                aria-label="Required GitHub checks"
                aria-describedby={`${id}-checks-help`}
                rows={2}
                className="min-h-14 resize-y px-2 py-1.5 text-xs"
                value={checks}
                onChange={(event) => setChecks(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor={`${id}-workflows`} className="font-medium">
                Post-merge workflows
              </label>
              <p id={`${id}-workflows-help`} className="text-muted-foreground">
                Push workflow names or numeric IDs, one per line.
              </p>
              <Textarea
                id={`${id}-workflows`}
                aria-label="Post-merge workflows"
                aria-describedby={`${id}-workflows-help`}
                rows={2}
                className="min-h-14 resize-y px-2 py-1.5 text-xs"
                value={workflows}
                onChange={(event) => setWorkflows(event.target.value)}
              />
            </div>
            <div className="space-y-1.5"><label htmlFor={`${id}-overlap`} className="font-medium">Overlap rules (JSON)</label><Textarea id={`${id}-overlap`} aria-label="Overlap rules" rows={3} value={overlapRules} onChange={event => setOverlapRules(event.target.value)} /><p className="text-muted-foreground">Array of pattern and match (added or changed), up to 50 rules.</p></div>
            <p className="text-muted-foreground">
              Authentication uses GH_TOKEN, GITHUB_TOKEN or gh on the BB server.
            </p>
          </div>
        </details>
        <div className="flex items-center gap-2">
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
            onClick={() => void act(false)}
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
    </section>
  );
}
