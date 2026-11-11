import { HugeiconsIcon } from "@hugeicons/react";
import Alert01Icon from "@hugeicons/core-free-icons/Alert01Icon";
import type { DependencyTask } from "../shared/contract";

export function DependencyWarning({ blockedBy }: { blockedBy?: readonly DependencyTask[] }) {
  if (!blockedBy?.length) return null;
  const explanation = `Waiting for Done: ${blockedBy.map(task => `${task.key} · ${task.title} (${task.status})`).join("; ")}`;
  return <span tabIndex={0} title={explanation} aria-label={`Blocked. ${explanation}`} className="inline-flex items-center gap-1 text-warning">
    <HugeiconsIcon icon={Alert01Icon} aria-hidden className="size-3 shrink-0" />
    Blocked{blockedBy.length > 1 ? ` · ${blockedBy.length}` : ""}
  </span>;
}
