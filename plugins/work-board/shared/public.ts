import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/**
 * Discoverable read API for other plugins (`bb plugin rpc list work-board`).
 * Keep it backward compatible: add optional fields, never rename or remove.
 */
export const publicRpcContract = defineRpcContract({
  threadTasks: {
    input: z.object({ threadId: z.string().regex(/^thr_[A-Za-z0-9_-]+$/) }),
    output: z.object({
      tasks: z.array(
        z.object({
          key: z.string(),
          title: z.string(),
          status: z.object({ id: z.string(), name: z.string(), icon: z.string().optional(), color: z.string().optional() }),
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
