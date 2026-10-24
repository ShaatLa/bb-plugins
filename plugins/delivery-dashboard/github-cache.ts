import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { githubRequest, secureUrlSchema, type GitHubRequest, type GitHubResponse } from "./metrics";

const responseSchema = z.object({ body: z.unknown(), hasNext: z.boolean(), etag: z.string().optional() });
function pick(value: unknown, keys: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(keys.filter((key) => key in value).map((key) => [key, (value as Record<string, unknown>)[key]]));
}

export function createGitHubCache(database: ReturnType<BbPluginApi["storage"]["database"]>) {
  const pending = new Map<string, Promise<GitHubResponse>>();
  return (configuration: string, token: string | undefined, signal: AbortSignal, ttl: number, force: boolean, canWrite: () => boolean): GitHubRequest => async (path, init) => {
    if (init?.method && init.method !== "GET") return githubRequest(path, token, signal, init);
    const key = JSON.stringify([configuration, path]);
    const row = database.prepare("SELECT data, checked_at FROM github_responses WHERE cache_key = ?").get(key) as { data: string; checked_at: number } | undefined;
    let previous: GitHubResponse | undefined;
    if (row) {
      try { previous = responseSchema.parse(JSON.parse(row.data)); } catch { /* Invalid cache entries are refetched. */ }
    }
    const metadata = path.startsWith("/search/issues?") || path.includes("/statuses?");
    if (!force && metadata && previous && row && Date.now() - row.checked_at >= 0 && Date.now() - row.checked_at < ttl) return previous;
    if (pending.has(key)) return pending.get(key)!;
    const operation = githubRequest(path, token, signal, init, previous).then((result) => {
      // Workflow responses contain large unused nested objects; retain only metric inputs.
      if (path.includes("/actions/runs?") && result.body && typeof result.body === "object" && "workflow_runs" in result.body && Array.isArray(result.body.workflow_runs)) {
        const body = result.body as { total_count?: unknown; workflow_runs: { id?: unknown; created_at?: unknown; conclusion?: unknown }[] };
        result = { ...result, body: { total_count: body.total_count, workflow_runs: body.workflow_runs.map(({ id, created_at, conclusion }) => ({ id, created_at, conclusion })) } };
      }
      if (path.includes("/deployments?") && Array.isArray(result.body)) result = { ...result, body: result.body.map((row) => pick(row, ["id", "environment", "production_environment", "ref", "created_at"])) };
      if (path.includes("/statuses?") && Array.isArray(result.body)) result = { ...result, body: result.body.map((row) => {
        const status = pick(row, ["state", "created_at", "log_url"]);
        if (status && typeof status === "object" && "log_url" in status && !secureUrlSchema.safeParse(status.log_url).success) status.log_url = null;
        return status;
      }) };
      if (path.startsWith("/search/issues?") && result.body && typeof result.body === "object") {
        const body = result.body as { total_count?: unknown; incomplete_results?: unknown; items?: unknown };
        result = { ...result, body: { total_count: body.total_count, incomplete_results: body.incomplete_results, ...(Array.isArray(body.items) ? { items: body.items.map((row) => pick(row, ["number", "title", "created_at"])) } : {}) } };
      }
      if (canWrite()) {
        database.prepare("INSERT INTO github_responses (cache_key, data, checked_at) VALUES (?, ?, ?) ON CONFLICT(cache_key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at")
          .run(key, JSON.stringify(result), Date.now());
        database.prepare("DELETE FROM github_responses WHERE cache_key NOT IN (SELECT cache_key FROM github_responses ORDER BY checked_at DESC LIMIT 512)").run();
      }
      return result;
    });
    pending.set(key, operation);
    try { return await operation; }
    finally { pending.delete(key); }
  };
}
