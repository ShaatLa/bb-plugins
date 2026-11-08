import { useRef, useState, type ReactNode } from 'react';
import { experimental_Icon as Icon, useSdk } from '@get-bb/plugin-sdk/app';
import type { Attachment } from './contract';
import { Button } from './components/ui/button';

// Local previews for images uploaded in this session; after a reload the chip falls back to the file name.
const previews = new Map<string, string>();
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

type Props = {
  label: string; value: string; onChange: (value: string) => void;
  attachments: Attachment[]; onAttachments: (update: (old: Attachment[]) => Attachment[]) => void;
  // Uploads go to the recipient thread's project; without one, attaching is off.
  projectId: string | null | undefined;
  onSend: () => void; sendDisabled?: boolean; pending?: boolean;
  actions?: ReactNode; autoFocus?: boolean; placeholder?: string;
  sendLabel?: string; header?: ReactNode; className?: string;
};

/** A reply box drawn like bb's prompt box: text, attachments, and an action row with Send at the right. */
export function Composer({ label, value, onChange, attachments, onAttachments, projectId, onSend, sendDisabled, pending, actions, autoFocus, placeholder = 'Reply…', sendLabel = 'Send', header, className = 'shadow-lift' }: Props) {
  const sdk = useSdk(), picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0), [error, setError] = useState('');
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
  const blocked = sendDisabled || pending || uploading > 0;
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
    <textarea aria-label={label} rows={2} autoFocus={autoFocus} placeholder={placeholder} maxLength={8000} className="block max-h-48 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground" value={value} disabled={pending}
      onChange={event => onChange(event.target.value)}
      onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length) { event.preventDefault(); void attach(files); } }}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) { event.preventDefault(); if (!blocked) onSend(); } }} />
    {error && <p role="alert" className="px-4 text-xs text-destructive">{error}</p>}
    <div className="flex items-center gap-1 px-2 pb-2">
      <input ref={picker} type="file" multiple hidden onChange={event => { void attach(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      <Button type="button" size="icon" variant="ghost" className="size-8 text-muted-foreground" aria-label="Attach files" disabled={!projectId || pending} onClick={() => picker.current?.click()}><Icon name="Paperclip" aria-hidden /></Button>
      <span className="flex-1" />
      {actions}
      <Button type="button" size="icon" className="size-8 rounded-lg" aria-label={sendLabel} disabled={blocked} onClick={onSend}><Icon name="ArrowUp" aria-hidden /></Button>
    </div>
  </div>;
}
