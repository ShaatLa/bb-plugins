import { useLayoutEffect, useRef, useState } from 'react';

// iOS picker-style change: a changed character rolls in from above while the old one rolls out below. Characters are
// matched from the right, so "$472" -> "$480" rolls only the last two and a new leading digit just appears.
export function RollingText({ text }: { text: string }) {
  const chars = [...text];
  return <span className="inline-flex tabular-nums">{chars.map((char, i) => <RollingChar key={chars.length - i} char={char} />)}</span>;
}

const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)', DURATION = 380;

function RollingChar({ char }: { char: string }) {
  const [state, setState] = useState({ now: char, old: null as string | null, turn: 0 });
  // Derived from the prop during render, so the new character and its animation land in the same frame.
  if (state.now !== char) setState({ now: char, old: state.now, turn: state.turn + 1 });
  const incoming = useRef<HTMLSpanElement>(null), outgoing = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    if (!state.turn || state.old === null) return;
    const inEl = incoming.current, outEl = outgoing.current;
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still || !inEl || typeof inEl.animate !== 'function') { setState(s => ({ ...s, old: null })); return; }
    inEl.animate([{ transform: 'translateY(-100%)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: DURATION, easing: EASING });
    const out = outEl?.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(100%)', opacity: 0 }], { duration: DURATION, easing: EASING, fill: 'forwards' });
    const turn = state.turn, done = () => setState(s => s.turn === turn ? { ...s, old: null } : s);
    if (out) out.onfinish = done; else done();
    return () => { if (out) out.onfinish = null; };
  }, [state.turn]);
  return <span className="relative inline-block overflow-hidden" data-rolling={state.old !== null || undefined}>
    <span ref={incoming} className="inline-block">{state.now}</span>
    {state.old !== null && <span ref={outgoing} aria-hidden className="absolute inset-x-0 top-0 inline-block">{state.old}</span>}
  </span>;
}
