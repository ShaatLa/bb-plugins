import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative } from "node:path";

/** The checkout could not be refreshed, so the script did not run. */
export class CheckoutRefreshError extends Error {}

export const OUTPUT_LIMIT_BYTES = 1_000_000;
export const GIT_TIMEOUT_MS = 60_000;
/** How long a timed-out command's process group gets after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 1000;

function missingIsNull(error: NodeJS.ErrnoException) {
  if (error.code !== "ENOENT") throw error;
  return null;
}

export interface CommandOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** A lock file this command may create; after a timeout, a lock that did not exist before it started is removed. */
  shallowLock?: string;
  killGraceMs?: number;
}

/**
 * Runs one command and captures its UTF-8 stdout and stderr (at most 1 MB). On POSIX the command leads its own process group,
 * so a timeout or a shutdown ends its helpers too: SIGTERM, then SIGKILL, and the result waits for the exit.
 */
export async function command(cmd: string, args: string[], cwd: string, signal: AbortSignal, options: CommandOptions = {}): Promise<{ code: number; output: string }> {
  const { timeoutMs = GIT_TIMEOUT_MS, env = process.env, shallowLock, killGraceMs = KILL_GRACE_MS } = options;
  const couldCreateLock = !!shallowLock && !(await lstat(shallowLock).catch(missingIsNull));
  const grouped = process.platform !== "win32";
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, detached: grouped, stdio: ["ignore", "pipe", "pipe"] });
    let output = "", bytes = 0, failure: Error | undefined, timedOut = false, settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const killGroup = (sig: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch (error) {
        // The group is already gone (ESRCH), or only a zombie is left that macOS refuses to signal (EPERM).
        if (!["ESRCH", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    };
    const finish = (done: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(escalation);
      signal.removeEventListener("abort", onAbort);
      done();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      failure ??= new Error(`${cmd} timed out`);
      killGroup("SIGTERM");
      escalation = setTimeout(() => killGroup("SIGKILL"), killGraceMs);
    }, timeoutMs);
    const onAbort = () => { failure ??= signal.reason instanceof Error ? signal.reason : new Error("aborted"); killGroup("SIGKILL"); };
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    const collect = (chunk: string) => {
      if (failure) return;
      output += chunk; bytes += Buffer.byteLength(chunk);
      if (bytes > OUTPUT_LIMIT_BYTES) { failure = new Error(`${cmd} output exceeds 1 MB`); killGroup("SIGKILL"); }
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", (error) => {
      failure ??= error;
      // A command that never started has no exit to wait for.
      if (!child.pid) finish(() => reject(failure));
    });
    child.on("close", async (code, sig) => {
      if (timedOut || failure) killGroup("SIGKILL"); // helpers that outlived the command
      if (timedOut && couldCreateLock) {
        try {
          // The private checkout has one runner: a lock that preceded this command stays, one it created goes.
          const lock = await lstat(shallowLock!).catch(missingIsNull);
          if (lock?.isFile()) await unlink(shallowLock!).catch(missingIsNull);
        } catch (cause) {
          finish(() => reject(new Error(`${failure?.message}; could not clear shallow.lock: ${String(cause)}`, { cause })));
          return;
        }
      }
      finish(() => {
        if (failure) reject(failure);
        else if (code === null) reject(new Error(`${cmd} killed by ${sig}`));
        else resolve({ code, output });
      });
    });
  });
}

/** Brings the tracker's private checkout to the tip of `branch`: depth-1 fetch, forced detached checkout, ignored files cleaned. */
export async function refreshCheckout(root: string, remote: string, branch: string, signal: AbortSignal, gitTimeoutMs = GIT_TIMEOUT_MS, killGraceMs = KILL_GRACE_MS) {
  const git = async (args: string[], shallowLock?: string) => {
    // No prompts and no hooks: the checkout belongs to the runner alone.
    const result = await command("git", ["-c", "core.hooksPath=/dev/null", ...args], root, signal, { timeoutMs: gitTimeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, shallowLock, killGraceMs });
    if (result.code) throw new Error(result.output);
  };
  try {
    await mkdir(root, { recursive: true });
    await git(["init"]);
    try { await git(["remote", "get-url", "origin"]); } catch { await git(["remote", "add", "origin", remote]); }
    await git(["remote", "set-url", "origin", remote]);
    await git(["fetch", "--depth=1", "--", remote, branch], join(root, ".git", "shallow.lock"));
    await git(["checkout", "--force", "--detach", "FETCH_HEAD"]);
    await git(["clean", "-ffdx"]);
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new CheckoutRefreshError(`Checkout refresh failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

export interface ScriptRun {
  remote: string;
  branch: string;
  script: string;
  args: string[];
  timeoutSeconds: number;
  snapshots: boolean;
  bbProjectId: string;
  manager: string;
  /** The stored bytes of the committed snapshot; null when there is none for this bb project. */
  committed: Buffer | null;
  /** The absolute `bb` (empty: use the inherited BB_CLI) and PATH entries (empty: inherit the server PATH). */
  bbCli: string;
  runtimePath: string;
  gitTimeoutMs?: number;
  killGraceMs?: number;
}

/** The script's environment: HOME and auth are inherited; PATH puts the `bb` directory first so bare `bb` and BB_CLI agree. */
export function scriptEnvironment(run: Pick<ScriptRun, "bbCli" | "runtimePath" | "bbProjectId" | "manager">, committed: string, candidate: string): NodeJS.ProcessEnv {
  if (run.bbCli && !isAbsolute(run.bbCli)) throw new Error("Set checksBbCli to the absolute path to bb (for example /opt/bin/bb), or clear it to use the server environment.");
  const bb = run.bbCli || process.env.BB_CLI || "";
  return {
    ...process.env,
    PATH: [bb && isAbsolute(bb) ? dirname(bb) : "", run.runtimePath || process.env.PATH || ""].filter(Boolean).join(delimiter),
    ...(run.bbCli ? { BB_CLI: run.bbCli } : {}),
    BB_PROJECT_ID: run.bbProjectId,
    BB_THREAD_ID: run.manager,
    // Both names are always exported, whatever the snapshots setting says; the script reads them.
    BB_SWEEP_COMMITTED_STATE: committed,
    BB_SWEEP_CANDIDATE_SNAPSHOT: candidate,
  };
}

/** Refreshes the checkout and runs the script in it. Throws CheckoutRefreshError when the refresh fails. */
export async function execute(base: string, trackerId: string, run: ScriptRun, signal: AbortSignal) {
  const root = join(base, "checks", "checkouts", trackerId);
  await refreshCheckout(root, run.remote, run.branch, signal, run.gitTimeoutMs, run.killGraceMs);
  const script = await realpath(join(root, run.script)), rel = relative(await realpath(root), script);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) throw new Error("Set script to a path inside the checkout, for example checks/run.py. Its symlinks must also resolve inside the checkout.");
  await mkdir(join(base, "checks"), { recursive: true });
  const temp = await mkdtemp(join(base, "checks", "run-"));
  try {
    const committed = join(temp, "committed.json"), candidate = join(temp, "candidate.json");
    if (run.committed) await writeFile(committed, run.committed, { mode: 0o400 });
    const env = scriptEnvironment(run, committed, candidate);
    const args = run.args.map((arg) => arg.replaceAll("{manager}", run.manager));
    const python = script.endsWith(".py");
    const result = await command(python ? "python3" : script, [...(python ? [script] : []), ...args, ...(run.snapshots ? ["--committed-state", committed, "--candidate-snapshot", candidate] : [])], root, signal, { timeoutMs: run.timeoutSeconds * 1000, env, killGraceMs: run.killGraceMs });
    let snapshot: Buffer | null = null;
    if (run.snapshots && result.code <= 1) {
      snapshot = await readFile(candidate).catch(missingIsNull);
      if (snapshot) {
        try { JSON.parse(snapshot.toString("utf8")); }
        catch (cause) { throw new Error("Write a complete JSON document to --candidate-snapshot, or omit the candidate if nothing needs acknowledgement.", { cause }); }
      }
    }
    return { ...result, snapshot };
  } finally { await rm(temp, { recursive: true, force: true }); }
}
