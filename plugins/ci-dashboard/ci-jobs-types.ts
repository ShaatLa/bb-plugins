// Shared job-level CI types for 0.2.x signals. Producers: ci-jobs.ts, ci-live.ts. Consumers: ci-classify.ts, server.ts, app.

export type JobAnnotation = { level: "failure" | "warning" | "notice"; title: string; message: string };

/** Result of scanning a failed job for user-configured known-flake signatures; `rules` is the version of the rules and artifact globs it was scanned with. */
export type JobSignature = { rules: string; label: string | null; match: string | null; source: "annotation" | "log" | "artifact" | null };

/** One job of one run attempt, normalized from GET /actions/runs/{id}/attempts/{n}/jobs. */
export type JobRecord = {
  repository: string;
  runId: number;
  attempt: number;
  jobId: number;
  workflowName: string;
  jobName: string;
  event: string;
  headBranch: string | null;
  headSha: string;
  pullRequests: number[];
  status: string; // queued | in_progress | completed | waiting | pending | requested
  conclusion: string | null;
  labels: string[];
  /** First runs-on label, e.g. "self-hosted-pool", "ubuntu-latest". */
  pool: string | null;
  runnerName: string | null;
  runnerGroup: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  failedSteps: string[];
  /** Only fetched for failure/cancelled jobs; notice-level entries are dropped. */
  annotations: JobAnnotation[];
  /** Up to 30 log lines before the first "##[error]" line; only fetched for transient candidates. */
  logExcerpt: string | null;
  /**
   * True when this attempt's listing repeats an earlier attempt's job without re-executing it
   * (same jobName in attempt-1 with identical startedAt and completedAt). Carried jobs get new ids.
   * Every duration, runner-minute and count must skip carried jobs.
   */
  carried: boolean;
  /** Absent until scanned; a stored result only counts while `rules` equals the current rules version. */
  signature?: JobSignature;
  /** Written by the scan: the package, suite or log line showing a build or setup failure (a deterministic failure, never a flake); null when scanned and none found. */
  buildFailure?: { match: string } | null;
};

export type FailureClass =
  | "runner_loss" // runner lost communication / shutdown signal / failed with no failed step
  | "timeout" // job exceeded the maximum execution time
  | "transient" // tool or network failure (HTTP 5xx, download refused, ECONNRESET...) found in logExcerpt
  | "flake" // real failed step; the same job passed at the same headSha in some run, or its failure matches a configured known-flake signature
  | "real" // real failed step; the job never passed at this headSha
  | "refused" // a failed step listed in the refusalSteps setting: an intentional gate refusal, nobody needs to act
  | "consequence" // aggregator job (e.g. "CI summary job") failed or cancelled because another job did
  | "superseded" // cancelled by concurrency: "Canceling since a higher priority waiting request..."
  | "manual_cancel" // "The run was canceled by @user"
  | "collateral_cancel" // only "The operation was canceled." (fail-fast or run-level cancel)
  | "unknown";

export type ClassifiedJob = { job: JobRecord; class: FailureClass; reason: string; evidence: string | null; /** Set when a known-flake signature made this a flake. */ flakeLabel?: string };

/** Static role that acts on a signal; mapped to a display name in settings. */
export type Actor = "owner_sre" | "pr_author" | "lead" | "manager";

export type SignalKind = "pool_stall" | "runner_loss" | "mass_cancel" | "rerun_failed" | "flake" | "transient" | "timeout";

export type Signal = {
  /** Stable dedup key for one continuous incident, e.g. "pool_stall:self-hosted-pool". One push per opening. */
  id: string;
  kind: SignalKind;
  severity: "critical" | "warning" | "info";
  title: string;
  what: string;
  where: { pool?: string; runId?: number; attempt?: number; jobId?: number; jobName?: string; runnerName?: string; branch?: string | null; headSha?: string; pullRequests?: number[]; url?: string };
  since: string;
  until: string | null;
  impact: string;
  actor: Actor;
  open: boolean;
};

export type PoolQueueState = {
  pool: string;
  queued: number;
  inProgress: number;
  oldestQueuedAt: string | null;
  lastStartedAt: string | null;
  queuedRunIds: number[];
};

export type RerunSummary = {
  runId: number;
  event: string;
  workflowName: string;
  headSha: string;
  headBranch: string | null;
  attempts: number;
  /** Per attempt, worst conclusion of the jobs that actually executed in it (non-carried). */
  outcomes: Array<string | null>;
  finalConclusion: string | null;
  /** Runner time spent by non-carried jobs in attempts >= 2. */
  repeatedRunnerMs: number;
};
