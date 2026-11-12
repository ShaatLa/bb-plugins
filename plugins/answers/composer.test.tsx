import { useState } from 'react';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_readPromptMentionClipboard: (element: Element) => element.getAttribute('data-test-kind') === 'project' ? { text: '@project:proj_one', mention: { kind: 'project', projectId: 'proj_one', label: 'Project One' } } : null, experimental_promptMentionClipboardAttributes: (_mention: any, text: string) => ({ 'data-prompt-mention': 'true', 'data-test-serialized': text }), experimental_VoiceInputTextarea: ({ onValueChange, onVoiceInputActiveChange, ...props }: any) => <><textarea {...props} onChange={event => onValueChange(event.target.value)} /><button onClick={() => onVoiceInputActiveChange(true)}>Start voice</button><button onClick={() => onVoiceInputActiveChange(false)}>Stop voice</button></> }));
import { Composer } from './composer';
afterEach(cleanup);
it('blocks keyboard and send controls while voice input is active', () => {
  const onSend = vi.fn();
  const slot = renderSlot({ component: () => <Composer label="Reply" value="Hello" onChange={() => {}} attachments={[]} onAttachments={() => {}} projectId={null} onSend={onSend} /> }, {});
  fireEvent.click(slot.getByRole('button', { name:'More send options' }));
  fireEvent.click(slot.getByRole('button', { name:'Start voice' }));
  const editor = slot.getByRole('textbox', { name:'Reply' }); fireEvent.keyDown(editor, { key:'Enter' });
  fireEvent.click(slot.getByRole('menuitem', { name:'Steer' }));
  expect(slot.getByRole('button', { name:'Send' }).hasAttribute('disabled')).toBe(true);
  expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button', { name:'Stop voice' })); fireEvent.keyDown(editor, { key:'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
});
it('starts as one row and opens for a second line or attachments', () => {
  const view = (value: string, attachments: any[] = []) => renderSlot({ component: () => <Composer label="Reply" value={value} onChange={() => {}} attachments={attachments} onAttachments={() => {}} projectId="p" onSend={() => {}} /> }, {});
  const open = (slot: ReturnType<typeof view>) => slot.getByRole('button', { name:'Attach files' }).className.includes('row-start-2');
  expect(open(view(''))).toBe(false); cleanup();
  expect(open(view('one line'))).toBe(false); cleanup();
  expect(open(view('two\nlines'))).toBe(true); cleanup();
  expect(open(view('', [{ type:'localFile', path:'/a', name:'a.txt' }]))).toBe(true);
});

const thread = { id: 'thr_one', projectId: 'proj_one', title: 'Fix login', displayTitle: 'Fix login' };
function editor(value = '', options: any = {}) {
  const onChange = vi.fn();
  const slot = renderSlot({ component: () => <Composer label="Reply" value={value} onChange={onChange} attachments={[]} onAttachments={() => {}} projectId="proj_one" onSend={() => {}} /> }, {}, { sidebarThreads: { threads: [thread], projects: [] }, ...options } as any);
  return { slot, onChange, box: slot.getByRole('textbox', { name: 'Reply' }) as HTMLElement };
}
it('renders thread tokens with bb pill presentation', () => {
  const { box } = editor('See @thread:thr_one');
  expect(box.querySelector('.prompt-mention-pill')).toHaveProperty('textContent', 'Fix login');
  expect(box.querySelector('[data-test-serialized]')).toBeTruthy();
});
it('turns a pasted thread URL into a token pill', () => {
  const { box, onChange } = editor();
  fireEvent.paste(box, { clipboardData: { files: [], getData: (kind: string) => kind === 'text/plain' ? 'https://bb.example/projects/proj_one/threads/thr_one#msg=2' : '' } });
  expect(onChange).toHaveBeenCalledWith('@thread:thr_one');
});
it('renders a Markdown link as a compact link pill', () => {
  const { box } = editor('[ACM-5](/plugins/work-board/work-board/task/ACM-5)');
  expect(box.querySelector('[data-raw]')).toHaveProperty('textContent', 'ACM-5');
});
it('removes the entire adjacent pill with Backspace', () => {
  const { box, onChange } = editor('@thread:thr_one');
  box.focus(); const selection = window.getSelection()!, range = document.createRange(); range.selectNodeContents(box); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.keyDown(box, { key: 'Backspace' });
  expect(onChange).toHaveBeenCalledWith('');
});
it('inserts a thread from the @ menu', () => {
  const { box, slot, onChange } = editor();
  box.dataset.testValue = '@Fix'; fireEvent.input(box);
  expect(slot.getByRole('listbox', { name: 'Threads' })).toBeTruthy();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('@thread:thr_one ');
});
it('renders a message link with bb message label', () => {
  const { box } = editor('@thread:thr_one#msg=12');
  expect(box.querySelector('.prompt-mention-pill')?.textContent).toContain('· message');
});

it('renders only keys from connected Work Board projects', async () => {
  const { box } = editor('ACM-5 GPT-6 UTF-8', { rpc: { workBoardProjects: () => ({ available: true, projects: [{ id: 'p', prefix: 'ACM', name: 'Acme' }] }) } });
  await waitFor(() => expect(box.querySelectorAll('.prompt-mention-pill')).toHaveLength(1));
  expect(box.querySelector('.prompt-mention-pill')?.textContent).toBe('ACM-5');
});
it('recreates a pasted bb project mention inside copied message HTML', () => {
  const { box, onChange, slot } = editor();
  fireEvent.paste(box, { clipboardData: { files: [], getData: (kind: string) => kind === 'text/html' ? '<div>See <span data-prompt-mention="true" data-test-kind="project">Project One</span></div>' : 'See Project One' } });
  expect(onChange).toHaveBeenCalledWith('See @project:proj_one');
  // The parent draft stores text; a controlled rerender resolves the remembered resource.
  slot.unmount(); cleanup();
  const next = editor('See @project:proj_one');
  expect(next.box.querySelector('.prompt-mention-pill')?.textContent).toContain('Project One');
});
it('shows thread titles with the host title component', () => {
  const { box } = editor('@thread:thr_one');
  expect(box.querySelector('.prompt-mention-pill')?.textContent).toContain('Fix login');
});
it('keeps quote Markdown text literal while editing, as bb composer does', () => {
  const { box } = editor('> Quoted line');
  expect(box.textContent).toBe('> Quoted line');
});

function nativeEditor(options: any = {}) {
  const onSend = vi.fn();
  const slot = renderSlot({ component: () => {
    const [value, setValue] = useState('');
    return <Composer label="Native editor" value={value} onChange={setValue} attachments={[]} onAttachments={() => {}} projectId="proj_one" onSend={onSend} />;
  } }, {}, { sidebarThreads: { threads: [thread], projects: [] }, ...options } as any);
  const box = slot.getByRole('textbox', { name: 'Native editor' }) as HTMLElement;
  box.focus(); const range = document.createRange(), selection = window.getSelection()!;
  range.selectNodeContents(box); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
  return { box, onSend };
}
function nativeType(box: HTMLElement, text: string) {
  for (const char of text) {
    const before = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: char });
    if (!fireEvent(box, before)) continue;
    const selection = window.getSelection()!, range = selection.getRangeAt(0);
    range.deleteContents(); const node = document.createTextNode(char); range.insertNode(node);
    range.setStartAfter(node); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
    fireEvent.input(box, { inputType: 'insertText', data: char });
  }
}
it('types plain text through native beforeinput and input without duplication', () => {
  const { box } = nativeEditor(); nativeType(box, 'H');
  const firstNode = box.firstChild; nativeType(box, 'ello world');
  expect(box.firstChild).toBe(firstNode);
  expect(box.textContent).toBe('Hello world');
});
it('types a thread token into one pill, then continues after it', () => {
  const { box } = nativeEditor(); nativeType(box, 'See @thread:thr_one and more');
  expect(box.querySelectorAll('.prompt-mention-pill')).toHaveLength(1);
  expect(box.querySelector('.prompt-mention-pill')?.textContent).toBe('Fix login');
  expect(box.textContent).toBe('See Fix login and more');
  expect(Array.from(box.childNodes).map(node => node instanceof HTMLElement && node.dataset.raw ? node.dataset.raw : node.textContent).join('')).toBe('See @thread:thr_one and more');
});
it('backspaces the whole pill and sends on Enter after native typing', () => {
  const { box, onSend } = nativeEditor(); nativeType(box, '@thread:thr_one');
  fireEvent.keyDown(box, { key: 'Backspace' });
  expect(box.querySelector('.prompt-mention-pill')).toBeNull();
  expect(box.textContent).toBe('');
  nativeType(box, 'Reply'); fireEvent.keyDown(box, { key: 'Enter' });
  expect(onSend).toHaveBeenCalledOnce();
  expect(box.textContent).toBe('Reply');
});

it('keeps a mixed draft intact while typing around thread and link pills', () => {
  const { box } = nativeEditor();
  const text = 'See @thread:thr_one and [ACM-5](/plugins/work-board/work-board/task/ACM-5) ok ';
  nativeType(box, text);
  expect(Array.from(box.childNodes).map(node => node instanceof HTMLElement && node.dataset.raw ? node.dataset.raw : node.textContent).join('')).toBe(text);
  expect(box.querySelectorAll('.prompt-mention-pill')).toHaveLength(2);
  expect(box.textContent).toBe('See Fix login and ACM-5 ok ');
});
it('revokes an uploaded image preview when the attachment is removed, and on unmount', async () => {
  const create = vi.fn().mockReturnValueOnce('blob:one').mockReturnValueOnce('blob:two'), revoke = vi.fn();
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
  const upload = (n: string) => ({ type:'localImage', path:`/${n}.png`, name:`${n}.png`, mimeType:'image/png' });
  const names = ['one', 'two'];
  const slot = renderSlot({ component: () => { const [files, setFiles] = useState<any[]>([]); return <Composer label="Reply" value="" onChange={() => {}} attachments={files} onAttachments={update => setFiles(update)} projectId="p" onSend={() => {}} />; } }, {}, { sdk: { projects: { attachments: { upload: () => Promise.resolve(upload(names.shift()!)) } } } } as any);
  const input = slot.container.querySelector('input[type=file]')!;
  fireEvent.change(input, { target:{ files:[new File(['x'], 'one.png', { type:'image/png' }), new File(['y'], 'two.png', { type:'image/png' })] } });
  await slot.findByRole('button', { name:'Remove two.png' });
  expect(revoke).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button', { name:'Remove one.png' }));
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:one');
  cleanup();
  expect(revoke).toHaveBeenLastCalledWith('blob:two'); expect(revoke).toHaveBeenCalledTimes(2);
});

it('turns Send into Stop while the thread works and the box is empty, like bb', () => {
  const onStop = vi.fn(), onSend = vi.fn();
  const view = (value: string) => renderSlot({ component: () => <Composer label="Reply" value={value} onChange={() => {}} attachments={[]} onAttachments={() => {}} projectId="p" onSend={onSend} onStop={onStop} /> }, {});
  const empty = view('');
  fireEvent.click(empty.getByRole('button', { name: 'Stop' })); expect(onStop).toHaveBeenCalledOnce();
  expect(empty.queryByRole('button', { name: 'Send' })).toBeNull(); empty.unmount();
  const typed = view('More');
  expect(typed.queryByRole('button', { name: 'Stop' })).toBeNull(); expect(typed.getByRole('button', { name: 'Send' })).toBeTruthy();
});

it('collects into the reply pool on Enter and the main button once pooling, with Send now in the menu', () => {
  const onPool = vi.fn(), onSend = vi.fn();
  const slot = renderSlot({ component: () => <Composer label="Reply" value="Note" onChange={() => {}} attachments={[]} onAttachments={() => {}} projectId="p" onSend={onSend} onPool={onPool} poolFirst /> }, {});
  fireEvent.keyDown(slot.getByRole('textbox', { name:'Reply' }), { key:'Enter' }); expect(onPool).toHaveBeenCalledTimes(1);
  fireEvent.click(slot.getByRole('button', { name:'Add to reply pool' })); expect(onPool).toHaveBeenCalledTimes(2); expect(onSend).not.toHaveBeenCalled();
  fireEvent.click(slot.getByRole('button', { name:'More send options' }));
  expect(slot.queryByRole('menuitem', { name:'Add to reply pool' })).toBeNull();
  fireEvent.click(slot.getByRole('menuitem', { name:'Send now' })); expect(onSend).toHaveBeenCalledWith(undefined);
});
