import { useThreadCommands, commandMention, type Command } from './thread-commands';
import { taskKeyRegex } from './task-links';
import { rpcContract } from './contract';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { experimental_describePromptMention, experimental_Icon as Icon, experimental_PromptMentionIcon as PromptMentionIcon, experimental_promptMentionClipboardAttributes, experimental_readPromptMentionClipboard, experimental_useSidebarThreads, experimental_useRpcQuery as useQuery, experimental_ThreadTitleText as ThreadTitleText, useSdk } from '@get-bb/plugin-sdk/app';
import { threadToken, rememberMention, pastedMentions, type ThreadLabel } from './mentions';

const parts = /@thread:(thr_[a-zA-Z0-9_-]+)(?:#msg=(\d+))?|\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const threadUrl = /^https?:\/\/[^/\s]+(?:\/projects\/[^/\s]+)?\/threads\/(thr_[a-zA-Z0-9_-]+)(?:[?#][^\s]*)?$/;
const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
// The thread a composer writes to, so its editor can offer that thread's slash commands and skills as bb's composer does.
export const ComposerThread = createContext<string | null>(null);
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
export function RichEditor({ value, onChange, onSend, onCancel, onPasteFiles, disabled, autoFocus, label, placeholder, onBlur, className, editorRef, insertRef, menuAnchor }: {
  value: string; onChange(value: string): void; onSend(): void; onCancel?(): void; onPasteFiles(files: File[]): void;
  disabled?: boolean; autoFocus?: boolean; label: string; placeholder: string; onBlur?(): void; className: string; editorRef: React.RefObject<HTMLDivElement | null>; insertRef: React.MutableRefObject<(text: string) => void>; menuAnchor?: React.RefObject<HTMLElement | null>;
}) {
  const sdk = useSdk(), { threads } = experimental_useSidebarThreads();
  const threadById = useMemo(() => new Map(threads.map(thread => [thread.id, thread])), [threads]);
  const { data: workBoard } = useQuery({ contract: rpcContract, method: 'workBoardProjects', input: {} });
  const task = taskKeyRegex(workBoard?.projects.map(p => p.prefix) ?? []);
  const matcher = new RegExp(`${parts.source}|${task?.source ?? '((?!))'}|(${Array.from(pastedMentions().keys()).filter(key => !key.startsWith('@thread:')).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)'})`, 'g');
  const [fetched, setFetched] = useState<Record<string, ThreadLabel>>({}), [menu, setMenu] = useState<{ start: number; query: string; trigger: string } | null>(null), [active, setActive] = useState(0);
  const commands = useThreadCommands(useContext(ComposerThread));
  // A known command typed after its trigger ("/optimize", "$optimize") shows as bb's command pill; the text stays as typed.
  const commandSpans = useMemo(() => {
    if (!commands.length) return [];
    const names = commands.map(c => c.name).sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const byName = new Map(commands.map(c => [c.name, c]));
    return Array.from(value.matchAll(new RegExp(`(^|\\s)([/$])(${names.join('|')})(?=\\s|$)`, 'g')), m => ({ at: m.index + m[1].length, text: m[2] + m[3], mention: commandMention(byName.get(m[3])!, m[2] as '/' | '$') }));
  }, [commands, value]);
  const caret = useRef<number | null>(null);
  // Own undo history: the editor redraws its DOM on pastes, pills and quotes, which breaks the browser's native undo stack.
  const history = useRef({ past: [] as { value: string; at: number }[], future: [] as { value: string; at: number }[], typedAt: 0, emitted: value });
  if (value !== history.current.emitted) Object.assign(history.current, { past: [], future: [], typedAt: 0, emitted: value });
  // Every edit goes through here; a run of typing without a one-second pause is one undo step.
  const emit = (next: string, at: number, typing = false) => {
    const h = history.current, now = Date.now();
    if (!typing || now - h.typedAt > 1000) h.past.push({ value, at: selection()[0] });
    if (h.past.length > 200) h.past.shift();
    h.future = []; h.typedAt = typing ? now : 0; h.emitted = next; caret.current = at; onChange(next);
  };
  const travel = (back: boolean) => {
    const h = history.current, step = (back ? h.past : h.future).pop(); if (!step) return;
    (back ? h.future : h.past).push({ value, at: selection()[0] }); h.typedAt = 0; h.emitted = step.value; caret.current = step.at; onChange(step.value); setMenu(null);
  };
  // Own right-click menu over a selection, since bb's native one cannot take a Quote item; without a selection the native menu stays.
  const [context, setContext] = useState<{ left: number; top?: number; bottom?: number } | null>(null), contextBox = useRef<HTMLDivElement>(null), selectedOnPress = useRef<boolean | null>(null);
  useEffect(() => {
    if (!context) return;
    const close = (event: Event) => { if (!contextBox.current?.contains(event.target as Node)) setContext(null); };
    document.addEventListener('pointerdown', close, true); window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    return () => { document.removeEventListener('pointerdown', close, true); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [context]);
  const drawn = useRef('');
  const [pillContents, setPillContents] = useState<React.ReactPortal[]>([]);
  const spans = Array.from(value.matchAll(matcher), match => {
    const thread = match[1] ? threadById.get(match[1]) : undefined;
    const mention = match[1] ? { kind: 'thread' as const, threadId: match[1], label: thread?.displayTitle ?? fetched[match[1]]?.label ?? match[1], ...(thread?.projectId || fetched[match[1]]?.projectId ? { projectId: thread?.projectId ?? fetched[match[1]]?.projectId } : {}) } : match[6] ? pastedMentions().get(match[6]) : undefined;
    return { match, mention };
  });
  // Runs of "> " lines, drawn as one quote block like bb's composer; the draft keeps the Markdown text.
  const quotes = Array.from(value.matchAll(/^>(?: [^\n]*)?(?=\n|$)(?:\n>(?: [^\n]*)?(?=\n|$))*/gm), m => [m.index, m.index + m[0].length, m[0]] as const);
  const signature = JSON.stringify([spans.map(({ match, mention }) => [match[0], mention, match[2], match[3], match[4], match[5]]), quotes.map(q => q[2]), commandSpans.map(c => [c.at, c.text])]);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      for (const match of value.matchAll(threadToken)) if (!threadById.has(match[1]) && !fetched[match[1]]) void sdk.threads.get({ threadId: match[1] }).then(thread => {
        if (live) setFetched(old => ({ ...old, [match[1]]: { label: thread.title ?? match[1], projectId: thread.projectId } }));
      }).catch(() => { if (live) setFetched(old => ({ ...old, [match[1]]: { label: match[1] } })); });
    }, 300);
    return () => { live = false; clearTimeout(timer); };
  }, [value, threadById, fetched, sdk]);
  // Opening never scrolls: a quote popup is placed in view already, and focusing it must not move the chat under it.
  useEffect(() => { if (autoFocus) editorRef.current?.focus({ preventScroll: true }); }, [autoFocus, editorRef]);
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
        // The icon's own box centers it; left to the pill's baseline alignment, a glyph like Zap rides above the text.
        icon.className = 'flex shrink-0 self-center'; label.className = 'truncate'; pill.append(icon, label);
        contents.push(createPortal(mention.kind === 'command' && mention.source === 'skill' ? <Icon name="Zap" aria-hidden className="size-3.5 shrink-0 self-center text-muted-foreground" /> : <PromptMentionIcon mention={mention} className="size-3.5 shrink-0 self-center text-muted-foreground" />, icon, `${match.index}-icon`));
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
    for (const command of commandSpans) tokens.push({ at: command.at, length: command.text.length, node: () => drawPill(Object.assign([command.text], { index: command.at }) as unknown as RegExpMatchArray & { index: number }, command.mention) });
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
    // An empty line right after a quote (left with Shift+Enter) needs a <br> to show the caret under the quote.
    if (quotes.at(-1)?.[1] === value.length - 1) fragment.append(document.createElement('br'));
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
    emit(next, a + insert.length);
    updateMenu(next, a + insert.length);
  };
  const updateMenu = (text: string, at: number) => {
    const before = text.slice(0, at).match(/(?:^|\s)([@/$])([^\s@/$]*)$/);
    setMenu(before ? { start: at - before[2].length - 1, query: before[2], trigger: before[1] } : null); setActive(0);
  };
  insertRef.current = text => { replace(text); editorRef.current?.focus(); };
  const choices = menu?.trigger === '@' ? threads.filter(t => t.displayTitle.toLowerCase().includes(menu.query.toLowerCase())).slice(0,8) : [];
  // Commands whose name starts with the query come first, then the ones that only contain it.
  const query = menu?.query.toLowerCase() ?? '';
  // Grouped as bb's menu is (Skills, then Commands), each ranked; the list scrolls instead of cutting off.
  const ranked = menu && menu.trigger !== '@' ? commands.filter(c => c.name.toLowerCase().includes(query)).sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query))) : [];
  const commandGroups = ([['skill', 'Skills'], ['command', 'Commands']] as const).map(([source, label]) => ({ label, items: ranked.filter(c => c.source === source).slice(0, 100) })).filter(group => group.items.length);
  const commandChoices = commandGroups.flatMap(group => group.items);
  const count = menu?.trigger === '@' ? choices.length : commandChoices.length;
  const pick = (id: string) => { if (menu) replace(`@thread:${id} `, menu.start, selection()[1]); setMenu(null); editorRef.current?.focus(); };
  // Menus float above the whole composer box at its width, as bb's do, instead of covering the box from inside it.
  const [menuAt, setMenuAt] = useState<React.CSSProperties | null>(null), menuOpen = !!menu && (choices.length > 0 || commandChoices.length > 0), listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menuOpen) { setMenuAt(null); return; }
    const place = () => { const r = (menuAnchor?.current ?? editorRef.current?.parentElement)?.getBoundingClientRect(); if (r) setMenuAt({ left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6 }); };
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [menuOpen, menuAnchor, editorRef]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' }); }, [active, menuOpen]);
  const floating = (children: React.ReactNode) => menuAt && createPortal(<div ref={listRef} className="fixed z-[100] max-h-72 overflow-auto rounded-xl border border-border bg-background p-1 shadow-lg" style={menuAt}>{children}</div>, document.body);
  const pickCommand = (command: Command) => { if (menu) replace(`${menu.trigger}${command.name} `, menu.start, selection()[1]); setMenu(null); editorRef.current?.focus(); };
  const paste = (event: ClipboardEvent<HTMLDivElement>) => { event.preventDefault(); insertClipboard(Array.from(event.clipboardData.files), event.clipboardData.getData('text/plain'), event.clipboardData.getData('text/html')); };
  // The menu's Paste reads the clipboard itself (bb's window allows it) and inserts it the way ⌘V does.
  const pasteFromMenu = async () => {
    try {
      const files: File[] = []; let text = '', html = '';
      for (const item of await navigator.clipboard.read()) for (const type of item.types) {
        const blob = await item.getType(type);
        if (type === 'text/plain') text = await blob.text(); else if (type === 'text/html') html = await blob.text(); else if (type.startsWith('image/')) files.push(new File([blob], `Pasted image.${type.slice(6).replace('jpeg', 'jpg')}`, { type }));
      }
      insertClipboard(files, text, html);
    } catch { try { insertClipboard([], await navigator.clipboard.readText(), ''); } catch { /* clipboard access refused: nothing to paste */ } }
  };
  function insertClipboard(files: File[], long: string, html: string) {
    if (files.length) { onPasteFiles(files); return; }
    // Like bb's composer: a paste of 5,000+ characters goes in as a "Pasted text.txt" attachment.
    if (long.length >= 5000) { onPasteFiles([new File([long], 'Pasted text.txt', { type: 'text/plain' })]); return; }
    if (html) {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const pills = Array.from(doc.body.querySelectorAll('[data-prompt-mention]')).map(el => experimental_readPromptMentionClipboard(el)).filter(p => p !== null);
      for (const pill of pills) rememberMention(pill.text, pill.mention);
      if (pills.length) {
        replace((function read(node: Node): string { if (node instanceof Element) { const pill = experimental_readPromptMentionClipboard(node); if (pill) return pill.text; } if (node instanceof Element && node.tagName === 'BR') return '\n'; const content = node.nodeType === Node.TEXT_NODE ? node.textContent ?? '' : Array.from(node.childNodes).map(read).join(''); return node instanceof Element && /^(DIV|P)$/.test(node.tagName) && node.nextSibling ? content + '\n' : content; })(doc.body)); return;
      }
    }
    replace(threadUrl.exec(long.trim()) ? `@thread:${threadUrl.exec(long.trim())![1]}` : long);
  }
  // Quotes the selected lines (or the caret's line), or unquotes them when all already are.
  const toggleQuote = () => {
    const [a,b] = selection(), start = value.lastIndexOf('\n', a - 1) + 1, stop = value.indexOf('\n', b > a && value[b - 1] === '\n' ? b - 1 : b), end = stop < 0 ? value.length : stop;
    const lines = value.slice(start, end).split('\n'), isQuote = (line: string) => /^>(?: |$)/.test(line), unquote = lines.every(isQuote);
    replace(lines.map(line => unquote ? line.replace(/^> ?/, '') : isQuote(line) ? line : line ? `> ${line}` : '>').join('\n'), start, end);
  };
  // Select-all leaves out a leading hidden quote marker; take it too so the box really empties.
  const removeSelection = () => { const [a,b] = selection(); replace('', /^> ?$/.test(value.slice(0,a)) ? 0 : a, b); };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (context && event.key === 'Escape') { event.preventDefault(); setContext(null); return; }
    if (menu && count) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActive(i => (i + (event.key === 'ArrowDown' ? 1 : count - 1)) % count); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); if (menu.trigger === '@') pick(choices[active].id); else pickCommand(commandChoices[active]); return; }
    }
    // Cmd/Ctrl+Shift+9, the quote shortcut of Slack and Gmail; event.code keeps it working on any keyboard layout.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.code === 'KeyZ' || (event.code === 'KeyY' && event.ctrlKey && !event.shiftKey))) { event.preventDefault(); travel(event.code === 'KeyZ' && !event.shiftKey); return; }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.code === 'Digit9') { event.preventDefault(); toggleQuote(); return; }
    if (event.key === 'Escape') { if (menu) setMenu(null); else onCancel?.(); event.preventDefault(); return; }
    // On touch screens Enter is a line break, as in phone messengers; the Send button sends. With a mouse, Enter sends.
    if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); if (event.shiftKey || (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches)) {
      // Shift+Enter continues a quote; on an empty quote line it leaves the quote instead, so plain text can follow.
      const [a] = selection(), start = value.lastIndexOf('\n', a - 1) + 1, stop = value.indexOf('\n', a), end = stop < 0 ? value.length : stop;
      if (/^> ?$/.test(value.slice(start, end))) replace('', start, end); else replace(/^>(?: |\n|$)/.test(value.slice(start)) ? '\n> ' : '\n');
    } else onSend(); return; }
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const [a,b] = selection(); if (a !== b) { event.preventDefault(); removeSelection(); return; }
      const matches = [...Array.from(value.matchAll(matcher), m => ({ index: m.index, length: m[0].length })), ...commandSpans.map(c => ({ index: c.at, length: c.text.length }))];
      const pill = matches.find(m => event.key === 'Backspace' ? m.index + m.length === a : m.index === a);
      if (pill) { event.preventDefault(); replace('', pill.index, pill.index + pill.length); }
    }
  };
  return <div className="relative min-w-0 flex-1">
    <div ref={editorRef} role="textbox" aria-label={label} aria-multiline="true" contentEditable={!disabled} tabIndex={0} suppressContentEditableWarning autoFocus={autoFocus} data-placeholder={placeholder} className={`${className} min-h-[32px] max-h-[40vh] whitespace-pre-wrap break-words empty:before:content-[attr(data-placeholder)] empty:before:text-subtle-foreground`} onBlur={() => { setContext(null); onBlur?.(); }} onPaste={paste} onKeyDown={keyDown}
      onMouseDown={event => { if (event.button === 2 || (event.button === 0 && event.ctrlKey)) { const [a,b] = selection(); selectedOnPress.current = a !== b; } }}
      onContextMenu={event => {
        // macOS selects the word under a right-click, so only a selection made before the press opens the own menu.
        const [a,b] = selection(), had = selectedOnPress.current ?? true; selectedOnPress.current = null;
        if (disabled || a === b || !had) return;
        event.preventDefault();
        const left = Math.min(event.clientX, window.innerWidth - 200), y = event.clientY;
        setContext(y > window.innerHeight - 220 ? { left, bottom: window.innerHeight - y } : { left, top: y });
      }} onBeforeInput={event => { const input = event.nativeEvent as InputEvent; if (input.inputType === 'historyUndo' || input.inputType === 'historyRedo') { event.preventDefault(); travel(input.inputType === 'historyUndo'); return; } if (input.inputType === 'insertText' && raw(event.currentTarget).length >= 8000) event.preventDefault(); }} onInput={event => { const testValue = event.currentTarget.dataset.testValue; if (testValue !== undefined) { delete event.currentTarget.dataset.testValue; replace(testValue, 0, value.length); return; } const next = raw(event.currentTarget); if (next !== value) { const at = selection()[1]; emit(next.slice(0,8000), at, true); updateMenu(next, at); } }} />
    {pillContents}
    {context && createPortal(<div ref={contextBox} role="menu" aria-label="Text actions" className="fixed z-[100] w-48 rounded-lg border border-border bg-background p-1 shadow-lg" style={context}>
      {([['Undo', `${mod}Z`, () => travel(true), !history.current.past.length], ['Redo', `⇧${mod}Z`, () => travel(false), !history.current.future.length], null, ['Quote', `${mod}⇧9`, toggleQuote], null, ['Cut', `${mod}X`, () => { history.current.typedAt = 0; document.execCommand('cut'); }], ['Copy', `${mod}C`, () => document.execCommand('copy')], ['Paste', `${mod}V`, () => void pasteFromMenu()], ['Delete', '', removeSelection], null, ['Select All', `${mod}A`, () => { const root = editorRef.current, sel = window.getSelection(); if (!root || !sel) return; const range = document.createRange(); range.selectNodeContents(root); sel.removeAllRanges(); sel.addRange(range); }]] as const).map((entry, i) => entry
        // mousedown keeps the focus and the selection in the editor; cut and copy run through the browser so pills copy as they do with ⌘C.
        ? <button key={entry[0]} type="button" role="menuitem" disabled={entry[3] === true} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-state-hover disabled:pointer-events-none disabled:opacity-50" onMouseDown={event => event.preventDefault()} onClick={() => { setContext(null); entry[2](); }}>{entry[0]}<span className="text-xs text-muted-foreground">{entry[1]}</span></button>
        : <div key={`sep${i}`} role="separator" className="my-1 h-px bg-border" />)}
    </div>, document.body)}
    {menu && choices.length > 0 && floating(<div role="listbox" aria-label="Threads">{choices.map((thread,i) => <button type="button" key={thread.id} role="option" aria-selected={i===active} className={`block w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover ${i===active ? 'bg-state-active' : ''}`} onMouseDown={event => event.preventDefault()} onClick={() => pick(thread.id)}><ThreadTitleText title={thread.displayTitle} /></button>)}</div>)}
    {menu && commandChoices.length > 0 && floating(<div role="listbox" aria-label="Commands and skills">{commandGroups.map(group => <div key={group.label} role="group" aria-label={group.label}><div className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">{group.label}</div>{group.items.map(command => { const i = commandChoices.indexOf(command); return <button type="button" key={`${command.source}:${command.name}`} role="option" aria-selected={i===active} className={`flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover ${i===active ? 'bg-state-active' : ''}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(i)} onClick={() => pickCommand(command)}>{command.source === 'skill' ? <Icon name="Zap" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : <PromptMentionIcon mention={commandMention(command, menu.trigger as '/' | '$')} className="size-3.5 shrink-0 text-muted-foreground" />}<span className="shrink-0 text-foreground">{command.name}</span>{command.description && <span className="min-w-0 truncate text-muted-foreground">{command.description}</span>}</button>; })}</div>)}</div>)}
  </div>;
}
