import { z } from "zod";
import { githubRequest, repositorySchema, secureUrlSchema } from "./metrics";
import { minimumDate } from "./date-range";

export const cardDetailsInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ci"), repository: repositorySchema, since: z.iso.datetime(), until: z.iso.datetime() }).strict(),
  z.object({ kind: z.literal("production"), repository: repositorySchema, environment: z.string().min(1).max(200) }).strict(),
]);
export const cardDetailsOutput = z.object({
  checkedAt: z.iso.datetime(),
  items: z.array(z.object({
    id: z.number().int().positive(), title: z.string(), createdAt: z.iso.datetime({ offset: true }), state: z.string(),
    url: secureUrlSchema, compareUrl: secureUrlSchema.nullable(),
  })).max(5),
});
export type CardDetailsInput = z.infer<typeof cardDetailsInput>;
export type CardDetails = z.infer<typeof cardDetailsOutput>;
const timestamp = z.iso.datetime({ offset: true });

export async function loadCardDetails(input: CardDetailsInput, token: string | undefined, signal: AbortSignal): Promise<CardDetails> {
  cardDetailsInput.parse(input);
  const checkedAt = new Date().toISOString();
  const request = (path: string) => githubRequest(path, token, signal);
  const base = `https://github.com/${input.repository}`;
  if (input.kind === "ci") {
    if (Date.parse(input.since) < Date.parse(minimumDate()) || Date.parse(input.since) > Date.parse(input.until) || Date.parse(input.until) > Date.now()) throw new Error("Invalid statistics interval.");
    const { body } = await request(`/repos/${input.repository}/actions/runs?status=failure&created=${encodeURIComponent(`${input.since}..${input.until}`)}&per_page=5&page=1`);
    const { workflow_runs } = z.object({ workflow_runs: z.array(z.object({
      id: z.number().int().positive(), name: z.string().nullable().optional(), display_title: z.string().optional(),
      created_at: timestamp, conclusion: z.literal("failure"),
    })).max(5) }).parse(body);
    if (workflow_runs.some((run) => Date.parse(run.created_at) < Date.parse(input.since) || Date.parse(run.created_at) > Date.parse(input.until))) throw new Error("GitHub returned runs outside the selected range.");
    return { checkedAt, items: workflow_runs.map((run) => ({
      id: run.id, title: [run.name, run.display_title].filter(Boolean).join(" · ") || `Run #${run.id}`,
      createdAt: run.created_at, state: "failure", url: `${base}/actions/runs/${run.id}`, compareUrl: null,
    })) };
  }
  const { body } = await request(`/repos/${input.repository}/deployments?environment=${encodeURIComponent(input.environment)}&per_page=5&page=1`);
  const deployments = z.array(z.object({
    id: z.number().int().positive(), environment: z.string(), ref: z.string(),
    sha: z.string().regex(/^[a-fA-F0-9]{40}$/), created_at: timestamp,
  })).max(5).parse(body);
  if (deployments.some((row) => row.environment !== input.environment)) throw new Error("GitHub returned another deployment environment.");
  const items = await Promise.all(deployments.map(async (row, index) => {
    let state = "unknown", url = `${base}/deployments`;
    try {
      const { body } = await request(`/repos/${input.repository}/deployments/${row.id}/statuses?per_page=1`);
      const status = z.array(z.object({ state: z.string(), log_url: z.string().nullable().optional() })).parse(body)[0];
      state = status?.state ?? "unknown";
      const link = secureUrlSchema.safeParse(status?.log_url);
      if (link.success) url = link.data;
    } catch {
      signal.throwIfAborted();
      state = "unavailable";
    }
    const previous = deployments[index + 1];
    return { id: row.id, title: `${row.ref} · ${row.sha.slice(0, 7)}`, createdAt: row.created_at, state, url,
      compareUrl: previous && previous.sha !== row.sha ? `${base}/compare/${previous.sha}...${row.sha}` : null };
  }));
  return { checkedAt, items };
}
