import type { ClosedThread } from "../shared/contract";

/** The reason of an `on_idle` result whose decision has not finished: no start-fresh instruction goes with it. */
export const PENDING = "decision pending";

/**
 * What the agent that closed a card reads after the command's own result. The instruction not to reuse a session
 * lives here, in the tool output, and only for sessions that are or will be archived: a kept session may own other work.
 */
export function closedThreadsBlock(key: string, threads: readonly ClosedThread[]): string {
  if (!threads.length) return `${key} closed. No linked sessions.`;
  const archived = threads.filter((entry) => entry.action === "archived").map((entry) => entry.threadId);
  const later = threads.filter((entry) => entry.action === "on_idle" && entry.reason !== PENDING).map((entry) => entry.threadId);
  const pending = threads.filter((entry) => entry.action === "on_idle" && entry.reason === PENDING).map((entry) => entry.threadId);
  const kept = threads.filter((entry) => entry.action === "kept");
  const done = [
    ...archived.map((id) => `${id} archived`),
    ...later.map((id) => `${id} will be archived when its turn ends`),
  ];
  const lines = [`${key} closed.${done.length ? ` ${done.join("; ")}.` : ""}`];
  if (pending.length) lines.push(`Pending: ${pending.map((id) => `${id} (${PENDING})`).join(", ")}.`);
  if (kept.length) lines.push(`Kept: ${kept.map((entry) => `${entry.threadId} (${entry.reason ?? "kept"})`).join(", ")}.`);
  const retired = [...archived, ...later];
  if (retired.length) lines.push(`Do not reuse ${retired.join(" or ")} for new work; start a new thread. Reopen ${key} if it is not finished.`);
  return lines.join("\n");
}
