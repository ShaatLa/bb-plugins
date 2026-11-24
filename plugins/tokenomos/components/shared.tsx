import type { ReactNode } from "react";
import { useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip";

export function Section({ title, subtitle, action, children, collapseKey }: { title: string; subtitle?: string; action?: ReactNode; children: ReactNode; collapseKey?: string }) {
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
        {subtitle && <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{subtitle}</span>}
        {action}
      </div>
      {open && children}
    </section>
  );
}

// Collapsed state is a per-browser view preference, so it lives in localStorage.
const storageKey = (key: string) => `tokenomos:section:${key}`;
function readOpen(key: string, fallback = true): boolean {
  try { const v = localStorage.getItem(storageKey(key)); return v === null ? fallback : v === "open"; } catch { return fallback; }
}

/** Open state of a disclosure, remembered in this browser. */
export function useOpen(key: string, fallback: boolean): [boolean, () => void] {
  const [open, setOpen] = useState(() => readOpen(key, fallback));
  return [open, () => { setOpen(!open); writeOpen(key, !open); }];
}
function writeOpen(key: string, open: boolean) {
  try { localStorage.setItem(storageKey(key), open ? "open" : "closed"); } catch { /* storage unavailable */ }
}

/** A hover hint styled like bb's own popovers (white on a light theme); the host does not show native `title` tooltips. */
export function Hint({ text, children }: { text?: React.ReactNode; children: React.ReactElement }) {
  if (!text) return children;
  return (
    <TooltipProvider delayDuration={450}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top" className="border border-border bg-popover text-popover-foreground shadow-md">{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
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
