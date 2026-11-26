import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  gitSyncConfigSchema,
  observationStale,
  observationTtl,
  prIdentity,
  prLinkSchema,
  prSnapshotSchema,
  type PrLink,
  type PrSnapshot,
} from "../shared/git-sync";
import { recordedPrAuthors } from "./authors";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;

/** Author threads resolved live by the caller; `failed` means the lookup could not be completed. */
export interface GateAuthors {
  failed: boolean;
  /** The card's attached threads when the lookup started; the caller re-reads them before the move and fails the lookup if they changed. */
  threads?: readonly string[];
  byIdentity: ReadonlyMap<string, readonly string[]>;
}

export interface GateInput {
  task: { id: string; key: string; projectId: string };
  targetLabel: string;
  progressStatus: string | null;
  progressLabel: string | null;
  /** The agent thread making the move; null when a caller checks the rule without one. */
  mover: string | null;
  authors?: GateAuthors;
  now?: number;
}

export interface GateDecision {
  at: string;
  taskId: string;
  mover: string;
  path: "A" | "B";
  result: "passed" | "refused";
  detail: unknown;
}

export interface GateResult {
  refusal: string | null;
  decision: GateDecision;
  /** The history entry's review clause of a passed move. */
  clause: string | null;
}

interface EvidenceRow {
  id: string;
  createdAt: string;
  evidence: { kind: string; pr?: number; head?: string; verdict?: string; thread?: string };
}

const short = (sha: string) => sha.slice(0, 7);
const same = (left: string | undefined, right: string) => left?.toLowerCase() === right.toLowerCase();
const OWNER_MOVE = "the owner can still move the card on the board";

/**
 * The Done rule for an agent move (see skills/work-board/references/pr-ci.md). A card that delivers PRs needs an approval at each PR's gate head from a
 * thread that is neither the mover nor a known author of that PR; a card without one needs an approval after it last
 * entered In Progress. Reads only; the caller records the decision.
 */
export function evaluateReviewGate(db: Database, input: GateInput): GateResult {
  const { task } = input;
  const now = input.now ?? Date.now();
  const mover = input.mover;
  const links = db.prepare<[string], { payload: string }>("SELECT payload FROM task_pr_links WHERE task_id=? ORDER BY identity")
    .all(task.id).map((row) => prLinkSchema.parse(JSON.parse(row.payload)));
  const evidence = db.prepare<[string], { id: string; createdAt: string; evidence: string }>(
    "SELECT id, created_at AS createdAt, evidence FROM comments WHERE task_id=? AND evidence IS NOT NULL ORDER BY rowid",
  ).all(task.id).map((row): EvidenceRow => ({ id: row.id, createdAt: row.createdAt, evidence: JSON.parse(row.evidence) }));
  const configRow = db.prepare<[string], { payload: string }>("SELECT payload FROM git_sync_projects WHERE project_id=?").get(task.projectId);
  const config = gitSyncConfigSchema.parse(configRow ? JSON.parse(configRow.payload) : {});
  /** A snapshot is current until its observation outlives its freshness window; an errored refresh or an unconfigured repository makes it stale. */
  const staleOf = (snapshot: PrSnapshot, error: string | null) => Boolean(error) || !config.repositories.includes(snapshot.repository)
    || observationStale(snapshot.observedAt, observationTtl(snapshot, config, now), now);
  const snapshotOf = (identity: string) => {
    const row = db.prepare<[string, string], { payload: string | null; error: string | null }>(
      "SELECT payload, error FROM git_pr_snapshots WHERE project_id=? AND identity=?").get(task.projectId, identity);
    return { snapshot: row?.payload ? prSnapshotSchema.parse(JSON.parse(row.payload)) : null, error: row?.error ?? null };
  };

  const detail: Record<string, unknown> = {
    links: links.map((link) => ({ identity: prIdentity(link), role: link.role, confirmed: link.confirmed, excluded: link.excluded })),
  };
  const merges = evidence.filter((row) => row.evidence.kind === "merge");
  detail.merges = merges.map((row) => ({ commentId: row.id, pr: row.evidence.pr, head: row.evidence.head }));

  // The PRs the card delivers: its confirmed delivering links, and every PR a merge record names.
  interface Entry { identity: string; repository: string; number: number; link: PrLink | null; merges: EvidenceRow[] }
  const entries = new Map<string, Entry>();
  const problems: string[] = [];
  const unexcluded = links.filter((link) => !link.excluded);
  for (const link of unexcluded) {
    if (link.role !== "delivers" || !link.confirmed) continue;
    // Only a current closed observation says the PR was closed without merge; a stale one stays in the set and refuses.
    const seen = snapshotOf(prIdentity(link));
    if (seen.snapshot?.state === "closed" && !staleOf(seen.snapshot, seen.error)) continue;
    entries.set(prIdentity(link), { identity: prIdentity(link), repository: link.repository, number: link.number, link, merges: [] });
  }
  for (const merge of merges) {
    const number = merge.evidence.pr!;
    const named = unexcluded.filter((link) => link.number === number);
    let identity: string, repository: string, link: PrLink | null = null;
    if (named.length === 1) { link = named[0]!; identity = prIdentity(link); repository = link.repository; }
    else if (named.length === 0 && config.repositories.length === 1) {
      repository = config.repositories[0]!; identity = prIdentity({ repository, number });
    } else {
      problems.push(named.length > 1
        ? `two linked PRs share #${number}; unlink one, or the owner can move the card`
        : `a merge is recorded for PR #${number} that no link names, and the project has ${config.repositories.length ? "several repositories" : "no repository"}; link it with bb work-board pr link ${task.key} <url> --role delivers`);
      continue;
    }
    const entry = entries.get(identity) ?? { identity, repository, number, link, merges: [] };
    entry.merges.push(merge);
    entries.set(identity, entry);
  }
  for (const entry of entries.values())
    if (entry.link && unexcluded.filter((link) => link.number === entry.number).length > 1)
      problems.push(`two linked PRs share #${entry.number}; unlink one, or the owner can move the card`);

  const prefix = task.key.slice(0, task.key.lastIndexOf("-"));
  const lines: string[] = [];
  const clauses: string[] = [];
  const prDetails: unknown[] = [];
  let remedyPr: number | null = null;
  if (entries.size && input.authors?.failed) problems.push("could not resolve the PR's author threads; retry, or the owner can move the card");
  for (const entry of problems.length ? [] : entries.values()) {
    const name = `${entry.repository}#${entry.number}`;
    const { snapshot, error } = snapshotOf(entry.identity);
    const mergeRecord = [...entry.merges].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1) ?? null;
    let headSource: "merged_snapshot" | "open_snapshot" | "merge_evidence" | null = null;
    let head: string | null = null;
    let stale: boolean | null = null;
    if (snapshot) {
      stale = staleOf(snapshot, error);
      if (snapshot.state === "merged") { headSource = "merged_snapshot"; head = snapshot.headSha; stale = false; }
      else if ((snapshot.state === "open" || snapshot.state === "draft") && !stale) { headSource = "open_snapshot"; head = snapshot.headSha; }
    } else if (mergeRecord) { headSource = "merge_evidence"; head = mergeRecord.evidence.head!; }
    const live = input.authors?.byIdentity.get(entry.identity) ?? [];
    const authors = new Map<string, "live" | "record">();
    for (const thread of recordedPrAuthors(db, task.projectId, entry.identity)) authors.set(thread, "record");
    for (const thread of live) authors.set(thread, "live");
    const approvals = head === null ? [] : evidence.filter((row) =>
      (row.evidence.kind === "review" && row.evidence.verdict === "approve" || row.evidence.kind === "qa" && row.evidence.verdict === "pass")
      && row.evidence.pr === entry.number && same(row.evidence.head, head!));
    const qualifying = approvals.filter((row) => row.evidence.thread !== mover && !authors.has(row.evidence.thread!));
    prDetails.push({
      identity: entry.identity, number: entry.number, headSource, gateHead: head,
      snapshot: snapshot ? { state: snapshot.state, observedAt: snapshot.observedAt, stale } : null,
      snapshotHead: headSource === "merge_evidence" || !snapshot ? null : snapshot.headSha,
      mergeCommentId: headSource === "merge_evidence" ? mergeRecord!.id : null,
      mergeCommentIds: entry.merges.map((row) => row.id),
      authors: [...authors].map(([thread, source]) => ({ thread, source })), authorsKnown: authors.size,
      approvals: approvals.map((row) => ({ commentId: row.id, thread: row.evidence.thread, head: row.evidence.head, verdict: row.evidence.verdict })),
      qualifying: qualifying.map((row) => row.id),
    });
    if (head === null) {
      lines.push(`- PR state for ${name} is unknown or stale; run bb work-board sync --project ${prefix} and retry, or ${OWNER_MOVE}`);
    } else if (!qualifying.length) {
      remedyPr ??= entry.number;
      const others = [...new Set(approvals.map((row) => row.evidence.thread!))];
      lines.push(others.length
        ? `- ${name} (head ${short(head)}): approved only by ${others.some((thread) => authors.has(thread)) ? "an author thread" : "you"} (${others.join(", ")})`
        : `- ${name} (head ${short(head)}): no approval at this head from a thread other than you or the PR's authors`);
    } else {
      const first = qualifying[0]!;
      clauses.push(`#${entry.number} ${first.evidence.verdict}@${short(head)} by ${first.evidence.thread}${authors.size === 0 ? " (no author known)" : ""}`);
    }
  }
  const header = `${task.key} cannot move to ${input.targetLabel}: this project requires a review before Done.`;
  const remedy = (pr: string) =>
    `Ask a reviewer thread to review that head and record it: bb work-board comment ${task.key} --kind review ${pr}--head <sha> --verdict approve --thread <reviewer thread> --body "...".\n` +
    `The project manager or the owner can record it too, and ${OWNER_MOVE}.`;
  const decision = (path: "A" | "B", result: "passed" | "refused", extra: Record<string, unknown>): GateDecision =>
    ({ at: new Date(now).toISOString(), taskId: task.id, mover: mover ?? "", path, result, detail: { ...detail, ...extra } });

  if (entries.size || problems.length) {
    if (problems.length) {
      const text = `${header} ${[...new Set(problems)].join("; ")}`;
      return { refusal: text, clause: null, decision: decision("A", "refused", { prs: prDetails, problems }) };
    }
    if (lines.length)
      return { refusal: `${header}\n${lines.join("\n")}\n${remedy(remedyPr ? `--pr ${remedyPr} ` : "")}`, clause: null, decision: decision("A", "refused", { prs: prDetails }) };
    return { refusal: null, clause: `review: ${clauses.join("; ")}`, decision: decision("A", "passed", { prs: prDetails }) };
  }

  // No PR to deliver: one approval from another thread after the card last entered In Progress.
  const last = input.progressStatus
    ? db.prepare<[string, string], { id: number; at: string | null }>("SELECT id, at FROM task_review_log WHERE task_id=? AND status=? ORDER BY id DESC LIMIT 1").get(task.id, input.progressStatus) ?? null
    : null;
  const approvals = db.prepare<[string, number], { logId: number; commentId: string; createdAt: string; evidence: string }>(
    `SELECT l.id AS logId, c.id AS commentId, c.created_at AS createdAt, c.evidence FROM task_review_log l JOIN comments c ON c.id=l.comment_id
     WHERE l.task_id=? AND l.kind='approval' AND l.id > ? ORDER BY l.id`,
  ).all(task.id, last?.id ?? 0).map((row) => ({ ...row, thread: JSON.parse(row.evidence).thread as string }));
  // Order is the review-log id alone: the log is written in transaction order, so a same-millisecond approval still follows the status row.
  const found = approvals.find((row) => row.thread !== mover) ?? null;
  const extra = {
    prs: [], lastInProgress: last, approval: found && { commentId: found.commentId, createdAt: found.createdAt, thread: found.thread, logId: found.logId },
  };
  if (found) return { refusal: null, clause: `review: approve by ${found.thread}`, decision: decision("B", "passed", extra) };
  const since = input.progressLabel ? `since the card last entered ${input.progressLabel}` : "on this card";
  return {
    refusal: `${header}\n- no approving review from a thread other than you ${since}\n${remedy("")}`,
    clause: null, decision: decision("B", "refused", extra),
  };
}

export function recordReviewGateDecision(db: Database, decision: GateDecision): void {
  if (!decision.mover) return;
  db.prepare<[string, string, string, string, string, string]>(
    "INSERT INTO review_gate_decisions(at, task_id, mover, path, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(decision.at, decision.taskId, decision.mover, decision.path, decision.result, JSON.stringify(decision.detail));
}

/** Thrown inside a move's transaction; the refusal's decision is recorded after the rollback. */
export class ReviewGateRefused extends Error {
  constructor(message: string, readonly decision: GateDecision) { super(message); }
}
