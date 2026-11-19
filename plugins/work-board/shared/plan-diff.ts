import { createTwoFilesPatch, diffLines } from "diff";

export interface PlanDiff {
  patch: string;
  added: number;
  removed: number;
}

/** Line diff between two plan bodies: unified-diff text and the added and removed line counts. */
export function diffPlanBodies(from: string, to: string, labels: { from: string; to: string }): PlanDiff {
  let added = 0;
  let removed = 0;
  for (const part of diffLines(from, to)) {
    if (part.added) added += part.count ?? 0;
    else if (part.removed) removed += part.count ?? 0;
  }
  return { patch: createTwoFilesPatch(labels.from, labels.to, from, to, undefined, undefined, { context: 3 }), added, removed };
}
