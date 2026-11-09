import { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, Markdown, useComposer } from '@get-bb/plugin-sdk/app';
import { Composer } from './composer';
import { Button } from './components/ui/button';

type CommentRequest = { quote: string; composer: ReturnType<typeof useComposer>; top: number; left: number };
export const COMMENT_EVENT = 'answers:chat-comment';

export function ChatComment() {
  const [request, setRequest] = useState<CommentRequest | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const popup = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const open = (event: Event) => { setRequest((event as CustomEvent<CommentRequest>).detail); setText(''); setError(''); };
    window.addEventListener(COMMENT_EVENT, open);
    return () => window.removeEventListener(COMMENT_EVENT, open);
  }, []);
  useEffect(() => {
    if (!request) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRequest(null); };
    const outside = (event: PointerEvent) => { if (popup.current && !popup.current.contains(event.target as Node)) setRequest(null); };
    document.addEventListener('keydown', escape); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', escape); document.removeEventListener('pointerdown', outside); };
  }, [request]);
  if (!request) return null;
  const submit = () => {
    try {
      const quote = request.quote.trim().split('\n').map(line => `> ${line}`).join('\n');
      request.composer.insert(`${request.composer.text ? '\n\n' : ''}${quote}\n\n${text}`, { at: 'end' });
      setRequest(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <div ref={popup} role="dialog" aria-label="Comment on chat selection" className="fixed z-[100] w-[min(560px,calc(100vw-16px))]" style={{ top: Math.min(request.top, window.innerHeight - 240), left: Math.max(8, Math.min(request.left, window.innerWidth - 568)) }}>
    <Composer label="Comment text" autoFocus value={text} onChange={setText} attachments={[]} onAttachments={() => {}} projectId={null} onSend={submit} sendLabel="Insert comment" header={<div className="flex items-start gap-2 pl-4 pr-2 pt-2"><div className="mt-1 max-h-32 min-w-0 flex-1 overflow-auto border-l-2 border-border-seam pl-2 text-sm text-muted-foreground"><Markdown content={request.quote} /></div><Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" aria-label="Close" onClick={() => setRequest(null)}><Icon name="X" aria-hidden /></Button></div>} />
    {error && <p role="alert" className="bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
