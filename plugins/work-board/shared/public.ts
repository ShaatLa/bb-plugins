import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Discoverable read API for other plugins (`bb plugin rpc list work-board`).
 * Keep it backward compatible: add optional fields, never rename or remove.
 */
const publicStatus = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  /** Shared app icon (`experimental_Icon`) of the effective glyph, drawn in currentColor. */
  iconName: z.string(),
  /** Theme-aware CSS color matching Work Board, e.g. `var(--attention)`. */
  cssColor: z.string(),
});

export const publicRpcContract = defineRpcContract({
  threadBoard: {
    input: z.object({ threadId: z.string().regex(/^thr_[A-Za-z0-9_-]+$/) }),
    output: z.object({
      /** The Work Board project linked to the thread's bb project; null when none is. */
      project: z.object({ id: z.string(), name: z.string(), url: z.string() }).nullable(),
      columns: z.array(
        z.object({
          status: publicStatus,
          /** Active top-level tasks in the column; cards may hold fewer. */
          total: z.number().int(),
          cards: z.array(
            z.object({
              key: z.string(),
              title: z.string(),
              type: z.string(),
              priority: z.string(),
              /** The task is linked to this thread. */
              mine: z.boolean(),
              url: z.string(),
            }),
          ),
        }),
      ),
    }),
  },
  threadTasks: {
    input: z.object({ threadId: z.string().regex(/^thr_[A-Za-z0-9_-]+$/) }),
    output: z.object({
      tasks: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          status: publicStatus,
          projectName: z.string(),
          archived: z.boolean(),
          /** How the thread is linked, e.g. "Attached", "Parent thread". */
          linkName: z.string(),
          linkedAt: z.string(),
          /** In-app path that opens the task in Work Board. */
          url: z.string(),
        }),
      ),
    }),
  },
});
