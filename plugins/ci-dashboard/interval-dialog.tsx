import { useEffect, useId, useRef, useState } from "react";
import { useViewportDialog } from "./use-viewport-dialog";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Metrics } from "./metrics";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { LoadingSkeleton, Skeleton } from "./components/ui/skeleton";
import { CiOutcomes, RepositoryActivity } from "./repository-details";

export type IntervalSelection = Pick<Metrics, "repository"> & Pick<Metrics["range"], "since" | "until">;

export function IntervalDialog({ selection, onClose }: { selection: IntervalSelection; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId(), description = useId();
  const [data, setData] = useState<Metrics | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useViewportDialog(dialog);
  useEffect(() => {
    let disposed = false;
    setError(false);
    void rpc.call("interval", selection).then(
      (result) => { if (!disposed) setData(result); },
      () => { if (!disposed) setError(true); },
    );
    return () => { disposed = true; };
  }, [rpc, selection, retry]);
  const dates = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })
    .formatRange(new Date(selection.since), new Date(selection.until));
  const deployments = data?.deployments.series?.reduce((total, point) => total + (point.value ?? 0), 0);
  return <dialog ref={dialog} aria-labelledby={heading} aria-describedby={description}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onClick={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) onClose();
    }}
    className="fixed right-auto bottom-auto m-0 box-border w-[42rem] min-w-0 -translate-x-1/2 -translate-y-1/2 overflow-y-auto overscroll-contain break-words rounded-lg border border-border bg-background p-3 text-foreground shadow-xl sm:p-5 backdrop:bg-black/60">
    <div className="flex items-start justify-between gap-3">
      <h2 id={heading} className="min-w-0 text-lg font-semibold">Interval statistics</h2>
      <Button variant="outline" size="sm" className="shrink-0" onClick={onClose}>Close</Button>
    </div>
    <p id={description} className="my-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground" title={`${new Date(selection.since).toUTCString()} – ${new Date(selection.until).toUTCString()}`}>
      <span>{dates}</span><span className="rounded border border-border px-1.5 py-0.5 text-[10px]">UTC</span>
    </p>
    {!data && !error && <LoadingSkeleton label="Loading interval statistics" className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{[0, 1].map((key) => <Card key={key} className="space-y-3 p-4"><Skeleton className="h-4 w-24" /><Skeleton className="h-8 w-20" /><Skeleton className="h-3 w-3/4" /></Card>)}</div>
      <Card className="space-y-4 p-4"><Skeleton className="h-4 w-32" /><Skeleton className="h-16 w-full" /></Card>
    </LoadingSkeleton>}
    {error && <div role="alert" className="space-y-3"><p className="text-sm text-destructive-text">Unable to load interval statistics. Please retry.</p><Button variant="outline" size="sm" onClick={() => setRetry((n) => n + 1)}>Retry</Button></div>}
    {data && <div className="space-y-3">
      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 12rem), 1fr))" }}>
        <Card className="space-y-2 p-4"><h3 className="text-sm text-muted-foreground">Deployments</h3><p className="text-2xl font-semibold tabular-nums">{deployments == null ? "—" : deployments.toLocaleString()}</p><p className="text-xs text-muted-foreground">All environments and outcomes</p>{data.deployments.error && <p role="alert" className="text-xs text-destructive-text">{data.deployments.error}</p>}</Card>
        <Card className="space-y-2 p-4"><h3 className="text-sm text-muted-foreground">CI pass rate</h3><p className="text-2xl font-semibold tabular-nums">{data.ci.value == null ? "—" : `${data.ci.value.toFixed(1)}%`}</p><p className="text-xs text-muted-foreground">{data.ci.detail}</p>{data.ci.error && <p role="alert" className="text-xs text-destructive-text">{data.ci.error}</p>}</Card>
      </div>
      <RepositoryActivity repo={data} />
      <CiOutcomes repo={data} />
    </div>}
  </dialog>;
}
