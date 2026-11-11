/** Match only task keys from connected Work Board projects; keep model/version lookalikes as text. */
export function taskKeyRegex(prefixes: string[]) {
  return prefixes.length ? new RegExp(`(?<![\\w-])((?:${prefixes.map(p => p.replace(/[^A-Za-z0-9]/g, '')).join('|')})-\\d+)(?![\\w-])`) : null;
}
/** Work Board's own task key shape (views/embed TASK_KEY_PATTERN) and its task route. */
export const TASK_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,9}-\d+$/;
export const TASK_LINK = /\/plugins\/work-board\/work-board\/task\/([^/?#]+)/;
