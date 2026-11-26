import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TASK_LINK_INSTRUCTIONS } from "../shared/task-link";

/**
 * The work-board skill was split into a short core plus references. The manifest lists, per new file, its ordered parts:
 * `{old: [from, to]}` is a verbatim line range of the pre-split SKILL.md (the fixture), `{added: text}` is new text.
 * The fixture is the old file byte for byte. The pre-split file must be rebuilt exactly from the new files.
 */
type Part = { old: [number, number]; added?: undefined } | { added: string; old?: undefined };
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "skill-split.manifest.json"), "utf8")) as {
  fixture: string;
  base: string;
  substitutions: { file: string; from: string; to: string; count: number }[];
  files: Record<string, Part[]>;
};
const baseDir = path.join(__dirname, manifest.base);
const fixture = fs.readFileSync(path.join(__dirname, manifest.fixture), "utf8");
const fixtureLines = fixture.split("\n").slice(0, -1).map((l) => `${l}\n`);
const read = (f: string) => fs.readFileSync(path.join(baseDir, f), "utf8");
const refDir = path.join(baseDir, "references");
const refFiles = fs.readdirSync(refDir).filter((f) => f.endsWith(".md")).sort();
const originalReferences = ["attachments.md", "delegation.md"];
const newReferences = Object.keys(manifest.files).filter((f) => f !== "SKILL.md").map((f) => path.basename(f)).sort();

/** The new text of a part: the old lines with the listed substitutions applied, or the added text. */
function expected(file: string, part: Part): string {
  if (part.added !== undefined) return part.added;
  let text = fixtureLines.slice(part.old[0] - 1, part.old[1]).join("");
  for (const s of manifest.substitutions.filter((x) => x.file === file)) text = text.split(s.from).join(s.to);
  return text;
}

describe("skill split", () => {
  it("rebuilds the pre-split SKILL.md byte for byte from the new files", () => {
    const old: { from: number; text: string }[] = [];
    for (const [file, parts] of Object.entries(manifest.files)) {
      const actual = read(file);
      let at = 0;
      for (const part of parts) {
        const want = expected(file, part);
        const got = actual.slice(at, at + want.length);
        expect(got, `${file} at ${at}`).toBe(want);
        at += want.length;
        if (part.old) {
          let text = got;
          for (const s of manifest.substitutions.filter((x) => x.file === file)) text = text.split(s.to).join(s.from);
          old.push({ from: part.old[0], text });
        }
      }
      expect(at, `${file} has text outside the manifest`).toBe(actual.length);
    }
    expect(old.sort((a, b) => a.from - b.from).map((p) => p.text).join("")).toBe(fixture);
  });

  it("uses every old line exactly once", () => {
    const seen = new Array(fixtureLines.length + 1).fill(0);
    for (const parts of Object.values(manifest.files)) for (const p of parts) if (p.old) for (let i = p.old[0]; i <= p.old[1]; i++) seen[i]++;
    expect(seen.slice(1).every((n) => n === 1)).toBe(true);
  });

  it("applies every listed substitution as many times as declared", () => {
    for (const s of manifest.substitutions) {
      const old = Object.values(manifest.files).flat().filter((p): p is Extract<Part, { old: unknown }> => !!p.old).map((p) => fixtureLines.slice(p.old[0] - 1, p.old[1]).join("")).join("");
      expect(old.split(s.from).length - 1).toBe(s.count);
    }
  });

  it("keeps the original references unchanged and names every reference in the index", () => {
    expect(refFiles).toEqual([...originalReferences, ...newReferences].sort());
    const core = read("SKILL.md");
    for (const f of refFiles) expect(core, f).toContain(`\`references/${f}\``);
  });

  it("keeps the core short", () => {
    expect(read("SKILL.md").length).toBeLessThanOrEqual(20_000);
  });

  it("keeps the Markdown valid: balanced fences, no boundary inside a fence, list or table", () => {
    for (const f of ["SKILL.md", ...refFiles.map((r) => `references/${r}`)]) {
      const fences = read(f).split("\n").filter((l) => /^\s*```/.test(l)).length;
      expect(fences % 2, `${f} fences`).toBe(0);
    }
    for (const [file, parts] of Object.entries(manifest.files)) {
      let inFence = false;
      const text = parts.map((p) => expected(file, p));
      for (let i = 0; i < text.length; i++) {
        for (const l of text[i].split("\n")) if (/^\s*```/.test(l)) inFence = !inFence;
        expect(inFence, `${file} part ${i} ends inside a fence`).toBe(false);
        const last = text[i].replace(/\n+$/, "").split("\n").pop() ?? "";
        const trailingBlank = /\n\n$/.test(text[i]);
        const next = text[i + 1]?.split("\n")[0] ?? "";
        if (i + 1 < text.length && !trailingBlank) {
          // adjacent parts may only meet at a heading or a paragraph start, never inside a list or table
          expect(/^\s*(?:[-*]|\d+\.)\s|^\|/.test(last) && /^\s*(?:[-*]|\d+\.)\s|^\||^\s+\S/.test(next), `${file} part ${i} splits a list or table`).toBe(false);
        }
      }
    }
  });

  it("resolves every relative link", () => {
    for (const f of ["SKILL.md", ...refFiles.map((r) => `references/${r}`)]) {
      const dir = path.dirname(path.join(baseDir, f));
      for (const m of read(f).matchAll(/\]\((?!https?:|\/|#|mailto:)([^)\s]+)\)/g)) {
        expect(fs.existsSync(path.join(dir, m[1].split("#")[0])), `${f} -> ${m[1]}`).toBe(true);
      }
    }
    // paths named in backticks as references/x.md must exist too
    for (const m of read("SKILL.md").matchAll(/`references\/([\w-]+\.md)`/g)) expect(refFiles).toContain(m[1]);
  });
});

describe("standing instructions", () => {
  const removed = JSON.parse(fs.readFileSync(path.join(__dirname, "skill-split.removed-instructions.json"), "utf8")) as string[];
  const norm = (s: string) => s.replace(/\s+/g, " ");
  const skillText = norm([read("SKILL.md"), ...refFiles.map((f) => read(`references/${f}`))].join("\n"));

  it("stay within the size budget", () => {
    expect(TASK_LINK_INSTRUCTIONS.length).toBeLessThanOrEqual(1100);
  });

  it("no longer carry the sentences that the skill holds", () => {
    for (const s of removed) expect(norm(TASK_LINK_INSTRUCTIONS), s).not.toContain(norm(s));
  });

  it("account for every sentence of the old instructions", () => {
    // The old text byte for byte; each of its sentences stays in the new instructions or is on the removed list.
    const before = fs.readFileSync(path.join(__dirname, "skill-split.instructions-fixture.md"), "utf8");
    const sentences = before.split(/\n+/).flatMap((line) => line.startsWith("#") ? [line] : line.split(/(?<=[.!?:])\s+(?=[A-Z`])/)).map(norm).map((s) => s.trim()).filter(Boolean);
    const listed = new Set(removed.map((s) => norm(s).trim()));
    const kept = norm(TASK_LINK_INSTRUCTIONS);
    for (const s of sentences) expect(kept.includes(s) || listed.has(s), s).toBe(true);
    // The list holds only sentences of the old text, so nothing is invented to satisfy the skill check.
    for (const s of listed) expect(sentences, s).toContain(s);
  });

  it("have every removed sentence verbatim in the skill", () => {
    for (const s of removed) expect(skillText, s).toContain(norm(s));
  });

  it("keep the rules an agent follows without opening the skill", () => {
    expect(TASK_LINK_INSTRUCTIONS).toContain("[EXA-12](/plugins/work-board/work-board/task/EXA-12)");
    expect(TASK_LINK_INSTRUCTIONS).toContain("Plain keys and these links are for bb chat only");
    expect(TASK_LINK_INSTRUCTIONS).toContain("`bb work-board dependency list KEY --json`");
    expect(TASK_LINK_INSTRUCTIONS).toContain("Only Done satisfies a predecessor");
    expect(TASK_LINK_INSTRUCTIONS).toContain("ask on the task, not in chat, with `bb work-board question add KEY --kind decision|check`");
    expect(TASK_LINK_INSTRUCTIONS).toContain("Open the work-board skill");
  });
});
