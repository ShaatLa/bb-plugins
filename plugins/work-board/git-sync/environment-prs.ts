import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// bb 0.48 moved environment PR reads from bb.sdk.environments to the bundled GitHub PR Status plugin.
const PR_STATUS_PLUGIN_ID = "bb--github-pr-status";
const MAX_KEYS = 200;

const environmentPullRequestSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("available"),
    pullRequest: z.object({
      number: z.number().int().positive(),
      title: z.string(),
      state: z.enum(["draft", "open", "merged", "closed"]),
      url: z.string(),
      updatedAt: z.string(),
    }),
  }),
  z.object({ outcome: z.literal("absent") }),
  z.object({ outcome: z.literal("unavailable") }),
]);
const outputSchema = z.record(z.string(), environmentPullRequestSchema);

export type EnvironmentPullRequest = z.infer<typeof environmentPullRequestSchema>;

/** The PR of each environment's current branch; a failed read counts as unavailable. */
export async function environmentPullRequests(
  bb: BbPluginApi,
  environmentIds: Iterable<string>,
): Promise<Map<string, EnvironmentPullRequest>> {
  const ids = [...new Set(environmentIds)];
  const result = new Map<string, EnvironmentPullRequest>();
  for (let start = 0; start < ids.length; start += MAX_KEYS) {
    const keys = ids.slice(start, start + MAX_KEYS);
    let rows: z.infer<typeof outputSchema> = {};
    try {
      rows = await bb.sdk.plugins.callRpc({
        pluginId: PR_STATUS_PLUGIN_ID,
        method: "pullRequests",
        input: { keys },
        outputSchema,
      });
    } catch {
      /* Missing or disabled GitHub PR Status: every key stays unavailable. */
    }
    for (const key of keys) result.set(key, rows[key] ?? { outcome: "unavailable" });
  }
  return result;
}
