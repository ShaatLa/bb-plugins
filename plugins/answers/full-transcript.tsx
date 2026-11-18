import { createContext } from 'react';
import { experimental_Icon as Icon, ThreadChat } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';

export const FullTranscriptContext = createContext<(() => void) | null>(null);
export function FullTranscript({ threadId, onBack }: { threadId: string; onBack: () => void }) {
  return <section aria-label="Full transcript" className="absolute inset-0 z-30 flex min-h-0 flex-col bg-background"><div className="flex shrink-0 items-center gap-2 border-b border-border-seam px-4 py-2"><Button size="sm" variant="ghost" onClick={onBack}><Icon name="ArrowLeft" aria-hidden />Back to Agent Hub</Button><span className="text-sm text-muted-foreground">Full transcript</span></div><ThreadChat key={threadId} threadId={threadId} variant="full" permissionPolicy="inherit" className="min-h-0 flex-1" /></section>;
}
