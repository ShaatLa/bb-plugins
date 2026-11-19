import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { experimental_ThreadTitleText as ThreadTitleText, experimental_ThreadActionsMenu as ThreadActionsMenu, experimental_Icon as Icon, type PluginSidebarThread } from '@get-bb/plugin-sdk/app';
import { Button } from './components/ui/button';
import { threadTarget } from './thread-target';
import { chatShortcut } from './chat-commands';
export function ThreadHeader({ thread, parent, title, onSelect, actionsTarget, trailing }: { thread?: PluginSidebarThread; parent?: PluginSidebarThread; title: string; onSelect: (id: string) => void; actionsTarget?: HTMLElement | null; trailing?: ReactNode }) {
  const actions = thread && <ThreadActionsMenu thread={threadTarget(thread)} trigger={props => <Button {...props} size="sm" variant="ghost" aria-label="Thread actions" {...{ title: `Thread actions (${chatShortcut('t')})` }} className={[props.className, 'size-8 px-0'].filter(Boolean).join(' ')}><Icon name="MoreHorizontal" aria-hidden /></Button>} />;
  return <><div className="min-w-0 flex-1"><div className="truncate text-sm font-medium"><ThreadTitleText title={thread?.displayTitle ?? thread?.title ?? title} /></div>{parent && <button type="button" className="answers-hit block max-w-full truncate text-left text-xs text-muted-foreground hover:underline" onClick={() => onSelect(parent.id)}>↑ <ThreadTitleText title={parent.displayTitle ?? parent.title ?? 'Untitled thread'} /></button>}</div>{trailing}{actionsTarget ? createPortal(actions, actionsTarget) : actions}</>;
}
