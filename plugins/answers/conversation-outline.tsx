import { useEffect, useRef, useState } from 'react';
import { experimental_Icon as Icon, useSdk } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';

export function ConversationOutline({ threadId, onJump }: { threadId: string; onJump: (seq: number) => void }) {
  const sdk = useSdk(), root = useRef<HTMLDivElement>(null), [open, setOpen] = useState(false), [error, setError] = useState(''), [items, setItems] = useState<Awaited<ReturnType<typeof sdk.threads.conversationOutline>>['items']>([]);
  useEffect(() => {
    if (!open) return;
    let live = true; setError(''); setItems([]);
    void sdk.threads.conversationOutline({threadId,role:'user'}).then(result => { if (live) setItems(result.items); }).catch(e => { if (live) setError(String(e)); });
    const close = (event: Event) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => { live = false; document.removeEventListener('pointerdown', close); };
  }, [sdk, threadId, open]);
  return <div ref={root} className="relative"><Button size="sm" variant="ghost" aria-label="Thread table of contents" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="List" aria-hidden /></Button>{open && <div role="dialog" aria-label="Thread table of contents" className="absolute right-0 top-full z-20 max-h-72 w-72 max-w-[80vw] overflow-auto rounded-md border border-border-seam bg-popover p-1 shadow-md" onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}><div className="px-2 py-1 text-xs text-muted-foreground">Your messages</div>{error && <p role="alert">{error}</p>}{items.map(item => { const seq = Number(item.id.replace(/^.*:/, '')); return <button type="button" key={item.id} className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-state-hover" onClick={() => { if (Number.isSafeInteger(seq)) onJump(seq); setOpen(false); }}>{item.preview || 'Attachments'}</button>; })}</div>}</div>;
}
