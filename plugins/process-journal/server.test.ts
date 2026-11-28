import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import type { Proposal } from "./contract";
import plugin from "./server";

it("shares config, authenticated CLI attribution, persisted state and RPC reads", async () => {
  const projectId = "proj_example", threadId = "thr_example";
  const reviewerId = "thr_reviewer", outsider = "thr_outside", unknown = "thr_unknown";
  const attached = "thr_attached", executorChild = "thr_executor_child";
  let reviewerArchived = false;
  let linkedExecutors = [attached];
  const { bb, harness } = createFakePluginHost({ pluginId: "process-journal", sdk: {
    threads: {
      get: async ({ threadId }) => makeThreadResponse({
        id: threadId, projectId: threadId === outsider ? "proj_other" : projectId, title: "Example thread",
        archivedAt: threadId === reviewerId && reviewerArchived ? Date.now() : null,
      }),
      experimental_listAncestors: async ({ threadIds }) => ({
        threads: threadIds.filter(id => id !== unknown && !(id === reviewerId && reviewerArchived)).map(id => ({
          threadId: id, ancestorIds: id === reviewerId ? [threadId] : id === executorChild ? [attached, threadId] : [],
        })),
      }),
    },
  } });
  harness.sdk.stub("projects.get", async ({ projectId }) => ({ id: projectId, name: "Example" }) as never);
  const card = { id: "task_example", key: "EXA-1", projectId: "board_example", status: "todo", dueDate: null };
  harness.sdk.stub("plugins.callRpc", async ({ method }) => {
    switch (method) {
      case "listProjects": return { projects: [{ id: card.projectId, linkedBbProjectId: projectId }] };
      case "getTask":
      case "getTaskByKey": return { task: card };
      case "listTaskThreads": return { taskThreads: linkedExecutors.map(threadId => ({ threadId, presetName: "Parent thread" })) };
      case "listTaskPullRequests": return { pullRequests: [], unavailableThreadIds: [] };
      default: throw new Error(`Unexpected RPC: ${method}`);
    }
  });
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
    const entryInput = {
      title: "Skipped check", failure: "A check was missed", gap: "Checklist had no owner",
      proposal: { title: "Assign owner", hypothesis: "Assignment prevents misses", rollbackCondition: "Owner unavailable",
        deadlineAt: Date.now() + 100_000, metric: { definition: "Count misses" } },
    };
    const result = await harness.runCli(["entry-add", "--input", JSON.stringify(entryInput)], { projectId, threadId });
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
    const ref = { proposalId: created.proposal.id, revision: created.proposal.revision };
    async function cli(command: string, input: unknown, actor = threadId) {
      const result = await harness.runCli([command, "--input", JSON.stringify(input)], { projectId, threadId: actor });
      return { exitCode: result.exitCode, body: JSON.parse(result.stdout!) };
    }
    const apply = { ...ref, transition: { state: "applied", reason: "Linked implementation", deadlineAt: Date.now() + 100_000 } };
    expect(await cli("proposal-transition", apply)).toMatchObject({ exitCode: 1, body: { error: { code: "review_required" } } });
    await expect(harness.callRpc("proposal.transition", { projectId, ...apply })).rejects.toMatchObject({
      code: "conflict", issues: [{ message: "review_required" }],
    });
    const assign = { ...ref, generation: 0, reason: "Independent reviewer" };
    for (const candidate of [outsider, unknown]) {
      expect(await cli("review-assign", { ...assign, reviewerId: candidate })).toMatchObject({
        exitCode: 1, body: { error: { code: "reviewer_unverified" } },
      });
    }
    expect(await cli("review-assign", { ...assign, reviewerId: threadId })).toMatchObject({
      exitCode: 1, body: { error: { code: "reviewer_conflict" } },
    });
    await set("boardProject", card.projectId);
    expect(await cli("fix-link", { ...ref, taskKey: card.key })).toMatchObject({ exitCode: 0 });
    for (const candidate of [attached, executorChild]) {
      expect(await cli("review-assign", { ...assign, reviewerId: candidate })).toMatchObject({
        exitCode: 1, body: { error: { code: "reviewer_conflict" } },
      });
    }
    expect(await cli("review-assign", { ...assign, reviewerId })).toMatchObject({ exitCode: 0, body: { generation: 1 } });
    expect(await cli("review-submit", { ...ref, generation: 1, baseVersion: 0, submission: { stage: "hypothesis" } }))
      .toMatchObject({ exitCode: 0, body: { version: 1, status: "pending" } });
    const verdict = { proposalId: ref.proposalId, generation: 1, version: 1, stage: "hypothesis",
      verdict: "approved", feedback: "Checked the original evidence" };
    await expect(harness.callRpc("review.decide", { ...verdict, projectId })).rejects.toThrow(/assigned reviewer/);
    expect(await cli("review-decide", verdict, reviewerId)).toMatchObject({ exitCode: 0, body: { status: "approved" } });
    reviewerArchived = true;
    const applied = await cli("proposal-transition", apply);
    expect(applied).toMatchObject({ exitCode: 0, body: { state: "applied" } });
    const measuring = await cli("proposal-transition", {
      ...ref, revision: applied.body.revision, transition: {
        state: "measuring", reason: "Observe the result", checkAt: Date.now() + 30_000, deadlineAt: Date.now() + 100_000,
      },
    });
    expect(measuring).toMatchObject({ exitCode: 0, body: { state: "measuring" } });
    const observed = await cli("proposal-measure", {
      ...ref, revision: measuring.body.revision, observation: { note: "Example verification passed" },
    });
    expect(observed).toMatchObject({ exitCode: 0 });
    const observation = await harness.callRpc("proposal.detail", { projectId, proposalId: ref.proposalId }) as {
      events: { seq: number; observation?: unknown }[];
    };
    reviewerArchived = false;
    expect(await cli("review-submit", {
      ...ref, revision: observed.body.revision, generation: 1, baseVersion: 0, submission: {
        stage: "result", conclusion: "Keep the result", observationIds: [observation.events.find(event => event.observation)!.seq],
      },
    })).toMatchObject({ exitCode: 0, body: { version: 1, status: "pending" } });
    expect(await cli("review-decide", { ...verdict, stage: "result" }, reviewerId))
      .toMatchObject({ exitCode: 0, body: { status: "approved" } });
    reviewerArchived = true;
    expect(await cli("proposal-transition", {
      ...ref, revision: observed.body.revision, transition: { state: "kept", reason: "The reviewed result met its target" },
    })).toMatchObject({ exitCode: 0, body: { state: "kept" } });
    const persisted = await harness.callRpc("proposal.detail", { projectId, proposalId: created.proposal.id });

    // The manager becomes an executor after the manager-started reviewer has approved.
    reviewerArchived = false;
    const second = await cli("entry-add", entryInput);
    expect(second.exitCode).toBe(0);
    const secondRef = { proposalId: second.body.proposal.id, revision: second.body.proposal.revision };
    expect(await cli("fix-link", { ...secondRef, taskKey: card.key })).toMatchObject({ exitCode: 0 });
    expect(await cli("review-assign", { ...assign, ...secondRef, reviewerId })).toMatchObject({ exitCode: 0 });
    expect(await cli("review-submit", { ...secondRef, generation: 1, baseVersion: 0, submission: { stage: "hypothesis" } }))
      .toMatchObject({ exitCode: 0, body: { status: "pending" } });
    expect(await cli("review-decide", { ...verdict, proposalId: secondRef.proposalId }, reviewerId))
      .toMatchObject({ exitCode: 0, body: { status: "approved" } });
    reviewerArchived = true;
    linkedExecutors = [attached, threadId];
    expect(await cli("proposal-transition", { ...apply, ...secondRef })).toMatchObject({
      exitCode: 1, body: { error: { code: "review_required" } },
    });
    const secondDetail = { projectId, proposalId: secondRef.proposalId };
    expect(await harness.callRpc("proposal.detail", secondDetail)).toMatchObject({
      proposal: { state: "proposed" }, review: { hypothesis: { status: "superseded" } },
      events: expect.arrayContaining([{ kind: "review", actor: "Work Board",
        message: `Verified linked fix executor: ${threadId}`, at: expect.any(Number), seq: expect.any(Number) }]),
    });
    linkedExecutors = [attached];
    const failed = await harness.runCli(["list", "--project", "bad/project"]);
    expect(JSON.parse(failed.stdout!)).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const replacement = await harness.lifecycle.reload(plugin);
    try {
      expect(await replacement.harness.callRpc("proposal.detail", { projectId, proposalId: created.proposal.id }))
        .toEqual(persisted);
      expect(await replacement.harness.callRpc("proposal.detail", secondDetail)).toMatchObject({
        proposal: { state: "proposed" }, review: { hypothesis: { status: "superseded" } },
      });
    } finally { await replacement.harness.dispose(); }
  } finally { await harness.dispose(); }
});
