import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';

export const historyDays = 30;
export const projectId = z.string().regex(/^proj_[a-z0-9]+$/);
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
    input: z.null(),
    output: z.array(z.object({ id: projectId, name: z.string(), enabled: z.boolean() })),
  },
  stats: { input: statsInput, output: statsOutput },
});
