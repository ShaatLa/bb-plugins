import { useEffect, useState } from "react";
import { useRpc, type StandardSchemaV1 } from "@get-bb/plugin-sdk/app";
import type { Result, StatusParams, StatusView } from "./contract";

type StatusContract = { status: {
  input: StandardSchemaV1<StatusParams, StatusParams>;
  output: StandardSchemaV1<Result<StatusView>, Result<StatusView>>;
} };

export function useStatus() {
  const rpc = useRpc<StatusContract>();
  const [snapshot, setSnapshot] = useState<{ view: StatusView; receivedAt: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);

  useEffect(() => {
    let disposed = false;
    let pending = false;
    async function refresh() {
      if (document.visibilityState === "hidden" || pending) return;
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
      } finally { pending = false; }
    }
    const tick = setInterval(() => {
      if (document.visibilityState !== "hidden") setClock(Date.now());
    }, 1000);
    const poll = setInterval(() => { void refresh(); }, 10_000);
    const onVisibility = () => { void refresh(); };
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      disposed = true;
      clearInterval(tick);
      clearInterval(poll);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [rpc]);

  return { view: snapshot?.view ?? null, error,
    now: snapshot ? snapshot.view.at + Math.max(0, clock - snapshot.receivedAt) : clock };
}
