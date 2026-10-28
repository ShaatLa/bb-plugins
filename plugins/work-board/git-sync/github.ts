import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import {
  prSnapshotSchema,
  type GitSyncConfig,
  type PrSnapshot,
} from "../shared/git-sync";

const run = promisify(execFile);
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const pull = z.object({
  number: z.number().int().positive(),
  node_id: z.string(),
  html_url: z.string(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  draft: z.boolean().optional(),
  updated_at: z.string(),
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: sha.nullable().optional(),
  mergeable: z.boolean().nullable().optional(),
  mergeable_state: z.string().optional(),
  head: z.object({ sha }),
  base: z.object({
    ref: z.string(),
    repo: z.object({ full_name: z.string(), id: z.number() }),
  }),
});
const workflowRun = z.object({
  id: z.number(),
  workflow_id: z.number(),
  name: z.string().nullable(),
  head_sha: sha,
  head_branch: z.string().nullable(),
  event: z.string(),
  status: z.string(),
  conclusion: z.string().nullable(),
  html_url: z.string().url(),
  created_at: z.string(),
  run_attempt: z.number().default(1),
  head_repository: z.object({ id: z.number() }).nullable(),
});
type WorkflowRun = z.infer<typeof workflowRun>;
export class GithubError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function githubToken(signal: AbortSignal) {
  if (process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim())
    return process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim();
  for (const command of ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"]) {
    try {
      const { stdout } = await run(
        command,
        ["auth", "token", "--hostname", "github.com"],
        { signal, timeout: 5000, maxBuffer: 16384 },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      signal.throwIfAborted();
    }
  }
}
export function createGithubClient(options: {
  token: () => Promise<string | undefined>;
  signal: AbortSignal;
  fetcher?: typeof fetch;
}) {
  const cached = new Map<string, { etag?: string; body: unknown }>();
  let retryAt = 0;
  async function request(path: string, body?: unknown): Promise<unknown> {
    if (Date.now() < retryAt)
      throw new GithubError(429, "GitHub rate limit: retry later");
    options.signal.throwIfAborted();
    const token = await options.token();
    const scope = createHash("sha256")
      .update(token ?? "anonymous")
      .digest("hex");
    const key = `${scope}:${path}`;
    const previous = body === undefined ? cached.get(key) : undefined;
    let url = `https://api.github.com${path}`;
    let response: Response | undefined;
    for (let redirect = 0; redirect < 4; redirect++) {
      response = await (options.fetcher ?? fetch)(url, {
        method: body === undefined ? "GET" : "POST",
        redirect: "manual",
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]),
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "bb-work-board",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(previous?.etag ? { "If-None-Match": previous.etag } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (![301, 302, 307, 308].includes(response.status)) break;
      const target = new URL(response.headers.get("location") ?? "", url);
      if (
        target.origin !== "https://api.github.com" ||
        target.username ||
        target.password
      )
        throw new GithubError(502, "Unexpected GitHub redirect");
      url = target.href;
    }
    if (!response) throw new GithubError(502, "GitHub did not respond");
    if (response.status === 304 && previous) return previous.body;
    if (
      response.status === 429 ||
      (response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining") === "0" ||
          response.headers.has("retry-after")))
    ) {
      retryAt = Math.max(
        Date.now() + 60_000,
        (Number(response.headers.get("x-ratelimit-reset")) || 0) * 1000,
        Date.now() + (Number(response.headers.get("retry-after")) || 0) * 1000,
      );
      throw new GithubError(429, "GitHub rate limit: retry later");
    }
    if (!response.ok)
      throw new GithubError(
        response.status,
        `GitHub request failed (HTTP ${response.status})`,
      );
    const result: unknown = await response.json();
    if (body === undefined) {
      cached.delete(key);
      cached.set(key, {
        body: result,
        etag: response.headers.get("etag") ?? undefined,
      });
      while (cached.size > 256) cached.delete(cached.keys().next().value!);
    }
    return result;
  }
  async function optional(path: string, body?: unknown) {
    try {
      return await request(path, body);
    } catch (error) {
      if (
        error instanceof GithubError &&
        [401, 403, 404].includes(error.status)
      )
        return null;
      throw error;
    }
  }
  async function pages(path: string, field?: string) {
    const rows: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await request(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      const batch = z
        .array(z.unknown())
        .parse(
          field ? z.record(z.string(), z.unknown()).parse(data)[field] : data,
        );
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new GithubError(
      422,
      "GitHub result exceeds 2000 rows; narrow the configured lookback",
    );
  }
  async function optionalPages(path: string): Promise<unknown[] | null> {
    const rows: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await optional(`${path}?per_page=100&page=${page}`);
      if (data === null) return null;
      const batch = z.array(z.unknown()).parse(data);
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new GithubError(422, "GitHub rule list exceeds 2000 entries");
  }
  async function discover(repository: string, days: number) {
    const rows = new Map<number, z.infer<typeof pull>>();
    for (const raw of await pages(
      `/repos/${repository}/pulls?state=open&sort=created&direction=asc`,
    )) {
      const value = pull.parse(raw);
      rows.set(value.number, value);
    }
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    for (let page = 1; page <= 20; page++) {
      const batch = z
        .array(pull)
        .parse(
          await request(
            `/repos/${repository}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`,
          ),
        );
      for (const value of batch)
        if (value.updated_at >= cutoff) rows.set(value.number, value);
      if (batch.length < 100 || batch.at(-1)!.updated_at < cutoff)
        return [...rows.values()];
    }
    throw new GithubError(
      422,
      "Discovery window exceeds 2000 PRs; narrow the lookback",
    );
  }
  async function coverage(
    pr: z.infer<typeof pull>,
    config: GitSyncConfig,
  ): Promise<PrSnapshot["coverage"]> {
    if (
      !pr.merged_at ||
      !pr.merge_commit_sha ||
      !config.postMergeWorkflows.length
    )
      return [];
    if (Date.now() - Date.parse(pr.merged_at) > config.postMergeDays * 86400000)
      return [];
    const repo = pr.base.repo.full_name;
    const raw: unknown[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = z
        .object({ workflow_runs: z.array(z.unknown()) })
        .parse(
          await request(
            `/repos/${repo}/actions/runs?event=push&branch=${encodeURIComponent(pr.base.ref)}&per_page=100&page=${page}`,
          ),
        ).workflow_runs;
      raw.push(...batch);
      if (
        batch.length < 100 ||
        batch.some(
          (value) => workflowRun.parse(value).created_at < pr.merged_at!,
        )
      )
        break;
      if (page === 20)
        throw new GithubError(422, "Post-merge run window exceeds 2000 rows");
    }
    const runs = raw
      .map((value) => workflowRun.parse(value))
      .filter(
        (value) =>
          value.head_repository?.id === pr.base.repo.id &&
          value.head_branch === pr.base.ref &&
          value.event === "push" &&
          value.created_at >= pr.merged_at!,
      );
    const observations: PrSnapshot["coverage"] = [];
    for (const workflow of config.postMergeWorkflows)
      observations.push(
        await (async () => {
          const selected = runs
            .filter(
              (value) =>
                value.name === workflow ||
                String(value.workflow_id) === workflow,
            )
            .sort((a, b) => b.id - a.id || b.run_attempt - a.run_attempt);
          const empty = {
            workflow,
            state: "pending" as const,
            runId: null,
            sha: null,
            url: null,
            superseded: false,
            originalRunId: null,
          };
          if (new Set(selected.map((value) => value.workflow_id)).size > 1)
            return { ...empty, state: "unknown" as const };
          const direct = selected.find(
            (value) => value.head_sha === pr.merge_commit_sha,
          );
          const state = (
            value: WorkflowRun,
          ): "pending" | "passed" | "failed" | "skipped" =>
            value.status !== "completed" || value.conclusion === "cancelled"
              ? "pending"
              : value.conclusion === "success"
                ? "passed"
                : ["neutral", "skipped"].includes(value.conclusion ?? "")
                  ? "skipped"
                  : [
                        "failure",
                        "timed_out",
                        "action_required",
                        "startup_failure",
                      ].includes(value.conclusion ?? "")
                    ? "failed"
                    : "pending";
          const result = (value: WorkflowRun, superseded: boolean) => ({
            workflow,
            state: state(value),
            runId: value.id,
            sha: value.head_sha,
            url: value.html_url,
            superseded,
            originalRunId: direct?.id ?? null,
          });
          if (direct && direct.conclusion !== "cancelled")
            return result(direct, false);
          for (const value of selected.slice(0, 20)) {
            if (
              value.head_sha === pr.merge_commit_sha ||
              (direct && value.id <= direct.id)
            )
              continue;
            const comparison = z
              .object({ status: z.string() })
              .parse(
                await request(
                  `/repos/${repo}/compare/${pr.merge_commit_sha}...${value.head_sha}`,
                ),
              );
            if (["ahead", "identical"].includes(comparison.status))
              return result(value, true);
          }
          return direct ? result(direct, false) : empty;
        })(),
      );
    return observations;
  }
  async function snapshot(
    repository: string,
    number: number,
    config: GitSyncConfig,
    previous?: PrSnapshot | null,
  ): Promise<PrSnapshot> {
    const pr = pull.parse(
      await request(`/repos/${repository}/pulls/${number}`),
    );
    const repo = pr.base.repo.full_name;
    let files: PrSnapshot["files"] = previous?.headSha === pr.head.sha ? previous.files : undefined;
    if (pr.state === "open") {
      if (previous?.headSha === pr.head.sha && previous.files) files = previous.files;
      else {
        const entries: NonNullable<PrSnapshot["files"]>["entries"] = [];
        let truncated = false;
        for (let page = 1; page <= 30; page++) {
          const batch = z.array(z.object({ filename: z.string(), status: z.enum(["added", "modified", "removed", "renamed"]), previous_filename: z.string().optional() })).parse(await request(`/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`));
          entries.push(...batch);
          if (batch.length < 100) break;
          if (page === 30) truncated = true;
        }
        files = { entries, truncated };
      }
    }
    const checks: PrSnapshot["checks"] = [];
    const latest = new Map<
      string,
      { order: number; check: PrSnapshot["checks"][number] }
    >();
    const checkData = await pages(
      `/repos/${repo}/commits/${pr.head.sha}/check-runs?filter=latest`,
      "check_runs",
    );
    const rawCheck = z.object({
      name: z.string(),
      head_sha: sha,
      status: z.string(),
      conclusion: z.string().nullable(),
      html_url: z.string().url().nullable(),
      started_at: z.string().nullable(),
      completed_at: z.string().nullable(),
      id: z.number(),
      app: z.object({ id: z.number(), slug: z.string().optional() }).nullable(),
    });
    for (const raw of checkData) {
      const check = rawCheck.parse(raw);
      if (check.head_sha !== pr.head.sha) continue;
      const key = `${check.app?.id ?? "unknown"}:${check.name}`;
      const before = latest.get(key);
      if (before && before.order > check.id) continue;
      const state =
        check.status !== "completed"
          ? "pending"
          : check.conclusion === "success"
            ? "passed"
            : [
                  "failure",
                  "timed_out",
                  "action_required",
                  "startup_failure",
                ].includes(check.conclusion ?? "")
              ? "failed"
              : check.conclusion === "skipped"
                ? "skipped"
                : check.conclusion === "neutral"
                  ? "neutral"
                  : check.conclusion === "cancelled"
                    ? "cancelled"
                    : "unknown";
      latest.set(key, {
        order: check.id,
        check: {
          name: check.name,
          app: check.app?.slug ?? "unknown",
          appId: check.app?.id ?? null,
          sha: pr.head.sha,
          url: check.html_url,
          required: null,
          state,
        },
      });
    }
    checks.push(...[...latest.values()].map((value) => value.check));
    const statuses = await pages(
      `/repos/${repo}/commits/${pr.head.sha}/statuses`,
    );
    const contexts = new Set<string>();
    for (const raw of statuses) {
      const value = z
        .object({
          context: z.string(),
          state: z.string(),
          target_url: z.string().url().nullable(),
        })
        .parse(raw);
      if (contexts.has(value.context)) continue;
      contexts.add(value.context);
      checks.push({
        name: value.context,
        app: "commit-status",
        appId: null,
        sha: pr.head.sha,
        url: value.target_url,
        state:
          value.state === "success"
            ? "passed"
            : ["error", "failure"].includes(value.state)
              ? "failed"
              : "pending",
        required: null,
      });
    }
    let requirementsKnown = config.requiredChecks.length > 0;
    let required: { context: string; appId: number | null }[] | null = config
      .requiredChecks.length
      ? config.requiredChecks.map((context) => ({ context, appId: null }))
      : null;
    if (required === null) {
      const protection = await optional(
        `/repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}/protection/required_status_checks`,
      );
      const rules = await optionalPages(
        `/repos/${repo}/rules/branches/${encodeURIComponent(pr.base.ref)}`,
      );
      requirementsKnown = protection !== null && rules !== null;
      if (protection !== null || rules !== null) {
        required = [];
        if (protection) {
          const value = z
            .object({
              contexts: z.array(z.string()).default([]),
              checks: z
                .array(
                  z.object({
                    context: z.string(),
                    app_id: z.number().nullable(),
                  }),
                )
                .default([]),
            })
            .parse(protection);
          required.push(
            ...(value.checks.length
              ? value.checks.map((check) => ({
                  context: check.context,
                  appId: check.app_id,
                }))
              : value.contexts.map((context) => ({ context, appId: null }))),
          );
        }
        if (rules)
          for (const value of z
            .array(
              z.object({
                type: z.string(),
                parameters: z.unknown().optional(),
              }),
            )
            .parse(rules))
            if (value.type === "required_status_checks")
              required.push(
                ...z
                  .object({
                    required_status_checks: z.array(
                      z.object({
                        context: z.string(),
                        integration_id: z.number().nullable().optional(),
                      }),
                    ),
                  })
                  .parse(value.parameters)
                  .required_status_checks.map((check) => ({
                    context: check.context,
                    appId: check.integration_id ?? null,
                  })),
              );
      }
    }
    if (required) {
      for (const check of checks)
        check.required = required.some(
          (rule) =>
            rule.context === check.name &&
            (rule.appId === null || rule.appId === check.appId),
        )
          ? true
          : requirementsKnown
            ? false
            : null;
      for (const rule of required)
        if (
          !checks.some(
            (check) =>
              check.name === rule.context &&
              (rule.appId === null || rule.appId === check.appId),
          )
        )
          checks.push({
            name: rule.context,
            app: "required",
            appId: rule.appId,
            sha: pr.head.sha,
            url: null,
            required: true,
            state: "pending",
          });
    }
    let review: string | null = null;
    let unresolvedThreads: number | null = null;
    let mergeState = pr.mergeable_state ?? null;
    const detail = await optional("/graphql", {
      query:
        "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewDecision mergeStateStatus mergeQueueEntry{id} autoMergeRequest{enabledAt} reviewThreads(first:100){nodes{isResolved} pageInfo{hasNextPage}}}}}",
      variables: {
        owner: repo.split("/")[0],
        repo: repo.split("/")[1],
        number,
      },
    });
    const parsed = z
      .object({
        data: z
          .object({
            repository: z
              .object({
                pullRequest: z
                  .object({
                    reviewDecision: z.string().nullable(),
                    mergeQueueEntry: z
                      .object({ id: z.string() })
                      .nullable()
                      .optional(),
                    autoMergeRequest: z
                      .object({ enabledAt: z.string() })
                      .nullable()
                      .optional(),
                    mergeStateStatus: z.string().nullable(),
                    reviewThreads: z.object({
                      nodes: z.array(z.object({ isResolved: z.boolean() })),
                      pageInfo: z.object({ hasNextPage: z.boolean() }),
                    }),
                  })
                  .nullable(),
              })
              .nullable(),
          })
          .nullable()
          .optional(),
      })
      .safeParse(detail);
    const details = parsed.success
      ? parsed.data.data?.repository?.pullRequest
      : null;
    if (details) {
      review = details.reviewDecision;
      mergeState = details.mergeStateStatus;
      if (!details.reviewThreads.pageInfo.hasNextPage)
        unresolvedThreads = details.reviewThreads.nodes.filter(
          (value) => !value.isResolved,
        ).length;
    }
    const ci = !checks.length
      ? "no_checks"
      : checks.some((check) => check.state === "failed")
        ? "failing"
        : checks.some((check) => ["pending", "cancelled"].includes(check.state))
          ? "pending"
          : checks.some((check) => check.state === "unknown")
            ? "unknown"
            : "passing";
    return prSnapshotSchema.parse({
      files,
      repository: repo,
      number,
      remoteId: pr.node_id,
      url: pr.html_url,
      title: pr.title,
      state: pr.merged_at
        ? "merged"
        : pr.state === "closed"
          ? "closed"
          : pr.draft
            ? "draft"
            : "open",
      headSha: pr.head.sha,
      mergeSha: pr.merged_at ? pr.merge_commit_sha : null,
      mergedAt: pr.merged_at ?? null,
      baseBranch: pr.base.ref,
      updatedAt: pr.updated_at,
      observedAt: new Date().toISOString(),
      checks,
      requirementsKnown,
      ci,
      mergeState,
      mergeable: pr.mergeable ?? null,
      review,
      inMergeQueue:
        details?.mergeQueueEntry === undefined
          ? null
          : details.mergeQueueEntry !== null,
      autoMerge:
        details?.autoMergeRequest === undefined
          ? null
          : details.autoMergeRequest !== null,
      unresolvedThreads,
      coverage: await coverage(pr, config),
    });
  }
  return { discover, snapshot };
}
export type GithubClient = ReturnType<typeof createGithubClient>;
