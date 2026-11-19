import { useEffect, useState, type ComponentProps, type ReactNode } from 'react';
import { experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';

export type IconName = ComponentProps<typeof Icon>['name'];

/** Centered empty state: a soft icon tile, a title and a one-line hint. */
export function EmptyState({ icon, title, children }: { icon: IconName; title: string; children?: ReactNode }) {
  return <div className="flex h-full min-h-40 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
    <span className="flex size-10 items-center justify-center rounded-xl border border-border-seam bg-surface-recessed text-muted-foreground"><Icon name={icon} aria-hidden className="size-5" /></span>
    <div className="space-y-1"><p className="text-sm font-medium text-foreground">{title}</p>{children && <p className="mx-auto max-w-72 text-xs leading-relaxed text-muted-foreground">{children}</p>}</div>
  </div>;
}

/** Feedback text that clears itself after a few seconds, unless it reports a problem. */
export function useTransientText(ms = 4000) {
  const [text, setText] = useState('');
  useEffect(() => {
    if (!text || /uncertain|not sent|error/i.test(text)) return;
    const timer = setTimeout(() => setText(''), ms);
    return () => clearTimeout(timer);
  }, [text, ms]);
  return [text, setText] as const;
}
