import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createStore, registerTasksApi } from "../api";
import { registerTasksCli } from "../cli";
import { tasksRpcContract } from "./contract";
import { assertNoSecrets, SecretDetectedError } from "./secret-guard";

// Synthetic fixtures are assembled to avoid storing token-shaped strings in source.
const token = (prefix: string, length: number) => prefix + "a".repeat(length);
const secret = token("ghp_", 36);

describe("write-time secret guard", () => {
  it.each([
    ...["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_"].map((prefix) => ["GitHub token", token(prefix, 82)]),
    ["AWS access key", "AKIA" + "A".repeat(16)],
    ["AWS access key", "ASIA" + "B".repeat(16)],
    ["AWS secret key", 'aws_secret_access_key = "' + "aB/1".repeat(10) + '"'],
    ["private key", ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ")],
    ["private key", ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")],
    ...["a", "b", "p", "r", "s"].map((type) => ["Slack token", token(`xox${type}-`, 32)]),
    ["Google API key", token("AIza", 35)],
    ["JWT", [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from('{"sub":"test"}').toString("base64url"), "s".repeat(32)].join(".")],
    ["Anthropic API key", token("sk-ant-api03-", 80)],
    ["OpenAI API key", token("sk-", 48)],
    ["OpenAI API key", token("sk-proj-", 120)],
    ["OpenAI API key", token("sk-svcacct-", 100)],
  ])("rejects %s without echoing the value", (pattern, value) => {
    for (const field of ["title", "description", "comment body"]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          assertNoSecrets(`Before\n${value}\nAfter`, field);
          expect.fail("Expected secret rejection");
        } catch (error) {
          expect(error).toBeInstanceOf(SecretDetectedError);
          expect((error as Error).message).toContain(field);
          expect((error as Error).message).toContain(pattern);
          expect((error as Error).message).not.toContain(value);
        }
      }
    }
  });

  it("allows ordinary text, references and placeholders", () => {
    for (const text of [undefined, "", "Use $OPENAI_API_KEY from the environment.", "ghp_<redacted> sk-... sk-your-key-here", "AWS AKIA/ASIA key names, JWT signing, private key rotation", "Task TSK-12: add GitHub OAuth"])
      expect(() => assertNoSecrets(text, "description")).not.toThrow();
  });

  it("rejects store/RPC/CLI writes atomically and still permits safe edits", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    registerTasksCli(bb, store, { name: "Work Board", version: "test" });
    const project = store.tasks.createProject({ name: "Guard", prefix: "GRD", color: "blue" });
    const task = store.tasks.createTask({ projectId: project.id, title: "Safe task" });
    const beforeProject = store.tasks.getProject(project.id);
    try {
      expect(() => store.tasks.createTask({ projectId: project.id, title: secret })).toThrow("title");
      expect(() => store.tasks.updateTask(task.id, { description: secret, status: "done" })).toThrow("description");
      expect(() => store.tasks.createComment({ taskId: task.id, kind: "agent", authorName: "Agent", body: secret })).toThrow("comment body");
      const created = tasksRpcContract.createTask.output.parse(await harness.callRpc("createTask", { projectId: project.id, title: "Safe", description: secret }));
      expect(created).toMatchObject({ ok: false, error: { code: "secret_detected" } });
      const updated = tasksRpcContract.updateTask.output.parse(await harness.callRpc("updateTask", { taskId: task.id, title: secret, status: "done" }));
      expect(updated).toMatchObject({ ok: false, error: { code: "secret_detected" } });
      expect(JSON.stringify([created, updated])).not.toContain(secret);
      await expect(harness.callRpc("createComment", { taskId: task.id, body: secret, notify: true })).rejects.toThrow("comment body");
      for (const args of [
        ["create", "--project", "GRD", "--title", secret],
        ["update", task.key, "--description", secret],
        ["comment", task.key, "--body", secret],
      ]) {
        const result = await harness.runCli(args);
        expect(result.exitCode).not.toBe(0);
        expect(result.stderr).toContain("detected");
        expect(result.stdout + result.stderr).not.toContain(secret);
      }
      expect(store.tasks.getProject(project.id)).toEqual(beforeProject);
      expect(store.tasks.listTasks()).toEqual([task]);
      expect(store.tasks.listComments(task.id)).toEqual([]);
      expect(harness.realtimeSignals).toEqual([]);
      expect(harness.sdk.calls).toEqual([]);
      expect(store.tasks.updateTask(task.id, { description: "Credentials removed" }).description).toBe("Credentials removed");
    } finally {
      await harness.dispose();
    }
  });
});
