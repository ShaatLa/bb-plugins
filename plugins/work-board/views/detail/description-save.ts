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

export function createDescriptionSaver(
  options: DescriptionSaverOptions,
): DescriptionSaver {
  const schedule = (run: () => void, delayMs: number) => {
    const timer = setTimeout(run, delayMs);
    return () => clearTimeout(timer);
  };

  const drafts = options.drafts ?? new Map<string, string>();
  let cancelTimer: (() => void) | undefined;
  let pending: { taskId: string; markdown: string } | undefined;
  let inFlight: typeof pending;
  let queued = false;

  const runSave = async (attempt: { taskId: string; markdown: string }) => {
    if (inFlight) {
      if (inFlight !== attempt) queued = true;
      return;
    }
    inFlight = attempt;
    try {
      const result = await options.save(attempt.taskId, attempt.markdown);
      if (result.ok) {
        if (pending === attempt) pending = undefined;
        if (drafts.get(attempt.taskId) === attempt.markdown) drafts.delete(attempt.taskId);
      } else {
        options.onError(result.errorMessage ?? "Failed to save description");
      }
    } catch (error) {
      options.onError(errorMessage(error));
    } finally {
      inFlight = undefined;
      if (queued && pending && pending !== attempt) {
        queued = false;
        void runSave(pending);
      } else {
        queued = false;
      }
    }
  };

  return {
    onChange(taskId, markdown) {
      pending = { taskId, markdown };
      drafts.set(taskId, markdown);
      cancelTimer?.();
      const attempt = pending;
      cancelTimer = schedule(() => {
        void runSave(pending ?? attempt);
      }, options.delayMs);
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
