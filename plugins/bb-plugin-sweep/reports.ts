import { createHash } from 'node:crypto';

export const summaryLine = /^sweep: (\d+) threads, (\d+) cards checked, (\d+) actions$/;
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
    const stable = tag === 'ACTION' ? detail.replace(/\b(idle |failed )\d+(?= min\b)/g, '$1#') : detail;
    items.set(hash(JSON.stringify([tag, stable])), kind);
  }
  return { items, fingerprint: hash(JSON.stringify([exitCode, [...items.keys()].sort(), diagnostics])) };
}
