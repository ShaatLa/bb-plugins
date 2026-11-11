import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} aria-hidden="true" className={cn("animate-pulse rounded-md bg-muted motion-reduce:animate-none", className)} />;
}

export function LoadingSkeleton({ label, children, className }: { label: string; children?: ReactNode; className?: string }) {
  return <div role="status" aria-label={label} aria-busy="true" className={cn("space-y-3", className)}>
    <span className="sr-only">{label}</span>
    {children ?? <><Skeleton className="h-7 w-24 max-w-full" /><Skeleton className="h-3 w-3/4" /><Skeleton className="h-3 w-1/2" /></>}
  </div>;
}
