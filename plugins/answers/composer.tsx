import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
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
  // The Inbox composer keeps edits made during a send; other boxes clear on success, so they lock while sending.
  editableWhilePending?: boolean;
  sendLabel?: string; header?: ReactNode; className?: string;
};

/** A reply box drawn like bb's prompt box: text, attachments, and an action row with Send at the right. */
export function Composer({ label, value, onChange, attachments, onAttachments, projectId, onSend, sendDisabled, pending, actions, autoFocus, editableWhilePending, placeholder = 'Reply…', sendLabel = 'Send', header, className = 'shadow-lift' }: Props) {
  const sdk = useSdk(), picker = useRef<HTMLInputElement>(null), editor = useRef<HTMLTextAreaElement>(null);
  const [uploading, setUploading] = useState(0), [error, setError] = useState(''), [voiceActive, setVoiceActive] = useState(false);
  useLayoutEffect(() => { const node = editor.current; if (node) { node.style.height = 'auto'; node.style.height = `${Math.min(node.scrollHeight, Math.max(96, window.innerHeight * .4))}px`; } }, [value]);
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
  return <div className={`rounded-xl border border-border bg-background ${className}`} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); }} onDrop={event => { if (!event.dataTransfer.files.length) return; event.preventDefault(); void attach(Array.from(event.dataTransfer.files)); }}>
    {header}
    {(attachments.length > 0 || uploading > 0) && <ul aria-label="Attachments" className="flex flex-wrap gap-1.5 px-3 pt-3">
      {attachments.map(file => <li key={file.path} className="group/file relative flex max-w-[180px] items-center gap-1.5 rounded-lg border border-border-seam bg-surface-recessed py-1 pl-1.5 pr-6 text-xs">
        {previews.has(file.path) ? <img src={previews.get(file.path)} alt="" className="size-6 shrink-0 rounded object-cover" /> : <Icon name={file.type === 'localImage' ? 'FileAttachment' : 'File'} aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />}
        <span className="truncate" title={file.name}>{file.name}</span>
        <button type="button" aria-label={`Remove ${file.name}`} className="absolute right-1 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground" onClick={() => onAttachments(old => old.filter(f => f.path !== file.path))}><Icon name="X" aria-hidden className="size-3" /></button>
      </li>)}
      {uploading > 0 && <li role="status" className="flex items-center rounded-lg border border-dashed border-border-seam px-2 py-1 text-xs text-muted-foreground">Uploading {uploading}…</li>}
    </ul>}
    <VoiceInputTextarea ref={editor} aria-label={label} rows={2} autoFocus={autoFocus} placeholder={placeholder} maxLength={8000} className="block min-h-[3.5rem] w-full resize-none overflow-y-auto bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground" value={value} disabled={pending && !editableWhilePending}
      onValueChange={onChange} onVoiceInputActiveChange={setVoiceActive}
      onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void attach(files); } }}
      onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
    {error && <p role="alert" className="px-4 text-xs text-destructive">{error}</p>}
    <div className="flex items-center gap-1 px-2 pb-2">
      <input ref={picker} type="file" multiple hidden onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="Attach files" disabled={!projectId || pending} onClick={() => picker.current?.click()}><Icon name="Paperclip" aria-hidden /></Button>
      <span className="flex-1" />
      {actions}
      <SendButton label={sendLabel} disabled={blocked} onSend={submit}><Icon name="ArrowUp" aria-hidden /></SendButton>
    </div>
  </div>;
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
