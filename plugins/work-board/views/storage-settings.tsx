import { useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { errorMessage } from "../shared/errors";
import { Button } from "@/components/ui/button";
import type { StorageResult } from "../shared/storage";

const size = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
export function StorageSettings() {
  const rpc = useTasksRpc();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<StorageResult>();
  const query = useTasksQuery(rpc => rpc.call("getStorageStatus", null), [], [], { enabled: open });
  const current = result?.after ?? query.data;
  async function maintain(optimize: boolean) {
    setBusy(true); setError(null); setResult(undefined);
    try { setResult(await rpc.call("maintainStorage", { optimize })); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <details className="rounded-md border border-border text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer px-3 py-2.5 font-medium">Storage</summary>
    <div className="space-y-3 border-t border-border p-3">
      <p className="text-xs text-muted-foreground">Shared by all projects. Daily cleanup removes unreachable cache rows and unreferenced blobs older than 24 hours. Active uploads, imports, archived tasks and accessible history are preserved.</p>
      {current ? <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-xs">
        <dt>Database / WAL</dt><dd>{size(current.databaseBytes)} / {size(current.walBytes)}</dd>
        <dt>Free database pages</dt><dd>{size(current.freeDatabaseBytes)}</dd>
        <dt>Blob contents / allocated blocks</dt><dd>{size(current.blobLogicalBytes)} / {size(current.blobPhysicalBytes)}</dd>
        <dt>Unreferenced blobs older than 24h</dt><dd>{current.orphanFiles} · {size(current.orphanBytes)}</dd>
        <dt>Missing attachment files</dt><dd>{current.missingAttachments}</dd>
        <dt>Last cleanup</dt><dd>{current.lastCleanedAt ? new Date(current.lastCleanedAt).toLocaleString() : "Not yet"}</dd>
      </dl> : <p className="text-xs text-muted-foreground">{query.isFetching ? "Checking storage…" : "Storage usage unavailable."}</p>}
      <p className="text-xs text-muted-foreground">Optimize storage shares identical immutable files without changing their contents or URLs and rebuilds SQLite. It may take time on large boards. Later daily cleanups reclaim free pages in small batches.</p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={busy || !current} onClick={() => void maintain(false)}>Clean up</Button>
        <Button size="sm" variant="outline" disabled={busy || !current} onClick={() => void maintain(true)}>Optimize storage</Button>
        <Button size="sm" variant="ghost" disabled={busy || query.isFetching} onClick={() => { setResult(undefined); query.refresh(); }}>Refresh usage</Button>
      </div>
      {busy ? <p role="status" className="text-xs text-muted-foreground">Maintaining storage…</p> : null}
      {result ? <p role="status" className="text-xs text-muted-foreground">Removed {result.removedFiles} files and {result.removedRows} cache rows; shared {result.deduplicatedFiles} duplicate files. {result.warnings ? `${result.warnings} files skipped; see plugin logs.` : "Cleanup complete."}</p> : null}
      {error || query.error ? <p role="alert" className="text-xs text-destructive">{error ?? query.error}</p> : null}
    </div>
  </details>;
}
