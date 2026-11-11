import { describe, expect, it } from "vitest";
import { cap, parseRef, problemRefs, REF_FORMS, whereRef } from "./ci-refs";

describe("parseRef", () => {
  it("parses every form", () => {
    expect(parseRef("job:123")).toEqual({ kind: "job", jobId: 123 });
    expect(parseRef("run:5")).toEqual({ kind: "run", runId: 5 });
    expect(parseRef(" run:5:2 ")).toEqual({ kind: "run", runId: 5, attempt: 2 });
    expect(parseRef("queue:5:2")).toEqual({ kind: "queue", runId: 5, attempt: 2 });
    expect(parseRef("pool:self-hosted:big")).toEqual({ kind: "pool", pool: "self-hosted:big" });
    expect(parseRef("pr:12")).toEqual({ kind: "pr", number: 12 });
    expect(parseRef("sha:ABCDEF1")).toEqual({ kind: "sha", sha: "abcdef1" });
  });
  it("tells run-level alerts and signal ids (problems) from run refs", () => {
    for (const id of ["run:streak:7", "run:main:7", "runner_loss:9", "flake:9", "transient:9", "timeout:9", "rerun_failed:7:2", "pool_stall:self-hosted", "mass_cancel:2026-11-05T10:00:00Z"]) expect(parseRef(id), id).toEqual({ kind: "problem", id });
    expect(parseRef("pool:stall")).toEqual({ kind: "pool", pool: "stall" });
  });
  it("rejects unknown or malformed refs with the accepted forms", () => {
    for (const bad of ["", "job", "job:", "job:abc", "job:0", "job:1:2", "run:1:2:3", "run:x", "queue:1", "pr:-1", "pool:", "sha:abc12", "sha:xyz1234", "sha:abc1234:5", "nope:1", "run:main:x", "https://github.com/acme/widgets/actions/runs/1"]) {
      expect(() => parseRef(bad), bad).toThrow(/Accepted forms: .*job:<jobId>.*run:<runId>.*queue:.*pool:.*pr:.*sha:/);
    }
    expect(REF_FORMS.length).toBeGreaterThanOrEqual(7);
  });
});

describe("ref helpers", () => {
  it("whereRef prefers the job, then the run, then the pool", () => {
    expect(whereRef({ jobId: 1, runId: 2, attempt: 3 })).toBe("job:1");
    expect(whereRef({ runId: 2, attempt: 3 })).toBe("run:2:3");
    expect(whereRef({ pool: "p" })).toBe("pool:p");
    expect(whereRef({})).toBeUndefined();
  });
  it("problemRefs gives at most four refs and adds the queue ref only for merge_group failures", () => {
    const where = { jobId: 9, runId: 5, attempt: 1, pool: "p" };
    expect(problemRefs({ id: "runner_loss:9", where })).toEqual(["job:9", "run:5:1", "pool:p"]);
    expect(problemRefs({ id: "runner_loss:9", where }, { failures: [{ runId: 5, attempt: 1, event: "merge_group" }] })).toEqual(["job:9", "run:5:1", "queue:5:1", "pool:p"]);
    expect(problemRefs({ id: "mass_cancel:t", where: { pool: "p" } }, { massCancels: [{ since: "t", runIds: [1, 5, 3, 2] }] })).toEqual(["pool:p", "run:5", "run:3", "run:2"]);
  });
  it("cap sorts newest first, de-duplicates and notes how many were cut", () => {
    expect(cap([{ ref: "a", at: 1 }, { ref: "b", at: 3 }, { ref: "a", at: 9 }, { ref: "c", at: 2 }], 2)).toEqual(["b", "c", "+1 more"]);
    expect(cap([{ ref: "a", at: 1 }])).toEqual(["a"]);
  });
});
