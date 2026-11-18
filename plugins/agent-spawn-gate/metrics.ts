import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const operation = z.enum(["start", "dry-run", "dispatch"]);
type Operation = z.infer<typeof operation>;
const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
const reportInput = z.object({
  projectId: projectId.optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict().refine(({ from, to }) => !from || !to || from <= to, "from must be on or before to");
const projectReport = z.object({
  projectId,
  name: z.string(),
  starts: z.number(),
  dryRuns: z.number(),
  blockedStarts: z.number(),
  refusals: z.array(z.object({ operation, reason: z.string(), count: z.number() })),
});
const reportOutput = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  coverageStartedAt: z.iso.datetime(),
  projects: z.array(projectReport),
});

const reportTag = (projectId?: string) => projectId ? `report:${projectId}` : "report";
export const reportContract = defineRpcContract({
  report: { input: reportInput, output: reportOutput, tags: ({ projectId }) => [reportTag(projectId)] },
});

type ProjectReport = z.infer<typeof projectReport>;
type MetricRow = { projectId: string; operation: Operation; reason: string; count: number };
export type RecordMetric = (projectId: string, operation: Operation, reason: string) => void;

export async function createMetrics(bb: BbPluginApi, db: ReturnType<BbPluginApi["storage"]["database"]>) {
  db.exec(`CREATE TABLE IF NOT EXISTS gate_daily_metrics (
    day TEXT NOT NULL, projectId TEXT NOT NULL, operation TEXT NOT NULL,
    reason TEXT NOT NULL, count INTEGER NOT NULL,
    PRIMARY KEY (day, projectId, operation, reason)
  );`);
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

  const record: RecordMetric = (projectId, operation, reason) => {
    try {
      increment.run(new Date().toISOString().slice(0, 10), projectId, operation, reason);
    } catch {
      bb.log.warn("Could not record a gate metric");
      return;
    }
    bb.rpc.experimental_invalidate([reportTag(projectId), reportTag()]);
  };
  const report = async (raw: z.input<typeof reportInput>) => {
    const { projectId, from: requestedFrom, to = new Date().toISOString().slice(0, 10) } = reportInput.parse(raw);
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
    return { from, to, coverageStartedAt, projects: [...projects.values()] };
  };
  return { record, report };
}
