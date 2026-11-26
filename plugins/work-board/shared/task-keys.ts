import MarkdownIt from "markdown-it";
import { taskHref } from "./task-link.js";

// `PREFIX-N`: an uppercase letter and up to 9 uppercase letters or digits (the shape Work Board allows for a prefix),
// a dash, a positive number without a leading zero. Whole words only: never glued to letters, digits, `_` or a dash.
const TASK_KEY = /(?<![\p{L}\p{N}_-])[A-Z][A-Z0-9]{0,9}-[1-9]\d{0,8}(?![\p{L}\p{N}_]|-[\p{L}\p{N}])/gu;

export interface TaskKeyRange {
  key: string;
  start: number;
  end: number;
}

/** The key-shaped text in `text`. Whether a card exists under it is decided by the `resolveTaskKeys` lookup, never here. */
export function findTaskKeys(text: string): TaskKeyRange[] {
  return Array.from(text.matchAll(TASK_KEY), (match) => ({ key: match[0], start: match.index, end: match.index + match[0].length }));
}

/** What the lookup knows about a key that is a card. `currentKey` differs from `key` for an old key kept as an alias. */
export interface ResolvedTaskKey {
  key: string;
  currentKey: string;
  title: string;
  status: string;
  statusName: string;
  archived: boolean;
}

export const MAX_RESOLVE_KEYS = 500;

/** The hover text of a key link: `EXA-12 · Card title · Status`, naming the current key when the written one is old. */
export function taskKeyTitle(task: ResolvedTaskKey): string {
  return `${task.currentKey} · ${task.title} · ${task.statusName}${task.archived ? " (archived)" : ""}`;
}

// html: true so an HTML block is a block token (its lines are skipped); the output is never rendered by this instance.
const markdown = new MarkdownIt({ html: true });

// One level of nested brackets in a label, as `LINK_PATTERN` in components/linked-text.tsx allows.
const LABEL = String.raw`(?:[^\[\]\n]|\[[^\[\]\n]*\])+`;
// Spans a key is never linked in, in the order they are tried at one position: a reference definition line; a code span (a run
// of N backticks to the next run of exactly N, CommonMark, never across a blank line); an inline link or image; a full or collapsed
// reference `[label][ref]`; a shortcut reference `[label]`; an HTML comment, inline tag or `<autolink>`; a bare URL.
const INLINE_PROTECTED = new RegExp(
  [
    String.raw`^[ \t]{0,3}\[[^\]\n]+\]:[^\n]*`,
    String.raw`(?<!\`)(?<ticks>\`+)(?!\`)(?:(?!\n[ \t]*\n)[\s\S])+?(?<!\`)\k<ticks>(?!\`)`,
    String.raw`!?\[${LABEL}\]\((?:[^()\n]|\([^()\n]*\))*\)`,
    String.raw`!?\[(?<flabel>${LABEL})\]\[(?<ref>[^\]\n]*)\]`,
    String.raw`!?\[(?<slabel>${LABEL})\]`,
    String.raw`<!--[\s\S]*?-->|<\/?[A-Za-z][^<>]*>`,
    String.raw`https?:\/\/[^\s<>)]+`,
  ].join("|"),
  "gm",
);

/** The ranges of `text` a key is never linked in. A reference is protected only when `body` defines it, else it is plain text. */
function protectedRanges(text: string, defined: (label: string) => boolean): Array<[number, number]> {
  const pattern = new RegExp(INLINE_PROTECTED);
  const ranges: Array<[number, number]> = [];
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const { flabel, ref, slabel } = match.groups ?? {};
    let length = match[0].length;
    if (flabel !== undefined) {
      if (!defined(ref || flabel)) length = defined(flabel) ? (match[0].startsWith("!") ? 1 : 0) + flabel.length + 2 : 0;
    } else if (slabel !== undefined && !defined(slabel)) length = 0;
    // Brackets that are no reference are plain text: look again from inside them.
    if (length === 0) { pattern.lastIndex = match.index + 1; continue; }
    ranges.push([match.index, match.index + length]);
    pattern.lastIndex = match.index + length;
  }
  return ranges;
}

/**
 * Markdown with each key in `resolved` (key as written -> current key) rewritten to `[KEY](in-app path)`. Never inside
 * fenced, indented or HTML blocks (found by markdown-it), code spans, links, images, defined references, definitions,
 * HTML or autolinks. Keys not in `resolved` stay as written. For rendering only: never store it.
 */
export function withTaskKeyLinks(body: string, resolved: ReadonlyMap<string, string>): string {
  if (resolved.size === 0) return body;
  const env: { references?: Record<string, unknown> } = {};
  const skipped = new Set<number>();
  for (const token of markdown.parse(body, env)) {
    if (token.map && (token.type === "fence" || token.type === "code_block" || token.type === "html_block")) {
      for (let line = token.map[0]; line < token.map[1]; line++) skipped.add(line);
    }
  }
  const defined = (label: string) => env.references?.[markdown.utils.normalizeReference(label)] !== undefined;
  const link = (text: string) => {
    let out = "";
    let last = 0;
    const plain = (from: number, to: number) => {
      let at = from;
      for (const { key, start, end } of findTaskKeys(text.slice(from, to))) {
        const current = resolved.get(key);
        if (current === undefined) continue;
        out += `${text.slice(at, from + start)}[${key}](${taskHref(current)})`;
        at = from + end;
      }
      out += text.slice(at, to);
    };
    for (const [from, to] of protectedRanges(text, defined)) {
      plain(last, from);
      out += text.slice(from, to);
      last = to;
    }
    plain(last, text.length);
    return out;
  };
  // Runs of lines outside code and HTML blocks are rewritten as one text, so a code span may cross a line break.
  const lines = body.split("\n");
  const out: string[] = [];
  for (let line = 0; line < lines.length; ) {
    if (skipped.has(line)) { out.push(lines[line++]!); continue; }
    const from = line;
    while (line < lines.length && !skipped.has(line)) line++;
    out.push(link(lines.slice(from, line).join("\n")));
  }
  return out.join("\n");
}
