import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { SIGNALS_CHANGED, investigateInputSchema, investigateOutputSchema, navigationBadgeOutputSchema, problemActionInputSchema, problemActionOutputSchema, signalsInputSchema, signalsOutputSchema, type SignalsOutput } from "./ci-signals-contract";

export type Contract = {
  signals: { input: typeof signalsInputSchema; output: typeof signalsOutputSchema }; navigationBadge: { input: z.ZodNull; output: typeof navigationBadgeOutputSchema };
  problemAction: { input: typeof problemActionInputSchema; output: typeof problemActionOutputSchema }; investigate: { input: typeof investigateInputSchema; output: typeof investigateOutputSchema };
};

export function useSignalsBadge() {
  const rpc = useRpc<Contract>();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [badge, setBadge] = useState<{ count: number; label: string; tone: "critical" | "neutral" } | null>(null);
  const connection = useRealtimeConnectionState();
  const sequence = useRef(0);
  // Only critical problems count: warnings stay in the CI health list without raising the navigation badge.
  const show = useCallback(({ critical }: { count: number; critical: number }) => setBadge(critical > 0 ? { count: critical, label: `${critical} critical CI ${critical === 1 ? "problem needs" : "problems need"} attention`, tone: "critical" } : null), []);
  const refresh = useCallback(() => { const request = ++sequence.current; void rpcRef.current.call("navigationBadge", null).then((counts) => {
    if (request === sequence.current) show(counts);
  }).catch(() => {}); }, [show]);
  useEffect(() => { refresh(); return () => { sequence.current++; }; }, [refresh]);
  useEffect(() => { if (connection === "connected") refresh(); }, [connection, refresh]);
  // The server sends the badge numbers with the signal; the RPC is only the fallback (mount, reconnect, payload-less signals).
  useRealtime(SIGNALS_CHANGED, useCallback((payload: unknown) => {
    const counts = navigationBadgeOutputSchema.safeParse(payload);
    if (!counts.success) return refresh();
    sequence.current++;
    show(counts.data);
  }, [refresh, show]));
  return badge;
}

export type JobSignals = { repo: SignalsOutput["repositories"][number] | undefined; actors: SignalsOutput["actors"] | undefined; error: boolean; loading: boolean; retry: () => void; now: number };

// Last answer per repository, so returning to the dashboard shows job-level numbers at once while the refresh runs.
const lastResult = new Map<string, SignalsOutput>();

/** Job-level data of one repository, cut to the dashboard range; open signals ignore the range. */
export function useRepositorySignals(repository: string, range: { since: string; until: string }): JobSignals {
  const rpc = useRpc<Contract>();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const [data, setData] = useState<SignalsOutput | null>(() => lastResult.get(repository) ?? null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(Date.now());
  const sequence = useRef(0);
  const { since, until } = range;
  const refresh = useCallback(() => { const request = ++sequence.current; void rpcRef.current.call("signals", { repository, since, until }).then((result) => {
    if (request === sequence.current) { lastResult.set(repository, result); setData(result); setError(false); }
  }).catch(() => { if (request === sequence.current) setError(true); }); }, [repository, since, until]);
  // A range change keeps the previous numbers on screen until the new ones arrive; another repository does not.
  useEffect(() => { setData(lastResult.get(repository) ?? null); setError(false); }, [repository]);
  useEffect(() => { refresh(); return () => { sequence.current++; }; }, [refresh]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useRealtime(SIGNALS_CHANGED, refresh);
  return { repo: data?.repositories.find((item) => item.repository === repository), actors: data?.actors, error, loading: !data && !error, retry: refresh, now };
}
