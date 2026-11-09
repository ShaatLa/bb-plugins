import { inflateRawSync } from "node:zlib";
import { firstMatch, type FlakeRule, type SignatureHit } from "./flake-signatures";

// Server-only: zip and test-report parsing need node:zlib, so they stay out of the browser bundle.
export const MAX_UNZIPPED_BYTES = 64 * 1024 * 1024;
const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
const xmlText = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const asRecord = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

// One failed test: `title` is the "FAIL <suite> <test>" line the signature matching sees, `name` the short label for people, `output` its log lines.
// `build` is set when the entry is a build or setup failure (nothing ran): the package or suite that did not start.
type Failure = { title: string; name: string; output: string[]; build?: string };
const lastSegment = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function jestFailures(report: Record<string, unknown>): Failure[] {
  const out: Failure[] = [];
  for (const suite of Array.isArray(report.testResults) ? report.testResults : []) {
    const file = asRecord(suite); if (!file) continue;
    const tests = Array.isArray(file.assertionResults) ? file.assertionResults : [];
    for (const raw of tests) {
      const test = asRecord(raw);
      if (test?.status !== "failed") continue;
      const output: string[] = [];
      for (const message of Array.isArray(test.failureMessages) ? test.failureMessages : []) output.push(...stripAnsi(String(message)).split(/\r?\n/));
      out.push({ title: `FAIL ${file.name} ${test.fullName ?? test.title}`, name: String(test.fullName ?? test.title), output });
    }
    // A suite that failed to run reports no assertions, only a message.
    // With an exec error or a message it is a setup failure (syntax error, missing module): the suite never started.
    if (!tests.length && file.status === "failed") {
      const message = stripAnsi(String(file.message ?? ""));
      out.push({ title: `FAIL ${file.name}`, name: lastSegment(String(file.name)), output: message.split(/\r?\n/), ...(file.testExecError || message.trim() ? { build: String(file.name) } : {}) });
    }
  }
  return out;
}
function goFailures(lines: string[]): Failure[] {
  const tests = new Map<string, { package: unknown; test: unknown; last: string; output: string[] }>();
  // Package-level events (no Test): a package that did not compile or set up reports `[build failed]` / `[setup failed]` and a final fail.
  const packages = new Map<string, { last: string; output: string[] }>();
  for (const line of lines) {
    const event = line.trim() ? asRecord(JSON.parse(line)) : null;
    if (!event) continue;
    const text = event.Action === "output" && typeof event.Output === "string" ? event.Output.replace(/\r?\n$/, "").split(/\r?\n/) : null;
    if (typeof event.Test !== "string") {
      const entry = packages.get(String(event.Package)) ?? { last: "", output: [] };
      packages.set(String(event.Package), entry);
      if (text) entry.output.push(...text); else if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") entry.last = String(event.Action);
      continue;
    }
    const key = `${event.Package}\0${event.Test}`;
    const entry = tests.get(key) ?? { package: event.Package, test: event.Test, last: "", output: [] };
    tests.set(key, entry);
    if (text) entry.output.push(...text);
    else if (event.Action === "pass" || event.Action === "fail" || event.Action === "skip") entry.last = event.Action;
  }
  const built = [...packages].filter(([, entry]) => entry.last === "fail" && entry.output.some((l) => /\[(?:build|setup) failed\]/.test(l)))
    .map(([name, entry]): Failure => ({ title: `BUILD FAILED ${name}`, name: `${lastSegment(name)} (build failed)`, output: entry.output, build: name }));
  return [...built, ...[...tests.values()].filter((entry) => entry.last === "fail").map((entry) => ({ title: `FAIL ${entry.package} ${entry.test}`, name: `${lastSegment(String(entry.package))}.${entry.test}`, output: entry.output }))];
}
function junitFailures(xml: string): Failure[] {
  const out: Failure[] = [], attribute = (attributes: string, name: string) => xmlText(new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? "");
  for (const found of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/.exec(found[2] ?? "");
    if (!failure) continue;
    const classname = attribute(found[1]!, "classname"), name = attribute(found[1]!, "name");
    out.push({ title: `FAIL ${classname} ${name}`, name: classname ? `${classname}.${name}` : name, output: [attribute(failure[2]!, "message"), xmlText(failure[3] ?? "")].join("\n").split(/\r?\n/) });
  }
  return out;
}
/** Failed tests of a recognized test report (Go test2json, Jest/Vitest JSON, JUnit XML); null when the text is not one. */
function failures(text: string): Failure[] | null {
  const head = text.trimStart();
  try {
    if (head.startsWith("{")) {
      try { const report = asRecord(JSON.parse(head)); if (report && Array.isArray(report.testResults)) return jestFailures(report); } catch { /* Not one JSON document: maybe JSONL. */ }
      const lines = head.split("\n");
      const first = asRecord(JSON.parse(lines[0]!));
      if (first && typeof first.Action === "string") return goFailures(lines);
    } else if (head.startsWith("<") && /<testcase\b/.test(head)) return junitFailures(head);
  } catch { /* Unparseable: treated as plain text. */ }
  return null;
}
/**
 * Test reports list every test, passed or not, so matching their raw lines would hit passing tests.
 * For Go test2json, Jest/Vitest JSON and JUnit XML this returns only the failed tests ("FAIL <suite> <test>" plus their output);
 * "" for a report with no failures; null when the text is not a recognized report (the caller matches its lines).
 */
export function failedTestCorpus(text: string): string | null {
  return failedTestEvidence(text)?.corpus ?? null;
}
/** The failed-test corpus plus the first build or setup failure of a recognized report (its package or suite); null when the text is not a report. */
export function failedTestEvidence(text: string): { corpus: string; build: string | null } | null {
  const found = failures(text);
  return found && { corpus: found.flatMap((failure) => [failure.title, ...failure.output]).join("\n"), build: found.find((failure) => failure.build)?.build ?? null };
}
/** Names of the FAILED tests of a recognized test report (no output, no passing tests); null when the text is not a report. */
export function failedTestNames(text: string): string[] | null {
  return failures(text)?.map((failure) => failure.name).filter(Boolean) ?? null;
}

/** Text entries of a zip (stored and deflated only, no zip64, no encryption); binary entries and anything past the total cap are skipped. */
export function* zipTextEntries(zip: Buffer, maxTotal = MAX_UNZIPPED_BYTES): Generator<{ name: string; text: string }> {
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16), total = 0;
  for (let n = 0; n < count && at + 46 <= zip.length && zip.readUInt32LE(at) === 0x02014b50; n++) {
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28), local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (name.endsWith("/") || flags & 1 || (method !== 0 && method !== 8) || !size || size === 0xffffffff || packed === 0xffffffff) continue;
    if (total + size > maxTotal) break;
    if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (start + packed > zip.length) continue;
    let data: Buffer;
    // maxOutputLength stops an entry that inflates past the size its header declared.
    try { data = method === 0 ? zip.subarray(start, start + packed) : inflateRawSync(zip.subarray(start, start + packed), { maxOutputLength: size }); } catch { continue; }
    total += size;
    if (data.subarray(0, 8000).includes(0)) continue;
    yield { name, text: data.toString("utf8") };
  }
}
/** What a zip says about a failure: `report` is true when it holds a recognized test report; then `hit` and `build` come from the failed tests only, otherwise `hit` from its text lines. */
export type ZipEvidence = { report: boolean; hit: SignatureHit | null; build: string | null };
export function scanZip(zip: Buffer, rules: FlakeRule[], maxTotal?: number): ZipEvidence {
  const out: ZipEvidence = { report: false, hit: null, build: null };
  try {
    const entries = [...zipTextEntries(zip, maxTotal)].map(({ text }) => ({ text, found: failedTestEvidence(text) }));
    // Sidecar files next to a test report (manifests, file lists) name passing tests too: search only the failures then.
    out.report = entries.some((entry) => entry.found);
    for (const { text, found } of entries) {
      if (found) { out.hit ??= firstMatch(rules, found.corpus); out.build ??= found.build; }
      else if (!out.report) out.hit ??= firstMatch(rules, text);
    }
  } catch { /* A corrupt archive has no readable evidence. */ }
  return out;
}
