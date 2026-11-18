import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./components/ui/select";
import type { reportOutput } from "./metrics";
import type { rpcContract } from "./server";

type Report = z.output<typeof reportOutput>;
const operationLabels = { start: "Start", "dry-run": "Dry run", dispatch: "Admission" };

export function GateActivity({ projectId, days, onDaysChange }: { projectId: string; days: string; onDaysChange: (days: string) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [refresh, setRefresh] = useState(0);
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.parse(to) - (Number(days) - 1) * 86_400_000).toISOString().slice(0, 10);
    rpc.call("report", { projectId, from, to }).then(result => {
      if (active) setReport(result);
    }, error => {
      if (active) setError(error instanceof Error ? error.message : String(error));
    });
    return () => { active = false; };
  }, [rpc, projectId, days, refresh]);

  const project = report?.projects[0];
  return <section aria-label="Gate activity" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-base font-semibold">Activity</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={days} onValueChange={next => {
          setReport(null);
          setError("");
          onDaysChange(next);
        }}>
          <SelectTrigger aria-label="Period" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="1">Today</SelectItem>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={() => {
          setReport(null);
          setError("");
          setRefresh(current => current + 1);
        }}>Refresh</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-destructive">Could not load activity: {error}</p>}
    {!report && !error && <p role="status" className="text-sm text-muted-foreground">Loading activity…</p>}
    {project && report && <>
      <p className="text-sm text-muted-foreground">{report.from} – {report.to} UTC</p>
      <dl className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {([["Starts", project.starts], ["Dry runs", project.dryRuns], ["Blocked starts", project.blockedStarts]] as const).map(([label, count]) =>
          <Card key={label} className="space-y-1 p-3">
            <dt className="text-sm text-muted-foreground">{label}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{count}</dd>
          </Card>
        )}
      </dl>
      {project.refusals.length ? <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="pb-2 text-left font-medium">Refusals by reason</caption>
          <thead className="text-muted-foreground">
            <tr><th scope="col" className="pb-1 pr-3 font-medium">Operation</th><th scope="col" className="pb-1 pr-3 font-medium">Reason</th><th scope="col" className="pb-1 text-right font-medium">Count</th></tr>
          </thead>
          <tbody>{project.refusals.map(row => <tr key={`${row.operation}:${row.reason}`} className="border-t border-border">
            <td className="py-2 pr-3">{operationLabels[row.operation]}</td>
            <td className="py-2 pr-3 break-all">{row.reason}</td>
            <td className="py-2 text-right tabular-nums">{row.count}</td>
          </tr>)}</tbody>
        </table>
      </div> : <p className="text-sm text-muted-foreground">No refusals recorded in this period.</p>}
    </>}
  </section>;
}
