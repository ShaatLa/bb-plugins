import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { Markdown, UrlLink, experimental_Icon as Icon, experimental_useRpcQuery as useQuery, useBbNavigate, useSdk } from '@get-bb/plugin-sdk/app';
import { z } from 'zod';
import { rpcContract } from './contract';

// bb's chat shows inline-vis pages (an ::inline-vis{file="…"} directive, or an ```inline-vis fenced page) through the
// built-in inline-vis plugin, but the Markdown bb lends plugins leaves them as text. The chat here splits them out and
// shows them the way inline-vis does: a sandboxed frame on the thread's background, in bb's theme, as tall as its page.

export type Segment = { kind: 'markdown'; text: string } | { kind: 'file'; file: string; source: 'workspace' | 'thread-storage' } | { kind: 'page'; html: string } | { kind: 'task'; key: string };

const DIRECTIVE = /^::inline-vis\{([^}\n]*)\}\s*$/, TASK = /^::task\{key="([A-Za-z][A-Za-z0-9]*-\d+)"\}\s*$/, FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)/;

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
    // Work Board's ::task card, which bb's chat draws and the lent Markdown leaves as text.
    const task = TASK.exec(line.trim()); if (task) { flush(); segments.push({ kind: 'task', key: task[1]!.toUpperCase() }); continue; }
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
// bb routes a message's local file links by the thread route it renders in; the plugin page has none, so such a link
// would navigate the app to the path. The chat opens it in bb's file preview panel instead, as bb's thread view does.
const APP_ROUTE = /^\/(?:projects|threads|plugins|settings|compose|new|docs|automations)(?:[/?#]|$)/;
export function localLink(href: string): { path: string; line: number | null } | null {
  if (href.startsWith('file://')) href = href.slice(7);
  else if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href) || APP_ROUTE.test(href)) return null;
  let path = href, line: number | null = null;
  const hash = /#L(\d+)(?:-L?\d+)?$/.exec(path) ?? /:(\d+)(?::\d+)?$/.exec(path);
  if (hash) { line = Number(hash[1]); path = path.slice(0, hash.index); }
  try { path = decodeURIComponent(path.split(/[?#]/)[0]!); } catch { return null; }
  return path ? { path, line } : null;
}
const environments = new Map<string, Promise<{ id: string; hostId: string; path: string | null } | null>>();
export function LocalLinks({ threadId, children }: { threadId: string; children: React.ReactNode }) {
  const sdk = useSdk(), navigate = useBbNavigate();
  const onClick = (event: React.MouseEvent) => {
    const anchor = (event.target as Element).closest?.('a[href]');
    if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = localLink(anchor.getAttribute('href') ?? '');
    if (!link) return;
    event.preventDefault(); event.stopPropagation();
    if (!environments.has(threadId)) environments.set(threadId, sdk.threads.get({ threadId }).then(t => t.environmentId ? sdk.environments.get({ environmentId: t.environmentId }) : null).then(e => e && { id: e.id, hostId: e.hostId, path: e.path }).catch(() => { environments.delete(threadId); return null; }));
    void environments.get(threadId)!.then(env => {
      if (!env) return;
      const root = env.path?.replace(/\/+$/, '') ?? null, absolute = link.path.startsWith('/');
      if (!absolute && root === null) return;
      const inside = root !== null && (!absolute || link.path.startsWith(root + '/'));
      const target = inside ? { kind: 'workspace' as const, environmentId: env.id, path: absolute ? link.path.slice(root!.length + 1) : link.path.replace(/^\.\//, '') } : { kind: 'host' as const, hostId: env.hostId, path: link.path };
      navigate.experimental_openFilePreview({ target, location: link.line ? { kind: 'line', line: link.line, column: null } : null });
    });
  };
  return <div className="contents" onClickCapture={onClick}>{children}</div>;
}

const taskSchema = z.object({ task: z.object({ key: z.string(), title: z.string(), status: z.string(), projectId: z.string() }).passthrough().nullable() });
const projectsSchema = z.object({ projects: z.array(z.object({ id: z.string(), statuses: z.array(z.object({ id: z.string(), name: z.string() })).default([]) }).passthrough()) });
let statusNames: Promise<Map<string, string>> | null = null;
/** A Work Board task as a compact card (key, title, status) linking to it; a plain key link while it loads or without Work Board. */
export function TaskCard({ taskKey }: { taskKey: string }) {
  const sdk = useSdk(), [task, setTask] = useState<{ title: string; status: string } | null>(null);
  useEffect(() => {
    let live = true;
    statusNames ??= sdk.plugins.callRpc({ pluginId: 'work-board', method: 'listProjects', input: {}, outputSchema: projectsSchema }).then(r => new Map(r.projects.flatMap(p => p.statuses.map(st => [`${p.id}:${st.id}`, st.name] as const)))).catch(() => { statusNames = null; return new Map(); });
    void sdk.plugins.callRpc({ pluginId: 'work-board', method: 'getTaskByKey', input: { taskKey }, outputSchema: taskSchema }).then(async r => { if (!live || !r.task) return; const names = await statusNames!; if (live) setTask({ title: r.task.title, status: names.get(`${r.task.projectId}:${r.task.status}`) ?? r.task.status }); }).catch(() => {});
    return () => { live = false; };
  }, [sdk, taskKey]);
  return <UrlLink href={`/plugins/work-board/work-board/task/${taskKey}`} className="my-2 flex w-fit max-w-full items-center gap-2 rounded-lg border border-border-seam px-3 py-2 text-sm no-underline hover:bg-state-hover">
    <Icon name="ListTodo" aria-hidden className="size-4 shrink-0 text-muted-foreground" /><span className="shrink-0 font-medium">{taskKey}</span>
    {task && <><span className="min-w-0 truncate text-foreground">{task.title}</span><span className="shrink-0 rounded-full bg-surface-recessed px-2 text-xs text-muted-foreground">{task.status}</span></>}
  </UrlLink>;
}

export function AgentMarkdown({ content, threadId }: { content: string; threadId: string }) {
  if (!content.includes('inline-vis') && !content.includes('::task{')) return <LocalLinks threadId={threadId}><Markdown content={content} /></LocalLinks>;
  return <LocalLinks threadId={threadId}>{splitInlineVis(content).map((segment, i) => <Fragment key={i}>{segment.kind === 'markdown' ? <Markdown content={segment.text} /> : segment.kind === 'page' ? <Page html={segment.html} /> : segment.kind === 'task' ? <TaskCard taskKey={segment.key} /> : <FilePage threadId={threadId} file={segment.file} source={segment.source} />}</Fragment>)}</LocalLinks>;
}
