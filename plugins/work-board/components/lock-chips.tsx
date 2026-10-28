import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useTasksQuery, useTasksRpc } from "../shell/data.js";
import type { Lock } from "../shared/locks.js";
import { errorMessage } from "../shared/errors.js";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const STALE_LABEL: Record<NonNullable<Lock["stale"]>, string> = {
  expired: "its time-to-live ran out",
  thread_failed: "the holder thread failed",
  thread_archived: "the holder thread was archived",
  thread_deleted: "the holder thread was deleted",
};

function holderName(lock: Lock): string {
  return lock.holderThreadId
    ? (lock.holderTitle ?? lock.holderThreadId)
    : "person";
}

function minutesSince(iso: string): string {
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).valueOf()) / 60_000),
  );
  if (minutes < 60) return `${minutes} min`;
  return minutes < 1440
    ? `${Math.floor(minutes / 60)} h`
    : `${Math.floor(minutes / 1440)} d`;
}

function LockChip({
  projectId,
  lock,
  onReleased,
}: {
  projectId: string;
  lock: Lock;
  onReleased: () => void;
}) {
  const rpc = useTasksRpc();
  const navigate = useBbNavigate();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const release = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("releaseLock", {
        projectId,
        name: lock.name,
        threadId: null,
        force: true,
        reason: reason.trim(),
      });
      if (result.ok) onReleased();
      else setError(result.error.message);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={lock.stale ? `STALE: ${STALE_LABEL[lock.stale]}` : undefined}
          className={cn(
            "flex min-w-0 max-w-[22rem] items-center gap-1 truncate rounded-md border px-2 py-0.5 text-xs",
            lock.stale
              ? "border-warning text-warning"
              : "border-border text-muted-foreground hover:text-foreground",
          )}
        >
          <span className="truncate">
            {lock.name} · {holderName(lock)} · {lock.reason} ·{" "}
            {minutesSince(lock.acquiredAt)}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-2 p-3 text-xs">
        <p className="text-sm font-medium">
          {lock.name}
          {lock.stale ? (
            <span className="ml-2 text-warning">STALE</span>
          ) : null}
        </p>
        {lock.stale ? (
          <p className="text-warning">{STALE_LABEL[lock.stale]}</p>
        ) : null}
        <p>{lock.reason}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-muted-foreground">
          <dt>Holder</dt>
          <dd className="truncate">
            {lock.holderThreadId ? (
              <button
                type="button"
                className="underline"
                onClick={() => navigate.toThread(lock.holderThreadId!)}
              >
                {holderName(lock)}
              </button>
            ) : (
              "person"
            )}
          </dd>
          {lock.taskKey ? (
            <>
              <dt>Task</dt>
              <dd>{lock.taskKey}</dd>
            </>
          ) : null}
          <dt>Since</dt>
          <dd>{new Date(lock.acquiredAt).toLocaleString()}</dd>
          {lock.expiresAt ? (
            <>
              <dt>Expires</dt>
              <dd>{new Date(lock.expiresAt).toLocaleString()}</dd>
            </>
          ) : null}
        </dl>
        <Input
          aria-label="Release reason"
          placeholder="Reason for releasing"
          maxLength={200}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        {error ? (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || reason.trim() === ""}
          onClick={release}
        >
          Release (force)
        </Button>
      </PopoverContent>
    </Popover>
  );
}

// Renders nothing while loading, on error, or when no lock is held.
export function LockChips({ projectId }: { projectId: string }) {
  const locks = useTasksQuery(
    async (rpc) => (await rpc.call("listLocks", { projectId })).locks,
    ["locks:changed"],
    [projectId],
  );
  if (!locks.data?.length) return null;
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5">
      {locks.data.map((lock) => (
        <LockChip
          key={lock.name}
          projectId={projectId}
          lock={lock}
          onReleased={locks.refresh}
        />
      ))}
    </div>
  );
}
