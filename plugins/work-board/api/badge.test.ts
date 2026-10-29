import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createStore, registerTasksApi } from "./index";
import { navigationBadgeCounts } from "./badge";
import { badgeLabel } from "../shared/badge";

describe("navigation badge", () => {
  it("counts each task once across the selected criteria", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
    const store = createStore(bb);
    const project = store.tasks.createProject({ name: "Badge", prefix: "BDG", color: "blue" });
    const owner = store.tasks.createTask({ projectId: project.id, title: "Owner with question", executionTarget: "owner" });
    store.tasks.createTask({ projectId: project.id, title: "Review", status: "in_review" });
    store.tasks.createTask({ projectId: project.id, title: "Done owner", status: "done", executionTarget: "owner" });
    store.tasks.createTask({ projectId: project.id, title: "Plain todo" });
    bb.storage.database()
      .prepare("INSERT INTO task_questions (id, task_id, payload) VALUES (?, ?, ?)")
      .run("q1", owner.id, JSON.stringify({ selectedOptionIds: [], answerText: "" }));

    const picked = navigationBadgeCounts(bb, store, ["needs_answer", "owner", "in_review"], null, Date.now());
    expect(picked).toEqual({ count: 2, counts: { needs_answer: 1, owner: 1, in_review: 1 } });
    expect(navigationBadgeCounts(bb, store, ["open"], null, Date.now())).toEqual({ count: 3, counts: { open: 3 } });
    expect(navigationBadgeCounts(bb, store, ["stale_idle"], null, Date.now())).toEqual({ count: 0, counts: {} });
    await harness.dispose();
  });

  it("describes one or several criteria", () => {
    expect(badgeLabel(1, { owner: 1 }, ["owner"])).toBe("1 task for the owner");
    expect(badgeLabel(2, { needs_answer: 1, owner: 1, in_review: 0 }, ["needs_answer", "owner", "in_review"])).toBe(
      "2 tasks: 1 with unanswered questions, 1 for the owner",
    );
  });

  it("stores the chosen criteria once, in a stable order, and counts with them", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({ name: "Badge", prefix: "BDG", color: "blue" });
    store.tasks.createTask({ projectId: project.id, title: "Review", status: "in_review" });
    store.tasks.createTask({ projectId: project.id, title: "Todo" });

    expect(await harness.callRpc("getNavigationBadgeCriteria", null)).toEqual({ criteria: ["open"] });
    expect(
      await harness.callRpc("setNavigationBadgeCriteria", { criteria: ["owner", "in_review", "owner"] }),
    ).toEqual({ criteria: ["in_review", "owner"] });
    expect(await harness.callRpc("navigationBadge", null)).toMatchObject({
      count: 1,
      criteria: ["in_review", "owner"],
      timeBased: false,
    });
    await harness.callRpc("setNavigationBadgeCriteria", { criteria: [] });
    expect(await harness.callRpc("navigationBadge", null)).toMatchObject({ count: 0, criteria: [] });
    await harness.dispose();
  });
});
