import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { paceFallback, paceOverride, paceSource } from "./pace";

const operation = z.enum(["start", "dry-run", "dispatch"]);
type Operation = z.infer<typeof operation>;
const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
const reportInput = z.object({
  projectId: projectId.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  events: z.boolean().optional(),
}).strict().refine(({ from, to }) => !from || !to || from <= to, "from must be on or before to");
const projectReport = z.object({
  projectId,
  name: z.string(),
  starts: z.number(),
  dryRuns: z.number(),
  blockedStarts: z.number(),
  refusals: z.array(z.object({ operation, reason: z.string(), count: z.number() })),
});
const refusalEvent = z.object({
  timestamp: z.iso.datetime(),
  projectId,
  operation,
  reason: z.string(),
  parentThreadId: z.string().nullable(),
  card: z.string().nullable(),
  sourceCommit: z.string().nullable(),
  stderr: z.string().nullable(),
});
const paceEventFields = {
  timestamp: z.iso.datetime(), projectId,
  parentThreadId: z.string().nullable(), card: z.string().nullable(), sourceCommit: z.string().nullable(),
};
const fallbackEvent = paceFallback.extend(paceEventFields);
const overrideEvent = paceOverride.extend(paceEventFields);
const paceReadingEvent = z.object({ ...paceEventFields, providers: z.array(paceSource) });
const reportOutput = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  coverageStartedAt: z.iso.datetime(),
  projects: z.array(projectReport),
  events: z.array(refusalEvent).optional(),
  fallbacks: z.array(fallbackEvent).optional(),
  overrides: z.array(overrideEvent).optional(),
  paceReadings: z.array(paceReadingEvent).optional(),
});

const reportTag = (projectId?: string) => projectId ? `report:${projectId}` : "report";
export const reportContract = defineRpcContract({
  report: { experimental_description: 'Read activity over inclusive UTC dates. Omit projectId for all projects. Set events to include refusals, provider pace fallbacks and pinned overrides, e.g. {"projectId":"proj_example","events":true}.', input: reportInput, output: reportOutput, tags: ({ projectId }) => [reportTag(projectId)] },
});

type ProjectReport = z.infer<typeof projectReport>;
type MetricRow = { projectId: string; operation: Operation; reason: string; count: number };
type RefusalEvent = z.infer<typeof refusalEvent>;
type FallbackEvent = z.infer<typeof fallbackEvent>;
type OverrideEvent = z.infer<typeof overrideEvent>;
type MetricDetails = Partial<Pick<RefusalEvent, "parentThreadId" | "card" | "sourceCommit" | "stderr">> & {
  paceReadings?: z.infer<typeof paceSource>[];
  fallback?: z.infer<typeof paceFallback>;
  override?: z.infer<typeof paceOverride>;
};
export type RecordMetric = (projectId: string, operation: Operation, reason: string, details?: MetricDetails) => void;

export async function createMetrics(bb: BbPluginApi, db: ReturnType<BbPluginApi["storage"]["database"]>) {
  db.exec(`CREATE TABLE IF NOT EXISTS gate_daily_metrics (
    day TEXT NOT NULL, projectId TEXT NOT NULL, operation TEXT NOT NULL,
    reason TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY (day, projectId, operation, reason)
  );
  CREATE TABLE IF NOT EXISTS gate_refusal_events (
    timestamp TEXT NOT NULL, projectId TEXT NOT NULL, operation TEXT NOT NULL, reason TEXT NOT NULL,
    parentThreadId TEXT, card TEXT, sourceCommit TEXT, stderr TEXT
  );
  CREATE INDEX IF NOT EXISTS gate_refusal_events_timestamp ON gate_refusal_events(timestamp);
  CREATE TABLE IF NOT EXISTS gate_pace_decisions (
    timestamp TEXT NOT NULL, projectId TEXT NOT NULL, parentThreadId TEXT, card TEXT, sourceCommit TEXT,
    fromProviderId TEXT NOT NULL, toProviderId TEXT, pace REAL NOT NULL, threshold REAL NOT NULL, overrideReason TEXT,
    CHECK ((toProviderId IS NULL) <> (overrideReason IS NULL))
  );
  CREATE INDEX IF NOT EXISTS gate_pace_decisions_timestamp ON gate_pace_decisions(timestamp);
  CREATE TABLE IF NOT EXISTS gate_pace_readings (
    timestamp TEXT NOT NULL, projectId TEXT NOT NULL, parentThreadId TEXT, card TEXT, sourceCommit TEXT,
    providers TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS gate_pace_readings_timestamp ON gate_pace_readings(timestamp);`);
  const key = "metrics-coverage-start";
  let coverageStartedAt = await bb.storage.kv.get<string>(key);
  if (!coverageStartedAt) {
    coverageStartedAt = new Date().toISOString();
    await bb.storage.kv.set(key, coverageStartedAt);
  }
  const increment = db.prepare(`INSERT INTO gate_daily_metrics VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(day, projectId, operation, reason) DO UPDATE SET count = count + 1`);
  const totals = db.prepare<[string, string, string | null, string | null], MetricRow>(`
    SELECT projectId, operation, reason, sum(count) AS count
    FROM gate_daily_metrics WHERE day BETWEEN ? AND ? AND (? IS NULL OR projectId = ?)
    GROUP BY projectId, operation, reason ORDER BY projectId, operation, reason`);
  const insertEvent = db.prepare(`INSERT INTO gate_refusal_events
    (timestamp, projectId, operation, reason, parentThreadId, card, sourceCommit, stderr)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const refusalEvents = db.prepare<[string, string, string | null, string | null], RefusalEvent>(`
    SELECT timestamp, projectId, operation, reason, parentThreadId, card, sourceCommit, stderr
    FROM gate_refusal_events WHERE timestamp BETWEEN ? AND ? AND (? IS NULL OR projectId = ?)
    ORDER BY timestamp DESC, rowid DESC`);
  const insertDecision = db.prepare(`INSERT INTO gate_pace_decisions
    (timestamp, projectId, parentThreadId, card, sourceCommit, fromProviderId, toProviderId, pace, threshold, overrideReason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const fallbackEvents = db.prepare<[string, string, string | null, string | null], FallbackEvent>(`
    SELECT timestamp, projectId, parentThreadId, card, sourceCommit, fromProviderId, toProviderId, pace, threshold
    FROM gate_pace_decisions WHERE toProviderId IS NOT NULL AND timestamp BETWEEN ? AND ? AND (? IS NULL OR projectId = ?)
    ORDER BY timestamp DESC, rowid DESC`);
  const overrideEvents = db.prepare<[string, string, string | null, string | null], OverrideEvent>(`
    SELECT timestamp, projectId, parentThreadId, card, sourceCommit, fromProviderId AS providerId, pace, threshold, overrideReason AS reason
    FROM gate_pace_decisions WHERE overrideReason IS NOT NULL AND timestamp BETWEEN ? AND ? AND (? IS NULL OR projectId = ?)
    ORDER BY timestamp DESC, rowid DESC`);
  const insertReadings = db.prepare(`INSERT INTO gate_pace_readings
    (timestamp, projectId, parentThreadId, card, sourceCommit, providers) VALUES (?, ?, ?, ?, ?, ?)`);
  const readingEvents = db.prepare<[string, string, string | null, string | null],
    Omit<z.infer<typeof paceReadingEvent>, "providers"> & { providers: string }>(`
    SELECT timestamp, projectId, parentThreadId, card, sourceCommit, providers
    FROM gate_pace_readings WHERE timestamp BETWEEN ? AND ? AND (? IS NULL OR projectId = ?)
    ORDER BY timestamp DESC, rowid DESC`);
  const recordMetric = db.transaction((projectId: string, operation: Operation, reason: string, {
    parentThreadId = null, card = null, sourceCommit = null, stderr = null,
    fallback, override, paceReadings,
  }: MetricDetails) => {
    const timestamp = new Date().toISOString();
    increment.run(timestamp.slice(0, 10), projectId, operation, reason);
    if (reason !== "success") insertEvent.run(timestamp, projectId, operation, reason, parentThreadId, card, sourceCommit, stderr);
    if (reason === "success" && operation === "start") {
      if (paceReadings?.length) insertReadings.run(timestamp, projectId, parentThreadId, card, sourceCommit, JSON.stringify(paceReadings));
      if (fallback) insertDecision.run(timestamp, projectId, parentThreadId, card, sourceCommit,
        fallback.fromProviderId, fallback.toProviderId, fallback.pace, fallback.threshold, null);
      if (override) insertDecision.run(timestamp, projectId, parentThreadId, card, sourceCommit,
        override.providerId, null, override.pace, override.threshold, override.reason);
    }
  });

  const record: RecordMetric = (projectId, operation, reason, details = {}) => {
    try {
      recordMetric(projectId, operation, reason, details);
    } catch {
      bb.log.warn("Could not record a gate metric");
      return;
    }
    bb.rpc.experimental_invalidate([reportTag(projectId), reportTag()]);
  };
  const report = async (raw: z.input<typeof reportInput>) => {
    const { projectId, from: requestedFrom, to = new Date().toISOString().slice(0, 10), events } = reportInput.parse(raw);
    const from = requestedFrom ?? new Date(Date.parse(to) - 6 * 86_400_000).toISOString().slice(0, 10);
    if (from > to) throw new Error("from must be on or before to");
    const projects = new Map<string, ProjectReport>();
    const addProject = (projectId: string, name: string): ProjectReport => {
      const row = { projectId, name, starts: 0, dryRuns: 0, blockedStarts: 0, refusals: [] };
      projects.set(projectId, row);
      return row;
    };
    for (const project of await bb.sdk.projects.list()) {
      if (!projectId || project.id === projectId) addProject(project.id, project.name);
    }
    for (const row of totals.all(from, to, projectId ?? null, projectId ?? null)) {
      const project = projects.get(row.projectId) ?? addProject(row.projectId, row.projectId);
      if (row.reason === "success" && row.operation === "start") project.starts += row.count;
      else if (row.reason === "success" && row.operation === "dry-run") project.dryRuns += row.count;
      else {
        if (row.operation === "dispatch") project.blockedStarts += row.count;
        project.refusals.push({ operation: row.operation, reason: row.reason, count: row.count });
      }
    }
    if (projectId && !projects.has(projectId)) throw new Error("Unknown project or no retained report data in this window");
    const eventRange = [`${from}T00:00:00.000Z`, `${to}T23:59:59.999Z`, projectId ?? null, projectId ?? null] as const;
    const fallbacks = events ? fallbackEvents.all(...eventRange) : [];
    const overrides = events ? overrideEvents.all(...eventRange) : [];
    const paceReadings = events ? readingEvents.all(...eventRange).map(({ providers, ...event }) =>
      paceReadingEvent.parse({ ...event, providers: JSON.parse(providers) })) : [];
    return {
      from, to, coverageStartedAt, projects: [...projects.values()],
      ...(events ? { events: refusalEvents.all(...eventRange) } : {}),
      ...(fallbacks.length ? { fallbacks } : {}),
      ...(overrides.length ? { overrides } : {}),
      ...(paceReadings.length ? { paceReadings } : {}),
    };
  };
  return { record, report };
}
