// Pure text-quote anchoring for plan notes (the idea of the W3C TextQuoteSelector): a note keeps the selected
// text and about 32 characters of context on each side, and is found again by text on every render of a version.
// No DOM and no I/O, so the server (for the order and "unanchored" state in feedback) and the UI share it.
//
// Matching ignores everything but letters, digits and combining marks. The anchor is taken from the rendered
// text, where block boundaries, list numbers and Markdown syntax look different from the source; comparing
// only the letters and digits makes the same passage match on both sides.

export const ANCHOR_CONTEXT = 32;

export interface TextAnchor {
  exact: string;
  prefix: string;
  suffix: string;
}

/** A half-open character range [start, end) of the text an anchor was resolved against. */
export interface TextSpan {
  start: number;
  end: number;
}

const KEPT = /[\p{L}\p{N}\p{M}]/u;

/** The kept characters of `text`, and for each of them its UTF-16 offset in `text`. */
export interface FoldedText {
  source: string;
  folded: string;
  offsets: number[];
}

export function fold(text: string): FoldedText {
  let folded = "";
  const offsets: number[] = [];
  let at = 0;
  for (const char of text) {
    if (KEPT.test(char)) {
      folded += char;
      for (let unit = 0; unit < char.length; unit++) offsets.push(at + unit);
    }
    at += char.length;
  }
  return { source: text, folded, offsets };
}

const foldedOf = (text: string) => fold(text).folded;

/** The anchor of text[start, end): the quote without surrounding whitespace plus its context. Null for a blank selection. */
export function buildAnchor(text: string, start: number, end: number): TextAnchor | null {
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  if (start >= end) return null;
  return {
    exact: text.slice(start, end),
    prefix: text.slice(Math.max(0, start - ANCHOR_CONTEXT), start),
    suffix: text.slice(end, end + ANCHOR_CONTEXT),
  };
}

const commonSuffix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const commonPrefix = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Where the anchor is in the text, or null when it is not there ("unanchored"). One occurrence is taken as it is.
 * Several are told apart by their context: the occurrence whose surroundings equal the stored prefix and suffix
 * wins, else the one sharing the longest context; with no shared context at all the anchor is ambiguous and
 * stays unplaced, so a wrong passage is never marked.
 */
export function resolveAnchor(text: string | FoldedText, anchor: TextAnchor): TextSpan | null {
  const { source, folded, offsets } = typeof text === "string" ? fold(text) : text;
  const exact = foldedOf(anchor.exact);
  if (!exact) return null;
  const found: number[] = [];
  for (let at = folded.indexOf(exact); at !== -1; at = folded.indexOf(exact, at + 1)) found.push(at);
  if (found.length === 0) return null;
  let best = found[0]!;
  if (found.length > 1) {
    const prefix = foldedOf(anchor.prefix);
    const suffix = foldedOf(anchor.suffix);
    let bestScore = -1;
    for (const at of found) {
      const before = folded.slice(Math.max(0, at - prefix.length), at);
      const after = folded.slice(at + exact.length, at + exact.length + suffix.length);
      const score = before === prefix && after === suffix ? Infinity : commonSuffix(before, prefix) + commonPrefix(after, suffix);
      if (score > bestScore) {
        bestScore = score;
        best = at;
      }
    }
    if (bestScore <= 0) return null;
  }
  let start = offsets[best]!;
  let end = offsets[best + exact.length - 1]! + 1;
  // The folded match stops at the first and last letter; take the quote's own edge punctuation along when it is there.
  const lead = /^[^\p{L}\p{N}\p{M}]*/u.exec(anchor.exact)![0];
  const trail = /[^\p{L}\p{N}\p{M}]*$/u.exec(anchor.exact)![0];
  if (lead && source.slice(start - lead.length, start) === lead) start -= lead.length;
  if (trail && source.slice(end, end + trail.length) === trail) end += trail.length;
  return { start, end };
}

/** The text a reader sees for a Markdown plan, as far as anchoring needs it: syntax that renders to no text is dropped. */
export function markdownPlainText(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (fenced && fenced[1]![0] === fence.char && fenced[1]!.length >= fence.length && fenced[2]!.trim() === "") fence = null;
      else out.push(line);
      continue;
    }
    if (fenced) {
      fence = { char: fenced[1]![0]!, length: fenced[1]!.length };
      continue;
    }
    out.push(
      line
        .replace(/^\s*(?:>\s?)+/, "")
        .replace(/^\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/, "")
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/<\/?[A-Za-z][^>]*>/g, ""),
    );
  }
  return out.join("\n");
}
