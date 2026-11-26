/** A task-key group in a title: `EXA-1`, or `EXA-1+2` for several cards. Shared with title discovery. */
export const KEY_GROUP_SOURCE = "([A-Z][A-Z0-9]{0,9})-([1-9][0-9]*(?:\\s*\\+\\s*[1-9][0-9]*)*)";

/** `EXA` and `1 + 2` expand to `EXA-1`, `EXA-2`. */
export function expandKeyGroup(prefix: string, numbers: string): string[] {
  return numbers.split(/\s*\+\s*/).map((number) => `${prefix.toUpperCase()}-${number}`);
}

/** Role words after the key in a review child's title (`<KEY> review: …`). Add another review naming here. */
export const REVIEW_ROLES = ["review", "plan-review", "code-review", "check"] as const;

const ROLE_TITLE = new RegExp(`^\\s*${KEY_GROUP_SOURCE}\\s+(${REVIEW_ROLES.join("|")}):`, "i");

/** The review role a title (`EXA-1 review: …`, `EXA-1+2 check: …`) gives for `key`, lower-cased, or null. */
export function reviewRoleOf(title: string | null | undefined, key: string): string | null {
  const match = ROLE_TITLE.exec(title ?? "");
  if (!match || !expandKeyGroup(match[1]!, match[2]!).includes(key.toUpperCase())) return null;
  return match[3]!.toLowerCase();
}
