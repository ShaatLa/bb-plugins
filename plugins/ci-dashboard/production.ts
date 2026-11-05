import { z } from "zod";

export type ProductionTarget = { repository: string; workflow: string; ref: string };
export const productionWorkflowUrl = (target: ProductionTarget) => `https://github.com/${target.repository}/actions/workflows/${encodeURIComponent(target.workflow)}`;

/** The configured deploy target, or null (action disabled) unless both a repository and a workflow file are set. */
export function productionTargetFrom(values: { productionRepository?: unknown; productionWorkflow?: unknown; productionRef?: unknown } | undefined): ProductionTarget | null {
  const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
  const repository = text(values?.productionRepository), workflow = text(values?.productionWorkflow);
  return repository && workflow ? { repository, workflow, ref: text(values?.productionRef) || "main" } : null;
}

export async function dispatchProduction(target: ProductionTarget, token: string | undefined, signal: AbortSignal): Promise<{ url: string }> {
  if (!token) throw new Error("GitHub authorization with Actions write permission is required for production deployment.");
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${target.repository}/actions/workflows/${encodeURIComponent(target.workflow)}/dispatches`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: target.ref }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    });
  } catch {
    throw new Error("Deployment request was not confirmed. Check the production workflow before retrying.");
  }
  if (!response.ok) throw new Error(`GitHub refused the deployment request (HTTP ${response.status}). Check workflow access and Actions write permission.`);
  const result = z.object({ workflow_run_id: z.number().int().positive() }).safeParse(
    response.status === 204 ? null : await response.json().catch(() => null),
  );
  return { url: result.success ? `https://github.com/${target.repository}/actions/runs/${result.data.workflow_run_id}` : productionWorkflowUrl(target) };
}
