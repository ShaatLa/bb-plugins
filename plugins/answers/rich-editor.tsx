import { taskKeyRegex } from './task-links';
import { rpcContract } from './contract';
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { experimental_describePromptMention, experimental_PromptMentionIcon as PromptMentionIcon, experimental_promptMentionClipboardAttributes, experimental_readPromptMentionClipboard, experimental_useSidebarThreads, experimental_useRpcQuery as useQuery, experimental_ThreadTitleText as ThreadTitleText, useSdk } from '@get-bb/plugin-sdk/app';
import { threadToken, rememberMention, pastedMentions, type ThreadLabel } from './mentions';

const parts = /@thread:(thr_[a-zA-Z0-9_-]+)(?:#msg=(\d+))?|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const threadUrl = /^https?:\/\/[^/\s]+(?:\/projects\/[^/\s]+)?\/threads\/(thr_[a-zA-Z0-9_-]+)(?:[?#][^\s]*)?$/;
const raw = (node: Node): string => node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : node instanceof HTMLElement && node.dataset.raw ? node.dataset.raw : Array.from(node.childNodes).map(raw).join('');
function offset(root: HTMLElement, node: Node, at: number) { const range = document.createRange(); range.selectNodeContents(root); range.setEnd(node, at); return raw(range.cloneContents()); }
function position(root: HTMLElement, at: number): [Node, number] {
  for (const child of Array.from(root.childNodes)) {
    const length = raw(child).length;
    // The end of a quote line sits inside its block, not after it on the next visual line.
    if (at < length || (at === length && child instanceof HTMLElement && child.dataset.quote !== undefined)) {
      if (child.nodeType === Node.TEXT_NODE) return [child, at];
      if (child instanceof HTMLElement && !child.dataset.raw) return position(child, at);
      return [root, Array.prototype.indexOf.call(root.childNodes, child)];
    }
    if (at === 0 && child.nodeName === 'BR') return [root, Array.prototype.indexOf.call(root.childNodes, child)];
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
  const drawn = useRef('');
  const [pillContents, setPillContents] = useState<React.ReactPortal[]>([]);
  const spans = Array.from(value.matchAll(matcher), match => {
    const thread = match[1] ? threads.find(t => t.id === match[1]) : undefined;
    const mention = match[1] ? { kind: 'thread' as const, threadId: match[1], label: thread?.displayTitle ?? fetched[match[1]]?.label ?? match[1], ...(thread?.projectId || fetched[match[1]]?.projectId ? { projectId: thread?.projectId ?? fetched[match[1]]?.projectId } : {}) } : match[6] ? pastedMentions().get(match[6]) : undefined;
    return { match, mention };
  });
  // Runs of "> " lines, drawn as one quote block like bb's composer; the draft keeps the Markdown text.
  const quotes = Array.from(value.matchAll(/^>(?: [^\n]*)?(?=\n|$)(?:\n>(?: [^\n]*)?(?=\n|$))*/gm), m => [m.index, m.index + m[0].length, m[0]] as const);
  const signature = JSON.stringify([spans.map(({ match, mention }) => [match[0], mention, match[2], match[3], match[4], match[5]]), quotes.map(q => q[2])]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      for (const match of value.matchAll(threadToken)) if (!threads.some(t => t.id === match[1]) && !fetched[match[1]]) void sdk.threads.get({ threadId: match[1] }).then(thread => {
        if (live) setFetched(old => ({ ...old, [match[1]]: { label: thread.title ?? match[1], projectId: thread.projectId } }));
      }).catch(() => { if (live) setFetched(old => ({ ...old, [match[1]]: { label: match[1] } })); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [value, threads, fetched, sdk]);
  useEffect(() => { if (autoFocus) editorRef.current?.focus(); }, [autoFocus, editorRef]);
  useLayoutEffect(() => {
    const root = editorRef.current; if (!root) return;
    if (raw(root) === value && drawn.current === signature) { caret.current = null; return; }
    const at = document.activeElement === root ? caret.current ?? selection()[1] : null;
    const fragment = document.createDocumentFragment(), contents: React.ReactPortal[] = [];
    const drawPill = (match: RegExpMatchArray & { index: number }, mention: (typeof spans)[number]['mention']) => {
      const pill = document.createElement('span');
      pill.contentEditable = 'false'; pill.dataset.raw = match[0];
      if (mention) {
        const look = experimental_describePromptMention(mention);
        pill.className = `${look.className} bg-surface-raised/50 font-normal no-underline hover:no-underline cursor-default whitespace-nowrap`;
        pill.title = look.title; pill.setAttribute('aria-label', look.text);
        for (const [key, data] of Object.entries(experimental_promptMentionClipboardAttributes(mention, match[0]))) pill.setAttribute(key, data);
        const icon = document.createElement('span'), label = document.createElement('span');
        label.className = 'truncate'; pill.append(icon, label);
        contents.push(createPortal(<PromptMentionIcon mention={mention} className="size-3.5 shrink-0 self-center text-muted-foreground" />, icon, `${match.index}-icon`));
        contents.push(createPortal(mention.kind === 'thread' ? <ThreadTitleText title={mention.label} /> : mention.label, label, `${match.index}-label`));
        if (match[2]) { const suffix = document.createElement('span'); suffix.className = 'shrink-0 text-muted-foreground'; suffix.textContent = '· message'; pill.append(suffix); }
      } else {
        pill.className = 'prompt-mention-pill inline-flex max-w-full items-baseline gap-0.5 rounded-full border border-border-seam bg-surface-raised/50 px-1.5 py-0.5 text-xs font-normal leading-4 align-baseline no-underline whitespace-nowrap';
        pill.title = match[4] ?? match[5] ?? '';
        const label = document.createElement('span'); label.className = 'truncate'; label.textContent = match[3] ?? match[5] ?? ''; pill.append(label);
      }
      return pill;
    };
    // Quote markers and the line break after a quote are hidden but kept in the raw text.
    const hidden = (text: string) => { const marker = document.createElement('span'); marker.contentEditable = 'false'; marker.dataset.raw = text; marker.className = 'hidden'; return marker; };
    const tokens: { at: number; length: number; node(): Node }[] = spans.map(({ match, mention }) => ({ at: match.index, length: match[0].length, node: () => drawPill(match, mention) }));
    for (const [start, end] of quotes) {
      for (let at = start; at < end; at = value.indexOf('\n', at) + 1 || end) { const marker = value[at + 1] === ' ' ? '> ' : '>'; tokens.push({ at, length: marker.length, node: () => hidden(marker) }); }
      if (value[end] === '\n') tokens.push({ at: end, length: 1, node: () => hidden('\n') });
    }
    let last = 0, block: HTMLElement | null = null, run = 0;
    const boundary = (at: number) => {
      // A block swallows its trailing empty line, so an empty last quote line gets a <br> to hold the caret.
      if (block && at >= quotes[run][1]) { if (/(?:^|\n)> ?$/.test(quotes[run][2])) block.append(document.createElement('br')); block = null; run++; }
      if (!block && run < quotes.length && at >= quotes[run][0]) { block = document.createElement('span'); block.dataset.quote = ''; block.className = 'my-1 block border-l-2 border-surface-selected-border pl-3 text-muted-foreground'; fragment.append(block); }
    };
    const put = (node: Node) => (block ?? fragment).append(node);
    const upTo = (to: number) => { while (last < to) { boundary(last); const stop = Math.min(to, block ? quotes[run][1] : quotes[run]?.[0] ?? to); put(document.createTextNode(value.slice(last, stop))); last = stop; } };
    for (const token of tokens.sort((x, y) => x.at - y.at)) {
      if (token.at < last) continue;
      upTo(token.at); boundary(token.at); put(token.node()); last = token.at + token.length;
    }
    upTo(value.length); boundary(value.length);
    fragment.append(document.createTextNode(''));
    root.replaceChildren(fragment); drawn.current = signature; setPillContents(contents);
    if (at !== null) {
      const [node, index] = position(root, at), selection = window.getSelection(), range = document.createRange();
      range.setStart(node, index); range.collapse(true);
      if (selection && 'removeAllRanges' in selection) { selection.removeAllRanges(); selection.addRange(range); }
    }
    caret.current = null;
  });
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
    updateMenu(next, a + insert.length);
  };
  const updateMenu = (text: string, at: number) => {
    const before = text.slice(0, at).match(/(?:^|\s)@([^\s@]*)$/);
    setMenu(before ? { start: at - before[1].length - 1, query: before[1] } : null); setActive(0);
  };
  insertRef.current = text => { replace(text); editorRef.current?.focus(); };
  const choices = menu ? threads.filter(t => t.displayTitle.toLowerCase().includes(menu.query.toLowerCase())).slice(0,8) : [];
  const pick = (id: string) => { if (menu) replace(`@thread:${id} `, menu.start, selection()[1]); setMenu(null); editorRef.current?.focus(); };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); onPasteFiles(files); return; }
    // Like bb's composer: a paste of 5,000+ characters goes in as a "Pasted text.txt" attachment.
    const long = event.clipboardData.getData('text/plain'); if (long.length >= 5000) { event.preventDefault(); onPasteFiles([new File([long], 'Pasted text.txt', { type: 'text/plain' })]); return; }
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
    // Cmd/Ctrl+Shift+9, the quote shortcut of Slack and Gmail: quotes the selected lines (or the caret's line), or unquotes them
    // when all already are; bb's context menu cannot take a plugin item. event.code keeps it working on any keyboard layout.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Digit9') {
      event.preventDefault();
      const [a,b] = selection(), start = value.lastIndexOf('\n', a - 1) + 1, stop = value.indexOf('\n', b > a && value[b - 1] === '\n' ? b - 1 : b), end = stop < 0 ? value.length : stop;
      const lines = value.slice(start, end).split('\n'), isQuote = (line: string) => /^>(?: |$)/.test(line), unquote = lines.every(isQuote);
      replace(lines.map(line => unquote ? line.replace(/^> ?/, '') : isQuote(line) ? line : line ? `> ${line}` : '>').join('\n'), start, end); return;
    }
    if (event.key === 'Escape') { if (menu) setMenu(null); else onCancel?.(); event.preventDefault(); return; }
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.shiftKey) { const [a] = selection(); replace(/^>(?: |\n|$)/.test(value.slice(a ? value.lastIndexOf('\n', a - 1) + 1 : 0)) ? '\n> ' : '\n'); } else onSend(); return; }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      // Select-all leaves out a leading hidden quote marker; take it too so the box really empties.
      const [a,b] = selection(); if (a !== b) { event.preventDefault(); replace('',/^> ?$/.test(value.slice(0,a)) ? 0 : a,b); return; }
      const matches = Array.from(value.matchAll(matcher));
      const pill = matches.find(m => event.key === 'Backspace' ? m.index + m[0].length === a : m.index === a);
      if (pill) { event.preventDefault(); replace('', pill.index, pill.index + pill[0].length); }
    }
  };
  return <div className="relative min-w-0 flex-1">
    <div ref={editorRef} role="textbox" aria-label={label} aria-multiline="true" contentEditable={!disabled} tabIndex={0} suppressContentEditableWarning autoFocus={autoFocus} data-placeholder={placeholder} className={`${className} min-h-[32px] max-h-[40vh] whitespace-pre-wrap break-words empty:before:content-[attr(data-placeholder)] empty:before:text-subtle-foreground`} onBlur={onBlur} onPaste={paste} onKeyDown={keyDown} onBeforeInput={event => { const input = event.nativeEvent as InputEvent; if (input.inputType === 'insertText' && raw(event.currentTarget).length >= 8000) event.preventDefault(); }} onInput={event => { const testValue = event.currentTarget.dataset.testValue; if (testValue !== undefined) { delete event.currentTarget.dataset.testValue; replace(testValue, 0, value.length); return; } const next = raw(event.currentTarget); if (next !== value) { const at = selection()[1]; caret.current = at; onChange(next.slice(0,8000)); updateMenu(next, at); } }} />
    {pillContents}
    {menu && choices.length > 0 && <div role="listbox" aria-label="Threads" className="absolute bottom-full left-0 z-30 mb-1 max-h-64 w-72 overflow-auto rounded-lg border border-border bg-background p-1 shadow-lg">{choices.map((thread,i) => <button type="button" key={thread.id} role="option" aria-selected={i===active} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover ${i===active ? 'bg-state-active' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => pick(thread.id)}><ThreadTitleText title={thread.displayTitle} /></button>)}</div>}
  </div>;
}
