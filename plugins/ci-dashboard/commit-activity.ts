import { z } from "zod";

const count = z.number().int().nonnegative();
export const commitActivitySchema = z.object({
  commits: count.nullable(), additions: count.nullable(), deletions: count.nullable(),
  branch: z.string().nullable(), error: z.string().nullable(),
});
export const commitRowSchema = z.object({ oid: z.string().min(1), additions: count, deletions: count, committedDate: z.iso.datetime({ offset: true }) });
export function summarizeCommitActivity(rows: z.infer<typeof commitRowSchema>[], branch: string | null) {
  return {
    commits: rows.length, additions: rows.reduce((sum, row) => sum + row.additions, 0),
    deletions: rows.reduce((sum, row) => sum + row.deletions, 0), branch, error: null,
  };
}
const historySchema = z.object({
  totalCount: count,
  nodes: z.array(commitRowSchema).max(100),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const targetSchema = z.object({ oid: z.string().min(1), history: historySchema });
const firstSchema = z.object({ repository: z.object({ defaultBranchRef: z.object({ name: z.string(), target: targetSchema }).nullable() }) });
const pageSchema = z.object({ repository: z.object({ target: targetSchema }) });
const envelopeSchema = z.object({ data: z.unknown().optional(), errors: z.array(z.unknown()).optional() });
const fields = `oid history(first:100,after:$cursor,since:$since,until:$until) {
  totalCount nodes { oid additions deletions committedDate } pageInfo { hasNextPage endCursor }
}`;
const parameters = `$owner:String!,$name:String!,$since:GitTimestamp!,$until:GitTimestamp!,$cursor:String`;
const firstQuery = `query CommitActivity(${parameters}) {
  repository(owner:$owner,name:$name) { defaultBranchRef { name target { ... on Commit { ${fields} } } } }
}`;
const nextQuery = `query CommitActivityPage(${parameters},$head:GitObjectID!) {
  repository(owner:$owner,name:$name) { target:object(oid:$head) { ... on Commit { ${fields} } } }
}`;

type Request = (path: string, init?: Pick<RequestInit, "method" | "body">) => Promise<{ body: unknown }>;

export async function loadCommitActivity(repository: string, token: string | undefined, since: string, until: string, request: Request, onHistory?: (rows: z.infer<typeof commitRowSchema>[], branch: string | null, head: string | null) => void, previous?: { commits: z.infer<typeof commitRowSchema>[]; branch: string | null; head?: string | null }): Promise<z.infer<typeof commitActivitySchema>> {
  if (!token) throw new Error("GitHub authorization is required for commit and line statistics. Use system gh authorization or a plugin token.");
  const [owner, name] = repository.split("/");
  const variables = { owner, name, since, until, cursor: null as string | null };
  async function query(source: string, extra: object = {}) {
    const { body } = await request("/graphql", { method: "POST", body: JSON.stringify({ query: source, variables: { ...variables, ...extra } }) });
    const result = envelopeSchema.parse(body);
    if (result.errors?.length) throw new Error("GitHub could not load commit activity. Check repository permissions and retry.");
    return result.data;
  }
  const branch = firstSchema.parse(await query(firstQuery)).repository.defaultBranchRef;
  if (!branch) {
    onHistory?.([], null, null);
    return { commits: 0, additions: 0, deletions: 0, branch: null, error: null };
  }
  const head = branch.target.oid;
  const expected = branch.target.history.totalCount;
  const prior = previous?.branch === branch.name ? previous.commits.filter((row) => Date.parse(row.committedDate) >= Date.parse(since) && Date.parse(row.committedDate) <= Date.parse(until)) : [];
  if (previous?.head === head && previous.branch === branch.name && prior.length === expected) {
    onHistory?.(prior, branch.name, head);
    return summarizeCommitActivity(prior, branch.name);
  }
  const rows = new Map<string, z.infer<typeof historySchema>["nodes"][number]>();
  let target = branch.target;
  const cursors = new Set<string>();
  while (true) {
    if (target.oid !== head || target.history.totalCount !== expected) throw new Error("GitHub commit history changed during pagination. Retry on the next refresh.");
    for (const row of target.history.nodes) {
      const time = Date.parse(row.committedDate);
      if (time < Date.parse(since) || time > Date.parse(until)) throw new Error("GitHub returned a commit outside the selected time window.");
      rows.set(row.oid, row);
    }
    if (previous?.head && previous.branch === branch.name && rows.has(previous.head)) {
      const combined = new Map(prior.map((row) => [row.oid, row]));
      for (const [oid, row] of rows) combined.set(oid, row);
      if (combined.size === expected) {
        const commits = [...combined.values()];
        onHistory?.(commits, branch.name, head);
        return summarizeCommitActivity(commits, branch.name);
      }
    }
    if (!target.history.pageInfo.hasNextPage) {
      if (rows.size !== expected) throw new Error("GitHub returned an incomplete commit history. Retry on the next refresh.");
      const commits = [...rows.values()];
      onHistory?.(commits, branch.name, head);
      return summarizeCommitActivity(commits, branch.name);
    }
    const cursor = target.history.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor) || target.history.nodes.length === 0 || rows.size >= expected) throw new Error("GitHub returned an invalid commit history cursor.");
    cursors.add(cursor);
    variables.cursor = cursor;
    target = pageSchema.parse(await query(nextQuery, { head })).repository.target;
  }
}
