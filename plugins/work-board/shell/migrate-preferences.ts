/** Copy device preferences once; retain the previous namespace for rollback. */
export function migrateBrowserPreferences(): void {
  try {
    const storage = window.localStorage;
    const marker = "bb-work-board:preferences-migrated";
    if (storage.getItem(marker) === "1") return;
    const entries = new Map<string, string>();
    for (const prefix of ["bb-agent-board:", "bb-tasks-plus:", "bb-tasks:"]) {
      for (let index = 0; index < storage.length; index++) {
        const key = storage.key(index);
        if (!key?.startsWith(prefix)) continue;
        const suffix = key.slice(prefix.length);
        if (suffix.startsWith("query-snapshot:") || suffix === "preferences-migrated") continue;
        const value = storage.getItem(key);
        const target = `bb-work-board:${suffix}`;
        if (value !== null && storage.getItem(target) === null && !entries.has(target))
          entries.set(target, value);
      }
    }
    for (const [key, value] of entries) storage.setItem(key, value);
    storage.setItem(marker, "1");
  } catch {
    /* Storage can be disabled or full; the tracker still works without preferences. */
  }
}
