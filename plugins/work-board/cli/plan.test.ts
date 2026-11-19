import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isUtf8 } from "node:buffer";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../server";

const directories: string[] = [];
const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(disposers.splice(0).map((dispose) => dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const filesSdk = {
  read: async ({ path }: { path: string }) => {
    const stats = await stat(path).catch(() => null);
    if (!stats?.isFile()) throw new Error(`Path does not exist: ${path}`);
    const contents = await readFile(path);
    const contentEncoding = isUtf8(contents) ? "utf8" : "base64";
    return { path, content: contents.toString(contentEncoding), contentEncoding, sizeBytes: stats.size };
  },
};

const PLAN = ["# Plan", "", "## Steps 1–4", "- first", "- second", "", "## Risks", "None.", ""].join("\n");

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "plan-cli-"));
  directories.push(dir);
  const { bb, harness } = createFakePluginHost({ pluginId: "work-board", sdk: { files: filesSdk as never, threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }) } } });
  disposers.push(() => harness.dispose());
  await plugin(bb);
  await harness.runCli(["project", "create", "--name", "Example", "--prefix", "EXA"]);
  await harness.runCli(["create", "--project", "EXA", "--title", "Planned work"]);
  const file = async (name: string, content: string) => {
    const path = join(dir, name);
    await writeFile(path, content);
    return path;
  };
  const run = (args: string[], threadId?: string) => harness.runCli(args, threadId ? { threadId } : undefined);
  const ok = async (args: string[], threadId?: string) => {
    const result = await run(args, threadId);
    expect(result, result.stderr).toMatchObject({ exitCode: 0, stderr: "" });
    return result.stdout;
  };
  return { bb, harness, dir, file, run, ok };
}

describe("bb work-board plan", () => {
  it("creates the first version from a file and shows header, base version and body", async () => {
    const { file, ok, run } = await setup();
    const missing = await run(["plan", "show", "EXA-1"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr).toContain("has no plan yet");
    expect(JSON.parse(await ok(["plan", "show", "EXA-1", "--json"]))).toEqual({ plan: null });

    const path = await file("plan.md", PLAN);
    const saved = await ok(["plan", "set", "EXA-1", "--file", path, "--base-version", "0", "--summary", "Initial plan"], "thr_example");
    expect(saved).toContain("EXA-1 plan saved as v1");
    expect(saved).toContain("Next edit: --base-version 1");

    const shown = await ok(["plan", "show", "EXA-1"]);
    expect(shown.split("\n").slice(0, 2)).toEqual([
      expect.stringMatching(/^Plan v1 · draft · updated \S+ by agent \(thr_example\)$/),
      "Next edit: --base-version 1",
    ]);
    expect(shown.endsWith(`\n\n${PLAN}`)).toBe(true);

    const section = await ok(["plan", "show", "EXA-1", "--section", "Steps 1–4"]);
    expect(section).toContain("Section: Steps 1–4");
    expect(section.endsWith("## Steps 1–4\n- first\n- second")).toBe(true);
    const json = JSON.parse(await ok(["plan", "show", "EXA-1", "--json"]));
    expect(json).toMatchObject({ taskKey: "EXA-1", plan: { version: 1, state: "draft", updatedBy: { kind: "agent", threadId: "thr_example" } }, body: PLAN, section: null });
    const unknown = await run(["plan", "show", "EXA-1", "--section", "Nope"]);
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("Available headings");
    expect(unknown.stderr).toContain("Plan > Steps 1–4");
  });

  it("accepts --body, records a person author without a thread and rejects both inputs", async () => {
    const { ok, run, file } = await setup();
    await ok(["plan", "set", "EXA-1", "--body", "# Inline", "--base-version", "0", "--summary", "Inline"]);
    const log = JSON.parse(await ok(["plan", "log", "EXA-1", "--json"]));
    expect(log.versions[0].author).toEqual({ kind: "person", threadId: null, name: "cli" });
    const both = await run(["plan", "set", "EXA-1", "--body", "x", "--file", await file("a.md", "x"), "--base-version", "1", "--summary", "s"]);
    expect(both.exitCode).toBe(1);
  });

  it("edits one section and one fragment, refuses stale bases and prints the current version", async () => {
    const { file, ok, run } = await setup();
    await ok(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial plan"]);

    const part = await file("part.md", "## Steps 1–4\n- only\n");
    expect(await ok(["plan", "edit", "EXA-1", "--section", "Steps 1–4", "--file", part, "--base-version", "1", "--summary", "Trim"])).toContain("saved as v2 · +1 −2 lines");
    expect((await ok(["plan", "show", "EXA-1"])).endsWith("## Steps 1–4\n- only\n\n## Risks\nNone.\n")).toBe(true);

    const find = await file("find.md", "None.");
    const replace = await file("replace.md", "Low.");
    expect(await ok(["plan", "edit", "EXA-1", "--find-file", find, "--replace-file", replace, "--base-version", "2", "--summary", "Rate"])).toContain("saved as v3");
    expect(await ok(["plan", "show", "EXA-1", "--section", "Risks"])).toContain("Low.");

    const stale = await run(["plan", "edit", "EXA-1", "--section", "Risks", "--body", "## Risks\nNew", "--base-version", "2", "--summary", "Late"]);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toMatch(/current version is v3.*plan show EXA-1.*--base-version 3/s);

    const repeated = await run(["plan", "edit", "EXA-1", "--find-file", await file("hash.md", "#"), "--replace-file", replace, "--base-version", "3", "--summary", "Many"]);
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toMatch(/matches/);
    const noChange = await run(["plan", "edit", "EXA-1", "--find-file", replace, "--replace-file", replace, "--base-version", "3", "--summary", "Same"]);
    expect(noChange.stderr).toContain("No change");

    const mixed = await run(["plan", "edit", "EXA-1", "--find-file", find, "--replace-file", replace, "--body", "x", "--base-version", "3", "--summary", "Mixed"]);
    expect(mixed.exitCode).toBe(1);
    const neither = await run(["plan", "edit", "EXA-1", "--section", "Risks", "--base-version", "3", "--summary", "Nothing"]);
    expect(neither.stderr).toContain("--section needs the new section");
    const noMode = await run(["plan", "edit", "EXA-1", "--base-version", "3", "--summary", "Nothing"]);
    expect(noMode.exitCode).toBe(1);
  });

  it("tolerates the trailing newline of fragment files and a section copied with its hashes", async () => {
    const { file, ok } = await setup();
    await ok(["plan", "set", "EXA-1", "--body", "# Plan\n\n## Notes\nlast line", "--base-version", "0", "--summary", "Initial"]);
    const find = await file("find.md", "last line\n");
    const replace = await file("replace.md", "final line\n");
    expect(await ok(["plan", "edit", "EXA-1", "--find-file", find, "--replace-file", replace, "--base-version", "1", "--summary", "Fragment"])).toContain("saved as v2");
    expect(await ok(["plan", "show", "EXA-1", "--section", "## Notes"])).toContain("## Notes\nfinal line");
  });

  it("restores a version, lists the log and diffs versions", async () => {
    const { ok, run } = await setup();
    await ok(["plan", "set", "EXA-1", "--body", "a\nb\n", "--base-version", "0", "--summary", "One"]);
    await ok(["plan", "set", "EXA-1", "--body", "a\nc\nd\n", "--base-version", "1", "--summary", "Two"], "thr_example");
    expect(await ok(["plan", "restore", "EXA-1", "--version", "1", "--base-version", "2", "--summary", "Undo"])).toContain("saved as v3");

    const log = await ok(["plan", "log", "EXA-1"]);
    expect(log).toMatch(/v1 .* cli .* create .* \+2 −0 lines .* One/);
    expect(log).toMatch(/v2 .* agent \(thr_example\) .* replace .* \+2 −1 lines .* Two/);
    expect(log).toMatch(/v3 .* restore v1 .* \+1 −2 lines .* Undo/);
    expect(JSON.parse(await ok(["plan", "log", "EXA-1", "--json"])).versions).toHaveLength(3);

    const diff = await ok(["plan", "diff", "EXA-1", "--from", "1", "--to", "2"]);
    expect(diff).toContain("EXA-1 plan v1 → v2 · +2 −1 lines");
    expect(diff).toContain("-b");
    expect(diff).toContain("+c");
    expect(await ok(["plan", "diff", "EXA-1"])).toContain("v2 → v3");
    expect(JSON.parse(await ok(["plan", "diff", "EXA-1", "--from", "0", "--to", "1", "--json"]))).toMatchObject({ from: 0, to: 1, added: 2, removed: 0 });
    expect((await run(["plan", "diff", "EXA-1", "--to", "9"])).stderr).toContain("does not exist");
    expect(await ok(["plan", "show", "EXA-1", "--version", "1"])).toContain("Showing historical v1");
  });

  it("submits the plan for review", async () => {
    const { ok, run } = await setup();
    expect((await run(["plan", "submit", "EXA-1"])).stderr).toContain("no plan to submit");
    await ok(["plan", "set", "EXA-1", "--body", "# Plan", "--base-version", "0", "--summary", "Initial"]);
    expect(await ok(["plan", "submit", "EXA-1"])).toBe("EXA-1 plan v1 submitted for review");
    expect((await run(["plan", "submit", "EXA-1"])).stderr).toContain("already in review");
    expect(await ok(["plan", "show", "EXA-1"])).toContain("Plan v1 · in_review");
    const comments = JSON.parse(await ok(["comment", "list", "EXA-1", "--kind", "system", "--json"]));
    expect(JSON.stringify(comments)).toContain("Plan v1 submitted for review by cli");
  });

  it("adds one plan line to show, and the full plan only with --with-plan", async () => {
    const { ok } = await setup();
    expect(await ok(["show", "EXA-1"])).toMatch(/^Plan\s+-$/m);
    expect(JSON.parse(await ok(["show", "EXA-1", "--json"])).plan).toBeNull();

    await ok(["plan", "set", "EXA-1", "--body", PLAN, "--base-version", "0", "--summary", "Initial"], "thr_example");
    await ok(["plan", "submit", "EXA-1"]);
    const text = await ok(["show", "EXA-1"]);
    expect(text).toMatch(/^Plan\s+v1 · in_review · bb work-board plan show EXA-1$/m);
    expect(text).not.toContain("- first");
    const withPlan = await ok(["show", "EXA-1", "--with-plan"]);
    expect(withPlan).toContain("Plan v1 (in_review)\n# Plan");
    expect(withPlan.indexOf("Description\n")).toBeLessThan(withPlan.indexOf("Plan v1 (in_review)"));

    const json = JSON.parse(await ok(["show", "EXA-1", "--json"]));
    expect(json.plan).toEqual({ version: 1, state: "in_review", updatedAt: expect.any(String), updatedBy: "agent (thr_example)" });
    expect(JSON.parse(await ok(["show", "EXA-1", "--json", "--with-plan"])).plan.body).toBe(PLAN);
  });
});
