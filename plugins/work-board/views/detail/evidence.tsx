import { UrlLink, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Comment, TaskPullRequest } from "../../shared/contract";
import { evidenceFlags, evidenceIndex } from "../../structured/evidence";
import { useMemo, useState } from "react";
import { useTasksQuery } from "../../shell/data";
import { Button } from "@/components/ui/button";

export function EvidenceSection({
  comments,
  taskId,
  pullRequests = [],
}: {
  comments: readonly Comment[];
  taskId?: string;
  pullRequests?: readonly TaskPullRequest[];
}) {
  const navigate = useBbNavigate();
  const [visibleCount, setVisibleCount] = useState(15);
  const links = useTasksQuery(async (rpc) => taskId ? (await rpc.call("listPrLinks", { taskId })).links : [], ["tasks:changed", "prs:changed"], [taskId]);
  const index = useMemo(() => evidenceIndex(comments), [comments]);
  const flags = evidenceFlags(index.records, pullRequests, links.data ?? []);
  const records = useMemo(() => {
    const latest = new Set([...index.records]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.commentId.localeCompare(a.commentId))
      .slice(0, visibleCount).map((record) => record.commentId));
    return index.records.filter((record) => latest.has(record.commentId));
  }, [index, visibleCount]);
  if (index.records.length === 0) return null;
  return (
    <section aria-label="Evidence" className="my-5 space-y-2">
      <h2 className="text-sm font-semibold">Evidence</h2>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              {["Time", "Kind", "PR / head", "Verdict", "Thread", "Remark"].map(
                (label) => (
                  <th key={label} className="p-2 font-medium">
                    {label}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {records.map((record) => {
              const pr = pullRequests.find(
                (candidate) => candidate.number === record.indexedPr,
              );
              return (
                <tr
                  key={record.commentId}
                  className={`border-b border-border last:border-0 ${record.superseded ? "text-muted-foreground" : ""}`}
                >
                  <td className="whitespace-nowrap p-2">
                    <time dateTime={record.createdAt}>
                      {record.createdAt.slice(0, 16).replace("T", " ")}
                    </time>
                  </td>
                  <td className="p-2">
                    {record.kind}
                    {flags.filter((flag) => flag.commentId === record.commentId).map((flag) => <span key={flag.kind} className="block rounded bg-amber-100 px-1 text-amber-900">⚠ {flag.message}</span>)}
                    {record.superseded ? (
                      <span className="block">superseded</span>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {record.indexedPr ? (
                      pr ? (
                        <UrlLink className="underline" href={pr.url}>
                          #{record.indexedPr}
                        </UrlLink>
                      ) : (
                        `#${record.indexedPr}`
                      )
                    ) : (
                      "—"
                    )}
                    <span
                      className="block font-mono"
                      title={record.indexedHead ?? undefined}
                    >
                      {record.indexedHead?.slice(0, 9)}
                    </span>
                  </td>
                  <td className="p-2">
                    {"verdict" in record ? record.verdict : "—"}
                  </td>
                  <td className="p-2">
                    {"thread" in record ? (
                      <button
                        className="underline"
                        onClick={() => {
                          if ("thread" in record)
                            navigate.toThread(record.thread);
                        }}
                      >
                        {record.thread}
                      </button>
                    ) : (
                      "—"
                    )}
                    {record.recordedByThread && (!("thread" in record) || record.recordedByThread !== record.thread) ? <span className="block">recorded by {record.recordedByThread}</span> : null}
                  </td>
                  <td className="min-w-40 p-2 whitespace-pre-wrap">
                    {record.body}
                    {Object.entries(record)
                      .filter(([key]) =>
                        [
                          "merge",
                          "run",
                          "env",
                          "lens",
                          "target",
                          "note",
                          "part",
                          "row",
                          "reason",
                          "ownerQuote",
                          "date",
                        ].includes(key),
                      )
                      .map(([key, value]) => (
                        <div
                          key={key}
                          className="break-all text-muted-foreground"
                        >
                          {key}: {String(value)}
                        </div>
                      ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {index.records.length > 15 ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>Showing {records.length} of {index.records.length}</span>
          {records.length < index.records.length ? (
            <Button size="sm" variant="ghost" onClick={() => setVisibleCount((count) => count + 15)}>
              Show earlier evidence
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
