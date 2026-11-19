// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import { bindChatCommands, chatShortcut, registerChatCommands } from './chat-commands';
it('routes focus, search and actions only to the focused Answers pane', () => {
 const root=document.createElement('div'), other=document.createElement('button'); document.body.append(root,other);
 const handlers={ focus:vi.fn(), search:vi.fn(), actions:vi.fn() }, commands:any[]=[];
 registerChatCommands({commands:{register: command => commands.push(command)}});
 const dispose=bindChatCommands(root,handlers);
 root.dispatchEvent(new Event('pointerdown',{bubbles:true}));
 for (const command of commands) { expect(command.isAvailable()).toBe(true); command.run(); }
 expect(handlers.focus).toHaveBeenCalledOnce(); expect(handlers.search).toHaveBeenCalledOnce(); expect(handlers.actions).toHaveBeenCalledOnce();
 other.dispatchEvent(new Event('pointerdown',{bubbles:true}));
 for (const command of commands) { expect(command.isAvailable()).toBe(false); command.run(); }
 expect(handlers.focus).toHaveBeenCalledOnce(); dispose(); root.remove(); other.remove();
});
it('labels the chat shortcuts the way bb shows them', () => {
  const platform = vi.spyOn(navigator, 'platform', 'get');
  platform.mockReturnValue('MacIntel'); expect(chatShortcut('f')).toBe('⌥⌘F');
  platform.mockReturnValue('Win32'); expect(chatShortcut('t')).toBe('Ctrl+Alt+T');
  platform.mockRestore();
});
