import { z } from "zod";

export const TASK_DATE_FIELDS = ["created", "updated", "archived"] as const;
export const taskDateFiltersSchema = z
  .object({
    dateField: z.enum(TASK_DATE_FIELDS).optional(),
    dateFrom: z.iso.date().optional(),
    dateTo: z.iso.date().optional(),
  })
  .refine(
    (value) =>
      !value.dateFrom || !value.dateTo || value.dateFrom <= value.dateTo,
    {
      message: "Start date must not be after end date",
    },
  );
export type TaskDateFilters = z.infer<typeof taskDateFiltersSchema>;
