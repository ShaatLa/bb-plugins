import { describe, expect, it } from "vitest";
import { parseThreadRef } from "./thread-ref";

describe("parseThreadRef", () => {
  it("finds a trailing (thr_…) and keeps the label before it", () => {
    expect(parseThreadRef("agent (thr_example)")).toEqual({ threadId: "thr_example", label: "agent" });
    expect(parseThreadRef("agent (thr_ex-ample_1)  ")).toEqual({ threadId: "thr_ex-ample_1", label: "agent" });
    expect(parseThreadRef("(thr_example)")).toEqual({ threadId: "thr_example", label: "" });
  });

  it("takes a bare thread id as the whole text", () => {
    expect(parseThreadRef("thr_example")).toEqual({ threadId: "thr_example", label: "" });
    expect(parseThreadRef(" thr_example ")).toEqual({ threadId: "thr_example", label: "" });
  });

  it("ignores names without a trailing thread id", () => {
    for (const text of ["You", "cli", "agent (thr_example) later", "thr_example is mine", "agent (not_a_thread)", "agent thr_example", ""]) expect(parseThreadRef(text)).toBeNull();
  });
});
