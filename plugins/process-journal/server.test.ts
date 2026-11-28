import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type { Proposal } from "./contract";
import plugin from "./server";

it("shares config, authenticated CLI attribution, persisted state and RPC reads", async () => {
  const projectId = "proj_example", threadId = "thr_example";
  const { bb, harness } = createFakePluginHost({ pluginId: "process-journal", sdk: {
    threads: { get: async ({ threadId }) => makeThreadResponse({ id: threadId, projectId, title: "Example manager" }) },
  } });
  harness.sdk.stub("projects.get", async ({ projectId }) => ({ id: projectId, name: "Example" }) as never);
  try {
    plugin(bb);
    const set = (key: string, value: unknown) => harness.callRpc("config.set", { projectId, key, value });
    await set("managers", [threadId]);
    await set("defaultManager", threadId);
    await set("enabled", true);
    const configBefore = await harness.callRpc("config.get", { projectId });
    const readDisplay = () => harness.callRpc("config.get", { projectId, key: "boardDisplay" });
    const setDisplay = (expectedRevision: number) => set("boardDisplay", { expectedRevision, columns: null });
    expect(await readDisplay()).toEqual({ revision: 0, columns: null });
    expect(await setDisplay(0)).toEqual({ ok: true, revision: 1, columns: null });
    expect(await setDisplay(0)).toEqual({
      ok: false, code: "board_display_conflict", current: { revision: 1, columns: null },
    });
    const stale = await harness.runCli(["config", "set", "boardDisplay", '{"expectedRevision":0,"columns":null}'], { projectId });
    expect(stale.exitCode).toBe(1);
    expect(JSON.parse(stale.stdout!)).toMatchObject({ ok: false, code: "board_display_conflict" });
    expect(await harness.callRpc("config.get", { projectId })).toEqual(configBefore);
    expect(harness.registrations.instructionProvider!({ projectId, threadId })).toMatch(/same turn/);
    expect(harness.registrations.instructionProvider!({ projectId: "proj_other", threadId })).toBeNull();
    const result = await harness.runCli(["entry-add", "--input", JSON.stringify({
      title: "Skipped check", failure: "A check was missed", gap: "Checklist had no owner",
      proposal: { title: "Assign owner", hypothesis: "Assignment prevents misses", rollbackCondition: "Owner unavailable",
        deadlineAt: Date.now() + 100_000, metric: { definition: "Count misses" } },
    })], { projectId, threadId });
    expect(result.exitCode, JSON.stringify(result)).toBe(0);
    const created = JSON.parse(result.stdout!) as { proposal: Proposal };
    const detail = await harness.callRpc("proposal.detail", { projectId, proposalId: created.proposal.id });
    expect(detail).toMatchObject({ entry: { createdBy: threadId }, proposal: { managerId: threadId } });
    await expect(harness.callRpc("proposal.comment", {
      projectId, proposalId: created.proposal.id, body: "Reviewed", actorThreadId: threadId,
    })).rejects.toThrow("rpc input validation failed");
    await expect(harness.callRpc("entry.add", {
      projectId, title: "Another skipped check", failure: "Skipped", gap: "No owner",
      proposal: { title: "Assign an owner", hypothesis: "Assignment helps", rollbackCondition: "Wrong assignment",
        deadlineAt: Date.now() + 100_000, metric: { definition: "Count misses", command: "undeclared" } },
    })).rejects.toThrow(/trusted catalog/);
    await expect(harness.callRpc("proposal.comment", {
      projectId, proposalId: created.proposal.id, body: "Reviewed in BB",
    })).resolves.toMatchObject({ actor: "BB client", message: "Reviewed in BB" });
    const persisted = await harness.callRpc("proposal.detail", { projectId, proposalId: created.proposal.id });
    const failed = await harness.runCli(["list", "--project", "bad/project"]);
    expect(JSON.parse(failed.stdout!)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const replacement = await harness.lifecycle.reload(plugin);
    try {
      expect(await replacement.harness.callRpc("proposal.detail", { projectId, proposalId: created.proposal.id }))
        .toEqual(persisted);
    } finally { await replacement.harness.dispose(); }
  } finally { await harness.dispose(); }
});
