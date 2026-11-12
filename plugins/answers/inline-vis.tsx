import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Markdown, experimental_useRpcQuery as useQuery } from '@get-bb/plugin-sdk/app';
import { rpcContract } from './contract';

// bb's chat shows inline-vis pages (an ::inline-vis{file="…"} directive, or an ```inline-vis fenced page) through the
// built-in inline-vis plugin, but the Markdown bb lends plugins leaves them as text. The chat here splits them out and
// shows them the way inline-vis does: a sandboxed frame on the thread's background, in bb's theme, as tall as its page.

export type Segment = { kind: 'markdown'; text: string } | { kind: 'file'; file: string; source: 'workspace' | 'thread-storage' } | { kind: 'page'; html: string };

const DIRECTIVE = /^::inline-vis\{([^}\n]*)\}\s*$/, FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

/** Splits a message into Markdown runs, directive pages and fenced pages; directives inside other fences stay text. */
export function splitInlineVis(text: string): Segment[] {
  const segments: Segment[] = [], lines = text.split('\n');
  let markdown: string[] = [], fence: { marker: string; page: string[] | null } | null = null;
  const flush = () => { if (markdown.join('\n').trim()) segments.push({ kind: 'markdown', text: markdown.join('\n') }); markdown = []; };
  for (const line of lines) {
    if (fence) {
      const close = line.trim().startsWith(fence.marker) && /^[`~]+$/.test(line.trim());
      if (fence.page) { if (close) { segments.push({ kind: 'page', html: fence.page.join('\n') }); fence = null; } else fence.page.push(line); continue; }
      markdown.push(line); if (close) fence = null; continue;
    }
    const open = FENCE.exec(line);
    if (open) { const page = open[2]!.toLowerCase() === 'inline-vis'; if (page) flush(); else markdown.push(line); fence = { marker: open[1]!, page: page ? [] : null }; continue; }
    const directive = DIRECTIVE.exec(line.trim());
    if (directive) {
      const attrs = Object.fromEntries([...directive[1]!.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1]!, m[2]!]));
      if (attrs.file) { flush(); segments.push({ kind: 'file', file: attrs.file, source: attrs.source === 'thread-storage' ? 'thread-storage' : 'workspace' }); continue; }
    }
    markdown.push(line);
  }
  // An unclosed fenced page (a reply cut short) stays visible as its source.
  if (fence?.page) markdown.push('```inline-vis', ...fence.page);
  flush();
  return segments;
}

const THEME = ['background', 'foreground', 'muted', 'muted-foreground', 'subtle-foreground', 'card', 'card-foreground', 'popover', 'popover-foreground', 'surface-raised', 'surface-recessed', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'accent', 'accent-foreground', 'border', 'input', 'ring', 'brand', 'destructive', 'destructive-foreground', 'destructive-text', 'warning', 'warning-text', 'success', 'attention', 'diff-added', 'diff-removed', 'chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'radius', 'shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'font-sans', 'font-mono'];

/** A page in a sandboxed frame: bb's theme variables, a transparent page, the frame following the page's height. */
function Page({ html, baseHref }: { html: string; baseHref?: string }) {
  const frame = useRef<HTMLIFrameElement>(null), id = useId(), [height, setHeight] = useState(120);
  const root = getComputedStyle(document.documentElement), scheme = root.colorScheme.includes('dark') ? 'dark' : 'light';
  const vars = THEME.map(name => [name, root.getPropertyValue(`--${name}`).trim()] as const).filter(([, value]) => value).map(([name, value]) => `--${name}:${value}`).join(';');
  const head = `<meta charset="utf-8">${baseHref ? `<base href="${baseHref.replace(/"/g, '&quot;')}">` : ''}<style>:root{${vars};color-scheme:${scheme}}html{scrollbar-width:none}html,body{background:transparent}body{margin:0;color:var(--foreground);font:14px/1.5 var(--font-sans,system-ui)}</style>`
    + `<script>(()=>{const post=()=>parent.postMessage({answersInlineVis:${JSON.stringify(id)},height:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*');addEventListener('load',post);new ResizeObserver(post).observe(document.documentElement);})()</script>`;
  // The theme goes into the page's own head when it has one, so a full document keeps its doctype (and standards mode).
  const doc = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, match => match + head) : /<html[^>]*>/i.test(html) ? html.replace(/<html[^>]*>/i, match => match + `<head>${head}</head>`) : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  useEffect(() => {
    const listen = (event: MessageEvent) => { if (event.source === frame.current?.contentWindow && event.data?.answersInlineVis === id && typeof event.data.height === 'number') setHeight(Math.max(40, Math.min(2000, event.data.height))); };
    window.addEventListener('message', listen); return () => window.removeEventListener('message', listen);
  }, [id]);
  return <iframe ref={frame} title="Inline page" srcDoc={/^\s*<!doctype/i.test(doc) ? doc : `<!doctype html>${doc}`} sandbox="allow-scripts allow-forms" className="my-2 block w-full border-0" style={{ height, colorScheme: scheme }} />;
}

/** A page or Markdown document the directive names, read through the inline-vis plugin. */
function FilePage({ threadId, file, source }: { threadId: string; file: string; source: 'workspace' | 'thread-storage' }) {
  const preview = useQuery({ contract: rpcContract, method: 'inlinePreview', input: { threadId, file, source } }), data = preview.data;
  if (!data) return preview.error ? <p className="text-xs text-muted-foreground">Could not show {file}</p> : null;
  if (data.kind === 'html') return <Page html={data.content} baseHref={new URL(data.url, location.origin).href} />;
  if (data.kind === 'markdown') return <div className="my-2 rounded-lg border border-border-seam p-3"><Markdown content={data.content} experimental_document={{ threadId, rootPath: data.rootPath, target: data.target }} /></div>;
  return <p className="text-xs text-muted-foreground">{data.kind === 'not-found' ? `${file} was not found` : `Could not show ${file}: ${data.message}`}</p>;
}

/** An agent's message: Markdown, with inline-vis pages shown in place. */
export function AgentMarkdown({ content, threadId }: { content: string; threadId: string }) {
  if (!content.includes('inline-vis')) return <Markdown content={content} />;
  return <>{splitInlineVis(content).map((segment, i) => <Fragment key={i}>{segment.kind === 'markdown' ? <Markdown content={segment.text} /> : segment.kind === 'page' ? <Page html={segment.html} /> : <FilePage threadId={threadId} file={segment.file} source={segment.source} />}</Fragment>)}</>;
}
