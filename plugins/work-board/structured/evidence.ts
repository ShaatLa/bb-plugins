import type { Comment, Evidence, TaskPullRequest } from "../shared/contract";

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

export function evidenceFlags(records: readonly EvidenceEntry[], pullRequests: readonly TaskPullRequest[], links: readonly { link: { number: number; url?: string; excluded?: boolean }; snapshot: { state: string; headSha: string } | null }[]) {
  const flags: { commentId: string; kind: "self_review" | "stale_head"; message: string }[] = [];
  for (const record of records) {
    if ((record.kind !== "review" && record.kind !== "qa") || !record.pr) continue;
    const matches = pullRequests.filter((pr) => pr.number === record.pr);
    const linked = links.filter(({ link }) => !link.excluded && link.number === record.pr);
    if (matches.length === 1 && (linked.length === 0 || (linked.length === 1 && linked[0]!.link.url === matches[0]!.url)) && matches[0]!.threadIds.includes(record.thread))
      flags.push({ commentId: record.commentId, kind: "self_review", message: "Reviewer is the PR author thread" });
  }
  const merged = links.filter(({ link, snapshot }) => !link.excluded && snapshot?.state === "merged");
  for (const { link, snapshot } of merged) {
    if (!snapshot || links.filter((item) => !item.link.excluded && item.link.number === link.number).length !== 1) continue;
    const approvals = records.filter((record) => (record.kind === "review" || record.kind === "qa") && record.pr === link.number && (record.verdict === "approve" || record.verdict === "pass"));
    if (approvals.some((record) => record.indexedHead?.toLowerCase() === snapshot.headSha.toLowerCase())) continue;
    const newest = approvals.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.commentId.localeCompare(a.commentId))[0];
    if (newest && (newest.kind === "review" || newest.kind === "qa")) flags.push({ commentId: newest.commentId, kind: "stale_head", message: `Approved head ${newest.head.slice(0, 7)} differs from merged head ${snapshot.headSha.slice(0, 7)}` });
  }
  return flags;
}
