import { RichEditor } from './rich-editor';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { experimental_Icon as Icon, experimental_VoiceInputTextarea as VoiceInputTextarea, useSdk } from '@get-bb/plugin-sdk/app';
import type { Attachment, SendOptions } from './contract';
import { Button } from './components/ui/button';

// Local previews for images uploaded in this session; after a reload the chip falls back to the file name.
const previews = new Map<string, string>();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);
// datetime-local value for the next whole hour, in local time.
function nextHour() { const at = new Date(Date.now() + 3600e3); at.setMinutes(0, 0, 0); return new Date(at.getTime() - at.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }

type Props = {
  label: string; value: string; onChange: (value: string) => void;
  attachments: Attachment[]; onAttachments: (update: (old: Attachment[]) => Attachment[]) => void;
  // Uploads go to the recipient thread's project; without one, attaching is off.
  projectId: string | null | undefined;
  onSend: (options?: SendOptions) => void; sendDisabled?: boolean; pending?: boolean;
  actions?: ReactNode; autoFocus?: boolean; placeholder?: string;
  onBlur?: () => void;
  // The Inbox composer keeps edits made during a send; other boxes clear on success, so they lock while sending.
  editableWhilePending?: boolean;
  sendLabel?: string; header?: ReactNode; className?: string;
  editMode?: boolean; onCancel?: () => void;
};

/** A reply box drawn like bb's prompt box: text, attachments, and an action row with Send at the right. */
export function Composer({ label, value, onChange, attachments, onAttachments, projectId, onSend, sendDisabled, pending, actions, autoFocus, onBlur, editableWhilePending, placeholder = 'Reply…', sendLabel = 'Send', header, className = 'shadow-lift', editMode, onCancel }: Props) {
  const sdk = useSdk(), insertText = useRef<(text: string) => void>(() => {}), picker = useRef<HTMLInputElement>(null), editor = useRef<HTMLDivElement>(null), root = useRef<HTMLFormElement>(null), right = useRef<HTMLDivElement>(null);
  const [uploading, setUploading] = useState(0), [error, setError] = useState(''), [voiceActive, setVoiceActive] = useState(false), [grown, setGrown] = useState(false);
  const [savedPreviews, setSavedPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!editMode) return;
    let active = true; const urls: string[] = [];
    void Promise.all(attachments.filter(file => file.type === 'localImage' && !previews.has(file.path)).map(async file => {
      try { const image = await sdk.projects.attachments.read({ projectId: file.sourceProjectId ?? projectId!, path: file.path }); if (!active) return; const url = URL.createObjectURL(new Blob([new Uint8Array(image.bytes)], { type: image.mimeType })); urls.push(url); setSavedPreviews(old => ({ ...old, [file.path]: url })); } catch { /* the file name remains visible */ }
    }));
    return () => { active = false; urls.forEach(URL.revokeObjectURL); };
  }, [editMode, attachments, projectId, sdk]);
  // Like bb: one row (attach, text, send) until the text wraps or there is more to show; it stays open until cleared,
  // so a line that wraps only in the narrow one-row layout does not flip the layout back and forth.
  const tall = !!editMode || grown || !!header || attachments.length > 0 || uploading > 0 || value.includes('\n');
  useLayoutEffect(() => {
    const node = editor.current; if (!node) return;
    const style = getComputedStyle(node), oneLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    if (!value) setGrown(false); else if (node.scrollHeight > oneLine + 2) setGrown(true);
  }, [value, tall]);
  // The send group can include extra actions; its width places bb's microphone just left of it in the open layout.
  useLayoutEffect(() => { if (root.current && right.current) root.current.style.setProperty('--right-w', `${right.current.offsetWidth}px`); });
  async function attach(files: File[]) {
    if (!files.length) return;
    if (!projectId) { setError('Attachments need a thread in a project'); return; }
    if (attachments.length + files.length > 10) { setError('At most 10 attachments'); return; }
    setError(''); setUploading(n => n + files.length);
    for (const file of files) {
      try {
        const uploaded = await sdk.projects.attachments.upload({ projectId, clientFile: file, ...(file.type ? { mimeType: file.type } : {}) });
        if (uploaded.type === 'localImage') previews.set(uploaded.path, URL.createObjectURL(file));
        const { type, path, name, mimeType, sizeBytes, sourceProjectId } = uploaded;
        onAttachments(old => [...old, { type, path, name, ...(mimeType ? { mimeType } : {}), ...(sizeBytes ? { sizeBytes } : {}), ...(sourceProjectId ? { sourceProjectId } : {}) }]);
      } catch (e) { setError(`${file.name}: ${errorText(e)}`); }
      finally { setUploading(n => n - 1); }
    }
  }
  const blocked = sendDisabled || pending || uploading > 0 || voiceActive;
  const submit = (options?: SendOptions) => { if (!blocked) onSend(options); };
  return <form ref={root} className={`group/promptbox relative w-full rounded-xl border border-border bg-background ${className}`} onSubmit={event => event.preventDefault()} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void attach(Array.from(event.dataTransfer.files)); }}>
    {header}
    {(attachments.length > 0 || uploading > 0) && <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-3 pt-3">
      {attachments.map(file => <li key={file.path} className="group/file relative flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border-seam bg-surface-recessed py-1 pl-1.5 pr-6 text-xs">
        {previews.has(file.path) || savedPreviews[file.path] ? <img src={previews.get(file.path) ?? savedPreviews[file.path]} alt="" className="size-6 shrink-0 rounded object-cover" /> : <Icon name={file.type === 'localImage' ? 'FileAttachment' : 'File'} aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate" title={file.name}>{file.name}</span>
        <button type="button" aria-label={`Remove ${file.name}`} className="absolute right-1 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => onAttachments(old => old.filter(f => f.path !== file.path))}><Icon name="X" aria-hidden className="size-3" /></button>
      </li>)}
      {uploading > 0 && <li role="status" className="flex items-center rounded-lg border border-dashed border-border-seam px-2 py-1 text-xs text-muted-foreground">Uploading {uploading}…</li>}
    </ul>}
    <input ref={picker} type="file" multiple hidden onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
    {/* The host voice control sits beside Send in both grid layouts. */}
    <div className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-1 ${tall ? 'pb-2 pl-3.5 pr-[13px] pt-1.5 [&>.relative]:col-span-3 [&>.relative]:row-start-1 [&>.relative>.absolute]:-bottom-9 [&>.relative>.absolute]:right-[calc(var(--right-w)+4px)]' : 'min-h-12 px-2 [&>.relative>.absolute]:bottom-0'}`}>
      <Button type="button" size="icon" variant="ghost" className={`size-8 text-muted-foreground ${tall ? 'col-start-1 row-start-2' : ''}`} aria-label="Attach files" disabled={!projectId || pending} onClick={() => picker.current?.click()}><Icon name="Paperclip" aria-hidden /></Button>
      <RichEditor insertRef={insertText} editorRef={editor} label={label} value={value} onChange={onChange} onSend={() => submit()} onCancel={editMode ? onCancel : undefined} onPasteFiles={files => void attach(files)} disabled={pending && !editableWhilePending} autoFocus={autoFocus} placeholder={placeholder} onBlur={onBlur} className={`block w-full overflow-y-auto bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none ${tall ? '' : 'pr-10'}`} />
      <div className={`absolute bottom-2 right-[calc(var(--right-w)+4px)] z-10 ${voiceActive ? 'left-2' : 'w-8'}`}><VoiceInputTextarea aria-label="Voice input" rows={1} value="" onValueChange={transcript => insertText.current(transcript)} onVoiceInputActiveChange={setVoiceActive} disabled={pending && !editableWhilePending} className="absolute h-8 w-8 opacity-0 pointer-events-none" tabIndex={-1} /></div>
      <div ref={right} className={`flex items-center gap-1 ${tall ? 'col-start-3 row-start-2' : ''}`}>
        {actions}
        {editMode ? <Button type="button" size="sm" className="ml-1 h-8 px-2" aria-label={sendLabel} disabled={blocked} onClick={() => submit()}><Icon name="CornerDownLeft" aria-hidden /></Button> : <SendButton label={sendLabel} disabled={blocked} onSend={submit}><Icon name="ArrowUp" aria-hidden /></SendButton>}
      </div>
    </div>
    {error && <p role="alert" className="px-4 pb-2 text-xs text-destructive">{error}</p>}
  </form>;
}

/**
 * bb's split send button: the main part queues; the menu steers, saves a draft held in the
 * thread's queue, or schedules. Children are the main part's content (an icon or a label).
 */
export function SendButton({ label, disabled, onSend, children, side = 'top', className = 'size-8 px-0' }: { label: string; disabled?: boolean; onSend: (options?: SendOptions) => void; children: ReactNode; side?: 'top' | 'bottom'; className?: string }) {
  const [menu, setMenu] = useState(false), [later, setLater] = useState<string | null>(null), [error, setError] = useState('');
  const close = () => { setMenu(false); setLater(null); setError(''); };
  const item = 'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover';
  return <div className="relative flex shrink-0" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) close(); }} onKeyDown={event => { if (event.key === 'Escape' && menu) { event.stopPropagation(); close(); } }}>
    <Button type="button" size="sm" className={`rounded-r-none ${className}`} aria-label={label} disabled={disabled} onClick={() => onSend()}>{children}</Button>
    <Button type="button" size="sm" className="h-8 w-6 rounded-l-none border-l border-background/25 px-0" aria-label="More send options" aria-haspopup="menu" aria-expanded={menu} disabled={disabled} onClick={() => menu ? close() : setMenu(true)}><Icon name="ChevronDown" aria-hidden className="size-3.5" /></Button>
    {menu && <div role="menu" className={`absolute right-0 z-20 w-56 rounded-lg border border-border bg-background p-1 shadow-lg ${side === 'top' ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
      {later === null ? <>
        <button type="button" role="menuitem" className={item} onClick={() => { close(); onSend({ mode: 'steer' }); }}><Icon name="CornerDownRight" aria-hidden className="size-4 text-muted-foreground" />Steer</button>
        <button type="button" role="menuitem" className={item} onClick={() => { close(); onSend({ mode: 'draft' }); }}><Icon name="EditFile" aria-hidden className="size-4 text-muted-foreground" />Save draft</button>
        <button type="button" role="menuitem" className={item} onClick={() => setLater(nextHour())}><Icon name="TimeSchedule" aria-hidden className="size-4 text-muted-foreground" />Send later…</button>
      </> : <div className="space-y-2 p-1.5">
        <input type="datetime-local" aria-label="Send at" autoFocus className="w-full rounded-md border border-border-seam bg-transparent px-2 py-1 text-sm" value={later} onChange={event => setLater(event.target.value)} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex justify-end gap-1"><Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => setLater(null)}>Back</Button><Button type="button" size="sm" className="h-7" disabled={!later} onClick={() => { const sendAt = new Date(later).getTime(); if (!(sendAt > Date.now())) { setError('Pick a time in the future'); return; } close(); onSend({ mode: 'queue', sendAt }); }}>Schedule</Button></div>
      </div>}
    </div>}
  </div>;
}
