import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ExperimentalBadge,
  useRealtime,
  useRealtimeConnectionState,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { badgeLabel } from "../shared/badge.js";
import { useTasksRpc } from "./data.js";

const TIME_BASED_REFRESH_MS = 60_000;

/** Work Board navigation badge: distinct tasks matching the criteria chosen in settings. */
export function useOpenTasksBadge(): ExperimentalBadge | null {
  const rpc = useTasksRpc();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const connectionState = useRealtimeConnectionState();
  const settings = useSettings();
  const settingsKey = JSON.stringify(settings.values ?? null);
  const requestState = useRef({
    isMounted: true,
    isRunning: false,
    refreshQueued: false,
  });
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

  useEffect(() => {
    const request = requestState.current;
    request.isMounted = true;
    return () => {
      request.isMounted = false;
      request.refreshQueued = false;
    };
  }, []);

  useEffect(() => {
    if (connectionState === "connected") refresh();
  }, [connectionState, refresh, settingsKey]);
  // The idle-thread criterion depends on elapsed time, not only on events.
  useEffect(() => {
    if (!badge.timeBased) return;
    const timer = setInterval(refresh, TIME_BASED_REFRESH_MS);
    return () => clearInterval(timer);
  }, [badge.timeBased, refresh]);
  useRealtime("tasks:changed", refresh);
  useRealtime("projects:changed", refresh);
  useRealtime("threads:changed", refresh);

  return badge.value;
}
