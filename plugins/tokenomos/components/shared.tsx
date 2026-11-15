import type { ReactNode } from "react";
import { useRef } from "react";
import { cn } from "../lib/utils";
import { Skeleton } from "./ui/skeleton";

export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
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
