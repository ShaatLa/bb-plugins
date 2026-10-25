import { useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "../shared/errors";
import type { PrLink, PrLinkState } from "../shared/git-sync";

export function PullRequestsSection({
  taskId,
  projectId,
}: {
  taskId: string;
  projectId: string;
}) {
  const rpc = useTasksRpc();
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("listPrLinks", { taskId })).links,
    ["tasks:changed"],
    [taskId],
    { relevantTaskIds: [taskId] },
  );
  const [adding, setAdding] = useState(false);
  const [url, setUrl] = useState("");
  const [role, setRole] = useState<PrLink["role"]>("delivers");
  const [part, setPart] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setMessage("");
    try {
      await work();
      query.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const render = ({ link, snapshot, stale, error: syncError }: PrLinkState) => (
    <div
      key={link.url}
      className="space-y-1 border-b border-border py-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className="font-medium hover:underline"
        >
          {link.repository}#{link.number}
        </a>
        <span>
          {link.role}
          {link.part ? ` ${link.part}` : ""}
        </span>
        <span className="text-muted-foreground">
          {link.excluded
            ? "Excluded"
            : link.confirmed
              ? "Confirmed"
              : `Suggested · ${link.source}`}
        </span>
        {!link.excluded ? (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-6 px-2 text-xs"
            disabled={busy}
            onClick={() =>
              void act(() => rpc.call("unlinkPr", { taskId, url: link.url }))
            }
          >
            Exclude
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          disabled={busy}
          onClick={() => {
            setUrl(link.url);
            setRole(link.role);
            setPart(link.part ?? "");
            setAdding(true);
          }}
        >
          {link.excluded ? "Relink" : "Edit link"}
        </Button>
      </div>
      {snapshot && !link.excluded ? (
        <>
          <p>{snapshot.title}</p>
          <p className="text-muted-foreground">
            {snapshot.state} · CI {snapshot.ci} · Merge{" "}
            {snapshot.mergeState ?? "unknown"} · Review{" "}
            {snapshot.review ?? "unknown"}
            {snapshot.inMergeQueue ? " · In merge queue" : ""}
            {snapshot.autoMerge ? " · Auto-merge enabled" : ""}
            {snapshot.unresolvedThreads !== null
              ? ` · ${snapshot.unresolvedThreads} unresolved threads`
              : ""}
          </p>
          <p className="text-muted-foreground">
            Head {snapshot.headSha.slice(0, 9)} · Checked{" "}
            {new Date(snapshot.observedAt).toLocaleString()}
            {stale ? " · Stale" : ""}
            {!snapshot.requirementsKnown ? " · Required checks unknown" : ""}
          </p>
          {snapshot.checks.length ? (
            <details>
              <summary className="cursor-pointer">
                Checks ({snapshot.checks.length})
              </summary>
              <ul className="space-y-1 pt-1">
                {snapshot.checks.map((check, index) => (
                  <li key={index}>
                    {check.url ? (
                      <a
                        className="hover:underline"
                        href={check.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {check.name}
                      </a>
                    ) : (
                      check.name
                    )}{" "}
                    · {check.state} ·{" "}
                    {check.required === null
                      ? "requirement unknown"
                      : check.required
                        ? "required"
                        : "optional"}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {snapshot.coverage.map((coverage) => (
            <p key={coverage.workflow}>
              {coverage.workflow} · {coverage.state}
              {coverage.superseded
                ? ` · Superseded${coverage.originalRunId ? ` #${coverage.originalRunId}` : ""}, covered by `
                : " · "}
              {coverage.url ? (
                <a
                  href={coverage.url}
                  target="_blank"
                  rel="noreferrer"
                  className="hover:underline"
                >
                  run {coverage.runId}
                </a>
              ) : (
                "awaiting run"
              )}
              {coverage.sha ? ` on ${coverage.sha.slice(0, 9)}` : ""}
            </p>
          ))}
        </>
      ) : !link.excluded ? (
        <p className="text-muted-foreground">
          Not checked yet. Sync to load PR status.
        </p>
      ) : null}
      {syncError && !link.excluded ? (
        <p className="text-destructive">{syncError}</p>
      ) : null}
    </div>
  );
  return (
    <section aria-label="Task pull requests" className="mt-6 space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium">Pull requests</h3>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const result = await rpc.call("syncGit", { projectId });
              setMessage(
                `${result.checked} PRs checked${result.errors.length ? ` · ${result.errors.join("; ")}` : ""}`,
              );
            })
          }
        >
          Sync PRs
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={() => setAdding(!adding)}
        >
          Link PR
        </Button>
      </div>
      {query.data?.filter((value) => !value.link.excluded).map(render)}
      {query.data?.some((value) => value.link.excluded) ? (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Excluded links
          </summary>
          {query.data.filter((value) => value.link.excluded).map(render)}
        </details>
      ) : null}
      {adding ? (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await rpc.call("linkPr", {
                taskId,
                url,
                role,
                part: part || null,
              });
              setAdding(false);
              setUrl("");
              setPart("");
            });
          }}
        >
          <Input
            aria-label="PR URL"
            placeholder="https://github.com/owner/repo/pull/42"
            className="h-7 min-w-48 flex-1 text-xs"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <Select
            value={role}
            onValueChange={(value) => {
              setRole(value as typeof role);
              if (value !== "delivers") setPart("");
            }}
          >
            <SelectTrigger
              aria-label="PR link role"
              className="h-7 w-28 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["delivers", "design", "related"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {role === "delivers" ? (
            <Input
              aria-label="PR delivery part"
              placeholder="k/m"
              value={part}
              onChange={(event) => setPart(event.target.value)}
              className="h-7 w-16 text-xs"
            />
          ) : null}
          <Button type="submit" size="sm" className="h-7" disabled={busy}>
            Save link
          </Button>
        </form>
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
    </section>
  );
}
