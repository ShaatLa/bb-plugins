import { useEffect } from "react";

export function useActivityPoll(refresh: () => void, isFetching: boolean, hasSessions: boolean) {
  useEffect(() => {
    if (!hasSessions) return;
    const timer = setInterval(() => {
      if (!isFetching && document.visibilityState === "visible") refresh();
    }, 5_000);
    return () => clearInterval(timer);
  }, [refresh, isFetching, hasSessions]);
}
