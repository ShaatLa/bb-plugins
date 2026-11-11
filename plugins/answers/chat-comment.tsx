import { mentionsForText } from './mentions';
import { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, Markdown, experimental_useAppPanel, experimental_useSidebarThreads, useComposer, useRpc, useSdk } from '@get-bb/plugin-sdk/app';
import type { AnswersRpcContract, SendOptions } from './contract';
import { Composer } from './composer';
import { Button } from './components/ui/button';

type CommentRequest = { quote: string; quoteSeq?: number; threadId: string; composer: ReturnType<typeof useComposer>; top: number; left: number };
export const COMMENT_EVENT = 'answers:chat-comment';

export function ChatComment() {
  const sdk = useSdk(), { threads } = experimental_useSidebarThreads(), [request, setRequest] = useState<CommentRequest | null>(null), [pending, setPending] = useState(false);
  const rpc = useRpc<AnswersRpcContract>(), panel = experimental_useAppPanel();
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
  // Sent straight to the thread: bb's composer can only hold plain text, where the quote would show as raw '>' lines,
  // while the sent message renders it as a quote bar, as the popup header does.
  const submit = async (options?: SendOptions) => {
    if (!text.trim() || pending) return;
    const quote = request.quote.trim().split('\n').map(line => `> ${line}`).join('\n');
    setPending(true); setError('');
    try {
      await sdk.threads.send({ threadId: request.threadId, mode: options?.mode === 'steer' ? 'steer-if-active' : 'queue-if-active', input: [{ type: 'text', text: `${quote}\n\n${text.trim()}`, mentions: mentionsForText(`${quote}\n\n${text.trim()}`, id => { const thread = threads.find(t => t.id === id); return thread ? { label: thread.displayTitle, projectId: thread.projectId } : undefined; }) }], ...(options?.sendAt ? { sendAt: options.sendAt } : {}) });
      setRequest(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  // The thread's reply pool lives in its My questions tab, as the "Add to reply pool" message action does.
  const addToPool = async () => {
    if (pending) return;
    setPending(true); setError('');
    try {
      await rpc.call('poolAdd', { threadId: request.threadId, quote: request.quote, ...(request.quoteSeq === undefined ? {} : { quoteSeq: request.quoteSeq }), note: text.trim() });
      panel.openTab({ tab: { id: 'my-questions', context: { kind: 'thread' }, availability: 'fixed' } });
      setRequest(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setPending(false); }
  };
  return <div ref={popup} role="dialog" aria-label="Comment on chat selection" className="fixed z-[100] w-[min(560px,calc(100vw-16px))]" style={{ top: Math.min(request.top, window.innerHeight - 240), left: Math.max(8, Math.min(request.left, window.innerWidth - 568)) }}>
    <Composer label="Comment text" autoFocus value={text} onChange={setText} attachments={[]} onAttachments={() => {}} projectId={null} pending={pending} sendDisabled={!text.trim()} onSend={options => void submit(options)} sendLabel="Send comment" onPool={request.quote.length > 20000 ? undefined : () => void addToPool()} header={<div className="flex items-start gap-2 pl-4 pr-2 pt-2"><div className="mt-1 max-h-32 min-w-0 flex-1 overflow-auto border-l-2 border-border-seam pl-2 text-sm text-muted-foreground"><Markdown content={request.quote} /></div><Button type="button" size="icon" variant="ghost" className="size-7 shrink-0 text-muted-foreground" aria-label="Close" onClick={() => setRequest(null)}><Icon name="X" aria-hidden /></Button></div>} />
    {error && <p role="alert" className="bg-background p-2 text-xs text-destructive">{error}</p>}
  </div>;
}
