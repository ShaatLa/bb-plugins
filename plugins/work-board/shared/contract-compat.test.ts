import { describe, expect, it } from "vitest";
import { tasksRpcContract } from "./contract";

describe("createTask input compatibility", () => {
  it("accepts and ignores requesterThreadId sent by Answers", () => {
    const input = tasksRpcContract.createTask.input.parse({
      projectId: "01J00000000000000000000000",
      title: "From a question",
      requesterThreadId: "thr_asker",
    });
    expect(input.title).toBe("From a question");
  });
});
