/** Copy device preferences once; retain the previous namespace for rollback. */
export function migrateBrowserPreferences(): void {
  try {
    const storage = window.localStorage;
    const marker = "bb-agent-board:preferences-migrated";
    if (storage.getItem(marker) === "1") return;
    const entries: [string, string][] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (!key || key.startsWith("bb-tasks:query-snapshot:")) continue;
      const prefix = ["bb-tasks-plus:", "bb-tasks:"].find((prefix) =>
        key.startsWith(prefix),
      );
      if (!prefix) continue;
      const value = storage.getItem(key);
      const target = `bb-agent-board:${key.slice(prefix.length)}`;
      if (value !== null && storage.getItem(target) === null)
        entries.push([target, value]);
    }
    for (const [key, value] of entries) storage.setItem(key, value);
    storage.setItem(marker, "1");
  } catch {
    /* Storage can be disabled or full; the tracker still works without preferences. */
  }
}
