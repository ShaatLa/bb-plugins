import { z } from "zod";
import type { GitHubRequest } from "./metrics";
import type { ciRunSchema } from "./ci-insights";

export const defaultDraftRules = { workflow: "CI", job: "CI complete", step: "Reject draft pull request" };
export type DraftRules = typeof defaultDraftRules;
export const draftNameSchema = z.string().trim().min(1).max(200);
export function draftRules(values: { draftWorkflow: string; draftJob: string; draftStep: string }): DraftRules {
  return { workflow: values.draftWorkflow, job: values.draftJob, step: values.draftStep };
}

type Run = z.infer<typeof ciRunSchema>;
export const draftCandidate = (run: Run, rules: DraftRules = defaultDraftRules) => run.name === rules.workflow && run.event === "pull_request" && run.conclusion === "failure";
const jobsSchema = z.object({ total_count: z.number().int().nonnegative(), jobs: z.array(z.object({
  id: z.number().int().positive(), name: z.string(), conclusion: z.string().nullable(),
  steps: z.array(z.object({ name: z.string(), conclusion: z.string().nullable() })),
})) });

export async function classifyDraft(run: Run, repository: string, request: GitHubRequest, rules: DraftRules = defaultDraftRules): Promise<boolean> {
  if (!draftCandidate(run, rules)) return false;
  const jobs = new Map<number, z.infer<typeof jobsSchema>["jobs"][number]>();
  for (let page = 1; ; page++) {
    // Pin the attempt so a rerun cannot change the evidence halfway through pagination.
    const attempt = run.run_attempt ? `/attempts/${run.run_attempt}` : "";
    const response = await request(`/repos/${repository}/actions/runs/${run.id}${attempt}/jobs?filter=latest&per_page=100&page=${page}`);
    const body = jobsSchema.parse(response.body);
    const before = jobs.size;
    for (const job of body.jobs) jobs.set(job.id, job);
    if (!response.hasNext) {
      if (jobs.size !== body.total_count) throw new Error("Incomplete CI job evidence");
      break;
    }
    if (jobs.size === before) throw new Error("Repeated CI job page");
  }
  const failed = [...jobs.values()].filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped");
  if (failed.length !== 1 || failed[0].name !== rules.job || failed[0].conclusion !== "failure") return false;
  const steps = failed[0].steps.filter((step) => step.conclusion !== "success" && step.conclusion !== "skipped");
  return steps.length === 1 && steps[0].name === rules.step && steps[0].conclusion === "failure";
}
