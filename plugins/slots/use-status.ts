import { useEffect, useRef, useState } from "react";
import { useRealtime, useRpc, type StandardSchemaV1 } from "@get-bb/plugin-sdk/app";
import { SLOTS_CHANGED, type Result, type StatusParams, type StatusView } from "./contract";

type StatusContract = { status: {
  input: StandardSchemaV1<StatusParams, StatusParams>;
  output: StandardSchemaV1<Result<StatusView>, Result<StatusView>>;
} };

// Trailing debounce that still fires at least once per maxWait under continuous calls.
export function debounce(fn: () => void, wait = 250, maxWait = 1000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let first = 0;
  return {
    call() {
      const now = Date.now();
      if (timer === undefined) first = now; else clearTimeout(timer);
      timer = setTimeout(() => { timer = undefined; fn(); }, Math.max(0, Math.min(wait, first + maxWait - now)));
    },
    cancel() { clearTimeout(timer); timer = undefined; },
  };
}

export function useStatus({ clock: ticking = true }: { clock?: boolean } = {}) {
  const rpc = useRpc<StatusContract>();
  const [snapshot, setSnapshot] = useState<{ view: StatusView; receivedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState(Date.now);

  const refreshRef = useRef<() => void>(() => {});
  const eventRef = useRef<() => void>(() => {});
  useRealtime(SLOTS_CHANGED, () => eventRef.current());

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let changed = false;
    let userWaiting = false;
    let lastDone = 0;
    // Only a user-triggered refresh drives `busy`; events and the poll refresh silently.
    async function refresh(user = false) {
      if (document.visibilityState === "hidden") return;
      if (user) { userWaiting = true; setBusy(true); }
      if (pending) { changed = true; return; }
      pending = true;
      try {
        const result = await rpc.call("status", {});
        if (disposed) return;
        if (!result.ok) throw new Error(result.error.message);
        const receivedAt = Date.now();
        setSnapshot({ view: result.data, receivedAt });
        setClock(receivedAt);
        setError(null);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : "Unable to load Slots status.");
      }
      pending = false;
      lastDone = Date.now();
      if (disposed) return;
      if (changed) { changed = false; void refresh(); return; }
      if (userWaiting) { userWaiting = false; setBusy(false); }
    }
    const events = debounce(() => { void refresh(); });
    eventRef.current = events.call;
    refreshRef.current = () => { events.cancel(); void refresh(true); };
    const tick = ticking ? setInterval(() => {
      if (document.visibilityState !== "hidden") setClock(Date.now());
    }, 1000) : undefined;
    // Fallback only: realtime events normally keep the view fresh.
    const poll = setInterval(() => { if (Date.now() - lastDone >= 10_000) void refresh(); }, 30_000);
    const onVisibility = () => { events.cancel(); void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      disposed = true;
      events.cancel();
      eventRef.current = () => {};
      refreshRef.current = () => {};
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [rpc, ticking]);

  return { view: snapshot?.view ?? null, error, busy, refresh: () => refreshRef.current(),
    now: snapshot ? snapshot.view.at + Math.max(0, clock - snapshot.receivedAt) : clock };
}
