import { useEffect, useRef, useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { gitSyncConfigSchema, type GitSyncConfig } from "../shared/git-sync";
import { errorMessage } from "../shared/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [config, setConfig] = useState<GitSyncConfig>(() =>
    gitSyncConfigSchema.parse({}),
  );
  const [repositories, setRepositories] = useState("");
  const [checks, setChecks] = useState("");
  const [workflows, setWorkflows] = useState("");
  const [busy, setBusy] = useState(false);
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
    }
  }, [query.data]);
  const act = async (save: boolean) => {
    setBusy(true);
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
    }
  };
  return (
    <section
      aria-label="Project Git and PR sync"
      className="max-w-2xl space-y-3 border-t border-border pt-4"
    >
      <h3 className="text-sm font-medium">Git and pull requests</h3>
      <p className="text-xs text-muted-foreground">
        Read-only GitHub synchronization for this project. Uses GH_TOKEN,
        GITHUB_TOKEN or gh authentication on the BB server. PR and CI updates
        preserve task workflow statuses.
      </p>
      <fieldset disabled={busy || !query.data} className="space-y-3 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(event) =>
              setConfig({ ...config, enabled: event.target.checked })
            }
          />
          Enable periodic synchronization
        </label>
        <label className="block space-y-1">
          Repositories (owner/repo, one per line)
          <textarea
            aria-label="Git repositories"
            className="block min-h-16 w-80 max-w-full rounded-md border border-input bg-background p-2"
            value={repositories}
            onChange={(event) => setRepositories(event.target.value)}
          />
        </label>
        {query.data?.suggestedRepository ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() =>
              setRepositories(
                [
                  ...new Set([
                    ...lines(repositories),
                    query.data!.suggestedRepository!,
                  ]),
                ].join("\n"),
              )
            }
          >
            Add {query.data.suggestedRepository} from BB project
          </Button>
        ) : null}
        <div className="flex flex-wrap gap-3">
          {(
            [
              ["pollMinutes", "Interval (minutes)", 60],
              ["lookbackDays", "Discovery lookback (days)", 365],
              ["postMergeDays", "Post-merge observation (days)", 90],
            ] as const
          ).map(([key, label, max]) => (
            <label key={key} className="space-y-1">
              {label}
              <Input
                type="number"
                min={1}
                max={max}
                aria-label={label}
                className="h-7 w-24 text-xs"
                value={config[key]}
                onChange={(event) =>
                  setConfig({ ...config, [key]: Number(event.target.value) })
                }
              />
            </label>
          ))}
        </div>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={config.titleDiscovery}
            onChange={(event) =>
              setConfig({ ...config, titleDiscovery: event.target.checked })
            }
          />
          Discover task keys in PR titles (suggested links)
        </label>
        <label className="block space-y-1">
          Required checks override (one name per line; empty reads available
          GitHub rules)
          <textarea
            aria-label="Required GitHub checks"
            className="block min-h-12 w-80 max-w-full rounded-md border border-input bg-background p-2"
            value={checks}
            onChange={(event) => setChecks(event.target.value)}
          />
        </label>
        <label className="block space-y-1">
          Post-merge push workflows (name or numeric ID, one per line)
          <textarea
            aria-label="Post-merge workflows"
            className="block min-h-12 w-80 max-w-full rounded-md border border-input bg-background p-2"
            value={workflows}
            onChange={(event) => setWorkflows(event.target.value)}
          />
        </label>
        <div className="flex gap-2">
          <Button size="sm" className="h-7" onClick={() => void act(true)}>
            Save Git/PR settings
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => void act(false)}
          >
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
