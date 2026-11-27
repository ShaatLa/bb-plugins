import { createHash, randomUUID } from "node:crypto";
import type { Database } from "better-sqlite3";
import {
  configSchema, isOpen, type BoardLink, type Config, type Entry, type Input, type JournalEvent,
  type Observation, type Proposal, type Run, type State, type Transition,
} from "./contract";
import { assertNoSecretsInValue } from "./secret-guard";
import { cutoff, occurrence } from "./time";

export const versionOne = `
CREATE TABLE config (project TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE entries (project TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project,id));
CREATE TABLE proposals (project TEXT NOT NULL, id TEXT NOT NULL, state TEXT NOT NULL, manager TEXT NOT NULL,
  updated INTEGER NOT NULL, deadline INTEGER NOT NULL, check_at INTEGER, metric_key TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(project,id));
CREATE INDEX proposal_scope ON proposals(project,manager,state,updated);
CREATE INDEX proposal_entry ON proposals(project,json_extract(body,'$.entryId'));
CREATE TABLE timeline (seq INTEGER PRIMARY KEY, project TEXT NOT NULL, proposal TEXT NOT NULL, at INTEGER NOT NULL,
  kind TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX timeline_proposal ON timeline(project,proposal,at);
CREATE TABLE links (project TEXT NOT NULL, proposal TEXT NOT NULL, task TEXT NOT NULL, deadline INTEGER NOT NULL, body TEXT NOT NULL,
  PRIMARY KEY(project,proposal,task));
CREATE UNIQUE INDEX one_deadline ON links(project,proposal) WHERE deadline = 1;
CREATE TABLE effects (id TEXT PRIMARY KEY, project TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL, phase TEXT NOT NULL,
  obligation INTEGER NOT NULL, next INTEGER NOT NULL, status TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0);
CREATE INDEX effects_pending ON effects(status,next);
CREATE TABLE runs (project TEXT NOT NULL, id TEXT NOT NULL, occurrence TEXT NOT NULL, status TEXT NOT NULL,
  body TEXT NOT NULL, PRIMARY KEY(project,id), UNIQUE(project,occurrence));
CREATE TABLE run_scans (project TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE fix_requests (project TEXT NOT NULL, proposal TEXT NOT NULL, request TEXT NOT NULL, board TEXT NOT NULL,
  deadline INTEGER NOT NULL, task TEXT, PRIMARY KEY(project,proposal,request));
`;

type Body = { body: string };
const parse = <T>(row: unknown): T => JSON.parse((row as Body).body) as T;
const json = JSON.stringify;
const openSql = "p.state IN ('proposed','applied','measuring')";
const nextDeadline = `CASE WHEN p.state='measuring' AND p.check_at IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM timeline m WHERE m.project=p.project AND m.proposal=p.id AND m.kind LIKE 'measurement:%'
  AND json_extract(m.body,'$.measurementSpec')=p.metric_key
) THEN p.check_at ELSE p.deadline END`;
export const stableId = (...parts: (string | number)[]) => createHash("sha256").update(json(parts)).digest("hex");
export type EffectKind = "wake" | "metric" | "manual" | "manager" | "ownerAsk" | "ownerNotice" | "run";
export type EffectPhase = "check" | "decision" | "run";
export const effectId = (project: string, subject: string, obligation: number, kind: EffectKind, phase: EffectPhase) =>
  stableId(project, subject, obligation, kind, phase);
export type Effect = {
  id: string; project: string; subject: string; kind: EffectKind; phase: EffectPhase; obligation: number;
  next: number; status: "pending" | "sending" | "sent" | "uncertain" | "failed"; tries: number;
};

export class JournalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
export function requireCondition(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new JournalError(code, message);
}

type EventData = Omit<JournalEvent, "seq" | "at">;

export function createStore(db: Database, now: () => number = Date.now) {
  function config(project: string): Config {
    const row = db.prepare("SELECT body FROM config WHERE project=?").get(project);
    return row ? parse<Config>(row) : configSchema.parse({});
  }
  const configuredProjects = () => (db.prepare("SELECT project, body FROM config ORDER BY project").all() as (Body & { project: string })[])
    .map(row => ({ projectId: row.project, config: parse<Config>(row) }));
  function setConfig(project: string, key: string, value: unknown) {
    assertNoSecretsInValue(value, "configuration");
    const next = configSchema.parse({ ...config(project), [key]: value });
    for (const manager of [next.defaultManager, next.scheduleManager]) {
      requireCondition(!manager || next.managers.includes(manager), "invalid_manager", "Default and scheduled managers must be in Managers");
    }
    requireCondition(!next.enabled || next.defaultManager, "missing_default", "Set a default manager before enabling the journal");
    requireCondition(!next.scheduleEnabled || next.scheduleSkill && (next.scheduleManager || next.defaultManager),
      "missing_schedule", "Set the scheduled skill and a manager before enabling the schedule");
    db.prepare("INSERT INTO config VALUES (?,?) ON CONFLICT(project) DO UPDATE SET body=excluded.body").run(project, json(next));
    if (["enabled", "scheduleEnabled", "scheduleTime", "scheduleCoveredThrough", "timeZone"].includes(key)) {
      db.prepare("DELETE FROM run_scans WHERE project=?").run(project);
    }
    return next[key as keyof Config];
  }
  function entry(project: string, id: string) {
    const row = db.prepare("SELECT body FROM entries WHERE project=? AND id=?").get(project, id);
    requireCondition(row, "entry_missing", "Entry does not exist in this project");
    return parse<Entry>(row);
  }
  function findProposal(project: string, id: string) {
    const row = db.prepare("SELECT body FROM proposals WHERE project=? AND id=?").get(project, id);
    return row ? parse<Proposal>(row) : undefined;
  }
  function proposal(project: string, id: string, revision?: number) {
    const row = findProposal(project, id);
    requireCondition(row, "proposal_missing", "Proposal does not exist in this project");
    requireCondition(revision === undefined || row.revision === revision, "stale_revision", "Proposal changed. Reload it and try again");
    return row;
  }
  const metricIdentity = (p: Proposal) => stableId(p.metric.definition, p.metric.unit ?? "", p.metric.command ?? "");
  function save(p: Proposal) {
    db.prepare(`INSERT INTO proposals VALUES (@projectId,@id,@state,@managerId,@updatedAt,@deadlineAt,@checkAt,@metricKey,@body)
      ON CONFLICT(project,id) DO UPDATE SET state=excluded.state, manager=excluded.manager, updated=excluded.updated,
      deadline=excluded.deadline, check_at=excluded.check_at, metric_key=excluded.metric_key, body=excluded.body`)
      .run({ ...p, metricKey: metricIdentity(p), body: json(p) });
    return p;
  }
  function event(project: string, id: string, data: EventData, at = now()) {
    const row = db.prepare("INSERT INTO timeline(project,proposal,at,kind,body) VALUES (?,?,?,?,?)")
      .run(project, id, at, data.kind, json(data));
    return { ...data, at, seq: Number(row.lastInsertRowid) };
  }
  function events(project: string, id: string, before?: number) {
    const rows = db.prepare(`SELECT seq,at,body FROM timeline WHERE project=? AND proposal=? AND (? IS NULL OR seq<?)
      ORDER BY seq DESC LIMIT 51`).all(project, id, before ?? null, before ?? null) as (Body & { seq: number; at: number })[];
    const page = rows.slice(0, 50);
    return { events: page.map(row => ({ ...parse<EventData>(row), seq: row.seq, at: row.at })),
      nextBefore: rows.length > 50 ? page.at(-1)!.seq : null };
  }
  const linkedProposals = (project: string) => db.prepare(`SELECT DISTINCT p.body FROM proposals p
    JOIN links l ON l.project=p.project AND l.proposal=p.id WHERE p.project=?`).all(project).map(parse<Proposal>);
  const openProposals = (project: string) => db.prepare("SELECT body FROM proposals WHERE project=? AND state IN ('proposed','applied','measuring')")
    .all(project).map(parse<Proposal>);
  function manager(project: string, id?: string) {
    const c = config(project);
    const resolved = id ?? c.defaultManager;
    requireCondition(resolved && c.managers.includes(resolved), "invalid_manager", "Choose a configured manager for this project");
    return resolved;
  }
  function checkFuture(at: number) {
    requireCondition(at > now(), "invalid_deadline", "The deadline must be in the future");
  }
  function addProposal(project: string, entryId: string, data: Input<"proposal.add">["proposal"], actor: string, runId?: string) {
    entry(project, entryId);
    const { key, managerId, ...fields } = data;
    requireCondition(!runId || key, "missing_key", "Provide a stable proposal key for scheduled review submissions");
    const id = key ? stableId(project, entryId, "proposal", runId ?? "", key) : randomUUID();
    if (runId) requireCondition(run(project, runId).managerId === actor, "invalid_actor", "Only the scheduled manager can submit results");
    const prior = findProposal(project, id);
    if (prior) return prior;
    if (runId) ensureActiveRun(project, runId, actor);
    assertNoSecretsInValue(data, "proposal");
    checkFuture(fields.deadlineAt);
    const at = now();
    const p = save({ ...fields, projectId: project, entryId, id, managerId: manager(project, managerId),
      state: "proposed", revision: 1, obligation: 1, checkAt: null, createdAt: at, updatedAt: at });
    event(project, id, { kind: "transition", actor, state: "proposed", deadlineAt: p.deadlineAt, message: "Proposal recorded" }, at);
    return p;
  }
  const insertProposal = db.transaction((input: Input<"proposal.add">, actor: string) =>
    addProposal(input.projectId, input.entryId, input.proposal, actor, input.runId));
  const addEntry = db.transaction((input: Input<"entry.add">, actor: string) => {
    const { projectId: project, key, proposal: first, ...fields } = input;
    requireCondition(!input.runId || key, "missing_key", "Provide a stable entry key for scheduled review submissions");
    const id = key ? stableId(project, "entry", input.runId ?? "", key) : randomUUID();
    if (input.runId) requireCondition(run(project, input.runId).managerId === actor, "invalid_actor", "Only the scheduled manager can submit results");
    const previous = db.prepare("SELECT body FROM entries WHERE project=? AND id=?").get(project, id);
    if (previous) {
      const created = db.prepare(`SELECT body FROM proposals WHERE project=? AND json_extract(body,'$.entryId')=?
        ORDER BY updated,id LIMIT 1`).get(project, id);
      return { entry: parse<Entry>(previous), proposal: created ? parse<Proposal>(created) : null };
    }
    if (input.runId) ensureActiveRun(project, input.runId, actor);
    assertNoSecretsInValue(input, "entry");
    const e = { ...fields, id, projectId: project, createdAt: now(), createdBy: actor };
    db.prepare("INSERT INTO entries VALUES (?,?,?)").run(project, id, json(e));
    return { entry: e, proposal: first ? addProposal(project, id, { ...first, key: first.key ?? "first" }, actor, input.runId) : null };
  });
  const update = db.transaction((i: Input<"proposal.update">, actor: string) => {
    const p = proposal(i.projectId, i.proposalId, i.revision);
    const patch = i.patch;
    requireCondition(isOpen(p.state), "closed", "Closed proposals are read-only");
    assertNoSecretsInValue(patch, "proposal");
    if (patch.deadlineAt !== undefined) checkFuture(patch.deadlineAt);
    if (patch.checkAt !== undefined) {
      requireCondition(p.state === "measuring", "invalid_state", "Enter Measuring before setting a check date");
      checkFuture(patch.checkAt);
    }
    const next = { ...p, ...patch };
    requireCondition(next.checkAt === null || next.checkAt < next.deadlineAt, "invalid_deadline", "Check must be before the decision deadline");
    if (patch.managerId !== undefined) manager(p.projectId, patch.managerId);
    const changed = Object.keys(patch).filter(key => json(p[key as keyof Proposal]) !== json(next[key as keyof Proposal]));
    if (!changed.length) return p;
    const obligationChanged = ["managerId", "deadlineAt", "checkAt", "metric"].some(key => changed.includes(key));
    if (obligationChanged) next.obligation++;
    if (changed.includes("managerId")) event(p.projectId, p.id, { kind: "reassigned", actor, message: `Reassigned from ${p.managerId} to ${next.managerId}` });
    const other = changed.filter(key => key !== "managerId");
    if (other.length) {
      const deadlines = other.filter(key => key === "checkAt" || key === "deadlineAt")
        .map(key => `${key === "checkAt" ? "Check" : "Deadline"}: ${p[key] === null ? "unset" : new Date(p[key]).toISOString()} → ${new Date(next[key]!).toISOString()}`);
      event(p.projectId, p.id, { kind: "updated", actor, message: [`Updated ${other.join(", ")}`, ...deadlines].join("\n") });
    }
    return save({ ...next, revision: p.revision + 1, updatedAt: now() });
  });
  function measured(project: string, id: string) {
    const p = proposal(project, id);
    return Boolean(db.prepare(`SELECT 1 FROM timeline WHERE project=? AND proposal=? AND kind LIKE 'measurement:%'
      AND json_extract(body,'$.measurementSpec')=? LIMIT 1`).get(project, id, metricIdentity(p)));
  }
  function changeState(p: Proposal, transition: Transition, actor: string) {
    assertNoSecretsInValue(transition, "decision");
    const { state, reason } = transition;
    const allowed: Record<State, State[]> = {
      proposed: ["applied", "withdrawn"], applied: ["measuring", "withdrawn"],
      measuring: ["kept", "reverted", "withdrawn"], kept: [], reverted: [], withdrawn: [],
    };
    const emergency = state === "reverted" && transition.override === true && (p.state === "applied" || p.state === "measuring");
    requireCondition(allowed[p.state].includes(state) || emergency, "invalid_transition", `Cannot move ${p.state} to ${state}`);
    if ((state === "kept" || state === "reverted") && !emergency) {
      requireCondition(measured(p.projectId, p.id), "no_measurement", "Record a measurement before deciding");
    }
    const at = now();
    const deadlineAt = "deadlineAt" in transition ? transition.deadlineAt : at;
    const checkAt = "checkAt" in transition ? transition.checkAt : null;
    if (isOpen(state)) checkFuture(deadlineAt);
    if (checkAt !== null) {
      checkFuture(checkAt);
      requireCondition(checkAt < deadlineAt, "invalid_deadline", "Check must be before the decision deadline");
    }
    event(p.projectId, p.id, { kind: "transition", state, actor, deadlineAt, checkAt,
      message: emergency ? `Urgent rollback decision: ${reason}` : reason }, at);
    return save({ ...p, state, deadlineAt, checkAt, updatedAt: at, revision: p.revision + 1, obligation: p.obligation + 1 });
  }
  const transition = db.transaction((i: Input<"proposal.transition">, actor: string) =>
    changeState(proposal(i.projectId, i.proposalId, i.revision), i.transition, actor));
  function recordMeasurement(p: Proposal, observation: Observation, actor: string, source: "manual" | "script") {
    requireCondition(p.state === "measuring", "invalid_state", "Measurements require a proposal in Measuring");
    assertNoSecretsInValue(observation, "measurement");
    event(p.projectId, p.id, { kind: `measurement:${source}`, actor, message: source === "manual" ? "Manual observation" : "Metric command observation",
      observation, unit: p.metric.unit, measurementSpec: metricIdentity(p) });
    return save({ ...p, revision: p.revision + 1, updatedAt: now() });
  }
  const measure = db.transaction((i: Input<"proposal.measure">, actor: string) =>
    recordMeasurement(proposal(i.projectId, i.proposalId, i.revision), i.observation, actor, "manual"));
  const comment = db.transaction((project: string, id: string, actor: string, kind: "comment" | "rollback", text: string) => {
    const p = proposal(project, id);
    requireCondition(kind !== "rollback" || p.state === "reverted", "invalid_state", "Rollback evidence requires a reverted proposal");
    assertNoSecretsInValue(text, kind);
    return event(project, id, { kind, actor, message: text });
  });
  function listEntries(i: Input<"entry.list">) {
    const rows = db.prepare(`SELECT e.body FROM entries e WHERE e.project=? AND
      (?=0 OR NOT EXISTS(SELECT 1 FROM proposals p WHERE p.project=e.project AND json_extract(p.body,'$.entryId')=e.id))
      ORDER BY json_extract(e.body,'$.createdAt') DESC,e.id LIMIT ? OFFSET ?`)
      .all(i.projectId, Number(Boolean(i.unproposed)), i.limit + 1, i.offset).map(parse<Entry>);
    return { items: rows.slice(0, i.limit), nextOffset: rows.length > i.limit ? i.offset + i.limit : null };
  }
  function list(i: Input<"list">) {
    const c = config(i.projectId);
    const at = now();
    const after = cutoff(at, c.timeZone, i.range);
    const clauses = ["p.project=@projectId"];
    if (i.managerId) clauses.push("p.manager=@managerId");
    if (i.state) clauses.push("p.state=@state");
    if (i.view === "board" || i.overdue) clauses.push(openSql);
    if (i.overdue) clauses.push(`(${nextDeadline})<=@at`);
    if (i.view === "history") clauses.push("EXISTS(SELECT 1 FROM timeline t WHERE t.project=p.project AND t.proposal=p.id AND t.kind='transition' AND t.at>=@after)");
    const order = i.overdue ? "nextAt,p.id" : "p.updated DESC,p.id";
    const rows = db.prepare(`SELECT p.body, e.body AS entry, ${nextDeadline} AS nextAt FROM proposals p JOIN entries e
      ON e.project=p.project AND e.id=json_extract(p.body,'$.entryId') WHERE ${clauses.join(" AND ")}
      ORDER BY ${order} LIMIT @page OFFSET @offset`).all({ ...i, at, after, page: i.limit + 1 }) as (Body & { entry: string; nextAt: number })[];
    return { timeZone: c.timeZone, items: rows.slice(0, i.limit).map(row => {
      const proposal = parse<Proposal>(row);
      return { proposal, entry: JSON.parse(row.entry) as Entry, nextAt: row.nextAt,
        overdue: isOpen(proposal.state) && row.nextAt <= at };
    }), nextOffset: rows.length > i.limit ? i.offset + i.limit : null };
  }
  function digest(project: string, managerId?: string) {
    const at = now(), after = cutoff(at, config(project).timeZone, "week");
    const scope = "p.project=@project AND (@manager IS NULL OR p.manager=@manager)";
    const args = { project, manager: managerId ?? null, at, after };
    const rows = db.prepare(`SELECT json_extract(t.body,'$.state') AS state, count(*) AS count FROM timeline t
      JOIN proposals p ON p.project=t.project AND p.id=t.proposal WHERE ${scope} AND t.kind='transition' AND t.at>=@after
      GROUP BY state`).all(args) as { state: State; count: number }[];
    const overdue = db.prepare(`SELECT count(*) AS total FROM proposals p WHERE ${scope} AND (${nextDeadline})<=@at
      AND ${openSql}`).get(args) as { total: number };
    const count = (state: State) => rows.find(row => row.state === state)?.count ?? 0;
    return { applied: count("applied"), kept: count("kept"), reverted: count("reverted"), overdue: overdue.total };
  }
  const links = (project: string, id: string) => db.prepare("SELECT body FROM links WHERE project=? AND proposal=? ORDER BY task").all(project, id).map(parse<BoardLink>);
  function saveLink(p: Proposal, link: BoardLink) {
    db.prepare(`INSERT INTO links VALUES (?,?,?,?,?) ON CONFLICT(project,proposal,task)
      DO UPDATE SET deadline=excluded.deadline,body=excluded.body`).run(p.projectId, p.id, link.taskId, Number(link.deadlineSource), json(link));
    return link;
  }
  function adjustCheck(snapshot: Proposal, at: number | null, actor: string) {
    const p = proposal(snapshot.projectId, snapshot.id);
    requireCondition(p.obligation === snapshot.obligation, "stale_revision", "Check obligation changed. Reload it and try again");
    if (at === p.checkAt) return p;
    requireCondition(p.state === "measuring" && at !== null && at < p.deadlineAt, "invalid_deadline",
      "The card date must be before the decision deadline and a check must have a date");
    event(p.projectId, p.id, { kind: "work-board", actor, message: `Check moved to ${new Date(at).toISOString()}` });
    return save({ ...p, checkAt: at, revision: p.revision + 1, obligation: p.obligation + 1, updatedAt: now() });
  }
  function queue(project: string, subject: string, obligation: number, kind: EffectKind, at: number, phase: EffectPhase) {
    const id = effectId(project, subject, obligation, kind, phase);
    const inserted = db.prepare("INSERT OR IGNORE INTO effects VALUES (?,?,?,?,?,?,?,'pending',0)")
      .run(id, project, subject, kind, phase, obligation, at).changes;
    return { id, inserted };
  }
  const pending = (at: number) => db.prepare("SELECT effects.* FROM effects JOIN config USING(project) WHERE status='pending' AND next<=? AND json_extract(config.body,'$.enabled')=1 ORDER BY next,id LIMIT 100").all(at) as Effect[];
  const inFlight = () => db.prepare("SELECT * FROM effects WHERE status='sending'").all() as Effect[];
  const effect = (id: string) => db.prepare("SELECT * FROM effects WHERE id=?").get(id) as Effect | undefined;
  const claim = (id: string) => db.prepare("UPDATE effects SET status='sending',tries=tries+1 WHERE id=? AND status='pending'").run(id).changes === 1;
  const settle = (id: string, status: Effect["status"], next = now()) =>
    db.prepare("UPDATE effects SET status=?,next=? WHERE id=? AND status='sending'").run(status, next, id);
  const ack = db.transaction((i: Input<"proposal.ack">, actor: string) => {
    const p = proposal(i.projectId, i.proposalId);
    const item = effect(i.effectId);
    requireCondition(item?.kind === "ownerAsk" && item.project === p.projectId && item.subject === p.id && item.obligation === p.obligation
      && isOpen(p.state) && (item.phase !== "check" || !measured(p.projectId, p.id)),
      "effect_stale", "Owner request is obsolete or unknown");
    requireCondition(actor === p.managerId, "invalid_actor", "Only the responsible manager can acknowledge this request");
    const old = db.prepare("SELECT seq,at,body FROM timeline WHERE project=? AND proposal=? AND kind=?")
      .get(p.projectId, p.id, `owner-ack:${item.id}`) as (Body & { at: number; seq: number }) | undefined;
    return old ? { ...parse<EventData>(old), at: old.at, seq: old.seq }
      : event(p.projectId, p.id, { kind: `owner-ack:${item.id}`, actor, message: `Agent Hub question ${i.questionId} recorded` });
  });
  const acknowledged = (p: Proposal, id: string) => Boolean(db.prepare("SELECT 1 FROM timeline WHERE project=? AND proposal=? AND kind=?")
    .get(p.projectId, p.id, `owner-ack:${id}`));
  function run(project: string, id: string) {
    const row = db.prepare("SELECT body FROM runs WHERE project=? AND id=?").get(project, id);
    requireCondition(row, "run_missing", "Scheduled run does not exist in this project");
    return parse<Run>(row);
  }
  function ensureActiveRun(project: string, id: string, actor: string) {
    const r = run(project, id);
    requireCondition(r.status !== "completed" && r.status !== "failed", "run_finished", "Scheduled run is finished");
    requireCondition(r.managerId === actor, "invalid_actor", "Only the scheduled manager can submit results");
    return r;
  }
  function saveRun(r: Run) {
    db.prepare(`INSERT INTO runs VALUES (?,?,?,?,?) ON CONFLICT(project,id)
      DO UPDATE SET status=excluded.status,body=excluded.body`).run(r.projectId, r.id, r.occurrence, r.status, json(r));
    return r;
  }
  const stageRun = db.transaction((project: string, occurrence: string, managerId: string, skill: string) => {
    const busy = db.prepare("SELECT 1 FROM runs WHERE project=? AND (occurrence=? OR status IN ('pending','sent','uncertain'))").get(project, occurrence);
    if (busy) return;
    const id = stableId(project, "review", occurrence);
    const at = now();
    saveRun({ id, projectId: project, occurrence, managerId, skill, createdAt: at, status: "pending", finishedAt: null, note: null });
    queue(project, id, 1, "run", at, "run");
  });
  const finishRun = db.transaction((i: Input<"run.finish">, actor: string) => {
    const r = run(i.projectId, i.runId);
    requireCondition(r.managerId === actor || actor === "Local operator", "invalid_actor", "Finish the run from its manager thread or the local CLI");
    if (r.status === i.status) return r;
    requireCondition(r.status !== "completed" && r.status !== "failed", "run_finished", "Scheduled run already has an outcome");
    assertNoSecretsInValue(i.note, "run note");
    return saveRun({ ...r, finishedAt: now(), status: i.status, note: i.note ?? null });
  });
  function listRuns(i: Input<"run.list">) {
    const rows = db.prepare(`SELECT body FROM runs WHERE project=? AND (? IS NULL OR json_extract(body,'$.managerId')=?)
      ORDER BY occurrence DESC LIMIT ? OFFSET ?`)
      .all(i.projectId, i.managerId ?? null, i.managerId ?? null, i.limit + 1, i.offset).map(parse<Run>);
    const eligible = occurrence(now(), config(i.projectId));
    return {
      items: rows.slice(0, i.limit).map(row => ({
        ...row, delayed: ["pending", "sent", "uncertain"].includes(row.status) && row.occurrence < eligible,
      })),
      nextOffset: rows.length > i.limit ? i.offset + i.limit : null,
    };
  }
  function scanSchedule(project: string, at: number, interval: number) {
    const row = db.prepare("SELECT at FROM run_scans WHERE project=?").get(project) as { at: number } | undefined;
    if (row && at - row.at < interval) return false;
    db.prepare("INSERT INTO run_scans VALUES (?,?) ON CONFLICT(project) DO UPDATE SET at=excluded.at").run(project, at);
    return true;
  }
  return {
    db, now, config, configuredProjects, setConfig, entry, findProposal, proposal, openProposals, linkedProposals, addEntry, insertProposal,
    update, changeState, transition, measure, recordMeasurement, comment, measured, event, events, list, listEntries, digest,
    links, saveLink, adjustCheck, queue, pending, inFlight, effect, claim, settle, ack, acknowledged,
    run, saveRun, stageRun, finishRun, listRuns, scanSchedule,
  };
}
export type Store = ReturnType<typeof createStore>;
