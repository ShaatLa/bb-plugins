import { z } from "zod";

/** Manual and background waits cannot suppress attention for longer than eight hours. */
export const MAX_PAUSE_MS = 8 * 60 * 60_000;

/** What a held or owner-question pause waits on now, as the UI links it. The stored `reason` is only a snapshot from when the pause began. */
export const pauseTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskKey: z.string() }).strict(),
  z.object({ kind: z.literal("question"), questionId: z.string(), label: z.string() }).strict(),
]);
export type PauseTarget = z.infer<typeof pauseTargetSchema>;

/** A pause as the card meta and the detail view read it. `targets` is set only for held and owner_question pauses. */
export const cardPauseSchema = z.object({ signal: z.string(), reason: z.string(), until: z.string().nullable(), targets: z.array(pauseTargetSchema).optional() }).strict();
export type CardPause = z.infer<typeof cardPauseSchema>;

export const PAUSE_RESOLVED_NOTE = "resolved — the pause ends on the next check";

/** The pause's reason as plain text: the items it waits on now, or the stored reason (with a note) when none is left. */
export function pauseReasonText(pause: CardPause): string {
  const targets = pause.targets;
  // Plain text (tooltips, the CLI): a Markdown link in a manual reason reads as its label.
  if (!targets) return pause.reason.replace(/\[([^\]\n]+)\]\([^)\s]*\)/g, "$1");
  if (!targets.length) return `${pause.reason} (${PAUSE_RESOLVED_NOTE})`;
  return pause.signal === "held"
    ? `Waiting on ${targets.map((target) => target.kind === "task" ? target.taskKey : "").join(", ")}`
    : `Waiting on the owner: ${targets.map((target) => target.kind === "question" ? target.label : "").join(", ")}`;
}

/** "in 5m", "in 3h": the time left, for a future instant. */
export function formatUntil(iso: string, nowMs: number): string {
  const minutes = Math.round((Date.parse(iso) - nowMs) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "any moment";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

/** One pause for a tooltip or a CLI line. */
export const pauseLineText = (pause: CardPause): string => `${pauseReasonText(pause)}${pause.until ? `, until ${new Date(pause.until).toLocaleString()}` : ""}`;
