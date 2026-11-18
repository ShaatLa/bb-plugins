import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
const choices = new Map<string, boolean>();
export function QuestionStack({ threadId, children }: { threadId: string; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState(choices.get(threadId) ?? false);
  const [summary, setSummary] = useState({ count: 0, title: '' });
  useLayoutEffect(() => {
    const node = body.current;
    if (!node) return;
    const measure = () => {
      const rows = node.querySelectorAll<HTMLElement>('[data-pending-title]');
      const title = rows[0]?.dataset.pendingTitle ?? '';
      setSummary(old => old.count === rows.length && old.title === title ? old : { count: rows.length, title });
      if (!choices.has(threadId) && window.matchMedia?.('(pointer: coarse)').matches && node.getBoundingClientRect().height > window.innerHeight * 0.4) setCollapsed(true);
    };
    measure();
    const observer = new MutationObserver(measure); observer.observe(node, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pending-title'] });
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure); resize?.observe(node);
    return () => { observer.disconnect(); resize?.disconnect(); };
  }, [threadId]);
  return <section>
    {summary.count > 0 && <Button variant="ghost" size="sm" className="mb-1 flex w-full justify-start px-2 text-xs" aria-label="Pending questions and approvals" aria-expanded={!collapsed} onClick={() => { choices.set(threadId, !collapsed); setCollapsed(!collapsed); }}><Icon name={collapsed ? 'ChevronRight' : 'ChevronDown'} aria-hidden className="size-3.5" /><span className="truncate">{summary.count} · {summary.title}</span></Button>}
    <div ref={body} hidden={collapsed}>{children}</div>
  </section>;
}
