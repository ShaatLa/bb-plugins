import { z } from "zod";
import { taskStatusSchema } from "./statuses.js";

export const workflowPolicySchema = z.object({
  bugfixStatus: taskStatusSchema.nullable().default("bugfix"),
  doneStatus: taskStatusSchema.nullable().default("done"),
  inProgressStatus: taskStatusSchema.nullable().default("in_progress"),
  reviewStatus: taskStatusSchema.nullable().default("in_review"),
  testingStatus: taskStatusSchema.nullable().default("in_testing"),
  earlyStatuses: z.array(taskStatusSchema).default(["todo", "in_progress"]),
  ownerDecisionLabel: z.string().trim().min(1).max(100).nullable().default("решение владельца"),
}).strict();

export type WorkflowPolicy = z.infer<typeof workflowPolicySchema>;
export function getWorkflowPolicy(project: { workflowPolicy?: Partial<WorkflowPolicy> | null }): WorkflowPolicy {
  return workflowPolicySchema.parse(project.workflowPolicy ?? {});
}
