// Breadcrumbs: stable refs that index views and observer lines hand out and ci_dashboard_metrics (ref=...) resolves.
// Pure and shared by the server, the agent views and the observer; refs name ids and labels only, never log text.

export type Ref =
  | { kind: "problem"; id: string }
  | { kind: "run"; runId: number; attempt?: number }
  | { kind: "job"; jobId: number }
  | { kind: "queue"; runId: number; attempt: number }
  | { kind: "pool"; pool: string }
  | { kind: "pr"; number: number }
  | { kind: "sha"; sha: string };

/** The accepted forms, shown in tool descriptions, SKILL.md and every parse error. */
export const REF_FORMS = [
  "job:<jobId>", "run:<runId>[:<attempt>]", "queue:<runId>:<attempt>", "pool:<name>", "pr:<number>", "sha:<sha or prefix of 7+ hex chars>",
  "a problem or signal id: run:streak:<runId>, run:main:<runId>, runner_loss:<jobId>, flake:<jobId>, transient:<jobId>, timeout:<jobId>, rerun_failed:<runId>:<attempt>, pool_stall:<pool>, mass_cancel:<iso time>",
];

// Ids that Signal and Problem use; `run:streak:` / `run:main:` are run-level alerts and must be told apart from `run:<runId>`.
const PROBLEM = /^(?:(?:pool_stall|runner_loss|mass_cancel|rerun_failed|flake|transient|timeout):.+|run:(?:streak|main):\d+)$/;
const NUMBER = /^[1-9]\d{0,15}$/;

export function parseRef(text: string): Ref {
  const ref = text.trim(), parts = ref.split(":"), [head = "", a, b] = parts;
  const fail = (): never => { throw new Error(`Unknown ref "${ref.slice(0, 80)}". Accepted forms: ${REF_FORMS.join("; ")}.`); };
  const number = (value: string | undefined) => value !== undefined && NUMBER.test(value) ? Number(value) : fail();
  if (PROBLEM.test(ref)) return { kind: "problem", id: ref };
  if (head === "run" && parts.length <= 3 && a !== undefined) return { kind: "run", runId: number(a), ...(b === undefined ? {} : { attempt: number(b) }) };
  if (head === "job" && parts.length === 2) return { kind: "job", jobId: number(a) };
  if (head === "queue" && parts.length === 3) return { kind: "queue", runId: number(a), attempt: number(b) };
  if (head === "pr" && parts.length === 2) return { kind: "pr", number: number(a) };
  if (head === "pool" && ref.length > 5) return { kind: "pool", pool: ref.slice(5) };
  if (head === "sha" && parts.length === 2 && /^[0-9a-f]{7,40}$/i.test(a!)) return { kind: "sha", sha: a!.toLowerCase() };
  return fail();
}

export const runRef = (runId: number, attempt?: number) => `run:${runId}${attempt === undefined ? "" : `:${attempt}`}`;
export const jobRef = (jobId: number) => `job:${jobId}`;
export const queueRef = (runId: number, attempt: number) => `queue:${runId}:${attempt}`;
export const poolRef = (pool: string) => `pool:${pool}`;
export const prRef = (number: number) => `pr:${number}`;
export const shaRef = (sha: string) => `sha:${sha.slice(0, 7)}`;

/** The most specific ref of what a row or signal is about: its job, else its run, else its pool. */
export const whereRef = (where: { jobId?: number; runId?: number; attempt?: number; pool?: string }) =>
  where.jobId !== undefined ? jobRef(where.jobId) : where.runId !== undefined ? runRef(where.runId, where.attempt) : where.pool ? poolRef(where.pool) : undefined;

/** Up to `max` refs of a problem for index rows: job, run, queue (merge_group runs), pool; a mass cancel names its newest runs. */
export function problemRefs(problem: { id: string; where: { jobId?: number; runId?: number; attempt?: number; pool?: string } },
  context: { failures?: { runId: number; attempt: number; event: string }[]; massCancels?: { since: string; runIds: number[] }[] } = {}, max = 4): string[] {
  const { where } = problem, out: string[] = [];
  if (where.jobId !== undefined) out.push(jobRef(where.jobId));
  if (where.runId !== undefined) out.push(runRef(where.runId, where.attempt));
  const inQueue = where.runId === undefined ? undefined : context.failures?.find((row) => row.runId === where.runId && row.event === "merge_group" && (where.attempt === undefined || row.attempt === where.attempt));
  if (inQueue) out.push(queueRef(inQueue.runId, inQueue.attempt));
  if (where.pool) out.push(poolRef(where.pool));
  const group = problem.id.startsWith("mass_cancel:") ? context.massCancels?.find((item) => `mass_cancel:${item.since}` === problem.id) : undefined;
  if (group) out.push(...[...group.runIds].sort((a, b) => b - a).map((id) => runRef(id)));
  return out.slice(0, max);
}

/** Newest first, de-duplicated, at most `max`; the rest is summarized as "+N more" so an agent knows the list was cut. */
export function cap(refs: { ref: string; at: number }[], max = 12): string[] {
  const seen = new Set<string>(), unique = refs.filter(({ ref }) => !seen.has(ref) && seen.add(ref)).sort((a, b) => b.at - a.at).map(({ ref }) => ref);
  return unique.length > max ? [...unique.slice(0, max), `+${unique.length - max} more`] : unique;
}
