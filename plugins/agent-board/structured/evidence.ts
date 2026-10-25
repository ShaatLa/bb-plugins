import type { Comment, Evidence } from "../shared/contract";

export type EvidenceEntry = Evidence & {
  commentId: string;
  taskId: string;
  createdAt: string;
  authorName: string;
  body: string;
  indexedPr: number | null;
  indexedHead: string | null;
  superseded: boolean;
};

export function evidenceIndex(comments: readonly Comment[]) {
  const ordered = [...comments]
    .filter((comment) => comment.evidence)
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
  const merges = new Map<string, { pr: number; head: string }>();
  for (const comment of ordered) {
    if (comment.evidence?.kind === "merge")
      merges.set(comment.evidence.merge, comment.evidence);
  }
  const newestHeads = new Map<number, string>();
  const seen = new Set<string>();
  const records: EvidenceEntry[] = ordered.map((comment) => {
    const evidence = comment.evidence!;
    const associated =
      evidence.kind === "deploy" ? merges.get(evidence.merge) : null;
    const pr =
      "pr" in evidence ? (evidence.pr ?? null) : (associated?.pr ?? null);
    const head =
      "head" in evidence ? evidence.head : (associated?.head ?? null);
    // A late verdict for a previously seen head does not make that head current again.
    if (pr !== null && head !== null && !seen.has(`${pr}:${head}`)) {
      seen.add(`${pr}:${head}`);
      newestHeads.set(pr, head);
    }
    return {
      ...evidence,
      commentId: comment.id,
      taskId: comment.taskId,
      createdAt: comment.createdAt,
      authorName: comment.authorName,
      body: comment.body,
      indexedPr: pr,
      indexedHead: head,
      superseded: false,
    };
  });
  for (const record of records)
    record.superseded =
      record.indexedPr !== null &&
      record.indexedHead !== null &&
      newestHeads.get(record.indexedPr) !== record.indexedHead;
  const summary = [...newestHeads]
    .sort(([a], [b]) => a - b)
    .map(([pr, head]) => ({
      pr,
      newestHead: head,
      kinds: [
        ...new Set(
          records
            .filter(
              (record) =>
                record.indexedPr === pr && record.indexedHead === head,
            )
            .map((record) => record.kind),
        ),
      ].sort(),
    }));
  // Group by PR and head, ordering heads by their first appearance, newest first.
  const headOrder = new Map<string, number>();
  records.forEach((record, index) => {
    const key = `${record.indexedPr}:${record.indexedHead}`;
    if (!headOrder.has(key)) headOrder.set(key, index);
  });
  records.sort(
    (a, b) =>
      (a.indexedPr ?? Number.MAX_SAFE_INTEGER) -
        (b.indexedPr ?? Number.MAX_SAFE_INTEGER) ||
      headOrder.get(`${b.indexedPr}:${b.indexedHead}`)! -
        headOrder.get(`${a.indexedPr}:${a.indexedHead}`)! ||
      b.createdAt.localeCompare(a.createdAt) ||
      b.commentId.localeCompare(a.commentId),
  );
  return { records, summary };
}

export function evidenceText(index: ReturnType<typeof evidenceIndex>): string {
  return (
    [
      ...index.records.map((record) =>
        [
          record.createdAt,
          record.kind,
          record.indexedPr ? `PR #${record.indexedPr}` : "",
          record.indexedHead?.slice(0, 9) ?? "",
          "verdict" in record ? record.verdict : "",
          "thread" in record ? `@thread:${record.thread}` : "",
          record.superseded ? "[superseded]" : "",
          JSON.stringify(
            Object.fromEntries(
              Object.entries(record).filter(([key]) =>
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
              ),
            ),
          ),
          record.body,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      ...index.summary.map(
        (entry) =>
          `PR #${entry.pr} · newest head ${entry.newestHead.slice(0, 9)} · ${entry.kinds.join(", ")}`,
      ),
    ].join("\n") || "(none)"
  );
}
