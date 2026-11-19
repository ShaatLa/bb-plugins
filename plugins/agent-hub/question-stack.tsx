import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
const Stack = createContext<{ collapsed: boolean; toggle: () => void } | null>(null);
export const useQuestionStack = () => useContext(Stack);
const choices = new Map<string, boolean>();
export function QuestionStack({ threadId, children }: { threadId: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(choices.get(threadId) ?? false);
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const measure = () => {
      if (!choices.has(threadId) && window.matchMedia?.('(pointer: coarse)').matches && node.getBoundingClientRect().height > window.innerHeight * 0.4) setCollapsed(true);
    };
    measure();
    const observer = new MutationObserver(measure); observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pending-title'] });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); resize?.observe(node);
    return () => { observer.disconnect(); resize?.disconnect(); };
  }, [threadId]);
  return <Stack.Provider value={{ collapsed, toggle: () => { choices.set(threadId, !collapsed); setCollapsed(!collapsed); } }}><div ref={body}>{children}</div></Stack.Provider>;
}
