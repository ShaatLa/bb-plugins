import { useMemo } from "react";
import type { CreatePlanNoteInput, PlanNote } from "../../shared/contract.js";
import { errorMessage } from "../../shared/errors.js";
import { fold, resolveAnchor, type TextSpan } from "../../shared/plan-anchor.js";
import { useTasksQuery, useTasksRpc } from "../../shell/data.js";
import { PERSON_AUTHOR } from "./data.js";

/** The notes of a task's plan, live on `tasks:changed`. */
export function usePlanNotes(taskId: string | null) {
  return useTasksQuery(
    async (rpc) => (taskId === null ? { notes: [] as PlanNote[] } : await rpc.call("listPlanNotes", { taskId })),
    ["tasks:changed"],
    [taskId],
    { enabled: taskId !== null, relevantTaskIds: taskId === null ? [] : [taskId] },
  );
}

/**
 * Where each anchored note is in the text on screen; null for a note whose quote is not there (unanchored).
 * The whole result is null while the body is not rendered, so nothing is called unanchored by mistake.
 */
export function usePlacements(notes: readonly PlanNote[], bodyText: string, ready: boolean): ReadonlyMap<string, TextSpan | null> | null {
  return useMemo(() => {
    if (!ready || bodyText === "") return null;
    const text = fold(bodyText);
    return new Map(
      notes.flatMap((note): Array<[string, TextSpan | null]> =>
        note.kind === "general" || note.exact === null ? [] : [[note.id, resolveAnchor(text, { exact: note.exact, prefix: note.prefix ?? "", suffix: note.suffix ?? "" })]],
      ),
    );
  }, [notes, bodyText, ready]);
}

export type Outcome<T = object> = ({ ok: true } & T) | { ok: false; message: string };

/** Note and review calls of the owner; refusals and failures come back as a message instead of throwing. */
export function usePlanReviewActions(taskId: string | null, refresh: () => void) {
  const rpc = useTasksRpc();
  async function run<T extends { ok: boolean }, R extends object>(call: () => Promise<T>, done: (result: Extract<T, { ok: true }>) => R): Promise<Outcome<R>> {
    if (taskId === null) return { ok: false, message: "The task is not loaded yet" };
    try {
      const result = await call();
      if (!result.ok) return { ok: false, message: (result as unknown as { error: { message: string } }).error.message };
      return { ok: true, ...done(result as Extract<T, { ok: true }>) };
    } catch (error) {
      return { ok: false, message: errorMessage(error) };
    } finally {
      refresh();
    }
  }
  return {
    create: (input: Omit<CreatePlanNoteInput, "taskId" | "authorName">) =>
      run(() => rpc.call("createPlanNote", { ...input, taskId: taskId!, authorName: PERSON_AUTHOR.name }), (result) => ({ note: result.note })),
    update: (noteId: string, body: string) => run(() => rpc.call("updatePlanNote", { noteId, body }), () => ({})),
    remove: (noteId: string) => run(() => rpc.call("deletePlanNote", { noteId }), () => ({})),
    setState: (noteId: string, state: "resolved" | "draft") => run(() => rpc.call("setPlanNoteState", { noteId, state }), () => ({})),
    send: () => run(() => rpc.call("sendPlanFeedback", { taskId: taskId!, author: PERSON_AUTHOR }), (result) => ({ delivered: result.delivered, notes: result.notes })),
    approve: (note: string) =>
      run(() => rpc.call("approvePlan", { taskId: taskId!, author: PERSON_AUTHOR, ...(note.trim() ? { note: note.trim() } : {}) }), (result) => ({ delivered: result.delivered })),
  };
}

/** What the owner is told after sending feedback or approving: the review is saved either way. */
export function deliveryNotice(delivered: "sent" | "failed" | "no_thread", what: string): { tone: "ok" | "warn"; text: string } {
  if (delivered === "sent") return { tone: "ok", text: `${what} sent to the agent` };
  if (delivered === "failed") return { tone: "warn", text: "Saved, but the agent could not be notified" };
  return { tone: "warn", text: "Saved, but there is no agent thread to notify" };
}
