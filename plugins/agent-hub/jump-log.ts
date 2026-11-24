// Temporary diagnostic: a chat still jumps far up with no input from the reader, and tests cannot reproduce it.
// It logs such a jump to the plugin log with the scroll writes and chat state just before it; remove once the cause is fixed.
const JUMP = 1200, QUIET = 1500, KEEP = 2500;
let sent = 0;
export function watchJumps(node: HTMLElement, threadId: string, state: () => Record<string, unknown>) {
  if (typeof performance === 'undefined') return () => {};
  // Reads and writes go through the prototype chain at call time, so anything else hooked there still applies.
  const proto = Object.getPrototypeOf(node), own = { get: () => Reflect.get(proto, 'scrollTop', node) as number, set: (to: number) => { Reflect.set(proto, 'scrollTop', to, node); } };
  const writes: { at: number; to: number; from: number; stack: string }[] = [];
  let last = own.get(), input = -Infinity, height = node.scrollHeight;
  const now = () => Math.round(performance.now());
  Object.defineProperty(node, 'scrollTop', { configurable: true, get: () => own.get(), set: (to: number) => {
    writes.push({ at: now(), to: Math.round(to), from: Math.round(own.get()), stack: (new Error().stack ?? '').split('\n').slice(2, 6).map(line => line.trim().replace(/^at /, '').replace(/https?:\/\/[^/]+/, '')).join(' < ') });
    while (writes.length > 12) writes.shift();
    own.set(to);
  } });
  const mark = () => { input = now(); };
  const inputs = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
  for (const name of inputs) node.addEventListener(name, mark, { passive: true, capture: true });
  const scrolled = () => {
    const top = own.get(), t = now();
    if (last - top > JUMP && t - input > QUIET && sent < 20) {
      sent++;
      const recent = writes.filter(write => t - write.at < KEEP).map(write => `${t - write.at}ms ago ${write.from}->${write.to} ${write.stack}`);
      const active = document.activeElement, focus = active ? `${active.tagName.toLowerCase()}${active.getAttribute('aria-label') ? `[${active.getAttribute('aria-label')}]` : ''}` : 'none';
      const message = `jump ${threadId} ${Math.round(last)}->${Math.round(top)} height ${height}->${node.scrollHeight} client ${node.clientHeight} input ${Number.isFinite(input) ? `${t - input}ms ago` : 'none'} focus ${focus} state ${JSON.stringify(state())}`;
      void fetch('/api/v1/plugins/agent-hub/rpc/logClientError', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ where: 'jump', message: message.slice(0, 2000), stack: (recent.join('\n') || 'no scroll writes: the browser moved it').slice(0, 8000) }) }).catch(() => {});
    }
    last = top; height = node.scrollHeight;
  };
  node.addEventListener('scroll', scrolled, { passive: true });
  return () => { node.removeEventListener('scroll', scrolled); for (const name of inputs) node.removeEventListener(name, mark, { capture: true }); delete (node as { scrollTop?: number }).scrollTop; };
}
