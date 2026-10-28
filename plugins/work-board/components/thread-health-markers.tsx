import { useEffect, useState } from "react";
import type { ThreadHealth } from "../shared/contract.js";
import { staleIdleMinutes } from "../shared/thread-health.js";
import { formatRelativeTime } from "../views/detail/meta.js";

/** Display-only dots: red for a failed attached thread, amber for an idle one with no task update. */
export function ThreadHealthMarkers({ health }: { health: ThreadHealth | undefined }) {
  const [now, setNow] = useState(Date.now);
  const armed = health?.idle != null;
  useEffect(() => {
    if (!armed) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [armed]);
  if (!health) return null;
  const idleMinutes = staleIdleMinutes(health.idle, now);
  const failedTitle = health.failed
    .map((entry) => `Thread ${entry.title} failed${formatRelativeTime(entry.failedAt) ? ` ${formatRelativeTime(entry.failedAt)}` : ""}`)
    .join("; ");
  const idleTitle = `Thread idle ${idleMinutes} min, task not updated`;
  return (
    <>
      {health.failed.length > 0 ? (
        <span role="img" title={failedTitle} aria-label={failedTitle} data-thread-health="failed" className="size-2 shrink-0 rounded-full bg-destructive" />
      ) : null}
      {idleMinutes !== null ? (
        <span role="img" title={idleTitle} aria-label={idleTitle} data-thread-health="idle" className="size-2 shrink-0 rounded-full bg-warning" />
      ) : null}
    </>
  );
}
