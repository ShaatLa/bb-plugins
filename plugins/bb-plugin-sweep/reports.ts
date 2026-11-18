import { createHash } from 'node:crypto';

export const summaryLine = /^sweep: (\d+) threads, (\d+) cards checked, (\d+) actions$/;
export const archivedWorktreeKind = 'ACTION archived-worktree';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

export function reportContents(exitCode: number, output: string) {
  const items = new Map<string, string>();
  const diagnostics: string[] = [];
  for (const line of output.trimEnd().split(/\r?\n/)) {
    if (summaryLine.test(line)) continue;
    const entry = /^(ANSWER|ACTION|WAIT|STATE) (\S.*)$/.exec(line);
    if (!entry) {
      diagnostics.push(line);
      continue;
    }
    const [, tag, detail] = entry;
    const subtype = tag === 'ACTION' && /^[a-z][a-z0-9-]*(?=[: ]|$)/.exec(detail)?.[0];
    const kind = subtype ? `${tag} ${subtype}` : tag;
    let stable = tag === 'ACTION'
      ? detail.replace(/\b(idle |failed |no active session for |no session for )\d+(?= min\b)/g, '$1#')
      : detail;
    if (subtype === 'provider-idle') stable = stable.replace(/\b\d+(?=%| h\b)/g, '#');
    items.set(hash(JSON.stringify([tag, stable])), kind);
  }
  const noteworthy: string[] = [], waiting: string[] = [];
  const comparisonItems: string[] = [];
  for (const [id, kind] of items) {
    // Sweep tracks worktree delivery by path until a scan observes it cleared.
    if (kind === archivedWorktreeKind) continue;
    comparisonItems.push(id);
    if (kind === 'ANSWER' || kind.startsWith('ACTION')) noteworthy.push(id);
    if (kind === 'WAIT') waiting.push(id);
  }
  return {
    items,
    fingerprint: hash(JSON.stringify([exitCode, comparisonItems.sort(), diagnostics])),
    changes: { noteworthy, waiting: waiting.length ? hash(JSON.stringify(waiting.sort())) : '' },
  };
}
