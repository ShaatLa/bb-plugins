import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDescriptionSaver,
  type DescriptionSaveOutcome,
} from "./description-save.js";

const DELAY_MS = 800;

function setup(
  save: (taskId: string, markdown: string) => Promise<DescriptionSaveOutcome>,
) {
  const errors: string[] = [];
  const saver = createDescriptionSaver({
    save,
    onError: (message) => errors.push(message),
    delayMs: DELAY_MS,
  });
  return { errors, saver };
}

const flushMicrotasks = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createDescriptionSaver", () => {
  it("clears the pending draft only after the server confirms the save", async () => {
    const calls: string[] = [];
    const { errors, saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      return { ok: true };
    });

    saver.onChange("task-1", "draft v1");
    expect(saver.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY_MS - 1);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toEqual(["draft v1"]);
    expect(saver.hasPending()).toBe(false);
    expect(errors).toEqual([]);
    saver.flush("task-1");
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1"]);
  });

  it("keeps the draft after a transport failure so the unmount flush retries", async () => {
    const calls: string[] = [];
    let fail = true;
    const { errors, saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      if (fail) throw new Error("network down");
      return { ok: true };
    });

    saver.onChange("task-1", "draft v1");
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(errors).toEqual(["network down"]);
    expect(saver.hasPending()).toBe(true);

    fail = false;
    saver.flush("task-1");
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1", "draft v1"]);
    expect(saver.hasPending()).toBe(false);
  });

  it("retains a domain-rejected draft and reports the error", async () => {
    const { errors, saver } = setup(async () => ({ ok: false, errorMessage: "rejected" }));
    saver.onChange("task-1", "draft");
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    expect(errors).toEqual(["rejected"]);
    expect(saver.hasPending()).toBe(true);
    expect(saver.getDraft("task-1")).toBe("draft");
  });

  it("restores a draft after a failed unmount flush", async () => {
    const drafts = new Map<string, string>();
    const errors: string[] = [];
    const options = { drafts, delayMs: DELAY_MS, onError: (message: string) => errors.push(message),
      save: async () => { throw new Error("offline"); } };
    const saver = createDescriptionSaver(options);
    saver.onChange("task-1", "latest draft");
    saver.flush("task-1");
    await flushMicrotasks();
    expect(errors).toEqual(["offline"]);
    expect(saver.hasPending()).toBe(true);
    expect(createDescriptionSaver(options).getDraft("task-1")).toBe("latest draft");
  });

  it("does not clear a newer draft typed while a save is in flight", async () => {
    const calls: string[] = [];
    let release: (() => void) | undefined;
    const { saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true };
    });

    saver.onChange("task-1", "draft v1");
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    saver.onChange("task-1", "draft v2");
    release?.();
    await flushMicrotasks();
    expect(saver.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    release?.();
    await flushMicrotasks();
    expect(calls).toEqual(["draft v1", "draft v2"]);
  });

  it("serializes an overdue newer draft and coalesces repeated flushes", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    let stored = "";
    const { saver } = setup(async (_taskId, markdown) => {
      calls.push(markdown);
      await new Promise<void>((resolve) => releases.push(resolve));
      stored = markdown;
      return { ok: true };
    });

    saver.onChange("task-1", "v1");
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    saver.onChange("task-1", "v2");
    await vi.advanceTimersByTimeAsync(DELAY_MS);
    saver.flush("task-1");
    saver.flush("task-1");
    expect(calls).toEqual(["v1"]);
    releases[0]();
    await flushMicrotasks();
    expect(calls).toEqual(["v1", "v2"]);
    saver.flush("task-1");
    releases[1]();
    await flushMicrotasks();
    expect(stored).toBe("v2");
    expect(calls).toEqual(["v1", "v2"]);
    expect(saver.hasPending()).toBe(false);
  });

  it("serializes remounts sharing drafts and isolates separate stores", async () => {
    const drafts = new Map<string, string>();
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    let stored = "";
    const options = { delayMs: DELAY_MS, onError: vi.fn(),
      save: async (_taskId: string, markdown: string) => {
        calls.push(markdown);
        await new Promise<void>((resolve) => releases.push(resolve));
        stored = markdown;
        return { ok: true };
      } };
    const first = createDescriptionSaver({ ...options, drafts });
    first.onChange("task-1", "v1");
    first.flush("task-1");
    const second = createDescriptionSaver({ ...options, drafts });
    second.onChange("task-1", "v2");
    second.flush("task-1");
    const independent = createDescriptionSaver({ ...options, drafts: new Map() });
    independent.onChange("task-1", "independent");
    independent.flush("task-1");
    expect(calls).toEqual(["v1", "independent"]);
    releases[0]();
    await flushMicrotasks();
    expect(drafts.get("task-1")).toBe("v2");
    expect(calls).toEqual(["v1", "independent", "v2"]);
    releases[1]();
    releases[2]();
    await flushMicrotasks();
    expect(stored).toBe("v2");
    expect(drafts.has("task-1")).toBe(false);
  });

  it("only flushes drafts belonging to the flushed task", async () => {
    const calls: Array<[string, string]> = [];
    const { saver } = setup(async (taskId, markdown) => {
      calls.push([taskId, markdown]);
      return { ok: true };
    });
    saver.onChange("task-2", "other task draft");
    saver.flush("task-1");
    await flushMicrotasks();
    expect(calls).toEqual([]);
    expect(saver.hasPending()).toBe(true);
  });
});
