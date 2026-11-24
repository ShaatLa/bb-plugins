import { createHash } from "node:crypto";

/** The script's summary line; `sweep:` is the older scripts' prefix and keeps working. */
export const summaryLine = /^(?:checks|sweep): (\d+) threads, (\d+) cards checked, (\d+) actions$/;
export const archivedWorktreeKind = "ACTION archived-worktree";
export const staleStatusKind = "ACTION stale-status";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Parses a script report and computes what decides whether it is worth sending: the item set, a fingerprint of everything
 * that matters, and the noteworthy and waiting hashes. Summary counts, order and the known volatile counters never count.
 * Items of the `drop` kind are removed from all of it and from `body`, whose summary action count is lowered to match.
 */
export function reportContents(exitCode: number, output: string, options: { drop?: string } = {}) {
  const items = new Map<string, string>();
  const diagnostics: string[] = [];
  const kept: string[] = [];
  let dropped = 0;
  for (const line of output.trimEnd().split(/\r?\n/)) {
    kept.push(line);
    if (summaryLine.test(line)) continue;
    const entry = /^(ANSWER|ACTION|WAIT|STATE) (\S.*)$/.exec(line);
    if (!entry) {
      // A blank line is no diagnostic: empty output and output that is only worktree lines fingerprint alike.
      if (line.trim()) diagnostics.push(line);
      continue;
    }
    const [, tag, detail] = entry;
    const subtype = tag === "ACTION" && /^[a-z][a-z0-9-]*(?=[: ]|$)/.exec(detail)?.[0];
    const kind = subtype ? `${tag} ${subtype}` : tag;
    if (kind === options.drop) { kept.pop(); dropped++; continue; }
    let stable = tag === "ACTION"
      ? detail.replace(/\b(idle |failed |no active session for |no session for )\d+(?= min\b)/g, "$1#")
      : detail;
    if (subtype === "provider-idle") stable = stable.replace(/\b\d+(?=%| h\b)/g, "#");
    items.set(hash(JSON.stringify([tag, stable])), kind);
  }
  const noteworthy: string[] = [], waiting: string[] = [];
  const comparisonItems: string[] = [];
  for (const [id, kind] of items) {
    // Worktree delivery is tracked by path until a scan observes it cleared, not by item.
    if (kind === archivedWorktreeKind) continue;
    comparisonItems.push(id);
    if (kind === "ANSWER" || kind.startsWith("ACTION")) noteworthy.push(id);
    if (kind === "WAIT") waiting.push(id);
  }
  const filtered = kept.map((line) => line.replace(summaryLine, (match: string, threads, cards, actions) => `${match.slice(0, match.indexOf(":"))}: ${threads} threads, ${cards} cards checked, ${Math.max(0, Number(actions) - dropped)} actions`)).join("\n").trimEnd();
  const body = !dropped ? output : filtered && `${filtered}\n`;
  return {
    items, body, dropped, diagnostics: diagnostics.length,
    fingerprint: hash(JSON.stringify([exitCode, comparisonItems.sort(), diagnostics])),
    changes: { noteworthy, waiting: waiting.length ? hash(JSON.stringify(waiting.sort())) : "" },
  };
}
export type ReportChanges = ReturnType<typeof reportContents>["changes"];
