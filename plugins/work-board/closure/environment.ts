import { createHash } from "node:crypto";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

const GIT_PLUGIN_ID = "bb--git";
/** Every read of a turn sample has this deadline; a read that misses it counts as unreadable. */
export const SAMPLE_TIMEOUT_MS = 5000;
const THREAD_LIST_LIMIT = 200;
const RUNNING = new Set(["pending", "starting", "active", "stopping"]);

const statusSchema = z.record(z.string(), z.object({
  outcome: z.string(),
  workspace: z.object({ checkout: z.object({ kind: z.string(), headSha: z.string().nullable().optional() }) }).optional(),
}));
const filesSchema = z.object({
  outcome: z.string(),
  files: z.array(z.object({ path: z.string(), revision: z.string() })).optional(),
  truncated: z.boolean().optional(),
});

/**
 * A stable hash of the environment's HEAD and its uncommitted files with their revisions, so a commit and an edit
 * that keeps the line counts both change it. Null when Git cannot answer completely: no git plugin, a non-git or
 * unknown checkout, a missing HEAD SHA, a truncated file list, a failure or the deadline.
 */
export async function environmentFingerprint(bb: BbPluginApi, environmentId: string, signal: AbortSignal): Promise<string | null> {
  try {
    const status = (await bb.sdk.plugins.callRpc({ pluginId: GIT_PLUGIN_ID, method: "status", input: { keys: [environmentId] }, outputSchema: statusSchema, signal }))[environmentId];
    const checkout = status?.outcome === "available" ? status.workspace?.checkout : undefined;
    // An unborn branch has no commit yet, so its first commit still changes the value; any other checkout needs its SHA.
    const head = checkout?.kind === "unborn" ? "unborn" : checkout?.kind === "branch" || checkout?.kind === "detached" ? checkout.headSha : null;
    if (!head) return null;
    const files = await bb.sdk.plugins.callRpc({
      pluginId: GIT_PLUGIN_ID,
      method: "files",
      input: { environmentId, target: { type: "uncommitted" }, ignoreWhitespace: false },
      outputSchema: filesSchema,
      signal,
    });
    if (files.outcome !== "available" || !files.files || files.truncated !== false) return null;
    const pairs = files.files.map((file) => [file.path, file.revision] as const).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return createHash("sha256").update(JSON.stringify([head, pairs])).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Whether another thread on the environment, archived or not, linked to a card or not, may have changed its files:
 * one is running now, or was last active at or after `since` (ms). A failed or truncated listing is uncertain too.
 */
export async function otherActivity(bb: BbPluginApi, environmentId: string, threadId: string, since: number | null, signal: AbortSignal): Promise<boolean> {
  try {
    const lists = await Promise.all([false, true].map((archived) => bb.sdk.threads.list({ environmentId, archived, includeHidden: true, limit: THREAD_LIST_LIMIT, signal })));
    if (lists.some((list) => list.length >= THREAD_LIST_LIMIT)) return true;
    return lists.flat().some((thread) => thread.id !== threadId && (RUNNING.has(thread.status) || (since !== null && thread.updatedAt >= since)));
  } catch {
    return true;
  }
}
