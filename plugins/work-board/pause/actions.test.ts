import { expect, it } from "vitest";
import { goLive, setup } from "../attention/fixtures";
import { endPauses, startManualPause } from "./store";

it("clears and reopens each occurrence only when its signal changes", async () => {
  const f = setup();
  await goLive(f);
  const active = f.card("Example");
  const signals = (id: string) => f.occurrences().filter(o => o.task_id === id).map(o => o.signal);
  expect(signals(active.id)).toContain("no_active_thread");
  const link = f.store.tasks.upsertTaskThread({ taskId: active.id, threadId: "thr_example", title: "Worker", presetName: "Agent", liveStatus: "working" });
  expect(signals(active.id)).not.toContain("no_active_thread");
  f.store.tasks.updateTaskThreadStatus(link.id, "idle");
  expect(signals(active.id)).toContain("no_active_thread");
  startManualPause(f.db, active.id, "Waiting", 60_000, "owner");
  expect(signals(active.id)).not.toContain("no_active_thread");
  f.db.transaction(() => endPauses(f.db, active.id, "resume", "owner"))();
  expect(signals(active.id)).toContain("no_active_thread");
  f.store.tasks.updateTask(active.id, { status: "todo" });
  expect(signals(active.id)).not.toContain("no_active_thread");

  const other = f.card("PR project", "todo");
  f.linkPr(other.id, 1, "open");
  const review = f.card("Review", "in_review");
  expect(signals(review.id)).toContain("no_open_pr");
  f.store.tasks.upsertTaskThread({ taskId: review.id, threadId: "thr_review", title: "Worker", presetName: "Agent", liveStatus: "working" });
  expect(signals(review.id)).toContain("no_open_pr");
  startManualPause(f.db, review.id, "Waiting", 60_000, "owner");
  expect(signals(review.id)).not.toContain("no_open_pr");
  f.db.transaction(() => endPauses(f.db, review.id, "resume", "owner"))();
  expect(signals(review.id)).toContain("no_open_pr");
  f.store.tasks.updateTask(review.id, { status: "todo" });
  expect(signals(review.id)).not.toContain("no_open_pr");
  f.store.tasks.updateTask(review.id, { status: "in_review" });
  expect(signals(review.id)).toContain("no_open_pr");
  f.linkPr(review.id, 2, "open");
  expect(signals(review.id)).not.toContain("no_open_pr");
  await f.dispose();
});
