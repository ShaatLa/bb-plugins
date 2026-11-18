/** Match only task keys from connected Work Board projects; keep model/version lookalikes as text. */
export function taskKeyRegex(prefixes: string[]) {
  return prefixes.length ? new RegExp(`(?<![\\w-])((?:${prefixes.map(p => p.replace(/[^A-Za-z0-9]/g, '')).join('|')})-\\d+)(?![\\w-])`) : null;
}
