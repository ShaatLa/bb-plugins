// Pure logic for the notes on a plan (the owner's and a reviewer thread's): kinds and states, the order notes are read in, and the exact
// texts sent to the agent. No I/O, so the server, the CLI and the UI bundle can import it.
import { fold, markdownPlainText, resolveAnchor } from "./plan-anchor";
import { taskPlanMarkdownLink } from "./task-link";

export const PLAN_NOTE_KINDS = ["comment", "remove", "general"] as const;
export const PLAN_NOTE_STATES = ["draft", "sent", "addressed", "resolved"] as const;
export const PLAN_NOTE_BODY_MAX = 4000;
/** The selected text is stored whole (a long selection still resolves); only its context is short. */
export const PLAN_NOTE_QUOTE_MAX = 5000;
export const PLAN_NOTE_CONTEXT_MAX = 64;
export const PLAN_NOTE_HEADING_MAX = 500;
/** A quote in a message to the agent is cut here. */
export const FEEDBACK_QUOTE_MAX = 200;

export type PlanNoteKind = (typeof PLAN_NOTE_KINDS)[number];
export type PlanNoteState = (typeof PLAN_NOTE_STATES)[number];

/** What the builders read of a note; the stored note has more. */
export interface NoteLike {
  number: number;
  kind: PlanNoteKind;
  exact: string | null;
  prefix: string | null;
  suffix: string | null;
  headingPath: string | null;
  madeOnVersion: number;
  body: string;
  state: PlanNoteState;
  reply?: string | null;
  replyBy?: string | null;
  addressedInVersion?: number | null;
}

export const noteLabel = (number: number) => `N${number}`;

/** `N3`, `n3` or `3` → 3; null for anything else. */
export function parseNoteNumber(text: string): number | null {
  const match = /^[Nn]?(\d{1,9})$/.exec(text.trim());
  const number = match ? Number(match[1]) : NaN;
  return number >= 1 ? number : null;
}

const KIND_LABELS: Record<PlanNoteKind, string> = { comment: "Comment", remove: "Remove", general: "General" };
export const noteKindLabel = (kind: PlanNoteKind) => KIND_LABELS[kind];

export type NotePlacement = "anchored" | "unanchored" | "general";

/**
 * Notes in plan order: placed ones by position in the text, then the ones whose quote is gone (by number),
 * then general ones (by number). Placement is judged on the plain text of the Markdown, which is an
 * approximation of the page the owner saw; the quote is always in the message either way.
 */
export function orderNotes<T extends NoteLike>(notes: readonly T[], planBody: string): Array<{ note: T; placement: NotePlacement }> {
  const text = fold(markdownPlainText(planBody));
  const placed: Array<{ note: T; start: number }> = [];
  const lost: T[] = [];
  const general: T[] = [];
  for (const note of notes) {
    if (note.kind === "general" || note.exact === null) general.push(note);
    else {
      const span = resolveAnchor(text, { exact: note.exact, prefix: note.prefix ?? "", suffix: note.suffix ?? "" });
      if (span) placed.push({ note, start: span.start });
      else lost.push(note);
    }
  }
  const byNumber = (a: T, b: T) => a.number - b.number;
  return [
    ...placed.sort((a, b) => a.start - b.start || a.note.number - b.note.number).map(({ note }) => ({ note, placement: "anchored" as const })),
    ...lost.sort(byNumber).map((note) => ({ note, placement: "unanchored" as const })),
    ...general.sort(byNumber).map((note) => ({ note, placement: "general" as const })),
  ];
}

/** The quote as one line, cut to the message limit. */
export function quoteLine(exact: string): string {
  const flat = exact.replace(/\s+/g, " ").trim();
  return flat.length > FEEDBACK_QUOTE_MAX ? `${flat.slice(0, FEEDBACK_QUOTE_MAX)}…` : flat;
}

export interface RenderNoteOptions {
  /** Adds the note's state to the first line and the agent's reply below it (`plan notes --all`). */
  detail?: boolean;
}

export function renderNote(note: NoteLike, placement: NotePlacement, options: RenderNoteOptions = {}): string {
  const head = [noteLabel(note.number), noteKindLabel(note.kind)];
  if (note.kind !== "general" && note.headingPath) head.push(`section "${note.headingPath}"`);
  if (placement === "unanchored") head.push(`unanchored (made on v${note.madeOnVersion})`);
  if (options.detail) head.push(note.state === "addressed" && note.addressedInVersion ? `addressed in v${note.addressedInVersion}` : note.state);
  const lines = [head.join(" · ")];
  if (note.kind !== "general" && note.exact) lines.push(`> ${quoteLine(note.exact)}`);
  if (note.body.trim()) lines.push(note.body.trim());
  if (options.detail && note.reply) lines.push(`Reply${note.replyBy ? ` from ${note.replyBy}` : ""}: ${note.reply.trim()}`);
  return lines.join("\n");
}

/** How a message and the log name the person who decided: "the owner", or the reviewer's name with its thread id. */
export function actorLabel(by: { kind: "agent" | "person"; threadId: string | null; name: string }): string {
  if (by.kind === "person") return "the owner";
  return by.threadId && !by.name.includes(by.threadId) ? `${by.name} (${by.threadId})` : by.name;
}

/** The command that sends the revised plan back to the reviewer it was reviewed by. */
export const resubmitCommand = (taskKey: string, reviewer: string) => `bb work-board plan submit ${taskKey} --reviewer ${reviewer}`;

/** The rules header and the numbered notes: the body of the feedback message, and the output of `plan notes`. */
export function buildFeedbackBody(input: {
  taskKey: string;
  version: number;
  notes: ReadonlyArray<{ note: NoteLike; placement: NotePlacement }>;
  detail?: boolean;
  /** `owner` or the reviewer's thread id: who the revised plan goes back to. */
  reviewer: string;
}): string {
  const { taskKey: key, version } = input;
  return [
    "YOUR PLAN WAS NOT APPROVED. Revise it to address every note below, then submit it again.",
    "",
    "Rules:",
    `- Edit the plan, never comments. Re-read it first: bb work-board plan show ${key}`,
    `  Then: bb work-board plan edit ${key} --section "<heading>" --file part.md --base-version ${version} --summary "…"`,
    "  (or --find-file / --replace-file for a single passage)",
    `- Answer every note: bb work-board plan reply ${key} N1 --body "what changed, or why not" --addressed`,
    `- Do not resubmit the plan unchanged. A resubmit needs a new version. When every note is answered: ${resubmitCommand(key, input.reviewer)}`,
    `- Plan: ${taskPlanMarkdownLink(key)}`,
    "",
    `Notes on v${version} (${input.notes.length}), in plan order:`,
    "",
    input.notes.map(({ note, placement }) => renderNote(note, placement, { detail: input.detail })).join("\n\n"),
  ].join("\n");
}

/** The message that wakes the agent when the owner or a reviewer sends feedback. The sender header (plugin:work-board) is added when it is delivered. */
export function buildFeedbackMessage(input: {
  taskKey: string;
  version: number;
  notes: ReadonlyArray<{ note: NoteLike; placement: NotePlacement }>;
  /** Who sent the feedback: "the owner", or the reviewer's name with its thread id. */
  by: string;
  reviewer: string;
}): string {
  return `${input.taskKey} · plan v${input.version}: changes requested by ${input.by}\n\n${buildFeedbackBody(input)}`;
}

/** The message that tells the agent the plan is approved. */
export function buildApprovalMessage(input: { taskKey: string; version: number; by: string; note?: string | null }): string {
  const note = input.note?.trim();
  return [
    `${input.taskKey} · plan v${input.version} approved by ${input.by}`,
    "",
    `Start the work as planned. The approved plan is v${input.version}: any new version returns it to draft and needs a new review.`,
    `Plan: ${taskPlanMarkdownLink(input.taskKey)}`,
    ...(note ? ["", `Note from ${input.by}: ${note}`] : []),
  ].join("\n");
}

/** The notice to the executors of a card in progress when its approved plan changes. */
export function buildLeftApprovedNotice(input: { taskKey: string; version: number; state: string; reason: string }): string {
  return [
    `${input.taskKey} · plan v${input.version} is ${input.state.replace("_", " ")} (${input.reason}); it is no longer approved`,
    "",
    `For information: this card is in progress, but the approved plan changed. Check what changed with bb work-board plan diff ${input.taskKey}, and wait for the new approval before work that depends on it. The plan author handles the revision.`,
    `Plan: ${taskPlanMarkdownLink(input.taskKey)}`,
  ].join("\n");
}

/** One notice to an executor whose card was not moved to In progress because the plan lost approval after its prompt was built. */
export function buildPlanAdvisoryNotice(taskKey: string, advisory: string): string {
  return `${taskKey} · ${advisory}.\n\nThe card was not moved to In progress. Wait for the approval or ask the plan author before going on. Plan: ${taskPlanMarkdownLink(taskKey)}`;
}

/** The message for an owner's request for changes that came without notes (a state change, not a feedback batch). */
export function buildStateChangeMessage(input: { taskKey: string; version: number; reviewer: string }): string {
  return [
    `${input.taskKey} · plan v${input.version}: changes requested by the owner`,
    "",
    `No notes were attached. Ask the owner what to change, revise the plan, then: ${resubmitCommand(input.taskKey, input.reviewer)}`,
    `Plan: ${taskPlanMarkdownLink(input.taskKey)}`,
  ].join("\n");
}

/** The informational copy of a result (feedback or approval) for the thread that does not act on it. */
export function buildResultCopyMessage(input: { taskKey: string; headline: string; actor: string | null }): string {
  return [input.headline, "", `For information${input.actor ? `; ${input.actor} acts on it` : ""}. Do not act on it yourself.`, `Plan: ${taskPlanMarkdownLink(input.taskKey)}`].join("\n");
}

/** The message that wakes a reviewer thread when a plan is submitted to it. */
/** A plan review stops while the owner has an open decision; the reviewer waits. */
export function buildReviewPausedMessage(input: { taskKey: string; version: number }): string {
  return `${input.taskKey} plan v${input.version}: review paused, waiting for the owner's decision. Check \`bb work-board plan reviews ${input.taskKey}\` before acting.`;
}
/** The last open decision was settled: the reviewer judges whether the plan text still holds. */
export function buildReviewResumedMessage(input: { taskKey: string; version: number }): string {
  return `${input.taskKey} plan v${input.version}: the owner's decision is settled. Read the decisions on the card, then judge whether the plan text still holds: approve it, or send feedback if it needs changes.`;
}
export function buildReviewRequestMessage(input: { taskKey: string; version: number; /** The version this reviewer itself decided on last, if any. */ decidedVersion: number | null; blockingNotes: number }): string {
  const { taskKey: key, version, decidedVersion } = input;
  return [
    `${key} · plan v${version} submitted for your review`,
    "",
    "You are the reviewer of this plan. Review it until nothing is left to fix, then approve it.",
    decidedVersion === null
      ? `You have not decided on an earlier version: review the whole plan.`
      : `You last decided on v${decidedVersion}. What changed: bb work-board plan diff ${key} --from ${decidedVersion} --to ${version}`,
    `Reviewer notes that block approval: ${input.blockingNotes}${input.blockingNotes ? ` (bb work-board plan notes ${key} --all)` : ""}`,
    `- Read it: bb work-board plan show ${key}`,
    `- Note a finding: bb work-board plan note ${key} --version ${version} --body "…" [--quote "exact text" [--section "<heading>"]]`,
    `- Send your notes to the author (requests changes): bb work-board plan feedback ${key} --version ${version}`,
    `- Close notes the author answered: bb work-board plan resolve ${key} N1 --version ${version}`,
    `- Approve when no note is open: bb work-board plan approve ${key} --version ${version}`,
    `Plan: ${taskPlanMarkdownLink(key)}`,
  ].join("\n");
}
