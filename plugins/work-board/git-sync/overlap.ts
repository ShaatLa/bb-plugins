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
export function prepareOverlaps(entries: Entry[], rules: NonNullable<GitSyncConfig["overlapRules"]>) {
  // Shared snapshots must prepare file sets only once across task comparisons.
  const snapshots = new Map<PrSnapshot, { paths: Set<string>; added: string[][] }>();
  const prepared = entries.map(entry => {
    let files = snapshots.get(entry.snapshot);
    if (!files) {
      const items = entry.snapshot.files?.entries ?? [];
      files = {
        paths: new Set(items.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])])),
        added: rules.map(rule => rule.match === "added" ? items.filter(file => ["added", "renamed"].includes(file.status) && matchesGlob(rule.pattern, file.filename)).map(file => file.filename) : []),
      };
      snapshots.set(entry.snapshot, files);
    }
    return { ...entry, files };
  });
  return (taskId: string): Overlap[] => {
  const results: Overlap[] = [];
  for (const left of prepared.filter(entry => entry.taskId === taskId)) for (const right of prepared) {
    if (right.taskId === taskId || left.link.repository !== right.link.repository || prIdentity(left.link) === prIdentity(right.link)) continue;
    const shared = [...left.files.paths].filter(path => right.files.paths.has(path)).sort();
    const base = { pr: { repository: left.link.repository, number: left.link.number }, otherTaskKey: right.taskKey, otherPr: { repository: right.link.repository, number: right.link.number } };
    for (const [index, rule] of rules.entries()) {
      let files: string[];
      if (rule.match === "changed") files = shared.filter(path => matchesGlob(rule.pattern, path));
      else {
        const a = left.files.added[index]!, b = right.files.added[index]!;
        files = a.length && b.length ? [...new Set([...a, ...b])].sort() : [];
      }
      if (files.length) results.push({ ...base, rule, files });
    }
    if (shared.length) results.push({ ...base, rule: null, files: shared });
  }
  return results;
  };
}

export function evaluateOverlaps(entries: Entry[], taskId: string, rules: NonNullable<GitSyncConfig["overlapRules"]>): Overlap[] {
  return prepareOverlaps(entries, rules)(taskId);
}
