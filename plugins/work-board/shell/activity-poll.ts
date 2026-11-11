import { useEffect } from "react";

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
