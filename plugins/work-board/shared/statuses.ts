import { z } from "zod";
import { COLOR_PALETTE } from "./colors.js";

export const statusColorSchema = z.enum(COLOR_PALETTE.map((color) => color.value));
export type StatusColor = z.infer<typeof statusColorSchema>;

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "canceled",
] as const;
export const STATUS_ICONS = [
  { id: "backlog", name: "Dashed circle" },
  { id: "todo", name: "Circle" },
  { id: "in_progress", name: "In progress" },
  { id: "in_review", name: "In review" },
  { id: "done", name: "Done" },
  { id: "canceled", name: "Canceled" },
  { id: "clock", name: "Waiting" },
  { id: "pause", name: "Paused" },
  { id: "play", name: "Ready" },
  { id: "search", name: "Investigation" },
  { id: "testing", name: "Testing" },
  { id: "bug", name: "Bug" },
  { id: "alert", name: "Attention" },
  { id: "lock", name: "Blocked" },
  { id: "flag", name: "Flag" },
  { id: "rocket", name: "Release" },
  { id: "star", name: "Star" },
  { id: "hourglass", name: "Pending" },
  { id: "checklist", name: "Checklist" },
  { id: "archive", name: "Archive" },
] as const;
export const statusIconSchema = z.enum(STATUS_ICONS.map((icon) => icon.id));
export type StatusIconName = z.infer<typeof statusIconSchema>;

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
        icon: statusIconSchema.optional(),
        color: statusColorSchema.optional(),
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
