import { createTwoFilesPatch, diffLines } from "diff";

export interface PlanDiff {
  patch: string;
  added: number;
  removed: number;
}

/** Added and removed line counts only; no patch text is built. */
export function countPlanChanges(from: string, to: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(from, to)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { added, removed };
}

/** Line diff between two plan bodies: unified-diff text and the added and removed line counts. */
export function diffPlanBodies(from: string, to: string, labels: { from: string; to: string }): PlanDiff {
  return { patch: createTwoFilesPatch(labels.from, labels.to, from, to, undefined, undefined, { context: 3 }), ...countPlanChanges(from, to) };
}
