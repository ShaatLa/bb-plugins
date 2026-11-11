import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExperimentalBadge,
  useRealtime,
  useRealtimeConnectionState,
} from "@get-bb/plugin-sdk/app";
import { badgeLabel } from "../shared/badge.js";
import { useTasksRpc } from "./data.js";

const TIME_BASED_REFRESH_MS = 60_000;
const EVENT_DEBOUNCE_MS = 200;
// A steady event stream must still refresh the badge, so the debounce cannot postpone it past this.
const EVENT_MAX_WAIT_MS = 1_000;

/** Work Board navigation badge: distinct tasks matching the criteria chosen in Work Board settings. */
export function useOpenTasksBadge(): ExperimentalBadge | null {
  const rpc = useTasksRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connectionState = useRealtimeConnectionState();
  const requestState = useRef({
    isMounted: true,
    isRunning: false,
    refreshQueued: false,
  });
  const pendingEvent = useRef<{ timer: ReturnType<typeof setTimeout>; since: number } | null>(null);
  const [badge, setBadge] = useState<{ value: ExperimentalBadge | null; timeBased: boolean }>({
    value: null,
    timeBased: false,
  });

  const refresh = useCallback(() => {
    const request = requestState.current;
    if (!request.isMounted) return;
    request.refreshQueued = true;
    if (request.isRunning) return;
    request.isRunning = true;

    void (async () => {
      try {
        while (request.isMounted && request.refreshQueued) {
          request.refreshQueued = false;
          try {
            const { count, counts, criteria, timeBased } = await rpcRef.current.call("navigationBadge", null);
            if (request.isMounted)
              setBadge({
                value: count > 0 ? { count, label: badgeLabel(count, counts, criteria) } : null,
                timeBased,
              });
          } catch {}
        }
      } finally {
        request.isRunning = false;
      }
    })();
  }, []);

  // Event bursts collapse into one trailing refresh; hidden windows skip the query and refresh on becoming visible.
  const scheduleRefresh = useCallback(() => {
    const now = Date.now();
    const since = pendingEvent.current?.since ?? now;
    clearTimeout(pendingEvent.current?.timer);
    const timer = setTimeout(
      () => {
        pendingEvent.current = null;
        if (document.visibilityState !== "hidden") refresh();
      },
      Math.max(0, Math.min(EVENT_DEBOUNCE_MS, since + EVENT_MAX_WAIT_MS - now)),
    );
    pendingEvent.current = { timer, since };
  }, [refresh]);

  useEffect(() => {
    const request = requestState.current;
    request.isMounted = true;
    const onVisible = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      request.isMounted = false;
      request.refreshQueued = false;
      document.removeEventListener("visibilitychange", onVisible);
      clearTimeout(pendingEvent.current?.timer);
      pendingEvent.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    if (connectionState === "connected") refresh();
  }, [connectionState, refresh]);
  // The idle-thread criterion depends on elapsed time, not only on events.
  useEffect(() => {
    if (!badge.timeBased) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") refresh();
    }, TIME_BASED_REFRESH_MS);
    return () => clearInterval(timer);
  }, [badge.timeBased, refresh]);
  useRealtime("tasks:changed", scheduleRefresh);
  useRealtime("projects:changed", scheduleRefresh);
  useRealtime("threads:changed", scheduleRefresh);
  useRealtime("badge:changed", scheduleRefresh);

  return badge.value;
}
