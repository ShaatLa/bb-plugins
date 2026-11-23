import { ActorLabel, ThreadChip } from "../../components/thread-chip.js";
import type { DisplayComment } from "../../shared/contract.js";

/** A comment's author: a thread chip when the comment came from a thread, else the name (a trailing `(thr_…)` still becomes a chip). */
export function CommentAuthor({ comment }: { comment: DisplayComment }) {
  if (comment.threadId) return <ThreadChip threadId={comment.threadId} fallbackTitle={comment.threadTitle ?? undefined} />;
  return <span className="font-semibold"><ActorLabel name={comment.authorName} /></span>;
}
