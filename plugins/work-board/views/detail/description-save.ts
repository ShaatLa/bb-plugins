import { errorMessage } from "../../shared/errors.js";

export interface DescriptionSaveOutcome {
  ok: boolean;
  errorMessage?: string;
}

interface DescriptionSaverOptions {
  save(taskId: string, markdown: string): Promise<DescriptionSaveOutcome>;
  onError(message: string): void;
  delayMs: number;
  drafts?: Map<string, string>;
}

export interface DescriptionSaver {
  onChange(taskId: string, markdown: string): void;
  flush(taskId: string): void;
  hasPending(): boolean;
  getDraft(taskId: string): string | undefined;
}

type Attempt = { taskId: string; markdown: string; run: () => void };
type SaveState = { latest: Attempt; inFlight?: Attempt; queued: boolean };
const saveStates = new WeakMap<Map<string, string>, Map<string, SaveState>>();

export function createDescriptionSaver(
  options: DescriptionSaverOptions,
): DescriptionSaver {
  const schedule = (run: () => void, delayMs: number) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  };

  const drafts = options.drafts ?? new Map<string, string>();
  let cancelTimer: (() => void) | undefined;
  let pending: Attempt | undefined;
  let states = saveStates.get(drafts);
  if (!states) {
    states = new Map();
    saveStates.set(drafts, states);
  }
  const taskStates = states;

  const runSave = async (attempt: Attempt) => {
    const state = taskStates.get(attempt.taskId);
    if (!state || state.latest !== attempt) return;
    if (state.inFlight) {
      if (state.inFlight !== attempt) state.queued = true;
      return;
    }
    state.inFlight = attempt;
    try {
      const result = await options.save(attempt.taskId, attempt.markdown);
      if (result.ok) {
        if (pending === attempt) pending = undefined;
        if (state.latest === attempt) {
          drafts.delete(attempt.taskId);
          taskStates.delete(attempt.taskId);
        }
      } else {
        options.onError(result.errorMessage ?? "Failed to save description");
      }
    } catch (error) {
      options.onError(errorMessage(error));
    } finally {
      state.inFlight = undefined;
      if (state.queued && state.latest !== attempt) {
        state.queued = false;
        state.latest.run();
      } else {
        state.queued = false;
      }
    }
  };

  return {
    onChange(taskId, markdown) {
      const attempt: Attempt = { taskId, markdown, run: () => { void runSave(attempt); } };
      pending = attempt;
      const state = taskStates.get(taskId);
      if (state) state.latest = attempt;
      else taskStates.set(taskId, { latest: attempt, queued: false });
      drafts.set(taskId, markdown);
      cancelTimer?.();
      cancelTimer = schedule(attempt.run, options.delayMs);
    },
    flush(taskId) {
      cancelTimer?.();
      cancelTimer = undefined;
      if (pending === undefined || pending.taskId !== taskId) return;
      const attempt = pending;
      void runSave(attempt);
    },
    hasPending: () => pending !== undefined,
    getDraft: (taskId) => drafts.get(taskId),
  };
}
