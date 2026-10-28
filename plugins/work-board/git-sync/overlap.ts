import { prIdentity, type GitSyncConfig, type Overlap, type PrLink, type PrSnapshot } from "../shared/git-sync";

export function matchesGlob(pattern: string, path: string): boolean {
  let regex = "^";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") { regex += "(?:.*/)?"; i++; }
        else regex += ".*";
      } else regex += "[^/]*";
    } else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(regex + "$").test(path);
}

type Entry = { taskId: string; taskKey: string; link: PrLink; snapshot: PrSnapshot };
export function evaluateOverlaps(entries: Entry[], taskId: string, rules: NonNullable<GitSyncConfig["overlapRules"]>): Overlap[] {
  const results: Overlap[] = [];
  for (const left of entries.filter(entry => entry.taskId === taskId)) for (const right of entries) {
    if (right.taskId === taskId || left.link.repository !== right.link.repository || prIdentity(left.link) === prIdentity(right.link)) continue;
    const leftFiles = left.snapshot.files?.entries ?? [], rightFiles = right.snapshot.files?.entries ?? [];
    const paths = (files: typeof leftFiles) => new Set(files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]));
    const rightPaths = paths(rightFiles);
    const shared = [...paths(leftFiles)].filter(path => rightPaths.has(path)).sort();
    const base = { pr: { repository: left.link.repository, number: left.link.number }, otherTaskKey: right.taskKey, otherPr: { repository: right.link.repository, number: right.link.number } };
    for (const rule of rules) {
      let files: string[];
      if (rule.match === "changed") files = shared.filter(path => matchesGlob(rule.pattern, path));
      else {
        const added = (items: typeof leftFiles) => items.filter(file => ["added", "renamed"].includes(file.status) && matchesGlob(rule.pattern, file.filename)).map(file => file.filename);
        const a = added(leftFiles), b = added(rightFiles);
        files = a.length && b.length ? [...new Set([...a, ...b])].sort() : [];
      }
      if (files.length) results.push({ ...base, rule, files });
    }
    if (shared.length) results.push({ ...base, rule: null, files: shared });
  }
  return results;
}
