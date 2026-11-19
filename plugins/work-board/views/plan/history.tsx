import type { PlanVersion } from "../../shared/contract.js";
import { formatRelativeTime } from "../activity/time.js";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Newest first: who changed the plan, when, how, why and by how many lines. */
export function PlanHistory({
  versions,
  current,
  shown,
  onSelect,
  onCompare,
}: {
  versions: readonly PlanVersion[];
  current: number;
  /** The version on screen. */
  shown: number;
  onSelect: (version: number) => void;
  onCompare: (version: number) => void;
}) {
  const now = Date.now();
  return (
    <section className="rounded-lg border border-border bg-card shadow-2xs">
      <h3 className="border-b border-border-hairline px-2 py-1.5 text-xs font-medium text-muted-foreground">History</h3>
      <ol aria-label="Plan history" className="max-h-64 divide-y divide-border-hairline overflow-y-auto text-sm">
        {[...versions].reverse().map((version) => (
          <li key={version.version} aria-current={version.version === shown ? "true" : undefined} className={cn("flex items-start gap-2 px-2 py-1.5", version.version === shown && "bg-state-hover")}>
            <button
              type="button"
              className="min-w-0 flex-1 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => onSelect(version.version)}
            >
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">v{version.version}{version.version === current ? " (current)" : ""}</span>
                <span className="text-xs text-muted-foreground">{version.author.name}</span>
                <time className="text-xs text-muted-foreground" dateTime={version.createdAt} title={version.createdAt}>{formatRelativeTime(version.createdAt, now)}</time>
                <span className="text-xs text-muted-foreground">
                  {version.op}{version.target ? ` · ${version.target.length > 40 ? `${version.target.slice(0, 40)}…` : version.target}` : ""}
                </span>
                <span className="font-mono text-xs"><span className="text-success">+{version.added}</span> <span className="text-destructive">−{version.removed}</span></span>
              </span>
              {version.summary ? <span className="block text-muted-foreground [overflow-wrap:anywhere]">{version.summary}</span> : null}
            </button>
            <Button type="button" size="sm" variant="ghost" className="h-6 shrink-0 px-2 text-2xs text-muted-foreground" disabled={version.version < 2} onClick={() => onCompare(version.version)}>
              Compare with previous
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
