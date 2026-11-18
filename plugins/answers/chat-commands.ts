import type { PluginCommandRegistration } from '@get-bb/plugin-sdk/app';
type Actions = Record<'focus' | 'search' | 'actions', () => void>;
let active: Actions | null = null;
export function bindChatCommands(root: HTMLElement, actions: Actions) {
 const select = (event: Event) => { if (root.contains(event.target as Node)) active=actions; else if (active===actions) active=null; };
 document.addEventListener('pointerdown',select); document.addEventListener('focusin',select);
 return () => { document.removeEventListener('pointerdown',select); document.removeEventListener('focusin',select); if(active===actions) active=null; };
}
// The hint bb shows for these shortcuts, e.g. ⌥⌘F on a Mac.
export const chatShortcut = (key: string) => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? `⌥⌘${key.toUpperCase()}` : `Ctrl+Alt+${key.toUpperCase()}`;
export function registerChatCommands(app: {commands:{register(command:PluginCommandRegistration):void}}) {
 for (const [id,title,key] of [['focus','Focus composer','l'],['search','Search conversation','f'],['actions','Thread actions','t']] as const) app.commands.register({id:`chat-${id}`,title,defaultShortcut:{mod:true,alt:true,key},isAvailable:()=>active!==null,run:()=>active?.[id]()});
}
