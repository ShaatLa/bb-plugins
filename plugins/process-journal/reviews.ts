import { createHash } from "node:crypto";
import type { Database } from "better-sqlite3";
import { isOpen, type BoardLink, type Entry, type Input, type JournalEvent, type Proposal, type ReviewRound,
  type ReviewStage, type ReviewSummary } from "./contract";
import { requireCondition } from "./errors";
import { assertNoSecretsInValue } from "./secret-guard";

export const reviewMigration = `
CREATE TABLE IF NOT EXISTS proposal_reviewers (
  project TEXT NOT NULL, proposal TEXT NOT NULL, reviewer TEXT NOT NULL, generation INTEGER NOT NULL,
  PRIMARY KEY(project,proposal)
);
CREATE TABLE IF NOT EXISTS proposal_reviews (
  project TEXT NOT NULL, proposal TEXT NOT NULL, stage TEXT NOT NULL, version INTEGER NOT NULL,
  body TEXT NOT NULL, next INTEGER NOT NULL, notice INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(project,proposal,stage,version)
);
CREATE TABLE IF NOT EXISTS proposal_review_executors (
  project TEXT NOT NULL, proposal TEXT NOT NULL, thread TEXT NOT NULL, PRIMARY KEY(project,proposal,thread)
);
CREATE TABLE IF NOT EXISTS proposal_review_ancestry (
  child TEXT NOT NULL, parent TEXT NOT NULL, PRIMARY KEY(child,parent)
);
CREATE TABLE IF NOT EXISTS proposal_review_legacy (
  project TEXT NOT NULL, proposal TEXT NOT NULL, PRIMARY KEY(project,proposal)
);
CREATE TABLE IF NOT EXISTS proposal_review_installation (installed INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO proposal_review_legacy
  SELECT project,id FROM proposals WHERE state IN ('applied','measuring')
    AND NOT EXISTS (SELECT 1 FROM proposal_review_installation);
INSERT OR IGNORE INTO proposal_review_installation VALUES (1);
INSERT OR IGNORE INTO proposal_review_executors
  SELECT project,proposal,json_extract(body,'$.actor') FROM timeline
  WHERE json_extract(body,'$.actor') GLOB 'thr_*'
    AND (kind IN ('transition','updated','measurement:manual') OR kind='reassigned');
INSERT OR IGNORE INTO proposal_review_executors
  SELECT project,proposal,substr(json_extract(body,'$.message'),17,instr(json_extract(body,'$.message'),' to ')-17)
  FROM timeline WHERE kind='reassigned' AND json_extract(body,'$.message') GLOB 'Reassigned from thr_* to thr_*';
`;

type StoreParts = {
  db: Database;
  now: () => number;
  entry: (project: string, id: string) => Entry;
  proposal: (project: string, id: string, revision?: number) => Proposal;
  links: (project: string, id: string) => BoardLink[];
  metricIdentity: (p: Proposal) => string;
  event: (project: string, id: string, event: Omit<JournalEvent, "seq" | "at">) => unknown;
};
export type ReviewIdentity = { reviewerId: string; links: string[]; executors: string[]; version?: number };
type Assignment = { reviewerId: string; generation: number };
type Work = { round: ReviewRound; next: number; notice: number };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const executorEvidence = (thread: string) => `Verified linked fix executor: ${thread}`;

export function createReviewStore({ db, now, entry, proposal, links, metricIdentity, event }: StoreParts) {
  function experiment(p: Proposal) {
    const source = entry(p.projectId, p.entryId);
    const { definition, unit, baseline, target, command } = p.metric;
    return {
      title: p.title, hypothesis: p.hypothesis, rollbackCondition: p.rollbackCondition,
      metric: { definition, unit, baseline, target, command }, links: [...new Set(p.links)].sort(),
      entry: { id: source.id, title: source.title, failure: source.failure, gap: source.gap,
        links: [...new Set(source.links)].sort() },
    };
  }
  function legacy(p: Proposal) {
    return !!db.prepare("SELECT 1 FROM proposal_review_legacy WHERE project=? AND proposal=?").get(p.projectId, p.id);
  }
  function assignment(p: Proposal) {
    return db.prepare("SELECT reviewer AS reviewerId,generation FROM proposal_reviewers WHERE project=? AND proposal=?")
      .get(p.projectId, p.id) as Assignment | undefined;
  }
  function rounds(p: Proposal) {
    const rows = db.prepare("SELECT body FROM proposal_reviews WHERE project=? AND proposal=? ORDER BY rowid DESC LIMIT 20")
      .all(p.projectId, p.id) as { body: string }[];
    return rows.map(row => JSON.parse(row.body) as ReviewRound);
  }
  function latest(p: Proposal, stage: ReviewStage) {
    const row = db.prepare("SELECT body FROM proposal_reviews WHERE project=? AND proposal=? AND stage=? ORDER BY version DESC LIMIT 1")
      .get(p.projectId, p.id, stage) as { body: string } | undefined;
    return row ? JSON.parse(row.body) as ReviewRound : null;
  }
  function save(round: ReviewRound, next = round.submittedAt) {
    db.prepare(`INSERT INTO proposal_reviews(project,proposal,stage,version,body,next) VALUES (?,?,?,?,?,?)
      ON CONFLICT(project,proposal,stage,version) DO UPDATE SET body=excluded.body,next=excluded.next`)
      .run(round.projectId, round.proposalId, round.snapshot.stage, round.version, JSON.stringify(round), next);
    return round;
  }
  function participant(p: Proposal, actor: string) {
    if (!actor.startsWith("thr_")) return;
    db.prepare("INSERT OR IGNORE INTO proposal_review_executors VALUES (?,?,?)").run(p.projectId, p.id, actor);
  }
  function lineage(child: string, ancestors: string[]) {
    const insert = db.prepare("INSERT OR IGNORE INTO proposal_review_ancestry VALUES (?,?)");
    for (const parent of new Set(ancestors)) if (child !== parent) insert.run(child, parent);
  }
  const recordLinkedExecutors = db.transaction((p: Proposal, executors: string[]) => {
    if (!executors.length) return;
    const known = db.prepare(`SELECT 1 FROM timeline WHERE project=? AND proposal=? AND kind='review'
      AND json_extract(body,'$.actor')='Work Board' AND json_extract(body,'$.message')=? LIMIT 1`);
    for (const actor of new Set(executors)) {
      participant(p, actor);
      const message = executorEvidence(actor);
      if (!known.get(p.projectId, p.id, message)) {
        event(p.projectId, p.id, { kind: "review", actor: "Work Board", message });
      }
    }
  });
  function conflicts(p: Proposal, reviewerId: string, additional?: string) {
    if (reviewerId === p.managerId) return true;
    // The manager is recorded as a participant even when they only assigned the work.
    return !!db.prepare(`WITH RECURSIVE ancestry(thread) AS (
      SELECT @reviewer UNION SELECT a.parent FROM proposal_review_ancestry a JOIN ancestry x ON x.thread=a.child
    ) SELECT 1 FROM ancestry WHERE (thread <> @manager OR EXISTS (
      SELECT 1 FROM timeline WHERE project=@project AND proposal=@proposal AND kind='review'
        AND json_extract(body,'$.actor')='Work Board' AND json_extract(body,'$.message')=@managerEvidence
    )) AND (thread = @executor OR thread IN (
      SELECT thread FROM proposal_review_executors WHERE project=@project AND proposal=@proposal
    ))`)
      .get({ reviewer: reviewerId, manager: p.managerId, managerEvidence: executorEvidence(p.managerId),
        executor: additional ?? "", project: p.projectId, proposal: p.id });
  }
  function independent(p: Proposal, identity: ReviewIdentity, additional?: string) {
    const current = links(p.projectId, p.id).map(link => link.taskId).sort();
    requireCondition(JSON.stringify(current) === JSON.stringify(identity.links), "stale_review", "Linked fix cards changed. Refresh the review and try again");
    recordLinkedExecutors(p, identity.executors);
    requireCondition(!conflicts(p, identity.reviewerId, additional), "reviewer_conflict",
      "Choose a reviewer independent of the author, managers and executors");
  }
  function hypothesisApproval(p: Proposal): ReviewRound | null {
    const round = latest(p, "hypothesis");
    return round?.status === "approved" && currentRound(p, round) ? round : null;
  }
  function currentRound(p: Proposal, round: ReviewRound): boolean {
    if (hash(round.snapshot.experiment) !== hash(experiment(p))) return false;
    if (isOpen(p.state) && conflicts(p, round.reviewerId)) return false;
    if (round.snapshot.stage === "hypothesis") return true;
    if (round.snapshot.hypothesisHash !== hash(round.snapshot.experiment)) return false;
    const approval = hypothesisApproval(p);
    return approval ? round.snapshot.hypothesisVersion === approval.version
      : legacy(p) && round.snapshot.hypothesisVersion === null;
  }
  function summary(p: Proposal): ReviewSummary {
    const reviewer = assignment(p);
    const summarize = (stage: ReviewStage) => {
      const round = latest(p, stage);
      if (!round) return null;
      const status = currentRound(p, round) ? round.status : "superseded";
      return { version: round.version, status };
    };
    return { reviewerId: reviewer?.reviewerId ?? null, generation: reviewer?.generation ?? 0,
      legacy: legacy(p), hypothesis: summarize("hypothesis"), result: summarize("result") };
  }
  function audit(p: Proposal, actor: string, message: string) {
    event(p.projectId, p.id, { actor, kind: "review", message });
  }
  function retire(p: Proposal, stage: ReviewStage, pendingOnly = false) {
    const round = latest(p, stage);
    if (round && (round.status === "pending" || !pendingOnly && round.status === "approved")) {
      save({ ...round, status: "superseded" });
    }
  }
  function proposalEdited(previous: Proposal, next: Proposal, actor: string) {
    if (previous.managerId !== next.managerId) {
      participant(next, previous.managerId);
      participant(next, next.managerId);
    }
    if (hash(experiment(previous)) === hash(experiment(next))) return;
    participant(next, actor);
    db.prepare("DELETE FROM proposal_review_legacy WHERE project=? AND proposal=?").run(next.projectId, next.id);
    retire(next, "hypothesis");
    retire(next, "result");
  }
  function submitSnapshot(
    p: Proposal, current: Assignment, actor: string, snapshot: ReviewRound["snapshot"], version: number,
  ) {
    const round = save({ projectId: p.projectId, proposalId: p.id, ...current, version,
      submittedBy: actor, submittedAt: now(), snapshot,
      hash: hash(snapshot.stage === "hypothesis" ? snapshot.experiment : snapshot),
      status: "pending", feedback: null, verdict: null, decidedAt: null, delivery: "queued" });
    audit(p, actor, `${snapshot.stage} review v${version} submitted to ${current.reviewerId}`);
    return round;
  }
  const assign = db.transaction((i: Input<"review.assign">, actor: string, identity: ReviewIdentity) => {
    const p = proposal(i.projectId, i.proposalId, i.revision);
    requireCondition(isOpen(p.state) && p.managerId === actor, "invalid_actor", "Assign the reviewer from the proposal manager thread");
    const previous = assignment(p);
    requireCondition((previous?.generation ?? 0) === i.generation && identity.reviewerId === i.reviewerId,
      "stale_review", "Reviewer assignment changed. Reload the proposal");
    independent(p, identity);
    assertNoSecretsInValue(i.reason, "review assignment");
    const current = { reviewerId: i.reviewerId, generation: i.generation + 1 };
    db.prepare(`INSERT INTO proposal_reviewers VALUES (?,?,?,?) ON CONFLICT(project,proposal)
      DO UPDATE SET reviewer=excluded.reviewer,generation=excluded.generation`).run(p.projectId, p.id, current.reviewerId, current.generation);
    audit(p, actor, `Reviewer assigned: ${current.reviewerId} · ${i.reason}`);
    const currentStage = p.state === "proposed" ? "hypothesis" : "result";
    for (const stage of ["hypothesis", "result"] as const) {
      const round = latest(p, stage);
      if (!round || (round.status !== "pending" && (round.status !== "approved" || stage !== currentStage))) continue;
      retire(p, stage);
      if (currentRound(p, { ...round, reviewerId: current.reviewerId })) submitSnapshot(p, current, actor, round.snapshot, round.version + 1);
    }
    return summary(p);
  });
  const submit = db.transaction((i: Input<"review.submit">, actor: string, identity: ReviewIdentity, hypothesis?: ReviewIdentity) => {
    const p = proposal(i.projectId, i.proposalId, i.revision);
    requireCondition(isOpen(p.state) && p.managerId === actor, "invalid_actor", "Submit a review from the proposal manager thread");
    const current = assignment(p);
    const stage = i.submission.stage;
    const previous = latest(p, stage);
    requireCondition(current?.generation === i.generation && current.reviewerId === identity.reviewerId
      && (previous?.version ?? 0) === i.baseVersion, "stale_review", "Review changed. Reload the proposal");
    independent(p, identity);
    assertNoSecretsInValue(i.submission, "review submission");
    const spec = experiment(p);
    let snapshot: ReviewRound["snapshot"];
    if (i.submission.stage === "hypothesis") {
      if (hypothesisApproval(p) && previous?.reviewerId === current.reviewerId) return previous;
      snapshot = { stage: "hypothesis", experiment: spec };
    } else {
      requireCondition(p.state === "measuring", "invalid_state", "Submit a result during Measuring");
      const approved = hypothesisApproval(p);
      if (approved || !legacy(p)) guard(p, "hypothesis", hypothesis);
      const read = db.prepare(`SELECT seq,at,body FROM timeline WHERE seq=? AND project=? AND proposal=?
        AND kind LIKE 'measurement:%' AND json_extract(body,'$.measurementSpec')=?`);
      const observations = [...i.submission.observationIds].sort((a, b) => a - b).map(seq => {
        const row = read.get(seq, p.projectId, p.id, metricIdentity(p)) as { seq: number; at: number; body: string } | undefined;
        requireCondition(row, "invalid_observation", "Select observations of the current proposal and metric");
        const { observation, unit } = JSON.parse(row.body) as JournalEvent;
        requireCondition(observation, "invalid_observation", "The selected event has no observation");
        return { seq, at: row.at, observation, unit };
      });
      snapshot = { stage: "result", experiment: spec, hypothesisVersion: approved?.version ?? null,
        hypothesisHash: approved?.hash ?? hash(spec), conclusion: i.submission.conclusion, observations };
    }
    if (previous && currentRound(p, previous) && ["approved", "pending"].includes(previous.status)
      && hash(previous.snapshot) === hash(snapshot)) return previous;
    retire(p, stage);
    if (stage === "hypothesis") retire(p, "result");
    return submitSnapshot(p, current, actor, snapshot, i.baseVersion + 1);
  });
  const decide = db.transaction((i: Input<"review.decide">, actor: string, identity: ReviewIdentity, hypothesis?: ReviewIdentity) => {
    const p = proposal(i.projectId, i.proposalId);
    const current = assignment(p);
    const round = latest(p, i.stage);
    requireCondition(isOpen(p.state) && round?.version === i.version && current?.generation === i.generation
      && round.generation === i.generation && round.status === "pending" && currentRound(p, round),
    "stale_review", "The submitted review is no longer pending");
    requireCondition(current.reviewerId === actor && identity.reviewerId === actor,
      "invalid_actor", "Only the assigned reviewer can record a verdict from their thread");
    independent(p, identity);
    if (i.stage === "result" && (hypothesisApproval(p) || !legacy(p))) guard(p, "hypothesis", hypothesis);
    assertNoSecretsInValue(i.feedback, "review feedback");
    audit(p, actor, `${i.stage} review v${i.version} · ${i.verdict.replace("_", " ")}\n${i.feedback}`);
    return save({ ...round, status: i.verdict, verdict: i.verdict, feedback: i.feedback, decidedAt: now() });
  });
  function approval(p: Proposal, stage: ReviewStage) {
    const round = latest(p, stage);
    return round?.status === "approved" && currentRound(p, round) ? round : null;
  }
  function guard(p: Proposal, stage: ReviewStage, identity?: ReviewIdentity, actor?: string) {
    const approved = approval(p, stage);
    requireCondition(approved && identity?.reviewerId === approved.reviewerId && identity.version === approved.version,
      "review_required", `An independent approval of the current ${stage} is required`);
    independent(p, identity, stage === "hypothesis" ? actor : undefined);
  }
  function retireClosed(p: Proposal) {
    retire(p, "hypothesis", true);
    retire(p, "result", true);
  }
  function pending(): Work[] {
    const rows = db.prepare(`SELECT r.body,r.next,r.notice FROM proposal_reviews r JOIN proposals p
      ON p.project=r.project AND p.id=r.proposal
      WHERE p.state IN ('proposed','applied','measuring') AND json_extract(r.body,'$.status')='pending'
        AND (r.notice<3 OR json_extract(r.body,'$.delivery')='queued') ORDER BY r.next`)
      .all() as { body: string; next: number; notice: number }[];
    return rows.map(row => ({ round: JSON.parse(row.body) as ReviewRound, next: row.next, notice: row.notice }));
  }
  function wanted(round: ReviewRound) {
    const p = proposal(round.projectId, round.proposalId);
    const current = latest(p, round.snapshot.stage);
    return isOpen(p.state) && current?.version === round.version && current.status === "pending" && currentRound(p, current);
  }
  function notified(round: ReviewRound, flag: number) {
    db.prepare("UPDATE proposal_reviews SET notice=notice|? WHERE project=? AND proposal=? AND stage=? AND version=?")
      .run(flag, round.projectId, round.proposalId, round.snapshot.stage, round.version);
  }
  function recover() {
    db.prepare(`UPDATE proposal_reviews SET body=json_set(body,'$.delivery','uncertain')
      WHERE json_extract(body,'$.delivery')='sending'`).run();
  }
  return { assign, submit, decide, summary, rounds, assignment, latest, approval, guard, independent, lineage, participant, recordLinkedExecutors,
    proposalEdited, retireClosed, pending, wanted, save, notified, recover };
}
