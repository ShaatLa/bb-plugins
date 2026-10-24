import { z } from "zod";
import { rangeInputSchema } from "./date-range";
import { metricsSchema, repositorySchema } from "./metrics";
import type { DashboardData } from "./server";

export const ciQuerySchema = z.object({
  repository: repositorySchema.optional().describe("Configured owner/repo; omit for all dashboard repositories."),
  selection: rangeInputSchema.default({ days: 7 }).describe("Preset days 1, 3, 7, 14, 30 or 90, or inclusive UTC start/end dates within the past year. One day means today from 00:00 UTC."),
  refresh: z.boolean().default(false).describe("False returns a local snapshot when available, including stale data with its timestamp. True forces a GitHub refresh; cold/large ranges may take time."),
}).strict();
export const ciReportSchema = z.object({
  source: z.enum(["cache", "collection"]), discoveryError: z.string().nullable(),
  repositories: z.array(metricsSchema.pick({ repository: true, updatedAt: true, range: true, ciOutcomes: true, ciInsights: true }).extend({
    projectName: z.string().nullable(), ageSeconds: z.number().nonnegative(), stale: z.boolean(), pending: z.array(z.string()),
    passRate: metricsSchema.shape.ci.omit({ series: true, seriesError: true }).extend({ historyError: z.string().nullable() }),
  })),
});
export type CiQuery = z.infer<typeof ciQuerySchema>;

export function ciReport(data: DashboardData, query: CiQuery, refreshSeconds: number, fromCache: boolean) {
  const repositories = data.repositories.filter((row) => !query.repository || row.repository.toLowerCase() === query.repository.toLowerCase());
  if (query.repository && repositories.length === 0) throw new Error("Repository is not configured in CI Dashboard or could not be discovered.");
  return ciReportSchema.parse({
    source: fromCache ? "cache" : "collection", discoveryError: data.discoveryError,
    repositories: repositories.map((row) => {
      const age = (Date.now() - Date.parse(row.updatedAt)) / 1000;
      return { repository: row.repository, projectName: row.projectName, updatedAt: row.updatedAt, range: row.range,
        ageSeconds: Math.max(0, Math.floor(age)), stale: age < 0 || age >= refreshSeconds,
        pending: row.pending?.filter((key) => key === "ci" || key === "commitActivity") ?? [],
        passRate: { value: row.ci.value, detail: row.ci.detail, error: row.ci.error, historyError: row.ci.seriesError },
        ciOutcomes: row.ciOutcomes, ciInsights: row.ciInsights,
      };
    }),
  });
}
