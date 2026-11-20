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
    send: () => run(() => rpc.call("sendPlanFeedback", { taskId: taskId!, author: PERSON_AUTHOR }), (result) => ({ delivered: result.delivered, deliveries: result.deliveries, notes: result.notes })),
    approve: (note: string) =>
      run(() => rpc.call("approvePlan", { taskId: taskId!, author: PERSON_AUTHOR, ...(note.trim() ? { note: note.trim() } : {}) }), (result) => ({ delivered: result.delivered, deliveries: result.deliveries })),
  };
}

type DeliveryResult = { delivered: "sent" | "failed" | "no_thread"; deliveries: ReadonlyArray<{ delivered: "sent" | "failed" | "no_thread"; threadId: string | null }> };

/**
 * What the owner is told after sending feedback or approving: the decision is saved either way, and every thread that
 * was not reached is named, so the owner can hand the result over by hand.
 */
export function deliveryNotice(result: DeliveryResult, what: string): { tone: "ok" | "warn"; text: string } {
  const missed = result.deliveries.filter((entry) => entry.delivered !== "sent");
  if (missed.length === 0) return { tone: "ok", text: `${what} sent to the agent` };
  if (result.deliveries.length === 1 && missed[0]!.delivered === "no_thread") return { tone: "warn", text: "Saved, but there is no agent thread to notify" };
  if (result.deliveries.length === 1) return { tone: "warn", text: "Saved, but the agent could not be notified" };
  return { tone: "warn", text: `${what} saved, but not delivered to ${missed.map((entry) => entry.threadId ?? "any thread").join(", ")}; tell them yourself` };
}
