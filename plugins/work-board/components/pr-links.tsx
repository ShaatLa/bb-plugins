import { UrlLink } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { errorMessage } from "../shared/errors";
import type { PrLink, PrLinkState } from "../shared/git-sync";
import { PR_STATE_META } from "../views/detail/meta";

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
    <details
      key={link.url}
      className="group min-w-0 border-b border-border-hairline last:border-0"
    >
      <summary
        aria-label={`PR details ${link.repository}#${link.number}`}
        className="flex cursor-pointer list-none items-start gap-2 rounded-md py-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden"
      >
        <Icon
          name={
            snapshot
              ? PR_STATE_META[snapshot.state].icon
              : "GitPullRequestArrow"
          }
          className={`mt-0.5 size-3.5 shrink-0 ${snapshot ? PR_STATE_META[snapshot.state].textClassName : "text-muted-foreground"}`}
        />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <UrlLink
              href={link.url}
              title={link.url}
              className="min-w-0 truncate font-medium hover:underline"
            >
              {link.repository.split("/")[1]}#{link.number}
            </UrlLink>
            <span className="shrink-0 text-2xs text-muted-foreground">
              {link.excluded ? "Excluded" : (snapshot?.state ?? "Not checked")}
            </span>
            {snapshot && !link.excluded ? (
              <span
                role="img"
                aria-label={`CI ${snapshot.ci}${stale ? ", stale" : ""}`}
                title={`CI ${snapshot.ci}${stale ? " · stale" : ""}`}
                className={`ml-auto shrink-0 text-2xs ${stale ? "text-muted-foreground" : snapshot.ci === "failing" ? "text-destructive" : snapshot.ci === "passing" ? "text-success" : "text-muted-foreground"}`}
              >
                {stale
                  ? "◌"
                  : snapshot.ci === "passing"
                    ? "✓"
                    : snapshot.ci === "failing"
                      ? "✕"
                      : "◷"}
              </span>
            ) : null}
          </span>
          <span
            title={snapshot?.title ?? link.repository}
            className="block truncate text-2xs text-muted-foreground"
          >
            {snapshot?.title ?? link.repository}
          </span>
        </span>
        <Icon
          name="ChevronRight"
          className="mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="space-y-1.5 pb-2 text-2xs [overflow-wrap:anywhere]">
        <p className="text-muted-foreground">
          {link.repository} · {link.role}
          {link.part ? ` ${link.part}` : ""}
        </p>
        <p className="text-muted-foreground">
          {link.excluded
            ? "Excluded"
            : link.confirmed
              ? "Confirmed"
              : `Suggested · ${link.source}`}
        </p>
        {snapshot && !link.excluded ? <p>{snapshot.title}</p> : null}
        {snapshot && !link.excluded ? (
          <>
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
                        <UrlLink className="hover:underline" href={check.url}>
                          {check.name}
                        </UrlLink>
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
                  <UrlLink href={coverage.url} className="hover:underline">
                    run {coverage.runId}
                  </UrlLink>
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
        <div className="flex flex-wrap gap-1 pt-1">
          {!link.excluded ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5 text-2xs"
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
            className="h-6 px-1.5 text-2xs"
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
      </div>
    </details>
  );
  return (
    <section
      aria-label="Task pull requests"
      className="mt-4 min-w-0 space-y-1 border-t border-border-hairline pt-3"
    >
      <TooltipProvider delayDuration={300}>
        <div className="flex items-center gap-1">
          <h3 className="min-w-0 flex-1 text-xs font-semibold text-muted-foreground">
            Pull requests
          </h3>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Sync PRs"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
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
                <Icon name="RefreshCw" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Sync PRs</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                aria-label="Link PR"
                size="icon"
                variant="ghost"
                className="size-6 shrink-0 text-muted-foreground"
                disabled={busy}
                onClick={() => setAdding(!adding)}
              >
                <Icon name="Plus" className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Link PR</TooltipContent>
          </Tooltip>
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
            className="flex min-w-0 flex-wrap gap-1.5 rounded-md border border-border p-2"
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
              className="h-7 w-full min-w-0 text-xs"
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
      </TooltipProvider>
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
