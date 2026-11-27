import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { getWorkflowPolicy } from "../shared/workflow-policy";
import { endedManualSpans, fillCoverage, pauseArm } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR;
type Interval = { start: number; end: number };
type Sample = { at: string; task_id: string; arm: "control" | "auto"; status: string; in_scope: number; held: number; waiting_owner: number; paused: number; worked: number };
type Notice = { task_id: string; occurrence_id: string; signal: string; accepted_at: string; cleared_at: string | null; first_seen_at: string; recipient_thread_id: string };
type OwnerReport = { cards: number; cardDays: number; notices: number; actions: number };
type ArmReport = { owner: OwnerReport; cardDays: number; notices: number; noiseRate: number | null; unnecessary: number; matureNotices: number; censoredNotices: number; unnecessaryShare: number | null; episodes: number; misses: number; unknownEpisodes: number; censoredEpisodes: number; totalUnflaggedMs: number; longestUnflaggedMs: number; executor: Record<string, number>; closedBeforeManager: number; controlBackgroundNotices: number };
const empty = (): ArmReport => ({ owner: { cards: 0, cardDays: 0, notices: 0, actions: 0 }, cardDays: 0, notices: 0, noiseRate: null, unnecessary: 0, matureNotices: 0, censoredNotices: 0, unnecessaryShare: null, episodes: 0, misses: 0, unknownEpisodes: 0, censoredEpisodes: 0, totalUnflaggedMs: 0, longestUnflaggedMs: 0, executor: {}, closedBeforeManager: 0, controlBackgroundNotices: 0 });
const ms = (value: string) => Date.parse(value);
const overlap = (a: Interval, b: Interval) => Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
const within = (at: number, intervals: Interval[]) => intervals.some(i => at >= i.start && at < i.end);
const clipped = (interval: Interval, window: Interval): Interval | null => { const start = Math.max(interval.start, window.start), end = Math.min(interval.end, window.end); return start < end ? { start, end } : null; };

/**
 * The time of a manual pause beyond eight hours of continuous manual coverage, per card: after that a wait is deliberate, never an
 * abandonment, so the report treats it as out of scope. Coverage chains Extends and re-pauses at most five minutes apart. A pause
 * carries its own start and coverage start (on its end row, or on its live row), so an old or pruned log row is never needed. A pause
 * counts until its deadline at the latest, however late the sweep ended it. Rows
 * written before those columns existed are paired and merged the v1 way.
 */
function manualExcess(db: Database, projectId: string, nowMs: number): Map<string, Interval[]> {
  const items = endedManualSpans(db, { projectId });
  for (const row of db.prepare<[string], { task_id: string; started_at: string; until: string | null; coverage_started_at: string | null }>("SELECT x.task_id,x.started_at,x.until,x.coverage_started_at FROM task_pauses x JOIN tasks t ON t.id=x.task_id WHERE t.project_id=? AND x.signal='manual' AND x.applied=1").all(projectId)) {
    const span = { start: ms(row.started_at), end: Math.min(nowMs, row.until ? ms(row.until) : Infinity), coverage: row.coverage_started_at ? ms(row.coverage_started_at) : null };
    if (Number.isFinite(span.start) && Number.isFinite(span.end)) (items.get(row.task_id) ?? items.set(row.task_id, []).get(row.task_id)!).push(span);
  }
  const result = new Map<string, Interval[]>();
  for (const [taskId, list] of items) {
    list.sort((a, b) => a.start - b.start);
    fillCoverage(list);
    for (const item of list) {
      const range = { start: Math.max(item.start, item.coverage! + 8 * HOUR), end: item.end };
      if (range.start < range.end) (result.get(taskId) ?? result.set(taskId, []).get(taskId)!).push(range);
    }
  }
  return result;
}

/** Report uses raw samples and occurrence deliveries, never pause events as evidence of work. */
export function pauseReport(db: Database, projectId: string, since?: string, until?: string, nowMs = Date.now()) {
  const project = db.prepare<[string], { workflow_policy: string | null; statuses: string | null }>("SELECT workflow_policy,statuses FROM projects WHERE id=?").get(projectId);
  if (!project) throw new Error("Project not found");
  const events = db.prepare<[string], { at: string; detail: string }>("SELECT at,detail FROM pause_log WHERE project_id=? AND event='mode' ORDER BY at,id").all(projectId);
  const ab: Interval[] = [];
  let opened: number | null = null;
  for (const event of events) {
    const mode = (JSON.parse(event.detail) as { mode: string }).mode;
    const at = ms(event.at);
    if (mode === "ab" && opened === null) opened = at;
    else if (mode !== "ab" && opened !== null) { ab.push({ start: opened, end: at }); opened = null; }
  }
  if (opened !== null) ab.push({ start: opened, end: nowMs });
  const latest = ab.at(-1);
  if (!latest) throw new Error("No A/B interval exists for this project");
  const start = since ? ms(since) : latest.start, end = until ? ms(until) : latest.end;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end > nowMs) throw new Error("Invalid report window");
  if (start < nowMs - 30 * DAY) throw new Error("Report window exceeds the 30-day sample retention");
  const window = { start, end };
  const periods = ab.map(i => clipped(i, window)).filter((i): i is Interval => i !== null);
  const abMs = periods.reduce((sum, p) => sum + p.end - p.start, 0);
  const retainedSince = new Date(nowMs - 30 * DAY).toISOString();
  const runs = db.prepare<[string, string, string], { at: string }>("SELECT at FROM pause_sample_runs WHERE project_id=? AND at>=? AND at<? ORDER BY at").all(projectId, retainedSince, new Date(end).toISOString()).map(row => ms(row.at));
  const intervals = runs.map((at, i) => ({ start: at, end: Math.min(runs[i + 1] ?? Infinity, at + 10 * MINUTE) }));
  const sampledMs = periods.reduce((sum, p) => sum + intervals.reduce((n, i) => n + overlap(p, i), 0), 0);
  const unsampledMs = Math.max(0, abMs - sampledMs);
  const samples = db.prepare<[string, string, string], Sample>("SELECT * FROM pause_samples WHERE project_id=? AND at>=? AND at<? ORDER BY at,task_id").all(projectId, retainedSince, new Date(end).toISOString());
  const byRun = new Map(runs.map((at, i) => [at, intervals[i]!]));
  const arms = { control: empty(), auto: empty() };
  const excess = manualExcess(db, projectId, nowMs);
  const excluded = (taskId: string, at: number) => within(at, excess.get(taskId) ?? []);
  // The trial judges automatic pauses on their own: from a card's first owner pause action (T) on, the card leaves both arms'
  // keep metrics. The lookback starts with the A/B interval holding the window start, so moving the start cannot re-include it.
  const lookback = (ab.find(i => i.start <= start && start < i.end) ?? ab.find(i => i.start >= start && i.start < end))?.start ?? start;
  const ownerRows = db.prepare<[string, string, string], { task_id: string; at: string }>("SELECT task_id,at FROM pause_log WHERE project_id=? AND thread_id='owner' AND event IN ('start','end') AND task_id IS NOT NULL AND at>=? AND at<? ORDER BY at,id").all(projectId, new Date(lookback).toISOString(), new Date(end).toISOString());
  const touchedAt = new Map<string, number>();
  for (const row of ownerRows) {
    if (!touchedAt.has(row.task_id)) touchedAt.set(row.task_id, Math.max(ms(row.at), start));
    if (ms(row.at) >= start) arms[pauseArm(row.task_id)].owner.actions++;
  }
  for (const taskId of touchedAt.keys()) arms[pauseArm(taskId)].owner.cards++;
  for (const sample of samples) {
    if (!sample.in_scope || excluded(sample.task_id, ms(sample.at))) continue;
    const interval = byRun.get(ms(sample.at));
    if (!interval) continue;
    const t = touchedAt.get(sample.task_id) ?? Infinity;
    const kept = { start: interval.start, end: Math.min(interval.end, t) }, owned = { start: Math.max(interval.start, t), end: interval.end };
    arms[sample.arm].cardDays += periods.reduce((sum, p) => sum + overlap(kept, p), 0) / DAY;
    arms[sample.arm].owner.cardDays += periods.reduce((sum, p) => sum + overlap(owned, p), 0) / DAY;
  }
  const notices = db.prepare<[string], Notice>(`SELECT o.task_id,o.id AS occurrence_id,o.signal,a.accepted_at,o.cleared_at,o.first_seen_at,a.recipient_thread_id FROM attention_attempt_items i JOIN attention_attempts a ON a.attempt_id=i.attempt_id JOIN manager_attention o ON o.id=i.occurrence_id WHERE a.tracker_id=? AND a.outcome IN ('appended','queued','inline') AND a.accepted_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM attention_withdrawals w WHERE w.attempt_id=i.attempt_id AND w.occurrence_id=i.occurrence_id)`).all(projectId);
  for (const n of notices) {
    const at = ms(n.accepted_at);
    if (!within(at, periods)) continue;
    const arm = pauseArm(n.task_id), report = arms[arm];
    const t = touchedAt.get(n.task_id) ?? Infinity;
    if (at >= t) { report.owner.notices++; continue; }
    report.notices++;
    if (arm === "control") {
      const signal = db.prepare<[string, string, string], { found: number }>(`SELECT 1 AS found FROM pause_log s WHERE s.task_id=? AND s.signal='background' AND s.event='start' AND s.at<=? AND NOT EXISTS (SELECT 1 FROM pause_log e WHERE e.task_id=s.task_id AND e.signal=s.signal AND e.signal_thread_id=s.signal_thread_id AND e.event='end' AND e.id>s.id AND e.at<=?) LIMIT 1`).get(n.task_id, n.accepted_at, n.accepted_at);
      if (signal) report.controlBackgroundNotices++;
    }
    const period = periods.find(p => at >= p.start && at < p.end)!;
    if (at + 30 * MINUTE > Math.min(period.end, t)) { report.censoredNotices++; continue; }
    report.matureNotices++;
    const status = samples.filter(s => s.task_id === n.task_id && ms(s.at) <= at).at(-1)?.status;
    const changed = samples.some(s => s.task_id === n.task_id && ms(s.at) > at && ms(s.at) <= at + 30 * MINUTE && status !== undefined && s.status !== status);
    const cleared = n.cleared_at !== null && ms(n.cleared_at) >= at && ms(n.cleared_at) <= at + 30 * MINUTE;
    const recipientWrite = db.prepare<[string, string, string, string, string], { found: number }>("SELECT 1 AS found FROM comments WHERE task_id=? AND created_at>=? AND created_at<=? AND (thread_id=? OR (kind='system' AND instr(body,?)>0)) LIMIT 1").get(n.task_id, n.accepted_at, new Date(at + 30 * MINUTE).toISOString(), n.recipient_thread_id, n.recipient_thread_id);
    if ((changed || cleared) && !recipientWrite) report.unnecessary++;
  }
  const policy = getWorkflowPolicy({ workflowPolicy: project.workflow_policy ? JSON.parse(project.workflow_policy) : null });
  const cardIds = [...new Set(samples.map(s => s.task_id))];
  for (const taskId of cardIds) {
    const touched = touchedAt.get(taskId) ?? Infinity;
    const rows = samples.filter(s => s.task_id === taskId && ms(s.at) < touched);
    let lastWork: number | null = null, entry: number | null = null, episodeStart: number | null = null, unknown = false;
    const finish = (episodeEnd: number, ownerCut = false) => {
      if (episodeStart === null) return;
      // An episode still open when the owner acted is cut there: censored, never a miss.
      if (ownerCut) {
        // T clamped to the window start can leave nothing of the episode inside the A/B periods: then there is no episode.
        if (!periods.some(p => episodeStart! < Math.min(p.end, episodeEnd) && episodeEnd > p.start)) { episodeStart = null; return; }
        const report = arms[pauseArm(taskId)];
        report.episodes++; report.censoredEpisodes++;
        // Its unflagged time up to the action still counts: until the first standing or later notice, inside the A/B periods.
        const flagged = notices.filter(n => n.task_id === taskId && (ms(n.accepted_at) > episodeStart! || n.cleared_at === null || ms(n.cleared_at) > episodeStart!))
          .map(n => Math.max(ms(n.accepted_at), episodeStart!)).sort((x, y) => x - y)[0];
        const elapsed = periods.reduce((sum, p) => sum + overlap({ start: episodeStart!, end: Math.min(episodeEnd, flagged ?? Infinity) }, p), 0);
        report.totalUnflaggedMs += elapsed; report.longestUnflaggedMs = Math.max(report.longestUnflaggedMs, elapsed);
        episodeStart = null; return;
      }
      if (episodeEnd <= episodeStart) { episodeStart = null; return; }
      const period = periods.find(p => episodeStart! < p.end && episodeEnd > p.start);
      if (!period) { episodeStart = null; return; }
      const visibleStart = Math.max(episodeStart, period.start);
      const report = arms[pauseArm(taskId)];
      report.episodes++;
      if (unknown) report.unknownEpisodes++;
      else if (episodeStart + HOUR > Math.min(period.end, touched)) report.censoredEpisodes++;
      else {
        const relevant = notices.filter(n => n.task_id === taskId && ((ms(n.accepted_at) <= episodeStart! && (n.cleared_at === null || ms(n.cleared_at) > episodeStart!)) || ms(n.accepted_at) >= episodeStart!));
        const standing = relevant.some(n => ms(n.accepted_at) <= episodeStart!);
        const subsequent = relevant.filter(n => ms(n.accepted_at) >= episodeStart! && ms(n.accepted_at) < episodeEnd).map(n => ms(n.accepted_at)).sort((a,b) => a-b)[0];
        if (!standing && (subsequent === undefined || subsequent > episodeStart + HOUR)) {
          const elapsed = Math.max(0, Math.min(episodeEnd, subsequent ?? Infinity, period.end, touched) - visibleStart);
          report.misses++; report.totalUnflaggedMs += elapsed; report.longestUnflaggedMs = Math.max(report.longestUnflaggedMs, elapsed);
        }
      }
      episodeStart = null;
    };
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, at = ms(row.at), interval = byRun.get(at)!;
      const population = !!row.in_scope && !row.held && !row.waiting_owner && row.status === policy.inProgressStatus && !excluded(taskId, at);
      if (!population) { finish(at); lastWork = null; entry = null; unknown = false; continue; }
      if (entry === null) { entry = at; lastWork = at; unknown = at > start - 8 * HOUR; }
      if (row.worked) { finish(at); lastWork = at; unknown = false; }
      if (episodeStart === null && lastWork !== null && lastWork + 8 * HOUR < interval.end) episodeStart = lastWork + 8 * HOUR;
      const next = rows[i + 1] ? ms(rows[i + 1]!.at) : Math.min(end, touched);
      if (next > interval.end) {
        const followingRun = runs.find(run => run > at);
        if (followingRun === undefined || followingRun > interval.end) {
          unknown = true;
        } else {
          finish(interval.end); lastWork = null; entry = null; unknown = false;
        }
      }
    }
    if (touched < end) finish(touched, true); else finish(end);
  }
  for (const arm of Object.values(arms)) { arm.noiseRate = arm.cardDays ? arm.notices / arm.cardDays : null; arm.unnecessaryShare = arm.matureNotices ? arm.unnecessary / arm.matureNotices : null; }
  const occurrences = db.prepare<[string, string, string], { id: string; task_id: string; first_seen_at: string; executor_state: string | null; executor_at: string | null; cleared_at: string | null }>("SELECT id,task_id,first_seen_at,executor_state,executor_at,cleared_at FROM manager_attention WHERE tracker_id=? AND first_seen_at>=? AND first_seen_at<?").all(projectId, new Date(start).toISOString(), new Date(end).toISOString());
  for (const row of occurrences) {
    if (!row.executor_state || !within(ms(row.first_seen_at), periods)) continue;
    const arm = arms[pauseArm(row.task_id)];
    arm.executor[row.executor_state] = (arm.executor[row.executor_state] ?? 0) + 1;
    if (row.cleared_at && !notices.some(n => n.occurrence_id === row.id)) arm.closedBeforeManager++;
  }
  const diagnosticRows = db.prepare<[string, string, string], { at: string; event: string; signal: string | null; end_reason: string | null; applied: number | null; thread_id: string | null }>("SELECT at,event,signal,end_reason,applied,thread_id FROM pause_log WHERE project_id=? AND at>=? AND at<? AND event IN ('start','end')").all(projectId, new Date(start).toISOString(), new Date(end).toISOString()).filter(row => within(ms(row.at), periods));
  const diagnostics: Record<string, number> = {};
  for (const row of diagnosticRows) { const key = `${row.thread_id === 'owner' ? 'owner:' : ''}${row.event}:${row.signal ?? '-'}:${row.end_reason ?? '-'}`; diagnostics[key] = (diagnostics[key] ?? 0) + 1; }
  for (const arm of ["control", "auto"] as const) diagnostics[`manualBeyond8h:${arm}`] = 0;
  for (const [taskId, ranges] of excess) for (const range of ranges) { const part = clipped(range, window); if (part) diagnostics[`manualBeyond8h:${pauseArm(taskId)}`]! += part.end - part.start; }
  let verdict: string;
  if (abMs < 7 * DAY) verdict = "extend: under 7 days";
  else if (unsampledMs > abMs * 0.1) verdict = "extend: incomplete sampling";
  else if ([arms.control, arms.auto].some(arm => arm.owner.cardDays > 0.1 * (arm.cardDays + arm.owner.cardDays))) verdict = "extend: owner actions cover too much card time";
  else if (arms.control.notices < 20 || arms.control.noiseRate === null || arms.auto.noiseRate === null) verdict = "extend: not enough data";
  else if (arms.auto.noiseRate <= 0.6 * arms.control.noiseRate && arms.auto.misses <= arms.control.misses + 1 && arms.auto.longestUnflaggedMs <= 8 * HOUR) verdict = "keep";
  else verdict = "switch off";
  // The owner overruling an automatic pause in the treatment arm: the signal the trial is about.
  const ownerOverruledAuto = db.prepare<[string, string, string], { n: number }>("SELECT COUNT(*) AS n FROM pause_log WHERE project_id=? AND event='end' AND thread_id='owner' AND source='auto' AND signal='background' AND arm='auto' AND end_reason IN ('resume','replaced') AND at>=? AND at<?").get(projectId, new Date(start).toISOString(), new Date(end).toISOString())!.n;
  return { projectId, ownerOverruledAuto, window: { since: new Date(start).toISOString(), until: new Date(end).toISOString(), abMs, outsideAbMs: end - start - abMs, unsampledMs }, arms, diagnostics, verdict, thresholds: { minimumAbMs: 7 * DAY, maxUnsampledShare: 0.1, minimumControlNotices: 20, maxAutoNoiseRatio: 0.6, maxAdditionalMisses: 1, maxUnflaggedMs: 8 * HOUR, maxOwnerShare: 0.1 }, limitations: "Only In Progress is included in abandonment; direct messages to executors are invisible when judging unnecessary notices; an owner pause action leaves its card out of the keep metrics from then on, but only actions since the start of the A/B interval holding the window start count." };
}
