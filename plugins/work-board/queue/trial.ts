import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { isClosedStatus } from "../shared/workflow-policy";
import { effectiveArm, queueArm, queueMode, zoneOf, type QueueArm, type QueueMode } from "./store";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
const MINUTE = 60_000, DAY = 86_400_000;
/** One scan stands for at most this much time; a longer gap is a gap in coverage. */
export const COVERAGE_CAP_MS = 30 * MINUTE;
const WINDOW_MS = 7 * DAY;
const iso = (ms: number) => new Date(ms).toISOString();
const dayOf = (ms: number) => iso(ms).slice(0, 10);

interface ModeChange { at: number; before: QueueMode; after: QueueMode }
function modeChanges(db: Database, projectId: string): ModeChange[] {
  return db.prepare<[string], { at: string; cause: string }>("SELECT at, cause FROM task_queue_log WHERE project_id=? AND action='mode' ORDER BY id").all(projectId).map((row) => {
    const [before, after] = row.cause.split("->") as [QueueMode, QueueMode];
    return { at: Date.parse(row.at), before, after };
  });
}
function modeAt(changes: readonly ModeChange[], at: number): QueueMode {
  if (!changes.length) return "trial";
  if (at < changes[0]!.at) return changes[0]!.before;
  return [...changes].reverse().find((change) => change.at <= at)!.after;
}
const armFor = (mode: QueueMode, projectId: string, threadId: string): QueueArm | null => mode === "off" ? null : mode === "on" ? "auto" : queueArm(projectId, threadId);

/**
 * One scan of the trial. A unit is (project, executor thread) with at least two open cards linked to the thread, the same
 * rule in both arms. Each eligible unit gets its coverage interval since the previous scan (split at UTC midnights and
 * mode changes, capped) and one sample row per card: the linked cards, plus queued cards that are not linked.
 */
export function sampleQueueTrial(db: Database, nowMs = Date.now()): void {
  const at = iso(nowMs);
  db.transaction(() => {
    for (const { id: projectId } of db.prepare<[], { id: string }>("SELECT id FROM projects").all()) {
      // A unit's interval is credited only when it was eligible at this project's previous scan too.
      const lastScan = db.prepare<[string], { at: string }>("SELECT at FROM queue_trial_scans WHERE project_id=?").get(projectId)?.at ?? null;
      db.prepare<[string, string]>("INSERT INTO queue_trial_scans(project_id, at) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET at=excluded.at").run(projectId, at);
      if (queueMode(db, projectId) === "off") continue;
      const zone = zoneOf(db, projectId);
      const links = db.prepare<[string], { thread_id: string; task_id: string; status: string }>("SELECT DISTINCT tt.thread_id, t.id AS task_id, t.status FROM task_threads tt JOIN tasks t ON t.id=tt.task_id WHERE t.project_id=? AND t.archived_at IS NULL").all(projectId)
        .filter((row) => !isClosedStatus(zone, row.status));
      const byThread = new Map<string, { task_id: string; status: string }[]>();
      for (const row of links) byThread.set(row.thread_id, [...(byThread.get(row.thread_id) ?? []), row]);
      const changes = modeChanges(db, projectId);
      for (const [threadId, cards] of byThread) {
        if (cards.length < 2) continue;
        writeCoverage(db, projectId, threadId, nowMs, changes, lastScan);
        const queued = new Map(db.prepare<[string, string], { task_id: string; position: number; status: string }>("SELECT q.task_id, q.position, t.status FROM task_queue q JOIN tasks t ON t.id=q.task_id WHERE q.project_id=? AND q.thread_id=?").all(projectId, threadId).map((row) => [row.task_id, row]));
        const insert = db.prepare<(string | number | null)[]>("INSERT OR IGNORE INTO queue_trial_samples(at, project_id, thread_id, task_id, status, linked, queue_position) VALUES (?,?,?,?,?,?,?)");
        for (const card of cards) insert.run(at, projectId, threadId, card.task_id, card.status, 1, queued.get(card.task_id)?.position ?? null);
        for (const [taskId, row] of queued) if (!cards.some((card) => card.task_id === taskId)) insert.run(at, projectId, threadId, taskId, row.status, 0, row.position);
      }
    }
    const cutoff = iso(nowMs - 30 * DAY);
    db.prepare<[string]>("DELETE FROM queue_trial_coverage WHERE at<?").run(cutoff);
    db.prepare<[string]>("DELETE FROM queue_trial_samples WHERE at<?").run(cutoff);
  })();
}

function writeCoverage(db: Database, projectId: string, threadId: string, nowMs: number, changes: readonly ModeChange[], lastScan: string | null): void {
  const insert = db.prepare<(string | number)[]>("INSERT OR IGNORE INTO queue_trial_coverage(at, project_id, thread_id, mode, arm, interval_ms) VALUES (?,?,?,?,?,?)");
  const last = db.prepare<[string, string], { at: string }>("SELECT at FROM queue_trial_coverage WHERE project_id=? AND thread_id=? ORDER BY at DESC LIMIT 1").get(projectId, threadId);
  // A unit that was ineligible at the previous scan starts again from now: its gap is unknown, so it is not credited.
  const previous = last && last.at === lastScan ? last : undefined;
  const start = previous ? Math.max(Date.parse(previous.at), nowMs - COVERAGE_CAP_MS) : nowMs;
  if (start >= nowMs) {
    const mode = modeAt(changes, nowMs);
    if (!previous && armFor(mode, projectId, threadId)) insert.run(iso(nowMs), projectId, threadId, mode, armFor(mode, projectId, threadId)!, 0);
    return;
  }
  const cuts = [...new Set([...changes.map((change) => change.at), ...Array.from({ length: 3 }, (_, i) => (Math.floor(start / DAY) + i + 1) * DAY)].filter((cut) => cut > start && cut < nowMs))].sort((a, b) => a - b);
  const edges = [start, ...cuts, nowMs];
  for (let i = 1; i < edges.length; i++) {
    const mode = modeAt(changes, edges[i - 1]!);
    const arm = armFor(mode, projectId, threadId);
    if (arm) insert.run(iso(edges[i]!), projectId, threadId, mode, arm, edges[i]! - edges[i - 1]!);
  }
}

type Arm = QueueArm | "unknown";
interface Attributed { key: string; task: string; at: string; units: string[] }
const emptyArm = () => ({ units: 0, coveredMs: 0, unitDays: 0, expectedMs: 0 });

/** When this project's trial began: the queue's rollout, or the project's creation when that is later. */
export function rolloutAt(db: Database, projectId: string): number {
  const rollout = db.prepare<[], { at: string }>("SELECT at FROM queue_rollout WHERE id=1").get()?.at;
  const created = db.prepare<[string], { created_at: string }>("SELECT created_at FROM projects WHERE id=?").get(projectId)?.created_at;
  return Math.max(rollout ? Date.parse(rollout) : 0, created ? Date.parse(created) : 0);
}

/** The proxies for ordering done by hand: a pause whose reason talks about a queue, and a "Blocked by" between two cards of one executor. */
export const QUEUE_PAUSE_PATTERN = /\b(queue[sd]?|behind|next in line|waiting (for|on) [A-Z][A-Z0-9]*-\d+|after [A-Z][A-Z0-9]*-\d+)/i;

export function queueReport(db: Database, projectId: string, input: { since?: string; nowMs?: number } = {}) {
  const nowMs = input.nowMs ?? Date.now();
  if (!db.prepare<[string], { id: string }>("SELECT id FROM projects WHERE id=?").get(projectId)) throw new Error("Project not found");
  if (!db.prepare<[string], { found: number }>("SELECT 1 AS found FROM queue_trial_coverage WHERE project_id=? LIMIT 1").get(projectId)) throw new Error("No queue trial coverage has been recorded for this project yet");
  // The window and the baseline are anchored to the rollout (or the project's creation, when later), not to the first scan.
  const start = input.since ? Date.parse(input.since) : rolloutAt(db, projectId);
  if (!Number.isFinite(start)) throw new Error("Invalid since");
  const end = Math.min(nowMs, start + WINDOW_MS);
  const changes = modeChanges(db, projectId);
  const excludedDays = [...new Set(changes.filter((change) => change.at >= start && change.at <= end).map((change) => dayOf(change.at)))].sort();
  const excluded = new Set(excludedDays);
  const arms: Record<QueueArm, ReturnType<typeof emptyArm>> = { auto: emptyArm(), control: emptyArm() };
  const unitSets: Record<QueueArm, Set<string>> = { auto: new Set(), control: new Set() };
  const coverage = db.prepare<[string, string, string], { at: string; thread_id: string; arm: QueueArm; interval_ms: number }>("SELECT at, thread_id, arm, interval_ms FROM queue_trial_coverage WHERE project_id=? AND at>? AND at<=? ORDER BY at").all(projectId, iso(start), iso(end + COVERAGE_CAP_MS));
  const armSpans = new Map<string, { at: number; arm: QueueArm }[]>();
  for (const row of coverage) {
    // A row that ends after the window may still overlap it (intervals are capped at COVERAGE_CAP_MS).
    if (Date.parse(row.at) - row.interval_ms >= end) continue;
    const spans = armSpans.get(row.thread_id) ?? [];
    spans.push({ at: Date.parse(row.at), arm: row.arm });
    armSpans.set(row.thread_id, spans);
    // Only the part of the interval inside the window counts; intervals never cross a UTC midnight, so one day applies.
    const from = Math.max(Date.parse(row.at) - row.interval_ms, start);
    if (excluded.has(dayOf(from))) continue;
    arms[row.arm].coveredMs += Math.min(Date.parse(row.at), end) - from;
    unitSets[row.arm].add(row.thread_id);
  }
  for (const arm of ["auto", "control"] as const) {
    arms[arm].units = unitSets[arm].size;
    arms[arm].unitDays = arms[arm].coveredMs / DAY;
    arms[arm].expectedMs = unitSets[arm].size * (end - start);
  }
  const armOf = (threadId: string, at: number): Arm => {
    const spans = armSpans.get(threadId);
    if (!spans) return "unknown";
    return (spans.find((span) => span.at >= at) ?? spans.at(-1)!).arm;
  };

  const occurrences = db.prepare<[string, string, string], { task_id: string; task_key: string; first_seen_at: string }>("SELECT task_id, task_key, first_seen_at FROM manager_attention WHERE tracker_id=? AND kind='stale-status' AND first_seen_at>=? AND first_seen_at<=? ORDER BY first_seen_at").all(projectId, iso(start), iso(end))
    .filter((row) => !excluded.has(row.first_seen_at.slice(0, 10)));
  const attribute = (linkedOnly: boolean) => {
    const matched: Attributed[] = [], unmatched: { key: string; task: string; at: string; reason: string; arm: Arm }[] = [];
    for (const occ of occurrences) {
      const seen = Date.parse(occ.first_seen_at);
      const latest = db.prepare<[string, string, string, number], { thread_id: string; at: string }>("SELECT thread_id, MAX(at) AS at FROM queue_trial_samples WHERE project_id=? AND task_id=? AND at<=? AND (?=0 OR linked=1) GROUP BY thread_id").all(projectId, occ.task_id, occ.first_seen_at, linkedOnly ? 1 : 0);
      const units = latest.filter((row) => seen - Date.parse(row.at) <= COVERAGE_CAP_MS).map((row) => row.thread_id);
      if (units.length) {
        matched.push({ key: occ.task_key, task: occ.task_id, at: occ.first_seen_at, units });
        continue;
      }
      const linkedThreads = db.prepare<[string], { thread_id: string }>("SELECT thread_id FROM task_threads WHERE task_id=?").all(occ.task_id).map((row) => effectiveArm(db, projectId, row.thread_id));
      const distinct = new Set(linkedThreads);
      unmatched.push({ key: occ.task_key, task: occ.task_id, at: occ.first_seen_at, reason: latest.length ? "no sample within 30 minutes" : "no sample before the occurrence", arm: distinct.size === 1 && !distinct.has("off") ? ([...distinct][0] as Arm) : "unknown" });
    }
    const rate = (arm: QueueArm, includeMultiple: boolean) => {
      let weight = 0;
      for (const m of matched) {
        if (!includeMultiple && m.units.length > 1) continue;
        for (const unit of m.units) if (armOf(unit, Date.parse(m.at)) === arm) weight += 1 / m.units.length;
      }
      return { occurrences: weight, perUnitDay: arms[arm].unitDays > 0 ? weight / arms[arm].unitDays : null };
    };
    return {
      auto: rate("auto", true), control: rate("control", true),
      withoutMultipleLinked: { auto: rate("auto", false), control: rate("control", false) },
      multipleLinked: matched.filter((m) => m.units.length > 1),
      unmatched, unmatchedByArm: { auto: unmatched.filter((u) => u.arm === "auto").length, control: unmatched.filter((u) => u.arm === "control").length, unknown: unmatched.filter((u) => u.arm === "unknown").length },
    };
  };

  // Secondary proxies: ordering done by hand. They do not prove intent.
  const workarounds: { kind: string; key: string; at: string; unit: string; arm: Arm; detail: string }[] = [];
  const covered = new Set(armSpans.keys());
  const linksOf = (taskId: string) => db.prepare<[string], { thread_id: string }>("SELECT DISTINCT thread_id FROM task_threads WHERE task_id=?").all(taskId).map((row) => row.thread_id);
  for (const pause of db.prepare<[string, string, string], { task_id: string; task_key: string; at: string; detail: string }>("SELECT task_id, task_key, at, detail FROM pause_log WHERE project_id=? AND event='start' AND signal='manual' AND at>=? AND at<=?").all(projectId, iso(start), iso(end))) {
    if (excluded.has(pause.at.slice(0, 10)) || !QUEUE_PAUSE_PATTERN.test(pause.detail ?? "")) continue;
    for (const unit of linksOf(pause.task_id).filter((thread) => covered.has(thread))) workarounds.push({ kind: "pause", key: pause.task_key, at: pause.at, unit, arm: armOf(unit, Date.parse(pause.at)), detail: pause.detail });
  }
  for (const dep of db.prepare<[string, string, string], { created_at: string; a: string; b: string; a_key: string; b_key: string }>(
    `SELECT d.created_at, d.task_id AS a, d.blocking_task_id AS b, pa.prefix || '-' || ta.number AS a_key, pb.prefix || '-' || tb.number AS b_key
     FROM task_dependencies d JOIN tasks ta ON ta.id=d.task_id JOIN projects pa ON pa.id=ta.project_id JOIN tasks tb ON tb.id=d.blocking_task_id JOIN projects pb ON pb.id=tb.project_id
     WHERE ta.project_id=? AND d.created_at>=? AND d.created_at<=?`).all(projectId, iso(start), iso(end))) {
    if (excluded.has(dep.created_at.slice(0, 10))) continue;
    const shared = linksOf(dep.a).filter((thread) => linksOf(dep.b).includes(thread) && covered.has(thread));
    for (const unit of shared) workarounds.push({ kind: "blocked-by", key: `${dep.a_key} blocked by ${dep.b_key}`, at: dep.created_at, unit, arm: armOf(unit, Date.parse(dep.created_at)), detail: "same-executor dependency" });
  }
  const secondary = Object.fromEntries((["auto", "control"] as const).map((arm) => {
    const count = workarounds.filter((row) => row.arm === arm).length;
    return [arm, { count, perUnitDay: arms[arm].unitDays > 0 ? count / arms[arm].unitDays : null }];
  }));

  return {
    projectId, since: iso(start), until: iso(end), windowDays: 7,
    arms: Object.fromEntries((["auto", "control"] as const).map((arm) => [arm, { ...arms[arm], coverageShare: arms[arm].expectedMs > 0 ? arms[arm].coveredMs / arms[arm].expectedMs : null }])),
    excludedDays,
    primary: attribute(true),
    sensitivityQueueInclusive: attribute(false),
    baseline: baseline(db, projectId, start),
    secondary, workarounds,
    limitations: [
      "Few executors means few units: read the rates as a direction, not a measurement.",
      "Managers may change their behavior in both arms.",
      "Control units cannot show which cards were waiting, so no per-card waiting is claimed for control.",
      "Scan gaps reduce coverage (coverageShare per arm); an occurrence with no sample within 30 minutes is listed as unmatched, never attributed.",
      "Days with a mode change are excluded.",
      "The workaround counts are proxies: a matched pause or dependency does not prove it was made to order work.",
      "The baseline and the queue-inclusive result are approximations.",
    ],
  };
}

/** The 7 days before release, linked-only, with the arm hash applied to threads retroactively; approximated from attachment times. */
function baseline(db: Database, projectId: string, releaseMs: number) {
  const from = releaseMs - WINDOW_MS;
  const rows = db.prepare<[string], { thread_id: string; task_id: string; attached_at: string; created_at: string; updated_at: string; status: string }>("SELECT tt.thread_id, t.id AS task_id, tt.attached_at, t.created_at, t.updated_at, t.status FROM task_threads tt JOIN tasks t ON t.id=tt.task_id WHERE t.project_id=?").all(projectId);
  const zone = zoneOf(db, projectId);
  const unitDays: Record<QueueArm, number> = { auto: 0, control: 0 };
  const seen = new Set<string>();
  for (let day = Math.floor(from / DAY) * DAY; day < releaseMs; day += DAY) {
    const open = new Map<string, Set<string>>();
    for (const row of rows) {
      if (Date.parse(row.attached_at) > day + DAY || Date.parse(row.created_at) > day + DAY) continue;
      if (isClosedStatus(zone, row.status) && Date.parse(row.updated_at) < day) continue;
      open.set(row.thread_id, (open.get(row.thread_id) ?? new Set()).add(row.task_id));
    }
    for (const [thread, cards] of open) if (cards.size >= 2 && !seen.has(`${thread}:${day}`)) { seen.add(`${thread}:${day}`); unitDays[queueArm(projectId, thread)]++; }
  }
  const weight: Record<QueueArm, number> = { auto: 0, control: 0 };
  for (const occ of db.prepare<[string, string, string], { task_id: string; first_seen_at: string }>("SELECT task_id, first_seen_at FROM manager_attention WHERE tracker_id=? AND kind='stale-status' AND first_seen_at>=? AND first_seen_at<?").all(projectId, iso(from), iso(releaseMs))) {
    const threads = [...new Set(rows.filter((row) => row.task_id === occ.task_id && row.attached_at <= occ.first_seen_at).map((row) => row.thread_id))];
    for (const thread of threads) weight[queueArm(projectId, thread)] += 1 / threads.length;
  }
  return { approximate: true, from: iso(from), until: iso(releaseMs), unitDays, occurrences: weight,
    perUnitDay: { auto: unitDays.auto ? weight.auto / unitDays.auto : null, control: unitDays.control ? weight.control / unitDays.control : null } };
}
