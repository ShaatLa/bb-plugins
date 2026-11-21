import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { createFakeThreads, MANAGER } from "../attention/fixtures";
import { getChecksEnvironment } from "../global-settings";
import { registerChecks } from "./rpc";
import { checksService } from "./service";

export const BB_PROJECT = "proj_example";
export { MANAGER };

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Example", "-c", "user.email=example@example.com", ...args], { cwd, stdio: "pipe" }).toString();

const dirs: string[] = [];
export const tempDir = (prefix = "checks-test-") => { const dir = mkdtempSync(join(tmpdir(), prefix)); dirs.push(dir); return dir; };
export const cleanTempDirs = () => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); };

/** A fixture repository on a temp directory; its file:// URL stands in for a remote. */
export function createRepo() {
  const dir = tempDir("checks-repo-");
  git(dir, "init", "-q", "-b", "main");
  return {
    dir,
    url: `file://${dir}`,
    /** Writes files (executable when `mode` is given), commits them and returns the commit id. */
    commit(files: Record<string, string | { content: string; mode: number }>, message = "update") {
      for (const [path, entry] of Object.entries(files)) {
        const file = join(dir, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, typeof entry === "string" ? entry : entry.content);
        if (typeof entry !== "string") chmodSync(file, entry.mode);
      }
      git(dir, "add", "-A");
      git(dir, "commit", "-q", "--allow-empty", "-m", message);
      return git(dir, "rev-parse", "HEAD").trim();
    },
    git: (...args: string[]) => git(dir, ...args),
  };
}
export const executable = (body: string) => ({ content: `#!/bin/sh\n${body}\n`, mode: 0o755 });

/** Executable `name` files in a new directory, for fixture `bb`, `gh` and `git` commands. */
export function binDir(commands: Record<string, string>) {
  const dir = tempDir("checks-bin-");
  for (const [name, body] of Object.entries(commands)) {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  }
  return dir;
}

/** The runner, a tracker linked to one bb project, a fixture repository and an in-memory thread SDK. */
export async function setup(options: { settings?: Record<string, string> } = {}) {
  const threads = createFakeThreads();
  const repo = createRepo();
  const pushes: { title: string; body: string }[] = [];
  /** A fake Agent Hub `notice` receiver with the real one's idempotency on (source, tickId) and its input limits. Off until a test enables it. */
  const hub = {
    enabled: false,
    calls: [] as Record<string, unknown>[],
    items: new Map<string, { id: string }>(),
    /** Throws to refuse a call before anything is stored. */
    before: undefined as undefined | ((input: Record<string, unknown>) => void),
    /** Runs after the item is stored: throw to lose the reply, or return a malformed one. */
    after: undefined as undefined | ((reply: { id: string; created: boolean }, signal?: AbortSignal) => unknown),
    /** Replaces the in-memory receiver altogether (the opt-in live test forwards to a real Agent Hub). */
    forward: undefined as undefined | ((input: Record<string, unknown>) => Promise<unknown>),
  };
  const noticeCall = async (input: Record<string, unknown>, signal?: AbortSignal) => {
    hub.calls.push(input);
    if (hub.forward) return hub.forward(input);
    hub.before?.(input);
    const markdown = String(input.markdown ?? "");
    if (!input.source || !input.tickId || !input.projectId || !markdown || Buffer.byteLength(markdown) > 1024 * 1024 || String(input.title ?? "").length > 200) throw Object.assign(new Error("invalid input"), { code: "invalid_input", status: 400 });
    const key = `${input.source}:${input.tickId}`;
    const found = hub.items.get(key);
    const item = found ?? { id: `ans_example${hub.items.size + 1}` };
    hub.items.set(key, item);
    const reply = { id: item.id, created: !found };
    return hub.after ? hub.after(reply, signal) : reply;
  };
  const control = { hub, pushFail: false, remote: repo.url as string | null, projectFail: false, onProject: undefined as (() => void) | undefined, /** The installed Sweep, when a test installs one: its RPC handler. */ sweep: undefined as undefined | ((method: string, input: unknown) => Promise<unknown>) };
  /** The archived-worktree scan's view of the host. Off (no primary host) until a test calls `worktrees.enable()`. */
  const scan = {
    calls: 0, primaryHostId: null as string | null, storage: "" as string, sources: [] as { hostId: string; path: string }[],
    environments: [] as Record<string, unknown>[], threads: new Map<string, { archivedAt: number | null; deletedAt: number | null }>(),
  };
  const sdk = {
    ...threads.sdk,
    projects: { get: async () => { control.onProject?.(); if (control.projectFail) throw new Error("projects unavailable"); return { id: BB_PROJECT, gitRemoteUrl: control.remote, sources: scan.sources }; } },
    system: { config: async () => { scan.calls++; return { primaryHostId: scan.primaryHostId }; } },
    hosts: { get: async () => ({ threadStorageRootPath: scan.storage || null }) },
    environments: { list: async ({ limit, offset }: { limit: number; offset: number }) => scan.environments.slice(offset, offset + limit) },
    threads: {
      ...threads.sdk.threads,
      list: async ({ threadIds, archived }: { threadIds: string[]; archived?: boolean }) => threadIds.flatMap((id) => {
        const row = scan.threads.get(id);
        return row && (!archived || row.archivedAt != null) ? [{ id, ...row }] : [];
      }),
    },
    plugins: {
      list: async () => ({ plugins: [...(control.sweep ? [{ id: "sweep", enabled: true }] : []), { id: "agent-hub", enabled: hub.enabled }] }),
      callRpc: async ({ pluginId, method, input, outputSchema, signal }: { pluginId: string; method: string; input: { title: string; body: string }; outputSchema?: { parse(value: unknown): unknown }; signal?: AbortSignal }) => {
        if (pluginId === "agent-hub") {
          if (!hub.enabled || method !== "notice") throw new Error(`Plugin agent-hub cannot serve ${method}`);
          const value = await noticeCall(input as unknown as Record<string, unknown>, signal);
          return outputSchema ? outputSchema.parse(value) : value;
        }
        if (pluginId === "sweep") {
          if (!control.sweep) throw new Error("Plugin sweep is not installed");
          const value = await control.sweep(method, input);
          return outputSchema ? outputSchema.parse(value) : value;
        }
        if (pluginId !== "push-notifications" || method !== "notifications.send") throw new Error(`unexpected ${pluginId}.${method}`);
        if (control.pushFail) throw new Error("push unavailable");
        pushes.push(input);
        return {};
      },
    },
  };
  const host = createFakePluginHost({ pluginId: "work-board", sdk: sdk as never, settings: options.settings });
  const { bb, harness } = host;
  const store = createStore(bb);
  registerTasksApi(bb, store);
  registerChecks(bb);
  registerTasksCli(bb, store, { name: "Work Board", version: "test" });
  await getChecksEnvironment(bb); // defines the global settings
  const db = bb.storage.database();
  const service = checksService(bb);
  const tracker = store.tasks.createProject({ name: "Checks", prefix: "CHK", color: "blue", linkedBbProjectId: BB_PROJECT });
  const setManager = (manager: string | null) => db.prepare("INSERT INTO attention_manager(tracker_id, manager, changed_at, previous) VALUES (?, ?, ?, NULL) ON CONFLICT(tracker_id) DO UPDATE SET manager=excluded.manager").run(tracker.id, manager, new Date().toISOString());
  setManager(MANAGER);
  const script = (body: string, extra: Record<string, string | { content: string; mode: number }> = {}) => repo.commit({ "checks/run.sh": executable(body), ...extra });
  const io = tempDir("checks-io-");
  writeFileSync(join(io, "code.txt"), "0"); writeFileSync(join(io, "out.txt"), "");
  /** Commits the standard fixture script: it logs each run, prints out.txt, copies cand.txt as the candidate and exits with code.txt. */
  const standard = () => script(`echo run >> "${io}/runs.log"\ncat "${io}/out.txt"\nif [ -f "${io}/cand.txt" ]; then cp "${io}/cand.txt" "$BB_SWEEP_CANDIDATE_SNAPSHOT"; fi\nexit $(cat "${io}/code.txt")`);
  const output = (text: string, code = 0, candidate: string | null = null) => {
    writeFileSync(join(io, "out.txt"), text ? `${text}\n` : ""); writeFileSync(join(io, "code.txt"), String(code));
    if (candidate === null) rmSync(join(io, "cand.txt"), { force: true }); else writeFileSync(join(io, "cand.txt"), candidate);
  };
  const runs = () => { try { return readFileSync(join(io, "runs.log"), "utf8").trim().split("\n").length; } catch { return 0; } };
  const configure = (fields: Record<string, unknown> = {}) => {
    for (const [key, value] of Object.entries({ branch: "main", script: "checks/run.sh", ...fields })) service.setField(tracker.id, key as never, value);
  };
  /** Configures the runner and enables it. */
  const enable = (fields: Record<string, unknown> = {}) => { configure(fields); return service.setEnabled(tracker.id, true); };
  const tick = () => service.scheduledTick(tracker.id);
  const state = () => JSON.parse((db.prepare("SELECT value FROM checks_state WHERE tracker_id=?").get(tracker.id) as { value: string } | undefined)?.value ?? "{}");
  const delivery = () => db.prepare("SELECT * FROM checks_delivery WHERE tracker_id=?").get(tracker.id) as Record<string, unknown> | undefined;
  const attempts = () => db.prepare<[string], Record<string, unknown>>("SELECT * FROM checks_attempts WHERE tracker_id=? ORDER BY started_at, rowid").all(tracker.id);
  const sent = () => threads.rows.map((row) => threads.text(row)).join("\n");
  /** A second tracker on another bb project, for ownership tests. */
  const other = (link = BB_PROJECT) => store.tasks.createProject({ name: "Other", prefix: "OTH", color: "red", linkedBbProjectId: link });
  const sourceGit = (cwd: string, ...args: string[]) => git(cwd, ...args);
  /** Temporary repositories for the scan: a source repository, worktrees under a thread storage root, and thread records. */
  const worktrees = {
    scan,
    /** Turns the scan on with a fresh storage root and a source repository registered as a project source. */
    enable() {
      scan.primaryHostId = "host_example"; scan.storage = realpathSync(tempDir("checks-storage-"));
      const source = worktrees.makeRepo(realpathSync(tempDir("checks-source-")));
      scan.sources = [{ hostId: "host_example", path: source }];
      return source;
    },
    makeRepo(dir: string) { mkdirSync(dir, { recursive: true }); sourceGit(dir, "init", "-q", "-b", "main"); sourceGit(dir, "commit", "-q", "--allow-empty", "-m", "init"); return realpathSync(dir); },
    get source() { return scan.sources[0]!.path; },
    /** `git worktree add` of a new detached tree at storage/threadId/name; the thread is archived unless said otherwise. */
    add(threadId: string, name = "tree", { archived = true, deleted = false, under = scan.storage } = {}) {
      const path = join(under, threadId, name);
      mkdirSync(dirname(path), { recursive: true });
      sourceGit(worktrees.source, "worktree", "add", "-q", "--detach", path);
      scan.threads.set(threadId, { archivedAt: archived ? 1 : null, deletedAt: deleted ? 1 : null });
      return realpathSync(path);
    },
    remove(path: string) { sourceGit(worktrees.source, "worktree", "remove", "--force", path); },
  };
  return { ...host, worktrees, bb, store, db, service, tracker, threads, repo, pushes, control, harness, setManager, script, standard, output, runs, io, configure, enable, tick, state, delivery, attempts, sent, other, dispose: () => harness.dispose() };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
