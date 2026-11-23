import { useEffect, useState } from 'react';
import { experimental_copyToClipboard, experimental_Icon as Icon } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';

export function messageLink(projectId: string | null, threadId: string, seq: number | null) {
  return window.location.origin + `${projectId ? `/projects/${encodeURIComponent(projectId)}` : ''}/threads/${encodeURIComponent(threadId)}${seq == null ? '' : `?msg=${seq}`}`;
}
export function MessageCopy({ text, link = false, small = false, menu = false }: { text: string; link?: boolean; small?: boolean; menu?: boolean }) {
  const [feedback, setFeedback] = useState('');
  useEffect(() => { if (!feedback) return; const timer = setTimeout(() => setFeedback(''), 1500); return () => clearTimeout(timer); }, [feedback]);
  const label = feedback || (link ? 'Copy link' : 'Copy');
  return <Button size="sm" variant="ghost" aria-label={label} role={menu ? 'menuitem' : undefined} {...{ title: label }} className={menu ? 'w-full justify-start px-2 py-1.5 text-left text-sm' : small ? 'size-6 px-0 [&_[data-icon-root]]:size-[13px] [@media(hover:none)]:size-8' : 'size-8 px-0'} onClick={async () => {
    try { setFeedback(await experimental_copyToClipboard({ text }) ? 'Copied' : 'Copy failed'); } catch { setFeedback('Copy failed'); }
  }}>{menu ? label : <Icon name={feedback === 'Copied' ? 'Check' : link ? 'Link' : 'Copy'} aria-hidden />}</Button>;
}
