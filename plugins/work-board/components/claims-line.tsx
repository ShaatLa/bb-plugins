import { useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { errorMessage } from "../shared/errors";

export function ClaimsLine({ taskId }: { taskId: string }) {
  const rpc = useTasksRpc();
  const query = useTasksQuery(async rpc => (await rpc.call("listTaskClaims", { taskId })).claims, ["tasks:changed"], [taskId], { relevantTaskIds: [taskId] });
  const [error, setError] = useState<string | null>(null);
  if (!query.data?.length) return null;
  return <div className="space-y-1 text-xs"><div className="font-medium">Claims</div>{query.data.map(claim => <div key={claim.id}>
    {claim.name} {claim.rendered}{claim.prUrl && <> · <a href={claim.prUrl} target="_blank" rel="noreferrer" className="underline">PR {claim.prUrl.match(/\/pull\/(\d+)/)?.[1] ? `#${claim.prUrl.match(/\/pull\/(\d+)/)?.[1]}` : claim.prUrl}</a></>}{" "}
    <button className="underline" onClick={async () => { const reason = window.prompt("Reason for release:"); if (!reason?.trim()) return; try { await rpc.call("releaseClaim", { projectId: claim.projectId, name: claim.name, value: claim.value, reason }); setError(null); query.refresh(); } catch (error) { setError(errorMessage(error)); } }}>Release</button>
  </div>)}{error && <div role="alert">{error}</div>}</div>;
}
