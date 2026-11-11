// Shared synthetic CI data for tests. Neutral names only: real-data regressions live in *.local.test.ts.
import { deflateRawSync } from "node:zlib";
import type { ClassifiedJob, JobRecord } from "./ci-jobs-types";
import type { GitHubRequest } from "./metrics";

export const REPO = "acme/widgets";
export const SHA = "0123456789abcdef0123456789abcdef01234567";
export const failure = (message: string) => ({ level: "failure" as const, title: "", message });
export const LOSS = "The runner has received a shutdown signal to terminate.";
export const TIMEOUT = "The job running on runner runner-a has exceeded the maximum execution time of 30 minutes.";
export const SUPERSEDED = "Canceling since a higher priority waiting request for CI-feature exists";
export const MANUAL = "The run was canceled by @user-a.";

/** Minutes after 2026-11-05T10:00:00Z as an ISO string without milliseconds. */
export const at = (minutes: number, seconds = 0) => new Date(Date.UTC(2026, 10, 5, 10, minutes, seconds)).toISOString().replace(".000Z", "Z");

export const job = (over: Partial<JobRecord> = {}): JobRecord => ({ repository: REPO, runId: 1, attempt: 1, jobId: 1, workflowName: "CI", jobName: "Unit tests", event: "push", headBranch: "main", headSha: SHA, pullRequests: [],
  status: "completed", conclusion: "success", labels: ["self-hosted"], pool: "self-hosted", runnerName: "runner-a", runnerGroup: "default", createdAt: "2026-10-20T10:00:00Z",
  startedAt: "2026-10-20T10:00:05Z", completedAt: "2026-10-20T10:03:00Z", failedSteps: [], annotations: [], logExcerpt: null, carried: false, ...over });

/** A failed job on a pull request branch ("feature") that completed `minute` minutes after 10:00; override anything. */
export const failed = (over: Partial<JobRecord> = {}, minute = 5): JobRecord => job({ event: "pull_request", headBranch: "feature", conclusion: "failure", failedSteps: ["Run tests"],
  annotations: [failure("Process completed with exit code 1.")], createdAt: at(minute - 4), startedAt: at(minute - 3), completedAt: at(minute), ...over });

export const classify = (j: JobRecord, cls: ClassifiedJob["class"]): ClassifiedJob => ({ job: j, class: cls, reason: "", evidence: null });

type RawJob = { id: number; name: string; status: string; conclusion: string | null; created_at: string; started_at: string; completed_at: string; labels: string[]; runner_name: string; runner_group_name: string;
  steps: { name: string; conclusion: string | null }[]; annotations: { level: string; title: string; message: string }[] };
export type RunFixture = { run: { id: number; name: string; event: string; head_branch: string; head_sha: string; pull_requests: number[]; run_attempt: number; status: string; conclusion: string | null; created_at: string }; attempts: Record<string, RawJob[]> };

/** One run with three attempts (4 jobs each, so listings paginate): attempt 2 and 3 repeat earlier jobs unchanged ("carried"). */
export function syntheticRun(): RunFixture {
  const raw = (id: number, name: string, conclusion: string, start: number, end: number, extra: Partial<RawJob> = {}): RawJob => ({ id, name, status: "completed", conclusion, created_at: at(start - 1), started_at: at(start), completed_at: at(end),
    labels: ["self-hosted"], runner_name: ["runner-a", "runner-b", "runner-c"][id % 3]!, runner_group_name: "default", steps: [], annotations: [], ...extra });
  const step = (name: string) => [{ name, conclusion: "failure" }];
  return { run: { id: 1001, name: "CI", event: "pull_request", head_branch: "feature", head_sha: SHA, pull_requests: [], run_attempt: 3, status: "completed", conclusion: "success", created_at: at(-1) }, attempts: {
    1: [raw(11, "Unit tests", "success", 0, 3), raw(12, "Integration tests", "failure", 0, 10, { steps: step("Run tests"), annotations: [failure("Process completed with exit code 1.")] }),
      raw(13, "Lint", "failure", 0, 2, { steps: step("Run lint"), annotations: [failure(LOSS)] }), raw(14, "CI summary", "cancelled", 10, 11)],
    2: [raw(21, "Unit tests", "success", 0, 3), raw(22, "Integration tests", "failure", 20, 28, { steps: step("Run tests"), annotations: [failure("Process completed with exit code 1.")] }),
      raw(23, "Lint", "success", 20, 22), raw(24, "CI summary", "failure", 28, 29, { steps: step("Check needs"), annotations: [failure("Process completed with exit code 1.")] })],
    3: [raw(31, "Unit tests", "success", 0, 3), raw(32, "Integration tests", "success", 40, 47), raw(33, "Lint", "success", 20, 22), raw(34, "CI summary", "success", 47, 48)],
  } };
}

export const runContext = (data: RunFixture, attempt: number) => ({ id: data.run.id, attempt, workflowName: data.run.name, event: data.run.event, headBranch: data.run.head_branch, headSha: data.run.head_sha, pullRequests: data.run.pull_requests });

/** A fake GitHub API serving a RunFixture: jobs split over two pages, annotations per job, every path recorded. */
export function fakeGithub(data: RunFixture) {
  const calls: string[] = [];
  const request: GitHubRequest = async (path) => {
    calls.push(path);
    if (path.includes("/annotations?")) {
      const jobId = Number(path.match(/check-runs\/(\d+)/)![1]), found = Object.values(data.attempts).flat().find((j) => j.id === jobId);
      return { body: (found?.annotations ?? []).map(({ level, ...rest }) => ({ annotation_level: level, ...rest })), hasNext: false };
    }
    const jobs = data.attempts[path.match(/attempts\/(\d+)/)![1]!]!, page = Number(path.match(/page=(\d+)$/)![1]), midpoint = Math.ceil(jobs.length / 2);
    return { body: { jobs: page === 1 ? jobs.slice(0, midpoint) : jobs.slice(midpoint) }, hasNext: page === 1 && midpoint < jobs.length };
  };
  return { request, calls };
}

// A minimal zip writer: stored and deflated entries, CRC left zero (the reader ignores it).
export function zip(entries: { name: string; data: string | Buffer; deflate?: boolean }[]): Buffer {
  const parts: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const { name, data, deflate } of entries) {
    const raw = Buffer.from(data), packed = deflate ? deflateRawSync(raw) : raw, label = Buffer.from(name), method = deflate ? 8 : 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(method, 8); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(label.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(method, 10); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(label.length, 28); entry.writeUInt32LE(offset, 42);
    parts.push(local, label, packed); directory.push(entry, label); offset += 30 + label.length + packed.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, central, end]);
}
