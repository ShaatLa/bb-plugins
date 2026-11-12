import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it } from "vitest";
import { MAX_AGENT_COMMENT_BYTES, createComment, createStore } from "./index";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.harness.dispose())); });

it("refuses agent comments over 8 KB with an attachment hint and keeps owner comments uncapped", async () => {
  const host = createFakePluginHost({ pluginId: "work-board" });
  hosts.push(host);
  const store = createStore(host.bb);
  const project = store.tasks.createProject({ name: "Cap", prefix: "CAP", color: "blue" });
  const task = store.tasks.createTask({ projectId: project.id, title: "Report" });
  const base = { taskId: task.id, authorName: "Agent", presetName: null, threadId: "thr_worker", notify: false, awaitDelivery: false };
  // Multi-byte text counts in UTF-8 bytes, as stored.
  const atLimit = "я".repeat(MAX_AGENT_COMMENT_BYTES / 2);
  await expect(createComment(host.bb, store, { ...base, kind: "agent", body: atLimit })).resolves.toMatchObject({ kind: "agent" });
  await expect(createComment(host.bb, store, { ...base, kind: "agent", body: `${atLimit}!` })).rejects.toThrow(/limited to 8 KB.*attachment add/);
  await expect(createComment(host.bb, store, { ...base, kind: "user", threadId: null, body: "x".repeat(20_000) })).resolves.toMatchObject({ kind: "user" });
  expect(store.tasks.listComments(task.id)).toHaveLength(2);
});
