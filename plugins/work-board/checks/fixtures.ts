import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const control = { pushFail: false, remote: repo.url as string | null, projectFail: false, onProject: undefined as (() => void) | undefined };
  const sdk = {
    ...threads.sdk,
    projects: { get: async () => { control.onProject?.(); if (control.projectFail) throw new Error("projects unavailable"); return { id: BB_PROJECT, gitRemoteUrl: control.remote }; } },
    plugins: {
      callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: { title: string; body: string } }) => {
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
  return { ...host, bb, store, db, service, tracker, threads, repo, pushes, control, harness, setManager, script, standard, output, runs, io, configure, enable, tick, state, delivery, attempts, sent, other, dispose: () => harness.dispose() };
}
export type Fixture = Awaited<ReturnType<typeof setup>>;
