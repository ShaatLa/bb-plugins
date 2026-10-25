import { z } from "zod";

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export const DEFAULT_TASK_STATUSES = [
  { id: "backlog", name: "Backlog" },
  { id: "todo", name: "Todo" },
  { id: "in_progress", name: "In Progress" },
  { id: "in_review", name: "In Review" },
  { id: "done", name: "Done" },
  { id: "canceled", name: "Canceled" },
];
export const taskStatusSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{0,63}$/,
    "Status ID must be lowercase letters, digits or underscores, starting with a letter (max 64)",
  );
export const taskStatusesSchema = z
  .array(
    z
      .object({
        id: taskStatusSchema,
        name: z.string().trim().min(1).max(80),
      })
      .strict(),
  )
  .min(6)
  .max(32)
  .superRefine((statuses, ctx) => {
    if (
      new Set(statuses.map((status) => status.id)).size !== statuses.length ||
      new Set(statuses.map((status) => status.name.toLowerCase())).size !==
        statuses.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Status IDs and names must be unique",
      });
    if (
      TASK_STATUSES.some((id) => !statuses.some((status) => status.id === id))
    )
      ctx.addIssue({
        code: "custom",
        message: "The six system status IDs must be retained",
      });
  });
export type TaskStatusDefinition = z.infer<typeof taskStatusesSchema>[number];
export function statusLabel(
  id: string,
  statuses: readonly TaskStatusDefinition[] = DEFAULT_TASK_STATUSES,
): string {
  return (
    statuses.find((status) => status.id === id)?.name ?? id.replaceAll("_", " ")
  );
}
