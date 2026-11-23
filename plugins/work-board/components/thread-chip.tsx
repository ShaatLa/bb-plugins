import { Icon } from "@/components/ui/icon";
import { parseThreadRef } from "../shared/thread-ref";
import { useOpenThread } from "./open-thread";
import { useThreadNames } from "./thread-names";

/** A thread as bb chat shows a thread mention: a small pill with a person icon and the thread title; a click opens the thread. */
export function ThreadChip({ threadId, fallbackTitle }: { threadId: string; fallbackTitle?: string }) {
  const openThread = useOpenThread();
  // The id is the label when the title is unknown, for example for an archived or deleted thread.
  const title = useThreadNames([threadId]).get(threadId) ?? fallbackTitle ?? threadId;
  return (
    <button
      type="button"
      aria-label={`Open thread ${title}`}
      title={title}
      className="relative z-10 inline-flex max-w-48 items-center gap-1 rounded-full border border-border bg-muted px-2 py-px align-middle text-xs font-normal text-foreground hover:bg-accent"
      onClick={(event) => {
        event.stopPropagation();
        openThread(threadId);
      }}
    >
      <Icon name="User" fallback="File" className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">{title}</span>
    </button>
  );
}

/**
 * Who did something: a thread chip when the actor is a thread (given, or found in a trailing `(thr_…)` of the stored
 * name, in which case only the chip is shown), else the plain name.
 */
export function ActorLabel({ name, threadId }: { name: string; threadId?: string | null }) {
  const id = threadId ?? parseThreadRef(name)?.threadId;
  return id ? <ThreadChip threadId={id} /> : <>{name}</>;
}
