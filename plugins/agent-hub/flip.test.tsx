// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { act, render } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useFlip } from './flip';

function List({ order }: { order: string[] }) {
  const ref = useRef<HTMLDivElement>(null); useFlip(ref);
  return <div ref={ref}>{order.map(id => <div key={id} data-flip={id}>{id}</div>)}</div>;
}
it('glides a re-ordered row from its old place and leaves unmoved rows alone', () => {
  const animate = vi.fn();
  const proto = HTMLElement.prototype as any, had = Object.getOwnPropertyDescriptor(proto, 'offsetTop');
  Object.defineProperty(proto, 'offsetTop', { configurable: true, get(this: HTMLElement) { return Array.from(this.parentElement!.children).indexOf(this) * 40; } });
  proto.animate = animate;
  try {
    let set!: (order: string[]) => void;
    function Host() { const [order, setOrder] = useState(['a', 'b', 'c']); set = setOrder; return <List order={order} />; }
    render(<Host />);
    expect(animate).not.toHaveBeenCalled();
    act(() => set(['b', 'a', 'c']));
    const moves = animate.mock.calls.map(([frames], i) => [(animate.mock.contexts[i] as HTMLElement).dataset.flip, frames[0].transform]);
    expect(moves).toEqual([['b', 'translateY(40px)'], ['a', 'translateY(-40px)']]);
  } finally { delete proto.animate; if (had) Object.defineProperty(proto, 'offsetTop', had); }
});
