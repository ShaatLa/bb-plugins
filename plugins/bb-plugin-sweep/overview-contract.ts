import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const historyDays = 30;
export const projectId = z.string().regex(/^proj_[a-z0-9]+$/, 'Pass a bb project ID, for example proj_example. Run bb project list to find the ID.');
export const projectInput = z.object({ projectId }).strict();
export const projectsTag = 'sweep:projects';
export const managerTag = 'sweep:manager';
export const statsTag = (projectId: string) => `sweep:stats:${projectId}`;
export const statsInput = z.object({ projectId, days: z.number().int().min(1).max(historyDays).default(1) }).strict();
const count = z.number().int().nonnegative();
const statsOutput = z.object({
  projectId, days: count, since: count,
  ticks: count, executed: count, deliveries: count, manager: count, answers: count,
  repeats: count, suppressedReports: count, reminderReports: count,
  refreshFailures: count, scriptFailures: count, deliveryFailures: count,
  newItems: z.record(z.string(), count),
});
export type SweepStats = z.infer<typeof statsOutput>;

export const overviewContract = defineRpcContract({
  'overview.projects': {
    experimental_description: 'List projects with a complete Sweep configuration.',
    input: z.null(),
    output: z.array(z.object({ id: projectId, name: z.string(), enabled: z.boolean() })),
    tags: () => [projectsTag],
  },
  manager: { experimental_description: 'Read the configured manager thread ID or null. Resolve availability before sending.', input: projectInput, output: z.object({ manager: z.string().nullable() }), tags: () => [managerTag] },
  stats: { experimental_description: 'Read scheduled-run statistics for one project. Pass days from 1 through 30 (default 1).', input: statsInput, output: statsOutput, tags: ({ projectId }) => [statsTag(projectId)] },
});
