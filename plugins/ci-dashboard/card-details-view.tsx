import { useEffect, useState } from "react";
import { experimental_Icon as Icon, UrlLink, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { CardDetails, CardDetailsInput } from "./card-details";
import { Button } from "./components/ui/button";
import { LoadingSkeleton } from "./components/ui/skeleton";

export function CardDetailsView({ input }: { input: CardDetailsInput }) {
  const rpc = useRpc<typeof rpcContract>();
  const [requested, setRequested] = useState(false);
  const [data, setData] = useState<CardDetails | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!requested) return;
    let disposed = false;
    setError(false);
    void rpc.call("cardDetails", input).then(
      (result) => { if (!disposed) setData(result); },
      () => { if (!disposed) setError(true); },
    );
    return () => { disposed = true; };
  }, [rpc, key, requested, attempt]);
  return <details className="space-y-3 border-t border-border pt-3" onToggle={(event) => { if (event.currentTarget.open) setRequested(true); }}>
    <summary className="cursor-pointer rounded-sm text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {input.kind === "ci" ? "Latest failed runs" : "Recent production deployments"}
    </summary>
    {requested && (error ? <div className="space-y-2">
      <p role="alert" className="text-xs text-destructive">Unable to load details. Check connectivity and GitHub access.</p>
      <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>Retry details</Button>
    </div> : !data ? <LoadingSkeleton label="Loading details…" />
      : <>
        {data.items.length === 0 ? <p className="text-xs text-muted-foreground">{input.kind === "ci" ? "No failed runs in this range." : "No deployments in this environment."}</p>
          : <ul className="divide-y divide-border">{data.items.map((item) => <li key={item.id} className="space-y-1 py-2 first:pt-0">
            <UrlLink href={item.url} className="break-words text-sm hover:underline">{item.title}<Icon name="ExternalLink" aria-hidden className="ml-1 inline size-3 shrink-0" /></UrlLink>
            <p className="text-xs text-muted-foreground"><span className={item.state === "failure" ? "text-destructive" : item.state === "success" ? "text-emerald-500" : ""}>{item.state.replaceAll("_", " ")}</span> · {new Date(item.createdAt).toLocaleString()}</p>
            {item.compareUrl && <UrlLink href={item.compareUrl} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">Changes since previous deployment<Icon name="ExternalLink" aria-hidden className="size-3" /></UrlLink>}
          </li>)}</ul>}
        <p className="text-xs text-muted-foreground">Checked {new Date(data.checkedAt).toLocaleString()}</p>
      </>)}
  </details>;
}
