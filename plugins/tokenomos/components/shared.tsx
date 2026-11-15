import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";

export function Section({ title, action, children, collapseKey }: { title: string; action?: ReactNode; children: ReactNode; collapseKey?: string }) {
  const [open, setOpen] = useState(() => !collapseKey || readOpen(collapseKey));
  const toggle = () => { const next = !open; setOpen(next); if (collapseKey) writeOpen(collapseKey, next); };
  return (
    <section className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        {collapseKey ? (
          <button type="button" onClick={toggle} aria-expanded={open}
            className="flex items-center gap-1 rounded-sm text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
            <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 text-muted-foreground" aria-hidden />
            <h2>{title}</h2>
          </button>
        ) : <h2 className="text-sm font-medium text-foreground">{title}</h2>}
        {action}
      </div>
      {open && children}
    </section>
  );
}

// Collapsed state is a per-browser view preference, so it lives in localStorage.
const storageKey = (key: string) => `tokenomos:section:${key}`;
function readOpen(key: string): boolean {
  try { return localStorage.getItem(storageKey(key)) !== "closed"; } catch { return true; }
}
function writeOpen(key: string, open: boolean) {
  try { localStorage.setItem(storageKey(key), open ? "open" : "closed"); } catch { /* storage unavailable */ }
}

export const Card = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("rounded-lg border border-border bg-card p-3 text-card-foreground", className)} {...props} />
);

export const Muted = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground">{children}</p>;

export const SkeletonBlock = ({ rows = 3, className }: { rows?: number; className?: string }) => (
  <div className={cn("space-y-2", className)} aria-busy="true" data-testid="skeleton">
    {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-8 w-full" />)}
  </div>
);

/**
 * Keeps the last value while a new input loads, so a range switch dims the page
 * instead of dropping back to skeletons; `stale` marks the held value.
 */
export function useHeld<T>(data: T | undefined, key: string): { value: T | undefined; stale: boolean; key: string } {
  const held = useRef<{ key: string; value: T } | undefined>(undefined);
  if (data !== undefined) held.current = { key, value: data };
  return { value: held.current?.value, stale: data === undefined && held.current !== undefined, key: held.current?.key ?? key };
}

/** RPC inputs are JSON, so an unset project is left out instead of passed as `undefined`. */
export const scope = (project?: string) => (project ? { projectId: project } : {});
