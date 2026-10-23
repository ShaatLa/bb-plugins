// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeDefaultThread, useDefaultThread } from "./thread-preference";

function Preference({ projectId }: { projectId: string }) {
  return <span>{useDefaultThread(projectId)?.title ?? "No default"}</span>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("default thread preference", () => {
  it("updates every mounted control and clears the project default", () => {
    const view = render(<><Preference projectId="first" /><Preference projectId="first" /><Preference projectId="other" /></>);
    act(() => storeDefaultThread("first", { id: "thr_worker", title: "Worker" }));
    expect(view.getAllByText("Worker")).toHaveLength(2);
    expect(view.getAllByText("No default")).toHaveLength(1);
    act(() => storeDefaultThread("first", null));
    expect(view.queryByText("Worker")).toBeNull();
    expect(view.getAllByText("No default")).toHaveLength(3);
  });

  it.each(["{broken", '{"id":"wrong","title":"Worker"}', '{"id":"thr_worker","title":123}'])("ignores invalid stored data: %s", (raw) => {
    window.localStorage.setItem("bb-tasks-plus:default-thread:first", raw);
    expect(render(<Preference projectId="first" />).getByText("No default")).toBeTruthy();
  });

  it("still renders when storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
    expect(render(<Preference projectId="first" />).getByText("No default")).toBeTruthy();
    expect(() => storeDefaultThread("first", null)).not.toThrow();
  });
});
