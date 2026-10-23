import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { Comment, TaskPullRequest } from "../../shared/contract";
import { evidenceIndex } from "../../structured/evidence";

export function EvidenceSection({
  comments,
  pullRequests = [],
}: {
  comments: readonly Comment[];
  pullRequests?: readonly TaskPullRequest[];
}) {
  const navigate = useBbNavigate();
  const index = evidenceIndex(comments);
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
            {index.records.map((record) => {
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
                    {record.superseded ? (
                      <span className="block">superseded</span>
                    ) : null}
                  </td>
                  <td className="p-2">
                    {record.indexedPr ? (
                      pr ? (
                        <a
                          className="underline"
                          href={pr.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          #{record.indexedPr}
                        </a>
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
    </section>
  );
}
