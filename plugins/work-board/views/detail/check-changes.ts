import { withoutLinkTargets } from "../../components/linked-text";
import type { TaskQuestion } from "../../shared/contract";

// Keep the longest ordered sequence of unchanged steps, including repeated steps.
function stepEdits(before: string[], after: string[]) {
  const lengths: number[][] = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lengths[i]![j] = before[i] === after[j]
        ? 1 + lengths[i + 1]![j + 1]!
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }
  const edits: string[] = [];
  let i = 0, j = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && before[i] === after[j]) {
      i++; j++;
    } else if (i < before.length && (j === after.length || lengths[i + 1]![j]! >= lengths[i]![j + 1]!)) {
      edits.push(`− ${before[i++]}`);
    } else {
      edits.push(`+ ${after[j++]}`);
    }
  }
  return edits.length > 5 ? [...edits.slice(0, 5), `and ${edits.length - 5} more`] : edits;
}

export function checkChanges(before: TaskQuestion, after: TaskQuestion) {
  const changes: string[] = [];
  if (before.prompt !== after.prompt) {
    changes.push(withoutLinkTargets(before.prompt) === withoutLinkTargets(after.prompt) ? "a link in the prompt" : "the prompt");
  }
  if (before.steps.length === after.steps.length && before.steps.every((step, i) =>
    withoutLinkTargets(step) === withoutLinkTargets(after.steps[i]!))) {
    before.steps.forEach((step, i) => {
      if (step !== after.steps[i]) changes.push(`a link in step ${i + 1}`);
    });
  } else {
    changes.push(...stepEdits(before.steps, after.steps));
  }
  return changes;
}
