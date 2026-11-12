import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import { SIGNALS_CHANGED, investigateInputSchema, investigateOutputSchema, navigationBadgeOutputSchema, problemActionInputSchema, problemActionOutputSchema, signalsInputSchema, signalsOutputSchema } from "./ci-signals-contract";

type SignalsOutput = z.infer<typeof signalsOutputSchema>;

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

// Keep range-specific answers separate while retaining the latest open problems.
const lastResult = new Map<string, SignalsOutput>();
const latestResult = new Map<string, SignalsOutput>();

/** Job-level data of one repository, cut to the dashboard range; open signals ignore the range. */
export function useRepositorySignals(repository: string, range: { since: string; until: string }): JobSignals {
  const rpc = useRpc<Contract>();
  const rpcRef = useRef(rpc); rpcRef.current = rpc;
  const { since, until } = range;
  const key = JSON.stringify([repository, since, until]);
  const [, redraw] = useState(0);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const flights = useRef(new Map<string, { dirty: boolean; active: boolean }>());
  const refresh = useCallback(() => {
    const existing = flights.current.get(key);
    if (existing) { existing.dirty = true; return; }
    const flight = { dirty: false, active: true }; flights.current.set(key, flight);
    const run = () => { flight.dirty = false; void rpcRef.current.call("signals", { repository, since, until, compact: true }).then((result) => {
      if (!flight.active) return;
      lastResult.delete(key); lastResult.set(key, result); if (lastResult.size > 8) lastResult.delete(lastResult.keys().next().value!); latestResult.set(repository, result); setErrorKey(null); redraw((n) => n + 1);
    }).catch(() => { if (flight.active) setErrorKey(key); }).finally(() => {
      if (flight.active && flight.dirty) run(); else if (flights.current.get(key) === flight) flights.current.delete(key);
    }); };
    run();
  }, [repository, since, until, key]);
  useEffect(() => { refresh(); return () => { const flight = flights.current.get(key); if (flight) { flight.active = false; flights.current.delete(key); } }; }, [refresh, key]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  useRealtime(SIGNALS_CHANGED, useCallback((payload: unknown) => {
    const changed = payload as { repository?: string } | null;
    if (!changed?.repository || changed.repository === repository) refresh();
  }, [repository, refresh]));
  const data = lastResult.get(key), latest = latestResult.get(repository), error = errorKey === key;
  const ranged = data?.repositories.find((item) => item.repository === repository);
  const current = latest?.repositories.find((item) => item.repository === repository);
  return { repo: ranged && current ? { ...ranged, problems: current.problems, live: current.live, signals: [...current.signals.filter((s) => s.open), ...ranged.signals.filter((s) => !s.open)] } : ranged ?? current,
    actors: data?.actors ?? latest?.actors, error, loading: !data && (!error || !!current), retry: refresh, now };
}
