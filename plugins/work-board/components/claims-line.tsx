import { UrlLink } from "@get-bb/plugin-sdk/app";
import { useState } from "react";
import { useTasksQuery, useTasksRpc } from "../shell/data";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "../shared/errors";

export function ClaimsLine({ taskId }: { taskId: string }) {
  const rpc = useTasksRpc();
  const query = useTasksQuery(
    async (rpc) => (await rpc.call("listTaskClaims", { taskId })).claims,
    ["tasks:changed"],
    [taskId],
    { relevantTaskIds: [taskId] },
  );
  // window.prompt is unavailable in the desktop app, so the reason is typed inline.
  const [releasing, setReleasing] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (!query.data?.length) return null;
  return (
    <div className="space-y-1 text-xs">
      <div className="font-medium">Claims</div>
      {query.data.map((claim) => {
        const pr = claim.prUrl?.match(/\/pull\/(\d+)/)?.[1];
        return (
          <div key={claim.id} className="space-y-1">
            <div>
              {claim.name} {claim.rendered}
              {claim.prUrl && (
                <>
                  {" · "}
                  <UrlLink className="hover:underline" href={claim.prUrl}>
                    {pr ? `PR #${pr}` : claim.prUrl}
                  </UrlLink>
                </>
              )}{" "}
              {releasing !== claim.id && (
                <button
                  type="button"
                  className="underline"
                  onClick={() => {
                    setReleasing(claim.id);
                    setReason("");
                  }}
                >
                  Release
                </button>
              )}
            </div>
            {releasing === claim.id && (
              <form
                className="flex gap-1"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (!reason.trim()) return;
                  try {
                    await rpc.call("releaseClaim", {
                      projectId: claim.projectId,
                      name: claim.name,
                      value: claim.value,
                      reason,
                    });
                    setError(null);
                    setReleasing(null);
                    query.refresh();
                  } catch (error) {
                    setError(errorMessage(error));
                  }
                }}
              >
                <Input
                  autoFocus
                  aria-label="Release reason"
                  placeholder="Reason"
                  className="h-7 text-xs"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
                <Button type="submit" size="sm" className="h-7" disabled={!reason.trim()}>
                  Release
                </Button>
                <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setReleasing(null)}>
                  Cancel
                </Button>
              </form>
            )}
          </div>
        );
      })}
      {error && <div role="alert">{error}</div>}
    </div>
  );
}
