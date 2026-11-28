import { z } from "zod";
import { boardStates } from "./states";

const columnName = z.string()
  .refine(value => !/[\p{Cc}\p{Bidi_Control}]/u.test(value), "Status names cannot contain control or bidi characters")
  .transform(value => value.trim())
  .refine(value => [...value].length >= 1 && [...value].length <= 64, "Use 1–64 characters for the status name");
const columnDisplay = z.object({
  id: z.enum(boardStates), name: columnName, visible: z.boolean(),
  icon: z.enum(["default", "Circle", "Check", "X", "Clock", "Search", "Flag", "Pause", "Star"]),
  color: z.enum(["default", "slateblue", "steelblue", "lightseagreen", "mediumseagreen", "goldenrod", "sandybrown",
    "indianred", "palevioletred", "mediumpurple", "slategray", "black"]),
}).strict();
export const boardIcons = columnDisplay.shape.icon.options;
export const boardColors = columnDisplay.shape.color.options;
const boardColumns = z.array(columnDisplay).length(boardStates.length)
  .refine(columns => new Set(columns.map(column => column.id)).size === boardStates.length, "Include every board status exactly once")
  .refine(columns => new Set(columns.map(column => column.name.normalize("NFKC").toLowerCase())).size === columns.length,
    "Status names must be unique");
const displayRevision = z.number().int().nonnegative();
export const boardDisplaySchema = z.object({ revision: displayRevision, columns: boardColumns.nullable() }).strict();
export const boardDisplayWriteSchema = z.object({ expectedRevision: displayRevision, columns: boardColumns.nullable() }).strict();
export const boardDisplayResultSchema = z.discriminatedUnion("ok", [
  boardDisplaySchema.extend({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.literal("board_display_conflict"), current: boardDisplaySchema }).strict(),
]);
export type BoardColumnDisplay = z.infer<typeof columnDisplay>;
