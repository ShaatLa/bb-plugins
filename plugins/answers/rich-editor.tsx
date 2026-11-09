import { taskKeyRegex } from './task-links';
import { rpcContract } from './contract';
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { experimental_describePromptMention, experimental_PromptMentionIcon as PromptMentionIcon, experimental_promptMentionClipboardAttributes, experimental_readPromptMentionClipboard, experimental_useSidebarThreads, experimental_useRpcQuery as useQuery, experimental_ThreadTitleText as ThreadTitleText, useSdk } from '@get-bb/plugin-sdk/app';
import { threadToken, rememberMention, pastedMentions, type ThreadLabel } from './mentions';

const parts = /@thread:(thr_[a-zA-Z0-9_-]+)(?:#msg=(\d+))?|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const threadUrl = /^https?:\/\/[^/\s]+(?:\/projects\/[^/\s]+)?\/threads\/(thr_[a-zA-Z0-9_-]+)(?:[?#][^\s]*)?$/;
const raw = (node: Node): string => node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : node instanceof HTMLElement && node.dataset.raw ? node.dataset.raw : Array.from(node.childNodes).map(raw).join('');
function offset(root: HTMLElement, node: Node, at: number) { const range = document.createRange(); range.selectNodeContents(root); range.setEnd(node, at); return raw(range.cloneContents()); }
function position(root: HTMLElement, at: number): [Node, number] {
  for (const child of Array.from(root.childNodes)) {
    const length = raw(child).length;
    if (at < length) {
      if (child.nodeType === Node.TEXT_NODE) return [child, at];
      return [root, Array.prototype.indexOf.call(root.childNodes, child)];
    }
    at -= length;
  }
  return [root, root.childNodes.length];
}
export function RichEditor({ value, onChange, onSend, onCancel, onPasteFiles, disabled, autoFocus, label, placeholder, onBlur, className, editorRef, insertRef }: {
  value: string; onChange(value: string): void; onSend(): void; onCancel?(): void; onPasteFiles(files: File[]): void;
  disabled?: boolean; autoFocus?: boolean; label: string; placeholder: string; onBlur?(): void; className: string; editorRef: React.RefObject<HTMLDivElement | null>; insertRef: React.MutableRefObject<(text: string) => void>;
}) {
  const sdk = useSdk(), { threads } = experimental_useSidebarThreads();
  const { data: workBoard } = useQuery({ contract: rpcContract, method: 'workBoardProjects', input: {} });
  const task = taskKeyRegex(workBoard?.projects.map(p => p.prefix) ?? []);
  const matcher = new RegExp(`${parts.source}|${task?.source ?? '((?!))'}|(${Array.from(pastedMentions().keys()).filter(key => !key.startsWith('@thread:')).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)'})`, 'g');
  const [fetched, setFetched] = useState<Record<string, ThreadLabel>>({}), [menu, setMenu] = useState<{ start: number; query: string } | null>(null), [active, setActive] = useState(0);
  const caret = useRef<number | null>(null);
  useEffect(() => {
    let live = true;
    for (const match of value.matchAll(threadToken)) if (!threads.some(t => t.id === match[1]) && !fetched[match[1]]) void sdk.threads.get({ threadId: match[1] }).then(thread => {
      if (live) setFetched(old => ({ ...old, [match[1]]: { label: thread.title ?? match[1], projectId: thread.projectId } }));
    }).catch(() => { if (live) setFetched(old => ({ ...old, [match[1]]: { label: match[1] } })); });
    return () => { live = false; };
  }, [value, threads, fetched, sdk]);
  useEffect(() => { if (autoFocus) editorRef.current?.focus(); }, [autoFocus, editorRef]);
  useLayoutEffect(() => {
    const root = editorRef.current; if (!root || caret.current === null || document.activeElement !== root) return;
    const [node, at] = position(root, caret.current); const selection = window.getSelection(), range = document.createRange();
    range.setStart(node, at); range.collapse(true); if (selection && 'removeAllRanges' in selection) { selection.removeAllRanges(); selection.addRange(range); } caret.current = null;
  }, [value, fetched, editorRef]);
  const selection = () => {
    const root = editorRef.current, sel = window.getSelection();
    if (!root || !sel?.rangeCount || !root.contains(sel.anchorNode) || !root.contains(sel.focusNode)) return [value.length, value.length];
    const a = offset(root, sel.anchorNode!, sel.anchorOffset).length, b = offset(root, sel.focusNode!, sel.focusOffset).length;
    return [Math.min(a,b), Math.max(a,b)];
  };
  const replace = (insert: string, start?: number, end?: number) => {
    const [a,b] = start === undefined ? selection() : [start, end ?? start];
    const next = value.slice(0,a) + insert + value.slice(b); if (next.length > 8000) return;
    caret.current = a + insert.length; onChange(next);
    const before = (value.slice(0,a) + insert).match(/(?:^|\s)@([^\s@]*)$/);
    setMenu(before ? { start: a + insert.length - before[1].length - 1, query: before[1] } : null); setActive(0);
  };
  insertRef.current = text => { replace(text); editorRef.current?.focus(); };
  const choices = menu ? threads.filter(t => t.displayTitle.toLowerCase().includes(menu.query.toLowerCase())).slice(0,8) : [];
  const pick = (id: string) => { if (menu) replace(`@thread:${id} `, menu.start, selection()[1]); setMenu(null); editorRef.current?.focus(); };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); onPasteFiles(files); return; }
    const html = event.clipboardData.getData('text/html');
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const pills = Array.from(doc.body.querySelectorAll('[data-prompt-mention]')).map(el => experimental_readPromptMentionClipboard(el)).filter(p => p !== null);
      for (const pill of pills) rememberMention(pill.text, pill.mention);
      if (pills.length) {
        event.preventDefault(); replace((function read(node: Node): string { if (node instanceof Element) { const pill = experimental_readPromptMentionClipboard(node); if (pill) return pill.text; } if (node instanceof Element && node.tagName === 'BR') return '\n'; const content = node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : Array.from(node.childNodes).map(read).join(''); return node instanceof Element && /^(DIV|P)$/.test(node.tagName) && node.nextSibling ? content + '\n' : content; })(doc.body)); return;
      }
    }
    const text = event.clipboardData.getData('text/plain'); event.preventDefault(); replace(threadUrl.exec(text.trim()) ? `@thread:${threadUrl.exec(text.trim())![1]}` : text);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (menu && choices.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(i => (i + (event.key === 'ArrowDown' ? 1 : choices.length - 1)) % choices.length); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); pick(choices[active].id); return; }
    }
    if (event.key === 'Escape') { if (menu) setMenu(null); else onCancel?.(); event.preventDefault(); return; }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.shiftKey) replace('\n'); else onSend(); return; }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const [a,b] = selection(); if (a !== b) { event.preventDefault(); replace('',a,b); return; }
      const matches = Array.from(value.matchAll(matcher));
      const pill = matches.find(m => event.key === 'Backspace' ? m.index + m[0].length === a : m.index === a);
      if (pill) { event.preventDefault(); replace('', pill.index, pill.index + pill[0].length); }
    }
  };
  const rendered = []; let last = 0;
  for (const match of value.matchAll(matcher)) {
    if (match.index > last) rendered.push(value.slice(last,match.index));
    if (match[1]) {
      const thread = threads.find(t => t.id === match[1]);
      const mention = { kind: 'thread' as const, threadId: match[1], label: thread?.displayTitle ?? fetched[match[1]]?.label ?? match[1], ...(thread?.projectId || fetched[match[1]]?.projectId ? { projectId: thread?.projectId ?? fetched[match[1]]?.projectId } : {}) };
      const look = experimental_describePromptMention(mention);
      rendered.push(<span key={match.index} contentEditable={false} data-raw={match[0]} {...experimental_promptMentionClipboardAttributes(mention,match[0])} className={`${look.className} bg-surface-raised/50 font-normal no-underline hover:no-underline cursor-default`} title={look.title}><PromptMentionIcon mention={mention} className="size-3.5 shrink-0 self-center text-muted-foreground" /><span className="truncate">Thread: <ThreadTitleText title={mention.label} /></span>{match[2] && <span className="shrink-0 text-muted-foreground">· message</span>}</span>);
    } else if (match[6]) { const mention = pastedMentions().get(match[6])!; const look = experimental_describePromptMention(mention); rendered.push(<span key={match.index} contentEditable={false} data-raw={match[0]} {...experimental_promptMentionClipboardAttributes(mention,match[0])} className={`${look.className} bg-surface-raised/50 font-normal no-underline hover:no-underline cursor-default`} title={look.title}><PromptMentionIcon mention={mention} className="size-3.5 shrink-0 self-center text-muted-foreground" /><span className="truncate">{look.text}</span></span>); }
    else if (match[5]) rendered.push(<span key={match.index} contentEditable={false} data-raw={match[0]} className="prompt-mention-pill inline-flex max-w-full items-baseline rounded-full border border-border-seam bg-surface-raised/50 px-1.5 py-0.5 text-xs leading-4 align-baseline" title={match[5]}>{match[5]}</span>);
    else rendered.push(<span key={match.index} contentEditable={false} data-raw={match[0]} className="prompt-mention-pill inline-flex max-w-full items-baseline gap-0.5 rounded-full border border-border-seam bg-surface-raised/50 px-1.5 py-0.5 text-xs font-normal leading-4 align-baseline no-underline" title={match[4]}><span className="truncate">{match[3]}</span></span>);
    last = match.index + match[0].length;
  }
  rendered.push(value.slice(last));
  return <div className="relative min-w-0 flex-1">
    <div ref={editorRef} role="textbox" aria-label={label} aria-multiline="true" contentEditable={!disabled} tabIndex={0} suppressContentEditableWarning autoFocus={autoFocus} data-placeholder={placeholder} className={`${className} min-h-[32px] max-h-[40vh] whitespace-pre-wrap break-words empty:before:content-[attr(data-placeholder)] empty:before:text-subtle-foreground`} onBlur={onBlur} onPaste={paste} onKeyDown={keyDown} onBeforeInput={event => { const input = event.nativeEvent as InputEvent; if (input.isComposing) return; if (input.inputType === 'insertText' && input.data) { event.preventDefault(); replace(input.data); } }} onInput={event => { const testValue = event.currentTarget.dataset.testValue; if (testValue !== undefined) { delete event.currentTarget.dataset.testValue; replace(testValue, 0, value.length); return; } const next = raw(event.currentTarget); if (next !== value) { caret.current = selection()[1]; onChange(next.slice(0,8000)); } }}>{rendered}</div>
    {menu && choices.length > 0 && <div role="listbox" aria-label="Threads" className="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-72 overflow-auto rounded-lg border border-border bg-background p-1 shadow-lg">{choices.map((thread,i) => <button type="button" key={thread.id} role="option" aria-selected={i===active} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover ${i===active ? 'bg-state-active' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => pick(thread.id)}><ThreadTitleText title={thread.displayTitle} /></button>)}</div>}
  </div>;
}
