import { describe, expect, it } from "vitest";
import { reviewRoleOf } from "./thread-role";

describe("reviewRoleOf", () => {
  it.each(["review", "plan-review", "code-review", "check"])("reads the %s role", (role) => {
    expect(reviewRoleOf(`EXA-1 ${role}: Title`, "EXA-1")).toBe(role);
  });

  it("expands key groups", () => {
    for (const title of ["EXA-1+2 review: T", "EXA-1 + 2 review: T"]) {
      expect(reviewRoleOf(title, "EXA-1")).toBe("review");
      expect(reviewRoleOf(title, "EXA-2")).toBe("review");
      expect(reviewRoleOf(title, "EXA-3")).toBeNull();
    }
    expect(reviewRoleOf("EXA-12 review: T", "EXA-1")).toBeNull();
  });

  it("ignores case and spacing", () => {
    expect(reviewRoleOf("  exa-1   Plan-Review: T", "EXA-1")).toBe("plan-review");
    expect(reviewRoleOf("EXA-1 review: T", "exa-1")).toBe("review");
  });

  it("rejects other words, a missing colon and a key that is not leading", () => {
    expect(reviewRoleOf("EXA-1 impl: T", "EXA-1")).toBeNull();
    expect(reviewRoleOf("EXA-1 reviewer: T", "EXA-1")).toBeNull();
    expect(reviewRoleOf("EXA-1 preview: T", "EXA-1")).toBeNull();
    expect(reviewRoleOf("EXA-1 review T", "EXA-1")).toBeNull();
    expect(reviewRoleOf("Fix EXA-1 review: T", "EXA-1")).toBeNull();
    expect(reviewRoleOf(null, "EXA-1")).toBeNull();
  });
});
