import { z } from "zod";

export const productionTarget = { repository: "simple-life-app/anvil", workflow: "production.yaml", ref: "main" } as const;
export const productionWorkflowUrl = `https://github.com/${productionTarget.repository}/actions/workflows/${productionTarget.workflow}`;

export async function dispatchProduction(token: string | undefined, signal: AbortSignal): Promise<{ url: string }> {
  if (!token) throw new Error("GitHub authorization with Actions write permission is required for production deployment.");
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/repos/${productionTarget.repository}/actions/workflows/${productionTarget.workflow}/dispatches`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2026-03-10", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ ref: productionTarget.ref }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      redirect: "error",
    });
  } catch {
    throw new Error("Deployment request was not confirmed. Check the Production workflow before retrying.");
  }
  if (!response.ok) throw new Error(`GitHub refused the deployment request (HTTP ${response.status}). Check workflow access and Actions write permission.`);
  const result = z.object({ workflow_run_id: z.number().int().positive() }).safeParse(
    response.status === 204 ? null : await response.json().catch(() => null),
  );
  return { url: result.success ? `https://github.com/${productionTarget.repository}/actions/runs/${result.data.workflow_run_id}` : productionWorkflowUrl };
}
