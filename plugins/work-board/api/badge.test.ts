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
    const owner = store.tasks.createTask({ projectId: project.id, title: "Owner with question", });
    store.tasks.createTask({ projectId: project.id, title: "Review", status: "in_review" });
    store.tasks.createTask({ projectId: project.id, title: "Done owner", status: "done", });
    store.tasks.createTask({ projectId: project.id, title: "Plain todo" });
    bb.storage.database()
      .prepare("INSERT INTO task_questions (id, task_id, payload) VALUES (?, ?, ?)")
      .run("q1", owner.id, JSON.stringify({ selectedOptionIds: [], answerText: "" }));

    const picked = navigationBadgeCounts(bb, store, ["needs_answer", "waiting_on_owner", "in_review"], Date.now());
    expect(picked).toEqual({ count: 2, counts: { needs_answer: 1, waiting_on_owner: 1, in_review: 1 } });
    expect(navigationBadgeCounts(bb, store, ["open"], Date.now())).toEqual({ count: 3, counts: { open: 3 } });
    expect(navigationBadgeCounts(bb, store, ["stale_idle"], Date.now())).toEqual({ count: 0, counts: { stale_idle: 0 } });
    await harness.dispose();
  });

  it("describes one or several criteria", () => {
    expect(badgeLabel(1, { waiting_on_owner: 1 }, ["waiting_on_owner"])).toBe("1 task waiting on you");
    expect(badgeLabel(2, { needs_answer: 1, waiting_on_owner: 1, in_review: 0 }, ["needs_answer", "waiting_on_owner", "in_review"])).toBe(
      "2 tasks: 1 with unanswered questions, 1 waiting on you",
    );
  });

  it("stores the chosen criteria once, in a stable order, and counts with them", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "work-board" });
    const store = createStore(bb);
    registerTasksApi(bb, store);
    const project = store.tasks.createProject({ name: "Badge", prefix: "BDG", color: "blue" });
    store.tasks.createTask({ projectId: project.id, title: "Review", status: "in_review" });
    store.tasks.createTask({ projectId: project.id, title: "Todo" });

    expect(await harness.callRpc("getNavigationBadgeCriteria", null)).toEqual({ criteria: ["open", "waiting_on_owner"] });
    expect(
      await harness.callRpc("setNavigationBadgeCriteria", { criteria: ["waiting_on_owner", "in_review", "waiting_on_owner"] }),
    ).toEqual({ criteria: ["waiting_on_owner", "in_review"] });
    expect(await harness.callRpc("navigationBadge", null)).toMatchObject({
      count: 1,
      criteria: ["waiting_on_owner", "in_review"],
      timeBased: false,
    });
    await harness.callRpc("setNavigationBadgeCriteria", { criteria: [] });
    expect(await harness.callRpc("navigationBadge", null)).toMatchObject({ count: 0, criteria: [] });
    await harness.dispose();
  });
});
