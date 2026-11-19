// shortcut: the SDK cannot open bb's own routes or another plugin's page, so this moves bb's router the way its own links do
// (a history entry plus popstate); if bb changes its routing this opens nothing, and an SDK navigation call should replace it.
export function openAppRoute(path: string) {
  history.pushState({ usr: null, key: Math.random().toString(36).slice(2, 10), idx: ((history.state as { idx?: number } | null)?.idx ?? 0) + 1 }, '', path);
  dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
}
