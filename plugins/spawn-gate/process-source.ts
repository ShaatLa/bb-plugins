import { isAbsolute } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { isBuilderBranch } from "./branch";

const provider = "project-instructions";
const sha = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const sourceResult = z.object({
  projectId: z.string(), configured: z.boolean(), enabled: z.boolean(),
  clonePath: z.string().nullable(),
  branch: z.string().nullable(),
  head: sha.nullable(), originHead: sha.nullable(),
  state: z.enum(["not_configured", "disabled", "missing", "wrong_branch", "dirty", "unreachable", "stale", "fresh", "error"]),
  reason: z.string().min(1).max(2000).nullable(),
  fetchedAt: z.number().nullable(),
});

export type ProcessSource = { clonePath: string; branch: string; commit: string };
export type ResolveProcessSource = (projectId: string, signal?: AbortSignal) => Promise<ProcessSource | null>;

export function isProcessPath(path: string) {
  return path.trim().length > 0 && !isAbsolute(path) && !/[\\\u0000]/.test(path) &&
    path.split("/").every(part => part && part !== "." && part !== ".." && part !== ".git");
}

export function createProcessSourceResolver(bb: BbPluginApi): ResolveProcessSource {
  const last = new Map<string, string>();
  const log = (projectId: string, message: string, refusal = false) => {
    if (last.get(projectId) === message) return;
    last.set(projectId, message);
    const line = `Launch source for ${projectId}: ${message}`;
    if (refusal) bb.log.warn(line);
    else bb.log.info(line);
  };
  const refuse = (projectId: string, state: string, message: string): never => {
    log(projectId, `Project Instructions refused (${state})`, true);
    throw new Error(message);
  };
  return async (projectId, signal) => {
    const deadline = AbortSignal.timeout(12_000);
    const probe = signal ? AbortSignal.any([signal, deadline]) : deadline;
    let source: z.infer<typeof sourceResult>;
    try {
      source = await bb.sdk.plugins.callRpc({
        pluginId: provider, method: "source.get", input: { projectId }, outputSchema: sourceResult, signal: probe,
      });
    } catch {
      signal?.throwIfAborted();
      const inventory = await bb.sdk.plugins.list({ signal: probe }).catch(() => null);
      if (inventory && !inventory.plugins.some(plugin => plugin.id === provider)) {
        log(projectId, "Spawn Gate settings (Project Instructions not installed)");
        return null;
      }
      return refuse(projectId, "unavailable", "Project Instructions launch source is unavailable. Check that Project Instructions is running and supports source.get, then retry.");
    }
    if (source.projectId !== projectId) return refuse(projectId, "wrong_project", "Project Instructions returned a source for a different project. Check the source.get integration.");
    if (!source.enabled && (source.state === "not_configured" || source.state === "disabled")) {
      log(projectId, `Spawn Gate settings (Project Instructions ${source.state})`);
      return null;
    }
    if (source.state !== "fresh") {
      const reason = source.reason ?? "check the process clone";
      return refuse(projectId, source.state, `Project Instructions launch source is ${source.state}: ${reason}. Restore the configured process checkout and retry.`);
    }
    if (!source.enabled || !source.configured || !source.clonePath || !isAbsolute(source.clonePath) ||
      !source.branch || !isBuilderBranch(source.branch) || !source.head || source.head !== source.originHead) {
      return refuse(projectId, "invalid_source", "Project Instructions returned an incomplete or unverified launch source. Check the source.get integration.");
    }
    log(projectId, `Project Instructions ${source.clonePath} @ ${source.branch} ${source.head}`);
    return { clonePath: source.clonePath, branch: source.branch, commit: source.head };
  };
}
