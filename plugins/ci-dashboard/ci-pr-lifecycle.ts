import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const context = z.discriminatedUnion("__typename", [
  z.object({ __typename: z.literal("CheckRun"), name: z.string(), status: z.string(), conclusion: z.string().nullable(), isRequired: z.boolean() }),
  z.object({ __typename: z.literal("StatusContext"), context: z.string(), state: z.string(), isRequired: z.boolean() }),
]);
const pullRequest = z.object({
  number: z.number().int().positive(), state: z.string(), merged: z.boolean(), mergedAt: z.iso.datetime().nullable(),
  mergeCommit: z.object({ oid: sha }).nullable(), headRefOid: sha, url: z.url(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ oid: sha, statusCheckRollup: z.object({
    state: z.string().optional(), contexts: z.object({ nodes: z.array(context), pageInfo: z.object({ hasNextPage: z.boolean() }) }),
  }).nullable() }) })) }),
});
const response = z.object({ data: z.object({ repository: z.record(z.string(), pullRequest.nullable()).nullable() }) });
export type PrLifecycleEvent = { number: number; key: string; text: string; closed?: boolean };

/** Only current-head labels are rendered; GitHub errors, logs and annotations never enter a line. */
export function prLifecycleEvents(body: unknown): PrLifecycleEvent[] {
  return Object.values(response.parse(body).data.repository ?? {}).flatMap((pr): PrLifecycleEvent[] => {
    if (!pr) return [];
    const { number, url, headRefOid: head } = pr;
    if (pr.merged) return pr.mergeCommit && pr.mergedAt ? [{ number, key: `pr_merged:${number}`, text: `PR merged · #${number} · merge commit ${pr.mergeCommit.oid} · ${pr.mergedAt} · ${url}` }] : [];
    if (pr.state === "CLOSED") return [{ number, key: `pr_closed:${number}`, closed: true, text: `PR closed · #${number} · not merged, subscription ended · ${url}` }];
    const commit = pr.commits.nodes[0]?.commit, contexts = commit?.statusCheckRollup?.contexts;
    // EXPECTED: a required check has not reported yet, so it is missing from contexts and the rest cannot decide.
    if (commit?.oid !== head || !contexts || contexts.pageInfo.hasNextPage || commit.statusCheckRollup?.state === "EXPECTED") return [];
    const required = contexts.nodes.filter((check) => check.isRequired), checks = required.length ? required : contexts.nodes;
    if (!checks.length || checks.some((check) => check.__typename === "CheckRun" ? check.status !== "COMPLETED" || !check.conclusion || ["EXPECTED", "PENDING"].includes(check.conclusion) : !["SUCCESS", "FAILURE", "ERROR"].includes(check.state))) return [];
    const failed = checks.filter((check) => check.__typename === "CheckRun" ? !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion!) : check.state !== "SUCCESS");
    const names = failed.slice(0, 5).map((check) => (check.__typename === "CheckRun" ? check.name : check.context).replace(/\s+/g, " ").trim().slice(0, 100));
    if (failed.length > 5) names.push(`+${failed.length - 5}`);
    const label = required.length ? "required checks" : "checks";
    return [{ number, key: `pr_ci:${number}:${head}`, text: failed.length
      ? `PR CI red · #${number} · head ${head} · ${failed.length} of ${checks.length} ${label} failed: ${names.join(", ")} · ${url}`
      : `PR CI green · #${number} · head ${head} · ${checks.length} ${label} passed · ${url}` }];
  });
}

export function prLifecycleQuery(numbers: number[]): string {
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){${numbers.map((number) => `pr${number}:pullRequest(number:${number}){number state merged mergedAt mergeCommit{oid} headRefOid url commits(last:1){nodes{commit{oid statusCheckRollup{state contexts(first:100){pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion isRequired(pullRequestNumber:${number})} ... on StatusContext{context state isRequired(pullRequestNumber:${number})}}}}}}}}`).join(" ")}}}`;
}

export type PrLifecyclePace = { at?: number; cursor?: number };
/** One request per minute, rotating batches so repositories with over 25 subscribed PRs cannot starve. */
export function prLifecycleBatch(numbers: number[], sent: Record<string, number>, pace: PrLifecyclePace, now: number): number[] {
  const pending = [...new Set(numbers)].filter((number) => sent[`pr_merged:${number}`] === undefined && sent[`pr_closed:${number}`] === undefined).sort((a, b) => a - b);
  if (!pending.length || (pace.at !== undefined && now - pace.at < 60_000)) return [];
  const start = pending.findIndex((number) => number > (pace.cursor ?? 0));
  const batch = pending.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 25);
  pace.at = now; pace.cursor = batch.at(-1);
  return batch;
}
