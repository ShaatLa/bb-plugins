import { HugeiconsIcon } from "@hugeicons/react";
import Clock01Icon from "@hugeicons/core-free-icons/Clock01Icon";
import { useSyncExternalStore } from "react";
import type { ThreadHealth } from "../shared/contract.js";
import { staleIdleMinutes } from "../shared/thread-health.js";
import { formatRelativeTime } from "../views/detail/meta.js";

// One shared interval for all idle clocks on a board, instead of one per card.
const TICK_MS = 60_000;
const tickListeners = new Set<() => void>();
let tickNow = Date.now();
let tickTimer: ReturnType<typeof setInterval> | undefined;

function subscribeTick(listener: () => void) {
  // Refresh the snapshot on subscribe so a newly armed clock does not show a stale minute.
  tickNow = Date.now();
  tickListeners.add(listener);
  tickTimer ??= setInterval(() => {
    tickNow = Date.now();
    tickListeners.forEach((notify) => notify());
  }, TICK_MS);
  return () => {
    tickListeners.delete(listener);
    if (tickListeners.size === 0) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };
}

const subscribeNone = () => () => {};
const getTickNow = () => tickNow;

/** Red marks failed sessions; an amber clock distinguishes stale idle from attachment. */
export function ThreadHealthMarkers({ health }: { health: ThreadHealth | undefined }) {
  const armed = health?.idle != null;
  const now = useSyncExternalStore(armed ? subscribeTick : subscribeNone, getTickNow);
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
        <span role="img" title={idleTitle} aria-label={idleTitle} data-thread-health="idle" className="inline-flex shrink-0 text-warning">
          <HugeiconsIcon icon={Clock01Icon} aria-hidden className="size-3" />
        </span>
      ) : null}
    </>
  );
}
