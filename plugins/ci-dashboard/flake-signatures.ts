import { z } from "zod";
import type { JobAnnotation } from "./ci-jobs-types";

/** A user-configured known-flake signature: a case-insensitive regex plus the label (e.g. a tracker key) shown as evidence. */
export type FlakeRule = { pattern: RegExp; label: string };
export type SignatureHit = { label: string; match: string };

export const MAX_RULES = 50;
export const MAX_RULES_TEXT = 4000;
/** Compressed artifact size above which an archive is not downloaded. */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024;
// shortcut: lines are cut before matching so a pathological user regex stays cheap; raise if signatures hide past this column.
const MAX_LINE = 4000;

/** One rule per line: `<regex> => <label>`. Blank lines and `#` comments are ignored. */
export function parseFlakeRules(text: string): { rules: FlakeRule[]; errors: string[] } {
  const rules: FlakeRule[] = [], errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith("#")) return;
    const fail = (message: string) => errors.push(`Line ${index + 1}: ${message}`);
    const parts = /^(.*?)\s+=>(?:\s+(.*))?$/.exec(line);
    if (!parts) return fail('use "<regex> => <label>"');
    const source = parts[1]!.trim(), label = (parts[2] ?? "").trim();
    if (!source) return fail("the regex is empty");
    if (!label) return fail("the label is empty");
    if (label.length > 100) return fail("the label is longer than 100 characters");
    let pattern: RegExp;
    try { pattern = new RegExp(source, "i"); } catch (error) { return fail(`invalid regex (${error instanceof Error ? error.message : String(error)})`); }
    // A rule that matches an empty line would flag every failure as a flake.
    if (pattern.test("")) return fail("the regex matches an empty line");
    rules.push({ pattern, label });
  });
  if (rules.length > MAX_RULES) errors.push(`At most ${MAX_RULES} rules are allowed`);
  return { rules, errors };
}

export const flakeSignaturesSchema = z.string().max(MAX_RULES_TEXT).superRefine((value, context) => {
  for (const message of parseFlakeRules(value).errors) context.addIssue({ code: "custom", message });
});

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Comma-separated artifact name globs; `*` is the only wildcard. */
export const parseArtifactGlobs = (text: string): RegExp[] =>
  text.split(",").map((glob) => glob.trim()).filter(Boolean).map((glob) => new RegExp(`^${glob.split("*").map(escapeRegex).join(".*")}$`));

// Pure JS hash: this module is also bundled into the browser app (via ci-classify), which has no node:crypto.
const fnv1a = (text: string) => { let hash = 0x811c9dc5; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193); return (hash >>> 0).toString(16).padStart(8, "0"); };
/** Bump when scan semantics change: stored jobs are then re-scanned once under the new rules. */
const SCAN_VERSION = "reports-over-logs-v1";
/** Parsed settings plus a version of the normalized rules and globs; blank rules disable the feature (hash ""). */
export function flakeSettings(signatures: string, artifacts: string) {
  const parsed = parseFlakeRules(signatures).rules, globs = parseArtifactGlobs(artifacts);
  const rules = parsed.length > MAX_RULES ? [] : parsed;
  const hash = rules.length ? fnv1a(JSON.stringify([SCAN_VERSION, rules.map((rule) => [rule.pattern.source, rule.label]), globs.map((glob) => glob.source)])) : "";
  return { rules, artifacts: globs, hash };
}

const snippet = (line: string, index: number) => { const from = index > 150 ? index - 100 : 0; return line.slice(from, from + 300).trim(); };
export function matchLine(rules: FlakeRule[], line: string): SignatureHit | null {
  const head = line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line;
  for (const { pattern, label } of rules) { const found = pattern.exec(head); if (found) return { label, match: snippet(head, found.index) }; }
  return null;
}
/** First matching line of a text (rule order within a line, line order across the text). */
export function firstMatch(rules: FlakeRule[], text: string): SignatureHit | null {
  for (let start = 0; start <= text.length;) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    const hit = matchLine(rules, text.slice(start, end));
    if (hit) return hit;
    start = end + 1;
  }
  return null;
}
export const annotationHit = (rules: FlakeRule[], annotations: JobAnnotation[]) =>
  rules.length ? firstMatch(rules, annotations.filter((a) => a.level === "failure").map((a) => `${a.title}\n${a.message}`).join("\n")) : null;

/** A deterministic build or setup failure in a log or annotation: no rerun can fix it. */
const BUILD_FAILURE = [{ pattern: /\[(?:build|setup) failed\]|C compiler "[^"]*" not found|cannot find package|could not import/i, label: "build" }];
/** First line of a text that shows a build or setup failure, trimmed. */
export const buildFailureLine = (text: string): string | null => firstMatch(BUILD_FAILURE, text)?.match ?? null;
