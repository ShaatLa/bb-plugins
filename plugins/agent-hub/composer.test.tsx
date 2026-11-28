import { usePreferences } from './use-preferences';
import { mentionsForText } from './mentions';
import { useState } from 'react';
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, waitFor, within } from '@testing-library/react';
import { renderSlot } from '@get-bb/plugin-sdk/testing/app';
vi.mock('@get-bb/plugin-sdk/app', async importOriginal => ({ ...await importOriginal<typeof import('@get-bb/plugin-sdk/app')>(), experimental_readPromptMentionClipboard: (element: Element) => element.getAttribute('data-test-kind') === 'project' ? { text: '@project:proj_one', mention: { kind: 'project', projectId: 'proj_one', label: 'Project One' } } : null, experimental_promptMentionClipboardAttributes: (_mention: any, text: string) => ({ 'data-prompt-mention': 'true', 'data-test-serialized': text }), experimental_VoiceInputTextarea: ({ onValueChange, onVoiceInputActiveChange, ...props }: any) => <><textarea {...props} onChange={event => onValueChange(event.target.value)} /><button onClick={() => onVoiceInputActiveChange(true)}>Start voice</button><button onClick={() => onVoiceInputActiveChange(false)}>Stop voice</button></> }));
import { Composer } from './composer';
import { ComposerThread } from './rich-editor';
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
it('keeps editor above toolbar across newlines and separates voice from Send', () => {
  const props = { label: 'Reply', onChange: () => {}, attachments: [], onAttachments: () => {}, projectId: 'proj_example', onSend: () => {} };
  const slot = renderSlot({ component: Composer }, { ...props, value: 'one' });
  const toolbar = slot.container.querySelector('[data-composer-toolbar]')!;
  const attach = slot.getByRole('button', { name: 'Attach files' });
  const voice = slot.getByRole('textbox', { name: 'Voice input' });
  const send = slot.getByRole('button', { name: 'Send' });
  expect(toolbar.contains(attach)).toBe(true); expect(toolbar.contains(voice)).toBe(true); expect(toolbar.contains(send)).toBe(true);
  expect(toolbar.previousElementSibling?.contains(slot.getByRole('textbox', { name: 'Reply' }))).toBe(true);
  expect(voice.closest('[data-composer-voice]')?.parentElement?.className).toContain('gap-3');
  slot.rerender(<Composer {...props} value={'one\ntwo'} />);
  expect(slot.container.querySelector('[data-composer-toolbar]')).toBe(toolbar);
  expect(toolbar.contains(attach)).toBe(true); expect(toolbar.contains(voice)).toBe(true); expect(toolbar.contains(send)).toBe(true);
  expect(slot.container.querySelector('[data-model-picker]')).toBeNull();
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
it('turns a pasted thread URL into a token pill, keeping its message anchor', () => {
  const { box, onChange } = editor();
  fireEvent.paste(box, { clipboardData: { files: [], getData: (kind: string) => kind === 'text/plain' ? 'https://bb.example/projects/proj_one/threads/thr_one#msg=2' : '' } });
  expect(onChange).toHaveBeenCalledWith('@thread:thr_one#msg=2');
});
it('keeps the message of a pasted message link and drops other query parts', () => {
  const { box, onChange } = editor();
  fireEvent.paste(box, { clipboardData: { files: [], getData: (kind: string) => kind === 'text/plain' ? 'https://bb.example/projects/proj_one/threads/thr_one?msg=7' : '' } });
  expect(onChange).toHaveBeenCalledWith('@thread:thr_one#msg=7');
  onChange.mockClear();
  fireEvent.paste(box, { clipboardData: { files: [], getData: (kind: string) => kind === 'text/plain' ? 'https://bb.example/threads/thr_two?tab=info' : '' } });
  expect(onChange).toHaveBeenCalledWith('@thread:thr_two');
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
it('draws "> " lines as one quote block with hidden markers, like bb composer, and continues the quote on Shift+Enter', () => {
  const { box, onChange } = editor('> **What holds.** one\n> two\nafter');
  const quote = box.querySelector('[data-quote]')!;
  expect(quote.textContent).toBe('**What holds.** one\ntwo');
  expect(box.textContent).toBe('**What holds.** one\ntwoafter');
  const range = document.createRange(), selection = window.getSelection()!;
  range.setStart(quote.lastChild!, 3); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith('> **What holds.** one\n> two\n> \nafter');
  range.setStart(quote.childNodes[1], 0); range.setEnd(box.lastChild!, 0); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.keyDown(box, { key: 'Backspace' });
  expect(onChange).toHaveBeenLastCalledWith('');
});

it('quotes the selected lines on Cmd+Shift+9 and unquotes them on a second press', () => {
  const { box, onChange } = editor('intro\nfirst line\n\nsecond line');
  const text = box.firstChild!, range = document.createRange(), selection = window.getSelection()!;
  range.setStart(text, 8); range.setEnd(text, 20); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.keyDown(box, { key: '(', code: 'Digit9', metaKey: true, shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith('intro\n> first line\n>\n> second line');
  cleanup(); const quoted = editor('intro\n> first line\n>\n> second line'), quote = quoted.box.querySelector('[data-quote]')!;
  range.selectNodeContents(quote); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.keyDown(quoted.box, { key: '(', code: 'Digit9', ctrlKey: true, shiftKey: true });
  expect(quoted.onChange).toHaveBeenLastCalledWith('intro\nfirst line\n\nsecond line');
});

it('opens its own Undo, Redo, Quote, Cut, Copy, Paste, Delete and Select All menu on a right-click over a selection, and keeps the native one otherwise', () => {
  const { box, onChange } = editor('intro\nfirst line');
  const text = box.firstChild!, range = document.createRange(), selection = window.getSelection()!;
  range.setStart(text, 3); range.collapse(true); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.mouseDown(box, { button: 2 }); expect(fireEvent.contextMenu(box)).toBe(true); expect(document.querySelector('[role=menu]')).toBeNull();
  range.setStart(text, 8); range.setEnd(text, 12); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.mouseDown(box, { button: 2 }); expect(fireEvent.contextMenu(box, { clientX: 10, clientY: 10 })).toBe(false);
  const menu = document.querySelector('[role=menu]') as HTMLElement;
  expect(Array.from(menu.querySelectorAll('[role=menuitem]'), item => item.firstChild!.textContent)).toEqual(['Undo', 'Redo', 'Quote', 'Cut', 'Copy', 'Paste', 'Delete', 'Select All']);
  expect(within(menu).getByRole('menuitem', { name: /Undo/ })).toHaveProperty('disabled', true);
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Quote/ }));
  expect(onChange).toHaveBeenLastCalledWith('intro\n> first line'); expect(document.querySelector('[role=menu]')).toBeNull();
  const exec = vi.fn(() => true); Object.assign(document, { execCommand: exec });
  fireEvent.mouseDown(box, { button: 2 }); fireEvent.contextMenu(box);
  fireEvent.click(within(document.querySelector('[role=menu]') as HTMLElement).getByRole('menuitem', { name: /Copy/ }));
  expect(exec).toHaveBeenCalledWith('copy');
  fireEvent.mouseDown(box, { button: 2 }); fireEvent.contextMenu(box);
  fireEvent.click(within(document.querySelector('[role=menu]') as HTMLElement).getByRole('menuitem', { name: /Delete/ }));
  expect(onChange).toHaveBeenLastCalledWith('intro\nfiline');
});

it('keeps its own undo history: Cmd+Z and Shift+Cmd+Z step through edits, typing runs merge, and the menu pastes the clipboard', async () => {
  const slot = renderSlot({ component: () => { const [value, setValue] = useState('one'); return <Composer label="History" value={value} onChange={setValue} attachments={[]} onAttachments={() => {}} projectId="proj_one" onSend={() => {}} />; } }, {}, { sidebarThreads: { threads: [thread], projects: [] } } as any);
  const box = slot.getByRole('textbox', { name: 'History' }) as HTMLElement, selection = window.getSelection()!;
  const select = (from: number, to = from) => { const range = document.createRange(), text = box.querySelector('[data-quote]')?.firstChild ?? box.firstChild!; range.setStart(text, from); range.setEnd(text, to); selection.removeAllRanges(); selection.addRange(range); };
  const type = (text: string) => { box.firstChild!.textContent = text; select(text.length); fireEvent.input(box); };
  box.focus(); type('one t'); type('one tw'); type('one two');
  select(0, 3); fireEvent.keyDown(box, { key: '(', code: 'Digit9', metaKey: true, shiftKey: true });
  expect(box.querySelector('[data-quote]')?.textContent).toBe('one two');
  fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', metaKey: true }); expect(box.textContent).toBe('one two');
  expect(box.querySelector('[data-quote]')).toBeNull();
  fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', metaKey: true }); expect(box.textContent).toBe('one');
  fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true }); expect(box.textContent).toBe('one two');
  Object.assign(navigator, { clipboard: { read: async () => [{ types: ['text/plain'], getType: async () => new Blob(['pasted']) }] } });
  select(4, 7); fireEvent.mouseDown(box, { button: 2 }); fireEvent.contextMenu(box);
  fireEvent.click(within(document.querySelector('[role=menu]') as HTMLElement).getByRole('menuitem', { name: /Paste/ }));
  await waitFor(() => expect(box.textContent).toBe('one pasted'));
  fireEvent.keyDown(box, { key: 'z', code: 'KeyZ', metaKey: true }); expect(box.textContent).toBe('one two');
});

it('leaves the quote on Shift+Enter in an empty quote line', () => {
  const { box, onChange } = editor('> one\n> ');
  const range = document.createRange(), selection = window.getSelection()!;
  range.selectNodeContents(box); range.collapse(false); selection.removeAllRanges(); selection.addRange(range);
  fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
  expect(onChange).toHaveBeenLastCalledWith('> one\n');
  cleanup(); const after = editor('> one\n');
  expect(after.box.querySelector('[data-quote] + span + br')).toBeTruthy(); expect(after.box.textContent).toBe('one');
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
it('attaches a paste of 5,000+ characters as Pasted text.txt, like bb', async () => {
  const upload = vi.fn((input: any) => input.clientFile.text().then((text: string) => ({ type:'localFile', path:'/pasted.txt', name:input.clientFile.name, mimeType:'text/plain', sizeBytes:text.length })));
  const onChange = vi.fn();
  const slot = renderSlot({ component: () => { const [files, setFiles] = useState<any[]>([]); return <Composer label="Reply" value="" onChange={onChange} attachments={files} onAttachments={update => setFiles(update)} projectId="p" onSend={() => {}} />; } }, {}, { sdk: { projects: { attachments: { upload } } } } as any);
  const long = 'x'.repeat(5000);
  fireEvent.paste(slot.getByRole('textbox', { name:'Reply' }), { clipboardData: { files: [], getData: (kind: string) => kind === 'text/plain' ? long : '' } });
  await waitFor(() => expect(slot.getByRole('list', { name:'Attachments' }).textContent).toContain('Pasted text.txt'));
  expect(upload.mock.calls[0][0]).toMatchObject({ projectId:'p', mimeType:'text/plain' });
  expect(onChange).not.toHaveBeenCalled();
});

it('opens an attached image before sending, reading a restored draft\'s image on demand', async () => {
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:shot'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const read = vi.fn(() => Promise.resolve({ bytes: [1], mimeType: 'image/png' }));
  const files = [{ type:'localImage', path:'/a.png', name:'a.png' }, { type:'localFile', path:'/b.txt', name:'b.txt' }];
  const slot = renderSlot({ component: () => <Composer label="Reply" value="" onChange={() => {}} attachments={files as any} onAttachments={() => {}} projectId="p" onSend={() => {}} /> }, {}, { sdk: { projects: { attachments: { read } } } } as any);
  expect(slot.queryByRole('button', { name:'Open b.txt' })).toBeNull();
  fireEvent.click(slot.getByRole('button', { name:'Open a.png' }));
  await waitFor(() => expect(read).toHaveBeenCalledWith({ projectId:'p', path:'/a.png' }));
  expect((await slot.findByRole('img', { name:'a.png' })).getAttribute('src')).toBe('blob:shot');
});

it('keeps edit previews by path and revokes only removed images', async () => {
  const create = vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second'), revoke = vi.fn();
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }));
  const read = vi.fn(async () => ({ bytes: [1], mimeType: 'image/png' }));
  const files = ['first', 'second'].map(path => ({ type: 'localImage' as const, path, name: path }));
  function Box() { const [attachments, onAttachments] = useState<import('./contract').Attachment[]>(files); return <Composer editMode label="Edit" value="" onChange={() => {}} attachments={attachments} onAttachments={onAttachments} projectId="p" onSend={() => {}} />; }
  const slot = renderSlot({ component: Box }, {}, { sdk: { projects: { attachments: { read } } } } as any);
  await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  fireEvent.click(slot.getByRole('button', { name: 'Remove first' }));
  await waitFor(() => expect(revoke).toHaveBeenCalledWith('blob:first'));
  expect(read).toHaveBeenCalledTimes(2); expect(revoke).not.toHaveBeenCalledWith('blob:second');
  slot.unmount(); expect(revoke).toHaveBeenCalledWith('blob:second');
});

it('lays out the toolbar without measuring control widths', () => {
  const callbacks: (() => void)[] = [];
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { callbacks.push(callback); } observe() {} disconnect() {} });
  const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
  const props = { label: 'Geometry', value: 'one', onChange: () => {}, attachments: [], onAttachments: () => {}, projectId: null, onSend: () => {} };
  try {
    const slot = renderSlot({ component: Composer }, props);
    width.mockClear();
    slot.rerender(<Composer {...props} value="two" />);
    expect(width).not.toHaveBeenCalled();
    callbacks.forEach(run => run());
    expect(width).not.toHaveBeenCalled();
    expect(slot.container.querySelector('form')?.style.getPropertyValue('--right-w')).toBe('');
  } finally { width.mockRestore(); vi.unstubAllGlobals(); }
});

it('resolves repeated thread mentions through the same sidebar labels', () => {
  const { box } = editor('Ask @thread:thr_one and @thread:thr_one#msg=2');
  expect(Array.from(box.querySelectorAll('.prompt-mention-pill')).map(pill => pill.textContent)).toEqual(['Fix login', 'Fix login· message']);
});

const commands = [{ name:'optimize', source:'skill', origin:'user', description:'Measured code optimization', argumentHint:null }, { name:'reload-skills', source:'command', origin:'builtin', description:null, argumentHint:null }];
function commandEditor(value = '') {
  const onChange = vi.fn(), list = vi.fn(async () => ({ commands }));
  const sdk = { threads: { get: async () => ({ id:'thr_cmd', projectId:'proj_one', environmentId:'env', providerId:'claude-code' }) }, projects: { commands: list } };
  const slot = renderSlot({ component: () => <ComposerThread.Provider value="thr_cmd"><Composer label="Reply" value={value} onChange={onChange} attachments={[]} onAttachments={() => {}} projectId="proj_one" onSend={() => {}} /></ComposerThread.Provider> }, {}, { sidebarThreads: { threads: [thread], projects: [] }, sdk } as any);
  return { slot, onChange, list, box: slot.getByRole('textbox', { name: 'Reply' }) as HTMLElement };
}
it('offers the thread’s skills and commands after / and inserts the picked one', async () => {
  const { box, slot, onChange, list } = commandEditor();
  await waitFor(() => expect(list).toHaveBeenCalledWith({ projectId:'proj_one', environmentId:'env', provider:'claude-code' }));
  box.dataset.testValue = '/'; fireEvent.input(box);
  const all = await slot.findByRole('listbox', { name: 'Commands and skills' });
  // Like bb's menu: above the composer box rather than inside it, skills and commands under their own headings.
  expect(all.closest('form')).toBeNull();
  expect(within(within(all).getByRole('group', { name: 'Skills' })).getByRole('option', { name: /optimize/ })).toBeTruthy();
  expect(within(within(all).getByRole('group', { name: 'Commands' })).getByRole('option', { name: /reload-skills/ })).toBeTruthy();
  box.dataset.testValue = '/opt'; fireEvent.input(box);
  const menu = await slot.findByRole('listbox', { name: 'Commands and skills' });
  expect(within(menu).getByRole('option', { name: /optimize/ })).toBeTruthy(); expect(within(menu).queryByRole('option', { name: /reload-skills/ })).toBeNull();
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('/optimize ');
});
it('draws a known command as bb’s command pill and leaves unknown ones as text', async () => {
  const { box } = commandEditor('/optimize the /unknown path');
  await waitFor(() => expect(box.querySelector('[data-raw="/optimize"]')).toBeTruthy());
  expect(box.querySelector('[data-raw="/optimize"]')!.getAttribute('aria-label')).toContain('optimize');
  expect(box.querySelector('[data-raw="/unknown"]')).toBeNull();
});
it('makes Enter a line break on touch screens and keeps it sending with a mouse', () => {
  const send = vi.fn(), change = vi.fn();
  const render = () => renderSlot({ component: () => <Composer label="Note" value="Hi" onChange={change} attachments={[]} onAttachments={() => {}} projectId="proj_one" onSend={send} /> }, {}, { sidebarThreads: { threads: [thread], projects: [] } } as any);
  const original = window.matchMedia;
  try {
    window.matchMedia = ((query: string) => ({ matches: query.includes('pointer: coarse'), media: query, addEventListener() {}, removeEventListener() {} })) as any;
    const touch = render(); fireEvent.keyDown(touch.getByRole('textbox', { name: 'Note' }), { key: 'Enter' });
    expect(send).not.toHaveBeenCalled(); expect(change).toHaveBeenLastCalledWith('Hi\n');
    cleanup();
    window.matchMedia = ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as any;
    const mouse = render(); fireEvent.keyDown(mouse.getByRole('textbox', { name: 'Note' }), { key: 'Enter' });
    expect(send).toHaveBeenCalledOnce();
  } finally { window.matchMedia = original; }
});
it('keeps bb\'s voice button in the toolbar row: its wrapper fills the toolbar height', () => {
  const { slot } = editor();
  expect(slot.container.querySelector('[data-composer-toolbar] [data-composer-voice]')!.className).toContain('[&>.relative]:h-full');
});
it('lines the attach icon up with the text above it and gives it no background', () => {
  const { slot } = editor();
  expect(slot.getByRole('button', { name: 'Attach files' }).className.split(' ')).toEqual(expect.arrayContaining(['-ml-2', 'hover:bg-transparent']));
});
it('closes the send menu on a tap outside it, which moves no focus on phones', () => {
  const slot = renderSlot({ component: () => <Composer label="Reply" value="Hello" onChange={() => {}} attachments={[]} onAttachments={() => {}} projectId={null} onSend={() => {}} /> }, {});
  fireEvent.click(slot.getByRole('button', { name:'More send options' }));
  fireEvent.pointerDown(slot.getByRole('menuitem', { name:'Steer' }));
  expect(slot.queryByRole('menuitem', { name:'Steer' })).toBeTruthy();
  fireEvent.pointerDown(document.body);
  expect(slot.queryByRole('menuitem', { name:'Steer' })).toBeNull();
});

it('debounces bounded workspace file and folder mentions in the selected environment', async () => {
  const paths = vi.fn(async (_args: any) => ({ paths: Array.from({length: 12}, (_,i) => ({kind: i === 0 ? 'directory' : 'file', path: i === 0 ? 'src' : `src/file${i}.ts`, name: `file${i}`, score: 1, positions: []})), truncated: true }));
  const onChange = vi.fn();
  const slot = renderSlot({ component: () => <ComposerThread.Provider value="thr_example"><Composer label="Reply" value="" onChange={onChange} attachments={[]} onAttachments={() => {}} projectId="proj_example" onSend={() => {}} /></ComposerThread.Provider> }, {}, { sdk: { threads: { get: async () => ({projectId:'proj_example', environmentId:'env_example'}) }, projects: {paths} } } as any);
  const box = slot.getByRole('textbox', {name:'Reply'}) as HTMLElement;
  box.dataset.testValue='@src'; fireEvent.input(box);
  expect(paths).not.toHaveBeenCalled();
  const list = await slot.findByRole('listbox', {name:'Files and folders'});
  expect(within(list).getAllByRole('option')).toHaveLength(8);
  expect(paths.mock.calls[0]?.[0]).toMatchObject({projectId:'proj_example', environmentId:'env_example', query:'src', limit:'8', includeDirectories:'true', includeFiles:'true'});
  fireEvent.click(within(list).getByRole('option', {name:'src/file1.ts'}));
  expect(onChange).toHaveBeenLastCalledWith('@src/file1.ts ');
  expect(mentionsForText('@src/file1.ts ')[0]?.resource).toMatchObject({kind:'path', source:'workspace', entryKind:'file', path:'src/file1.ts'});
  box.dataset.testValue='@src'; fireEvent.input(box);
  fireEvent.click(within(await slot.findByRole('listbox', {name:'Files and folders'})).getByRole('option', {name:'src'}));
  expect(mentionsForText('@src ')[0]?.resource).toMatchObject({kind:'path', entryKind:'directory', path:'src'});
});
it.each(['newline','send'])('touch Enter follows %s and Shift+Enter stays a newline',async touchEnter=>{
 const old=window.matchMedia;
 window.matchMedia=((query:string)=>({matches:query.includes('pointer: coarse'),media:query,addEventListener(){},removeEventListener(){}})) as any;
 try {
 const onSend=vi.fn(),onChange=vi.fn();
 const slot=renderSlot({component:()=> <><output>{usePreferences().data?.touchEnter}</output><Composer label='Reply' value='Hello' onChange={onChange} attachments={[]} onAttachments={()=>{}} projectId={null} onSend={onSend}/></>},{},{rpc:{getPreferences:()=>({touchEnter})}});
 await slot.findByText(touchEnter);
 const box=slot.getByRole('textbox',{name:'Reply'});
 fireEvent.keyDown(box,{key:'Enter'});
 expect(onSend).toHaveBeenCalledTimes(touchEnter==='send'?1:0);
 onSend.mockClear();fireEvent.keyDown(box,{key:'Enter',shiftKey:true});expect(onSend).not.toHaveBeenCalled();expect(onChange).toHaveBeenCalled();
 } finally {window.matchMedia=old;}
});
it('clears an attach error on the next edit', async () => {
  const slot = renderSlot({ component: () => { const [value, setValue] = useState(''); return <><Composer label="Reply" value={value} onChange={setValue} attachments={[]} onAttachments={() => {}} projectId="p" onSend={() => {}} /><button type="button" onClick={() => setValue('typed')}>Type</button></>; } }, {}, { sdk: { projects: { attachments: { upload: () => Promise.reject(new Error('HTTP 400: HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.')) } } } } as any);
  fireEvent.change(slot.container.querySelector('input[type=file]')!, { target:{ files:[new File(['x'], 'photo.heic', { type:'image/heic' })] } });
  expect((await slot.findByRole('alert')).textContent).toBe('photo.heic: HEIC images are not supported. Convert the image to JPEG or PNG before attaching it.');
  fireEvent.click(slot.getByRole('button', { name:'Type' }));
  expect(slot.queryByRole('alert')).toBeNull();
});
it('keeps the editor focused when Send is pressed, so a phone keyboard does not swallow the tap', () => {
  const onSend = vi.fn();
  const slot = renderSlot({ component: () => <Composer label="Reply" value="Hello" onChange={() => {}} attachments={[]} onAttachments={() => {}} projectId={null} onSend={onSend} /> }, {});
  const send = slot.getByRole('button', { name:'Send' });
  expect(fireEvent.pointerDown(send)).toBe(false);
  fireEvent.click(send); expect(onSend).toHaveBeenCalledOnce();
});
it('clears an attach error when only attachments are sent', async () => {
  const onSend = vi.fn();
  const slot = renderSlot({ component: () => <Composer label="Reply" value="" onChange={() => {}} attachments={[{ type: 'localFile', path: 'a.txt', name: 'a.txt' }]} onAttachments={() => {}} projectId="p" onSend={onSend} /> }, {}, { sdk: { projects: { attachments: { upload: () => Promise.reject(new Error('HTTP 400: HEIC images are not supported.')) } } } } as any);
  fireEvent.change(slot.container.querySelector('input[type=file]')!, { target:{ files:[new File(['x'], 'photo.heic', { type:'image/heic' })] } });
  await slot.findByRole('alert');
  fireEvent.click(slot.getByRole('button', { name:'Send' }));
  expect(onSend).toHaveBeenCalledOnce(); expect(slot.queryByRole('alert')).toBeNull();
});
it('draws an empty last line after a trailing line break, so text typed after Enter starts on it', () => {
  const { box } = editor('one\n');
  expect(box.lastChild?.previousSibling?.nodeName).toBe('BR');
  expect(box.textContent).toBe('one\n');
});
