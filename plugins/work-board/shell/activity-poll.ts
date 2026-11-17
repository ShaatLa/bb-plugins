import { useEffect, useRef } from "react";

export function samePolledMetadata(left: unknown, right: unknown): boolean {
  const serialize = (value: unknown) => JSON.stringify(value, function (this: Record<string, unknown>, key, entry) {
    // The server stamps every activity check; the timestamp does not change the displayed state.
    if (key === "checkedAt" && "inactiveSessions" in this && "hasWorked" in this) return undefined;
    return entry;
  });
  return serialize(left) === serialize(right);
}

export function useActivityPoll(refresh: () => void, isFetching: boolean, hasSessions: boolean) {
  useEffect(() => {
    if (!hasSessions) return;
    const timer = setInterval(() => {
      if (!isFetching && document.visibilityState === "visible") refresh();
    }, 5_000);
    return () => clearInterval(timer);
  }, [refresh, isFetching, hasSessions]);
}

type AdvisoryRow = { taskId: string; advisories?: readonly { validUntil: string }[] };
// Never recheck faster than this, even when a skewed client clock sees fresh advice as already expired.
const RECHECK_FLOOR_MS = 15_000;

/** Task ids whose advice has expired at `now`; the view rechecks them instead of letting the warning blink out. */
export function expiredAdvisoryTaskIds(rows: readonly AdvisoryRow[], now: number): string[] {
  return rows.filter((row) => row.advisories?.some((item) => Date.parse(item.validUntil) <= now)).map((row) => row.taskId);
}

/** One timer per view: when the earliest advice expires, recheck only the cards that carry expired advice. */
export function useAdvisoryRecheck(rows: readonly AdvisoryRow[] | undefined, recheck: (taskIds: string[]) => void) {
  const latest = useRef({ rows, recheck });
  latest.current = { rows, recheck };
  const expiry = Math.min(...(rows ?? []).flatMap((row) => row.advisories?.map((item) => Date.parse(item.validUntil)) ?? []));
  useEffect(() => {
    if (!Number.isFinite(expiry)) return;
    const run = () => {
      const ids = expiredAdvisoryTaskIds(latest.current.rows ?? [], Date.now());
      if (ids.length) latest.current.recheck(ids);
    };
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onVisible);
      run();
    };
    const timer = setTimeout(() => {
      // A hidden view rechecks when shown again instead of polling in the background.
      if (document.visibilityState === "visible") run(); else document.addEventListener("visibilitychange", onVisible);
    }, Math.min(Math.max(expiry - Date.now() + 1, RECHECK_FLOOR_MS), 2_147_483_647));
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [expiry]);
}
