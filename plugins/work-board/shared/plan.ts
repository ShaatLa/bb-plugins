// Pure Markdown logic for task plans: sections addressed by heading, exact-fragment edits and limits.
// No I/O and no dependencies, so the UI bundle can import it too.

export const PLAN_MAX_BYTES = 256 * 1024;
export const PLAN_SUMMARY_MAX = 300;
export const PLAN_FORMATS = ["markdown"] as const;
export const PLAN_STATES = ["draft", "in_review", "changes_requested", "approved"] as const;
export const PLAN_OPS = ["create", "replace", "section", "fragment", "restore"] as const;

export type PlanState = (typeof PLAN_STATES)[number];
export type PlanOp = (typeof PLAN_OPS)[number];

/** Raised for a plan edit that cannot be applied; the message tells the agent what to fix. */
export class PlanEditError extends Error {}

export interface PlanHeading {
  level: number;
  text: string;
  /** Ancestors and the heading itself, outermost first. */
  path: string[];
  /** Zero-based index of the heading line. */
  line: number;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t\r]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** ATX headings outside fenced code blocks, in document order. */
export function parseHeadings(body: string): PlanHeading[] {
  const headings: PlanHeading[] = [];
  const stack: PlanHeading[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const [line, text] of body.split("\n").entries()) {
    const fenced = FENCE.exec(text);
    if (fence) {
      // A closing fence uses the same character, is at least as long and carries no info string.
      if (fenced && fenced[1]![0] === fence.char && fenced[1]!.length >= fence.length && text.slice(fenced[0].length).trim() === "") fence = null;
      continue;
    }
    if (fenced) {
      fence = { char: fenced[1]![0]!, length: fenced[1]!.length };
      continue;
    }
    const match = HEADING.exec(text);
    if (!match) continue;
    const level = match[1]!.length;
    // Optional closing sequence: "## Title ##".
    const title = (match[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "").trim();
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    const heading: PlanHeading = { level, text: title, path: [...stack.map((item) => item.text), title], line };
    stack.push(heading);
    headings.push(heading);
  }
  return headings;
}

export const headingPath = (heading: PlanHeading): string => heading.path.join(" > ");

function listHeadings(headings: readonly PlanHeading[]): string {
  return headings.length ? headings.map((heading) => `  ${"#".repeat(heading.level)} ${headingPath(heading)}`).join("\n") : "  (the plan has no headings)";
}

export interface PlanSection {
  heading: PlanHeading;
  /** Zero-based line range [start, end) covering the heading line and its body. */
  start: number;
  end: number;
}

/** Resolves a heading text or a `Parent > Child` path to exactly one section. */
export function findSection(body: string, target: string): PlanSection {
  const wanted = target.trim();
  if (!wanted) throw new PlanEditError("Section heading must not be empty");
  const headings = parseHeadings(body);
  const segments = wanted.split(">").map((segment) => segment.trim());
  const suffixMatches = (heading: PlanHeading) =>
    segments.length <= heading.path.length && segments.every((segment, index) => heading.path[heading.path.length - segments.length + index] === segment);
  let candidates = headings.filter(suffixMatches);
  // A heading whose own text contains ">" still resolves when no path matches.
  if (!candidates.length && segments.length > 1) candidates = headings.filter((heading) => heading.text === wanted);
  if (!candidates.length)
    throw new PlanEditError(`Section "${wanted}" not found. Available headings:\n${listHeadings(headings)}`);
  if (candidates.length > 1)
    throw new PlanEditError(`Section "${wanted}" is ambiguous (${candidates.length} headings). Use the full path, for example "Parent > Child". Matching headings:\n${listHeadings(candidates)}`);
  const heading = candidates[0]!;
  const end = headings.find((other) => other.line > heading.line && other.level <= heading.level)?.line ?? body.split("\n").length;
  return { heading, start: heading.line, end };
}

/** The section's Markdown, heading line included, without its trailing blank lines. */
export function getSection(body: string, target: string): string {
  const section = findSection(body, target);
  const lines = body.split("\n").slice(section.start, section.end);
  while (lines.length > 1 && lines.at(-1)!.trim() === "") lines.pop();
  return lines.join("\n");
}

/** Replaces the whole section (heading line included); an empty replacement deletes it. */
export function replaceSection(body: string, target: string, replacement: string): string {
  const { start, end } = findSection(body, target);
  const lines = body.split("\n");
  const removed = lines.slice(start, end);
  const before = lines.slice(0, start);
  const after = lines.slice(end);
  if (replacement.trim() === "") return [...before, ...after].join("\n");
  // The blank lines that separated the old section from what follows keep separating the new one.
  let trailing = 0;
  while (trailing < removed.length - 1 && removed[removed.length - 1 - trailing]!.trim() === "") trailing++;
  const separator = removed.slice(removed.length - trailing);
  return [...before, ...replacement.replace(/(\r?\n)+$/, "").split("\n"), ...separator, ...after].join("\n");
}

/** Number of (possibly overlapping) occurrences of `find`. */
export function countOccurrences(body: string, find: string): number {
  if (!find) return 0;
  let count = 0;
  for (let at = body.indexOf(find); at !== -1; at = body.indexOf(find, at + 1)) count++;
  return count;
}

/** Replaces the single exact occurrence of `find`; zero or several occurrences are refused. */
export function replaceFragment(body: string, find: string, replacement: string): string {
  if (!find) throw new PlanEditError("The fragment to find must not be empty");
  const count = countOccurrences(body, find);
  if (count === 0) throw new PlanEditError("Fragment not found in the current plan (0 matches); it must match exactly, including whitespace and line breaks");
  if (count > 1) throw new PlanEditError(`Fragment is not unique (${count} matches); include more surrounding text so it occurs exactly once`);
  const at = body.indexOf(find);
  return body.slice(0, at) + replacement + body.slice(at + find.length);
}

/** Validates a body or summary against the plan limits. */
export function assertPlanText(body: string, summary: string): void {
  if (body.trim() === "") throw new PlanEditError("The plan must not be empty");
  if (new TextEncoder().encode(body).length > PLAN_MAX_BYTES)
    throw new PlanEditError(`The plan exceeds ${PLAN_MAX_BYTES / 1024} KB; shorten it or move details to an attachment`);
  if (summary.trim() === "") throw new PlanEditError("A summary of what changed is required");
  if (summary.length > PLAN_SUMMARY_MAX) throw new PlanEditError(`The summary exceeds ${PLAN_SUMMARY_MAX} characters`);
}
