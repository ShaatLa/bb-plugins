import { useEffect, useState, type ReactNode } from 'react';
import { useSdk, useBbNavigate, experimental_useTabVisible as useTabVisible, experimental_useRpcQuery as useQuery, experimental_useRpcMutation as useMutation, experimental_InfoSection as InfoSection, experimental_InfoList as InfoList, experimental_InfoListRow as InfoListRow, experimental_DetailRow as DetailRow, experimental_Icon as Icon, experimental_Diff as Diff, experimental_FileLink as FileLink } from '@get-bb/plugin-sdk/app';
import { useOpenChat } from './open-chat';
import { gitContract, boardContract, unavailable, type GitFile, type GitTarget } from './tab-contracts';

const git = { pluginId: 'bb--git', contract: gitContract };
type Sdk = ReturnType<typeof useSdk>;
type Thread = Awaited<ReturnType<Sdk['threads']['get']>>;
type Environment = Awaited<ReturnType<Sdk['environments']['get']>>;
// Mirrors the bundled Git plugin’s empty-state box (Dt).
function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground" role="status">{children}</div>;
}
function useChatDetails() {
  const sdk = useSdk(), chat = useOpenChat(), visible = useTabVisible();
  const [data, setData] = useState<{ thread: Thread; environment: Environment | null; parent: string; project: string }>();
  const [error, setError] = useState('');
  useEffect(() => {
    setError('');
    if (!visible || !chat.threadId) return;
    let active = true;
    void (async () => {
      const thread = await sdk.threads.get({ threadId: chat.threadId! });
      const [environment, parent, project] = await Promise.all([
        thread.environmentId ? sdk.environments.get({ environmentId: thread.environmentId }) : null,
        thread.parentThreadId ? sdk.threads.get({ threadId: thread.parentThreadId }).then(t => t.title ?? t.id).catch(() => thread.parentThreadId!) : 'None',
        thread.projectId ? sdk.projects.get({ projectId: thread.projectId }).then(p => p.name).catch(() => thread.projectId!) : 'None',
      ]);
      if (active) setData({ thread, environment, parent, project });
    })().catch(e => { if (active) setError(e instanceof Error ? e.message : String(e)); });
    return () => { active = false; };
  }, [sdk, chat.threadId, chat.revision, visible]);
  return { ...chat, visible, data: data?.thread.id === chat.threadId ? data : undefined, error };
}
export function InfoTab() {
  const chat = useChatDetails(), environmentId = chat.data?.environment?.id;
  const status = useQuery({ ...git, method: 'status', input: { keys: environmentId ? [environmentId] : [] }, enabled: chat.visible && !!environmentId });
  useEffect(() => { if (chat.visible && environmentId) void status.refetch(); }, [chat.visible, environmentId, chat.revision]);
  if (!chat.threadId) return <Empty>No chat open</Empty>;
  if (chat.error) return <Empty>{chat.error}</Empty>;
  if (!chat.data) return <Empty>Loading…</Empty>;
  const { environment, parent, project } = chat.data, row = environmentId ? status.data?.[environmentId] : undefined;
  const workspace = row?.outcome === 'available' ? row.workspace : undefined, base = workspace?.mergeBase;
  const files = base ?? workspace?.workingTree;
  const gitStatus = workspace ? [base?.aheadCount ? base.behindCount ? `${base.aheadCount} ahead, ${base.behindCount} behind ${base.mergeBaseBranch}` : `${base.aheadCount} ahead of ${base.mergeBaseBranch}` : '', base?.behindCount && !base.aheadCount ? `${base.behindCount} behind ${base.mergeBaseBranch}` : '', workspace.workingTree.hasUncommittedChanges ? 'Uncommitted changes' : ''].filter(Boolean).join(', ') || (base ? `Even with ${base.mergeBaseBranch}` : 'Clean') : status.error?.message ?? (row && row.outcome !== 'available' ? unavailable(row) : environment ? 'Loading…' : 'No environment');
  return <div className="h-full overflow-auto p-4 space-y-4">
    {/* Mirrors bb's thread Info details, using its host-owned rows. */}
    {/* shortcut: Parent and Merge base are read-only, add pickers when editing is requested. */}
    <div className="space-y-2">
      <DetailRow label="Parent" icon="MessageSquare">{parent}</DetailRow>
      <DetailRow label="Project" icon="Folder">{project}</DetailRow>
      <DetailRow label="Environment" icon="Folder">{environment?.name ?? (environment?.isWorktree ? 'Worktree' : environment ? 'Local' : 'None')}</DetailRow>
      <DetailRow label="Directory" icon="Folder">{environment?.path ?? 'None'}</DetailRow>
      <DetailRow label="Branch" icon="GitBranch">{workspace?.branch.currentBranch ?? 'None'}</DetailRow>
      <DetailRow label="Merge base" icon="GitMerge">{base?.mergeBaseBranch ?? 'None'}</DetailRow>
      <DetailRow label="Git status" icon="FileDiff">{gitStatus}</DetailRow>
    </div>
    {base && <InfoSection label="Commits" count={base.commits.length}><InfoList limit={5} items={[...base.commits].reverse()} getKey={c => c.sha} renderItem={c => <InfoListRow leading={<span className="size-[7px] rounded-full border border-subtle-foreground/60 bg-background group-hover:border-subtle-foreground" />} name={c.subject} context={c.shortSha} />} /></InfoSection>}
    {files && <InfoSection label="Files changed" count={files.fileCount}><InfoList limit={5} items={files.files} getKey={f => f.path} renderItem={f => <InfoListRow leading={<StatusIcon status={f.status} />} name={<FileLink target={{ kind: 'workspace', environmentId: environmentId!, path: f.path }}>{f.path}</FileLink>} trailing={<Counts added={f.insertions} removed={f.deletions} />} />} />{files.fileCount > files.files.length && <p className="m-0 text-2xs leading-6 text-subtle-foreground">{files.fileCount - files.files.length} more {files.fileCount - files.files.length === 1 ? 'file' : 'files'} not shown</p>}</InfoSection>}
  </div>;
}
// Mirrors the bundled Git plugin’s changed-file status icons (Ov) and line counts (Se).
function StatusIcon({ status }: { status: string }) {
  const kinds: Record<string, string> = { added: 'A', deleted: 'D', renamed: 'R', copied: 'C', modified: 'M', type_changed: 'M' };
  const icons: Record<string, [string, string]> = { M: ['DiffModified', 'text-subtle-foreground'], A: ['DiffAdded', 'text-diff-added'], '??': ['DiffAdded', 'text-diff-added'], D: ['DiffRemoved', 'text-diff-removed'], R: ['DiffRenamed', 'text-subtle-foreground'], C: ['Copy', 'text-subtle-foreground'], U: ['DiffConflict', 'text-destructive'] };
  const [name, color] = icons[kinds[status] ?? status] ?? ['CircleQuestion', 'text-subtle-foreground'];
  return <Icon name={name} className={`size-3 ${color}`} aria-hidden />;
}
function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  return <span className="whitespace-nowrap text-xs"><span className="text-diff-added">{added === null ? '' : `+${added}`}</span>{' '}<span className="text-diff-removed">{removed === null ? '' : `-${removed}`}</span></span>;
}
export function DiffTab() {
  const chat = useChatDetails();
  if (!chat.threadId) return <Empty>No chat open</Empty>;
  if (chat.error) return <Empty>{chat.error}</Empty>;
  if (!chat.data) return <Empty>Loading…</Empty>;
  if (!chat.data.environment) return <Empty>No environment</Empty>;
  return <EnvironmentDiff key={chat.threadId} environment={chat.data.environment} revision={chat.revision} visible={chat.visible} />;
}
function EnvironmentDiff({ environment, revision, visible }: { environment: Environment; revision: number; visible: boolean }) {
  const [branch, setBranch] = useState(false), [limit, setLimit] = useState(20);
  const status = useQuery({ ...git, method: 'status', input: { keys: [environment.id] }, enabled: visible });
  const row = status.data?.[environment.id], base = row?.outcome === 'available' ? row.workspace.mergeBase?.mergeBaseBranch : undefined;
  const target: GitTarget = branch && base ? { type: 'branch_committed', mergeBaseBranch: base } : { type: 'uncommitted' };
  const input = { environmentId: environment.id, target };
  const files = useQuery({ ...git, method: 'files', input: { ...input, ignoreWhitespace: false }, enabled: visible });
  const viewed = useQuery({ ...git, method: 'viewed', input, enabled: visible });
  useEffect(() => { if (visible) { void status.refetch(); void files.refetch(); void viewed.refetch(); } }, [visible, revision]);
  useEffect(() => setLimit(20), [branch]);
  const result = files.data;
  return <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden">
    {/* Mirrors the bundled Git plugin’s Diff toolbar (ou/Ub); native selection keeps keyboard navigation. */}
    <div className="shrink-0 select-none flex flex-col bg-sidebar"><div className="px-4 pb-3 pt-3"><div className="relative h-8 w-full min-w-0 rounded-lg border border-border bg-transparent px-2.5 text-xs font-normal max-md:pointer-coarse:h-10">
      <div className="flex h-full items-center justify-between gap-2" aria-hidden><span className="truncate">{branch && base ? `Branch against ${base}` : 'Uncommitted changes'}</span><Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" /></div>
      <select aria-label="Diff target" className="absolute inset-0 h-full w-full cursor-pointer opacity-0" value={branch ? 'branch' : 'uncommitted'} onChange={event => setBranch(event.target.value === 'branch')}><option value="uncommitted">Uncommitted changes</option><option value="branch" disabled={!base}>Branch against {base ?? 'merge base'}</option></select>
    </div></div></div>
    <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto px-4 pb-3 space-y-2">
    {files.error ? <Empty>{files.error.message}</Empty> : !result ? <Empty>Loading…</Empty> : result.outcome !== 'available' ? <Empty>{unavailable(result)}</Empty> : <>
      {!result.files.length && <Empty>No changes</Empty>}
      {/* shortcut: bounded rendering replaces host virtualization; revisit for very large diffs. */}
      {result.files.slice(0, limit).map(file => <DiffFile key={JSON.stringify([target, file.path, file.revision])} file={file} input={input} visible={visible} initial={result.initialPatches.find(p => p.path === file.path)} viewed={!!viewed.data?.files.some(f => f.path === file.path && f.revision === file.revision)} refreshViewed={viewed.refetch} />)}
      {result.files.length > limit && <button type="button" onClick={() => setLimit(n => n + 20)} className="p-3 text-xs text-muted-foreground">Load more</button>}
      {result.truncated && <p className="p-3 text-xs text-muted-foreground">More files not shown</p>}
    </>}
    {viewed.error && <p role="alert">{viewed.error.message}</p>}
    </div>
  </div>;
}
function DiffFile({ file, input, initial, viewed, visible, refreshViewed }: { file: GitFile; input: { environmentId: string; target: GitTarget }; initial?: { patch: string; truncated: boolean }; viewed: boolean; visible: boolean; refreshViewed: () => Promise<void> }) {
  const [load, setLoad] = useState(file.loadMode === 'auto'), [error, setError] = useState('');
  // Mirrors bb's gitPatchKey tuple, including the file revision supplied by files.
  const key = JSON.stringify([input.environmentId, input.target, false, file.path, file.revision]);
  const patches = useQuery({ ...git, method: 'patches', input: { keys: [key] }, enabled: visible && !viewed && load && !initial && !file.binary && file.loadMode !== 'too_large' });
  const mark = useMutation({ ...git, method: 'markViewed' }), clear = useMutation({ ...git, method: 'clearViewed' });
  const result = patches.data?.[key], patch = initial ?? (result?.outcome === 'available' ? result.patch : undefined);
  const toggle = async () => { setError(''); try { if (viewed) await clear.mutate({ ...input, path: file.path }); else await mark.mutate({ ...input, path: file.path, revision: file.revision }); await refreshViewed(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } };
  // Mirrors the bundled Git plugin’s Diff card, header, and Viewed label (gd/Ku).
  return <section className="overflow-clip rounded-lg border border-border bg-background">
    <div className="rounded-lg bg-background py-1.5 pl-2 pr-3 text-xs font-medium text-foreground"><div className="flex w-full min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1"><StatusIcon status={file.changeKind} /><FileLink className="min-w-0 flex-1 truncate font-mono font-medium text-foreground" target={{ kind: 'workspace', environmentId: input.environmentId, path: file.path }}>{file.path}</FileLink><Counts added={file.additions} removed={file.deletions} /><label className="ml-1 flex shrink-0 cursor-pointer items-center gap-1.5 border-l border-border pl-3 whitespace-nowrap text-xs leading-none text-muted-foreground has-[:disabled]:cursor-default has-[:disabled]:opacity-60"><input type="checkbox" checked={viewed} disabled={mark.isPending || clear.isPending} onChange={() => void toggle()} /><span>Viewed</span></label></div></div>
    {error && <p role="alert">{error}</p>}
    {!viewed && (patch ? <><Diff path={file.path} patch={patch.patch} />{patch.truncated && <p className="p-3 text-xs text-muted-foreground">Diff truncated</p>}</> : file.binary ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-xs text-muted-foreground">Binary file.</div> : file.loadMode === 'too_large' ? <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-3 text-xs text-muted-foreground">Too large to display ({file.additions + file.deletions} changed lines).</div> : patches.error ? <Empty>{patches.error.message}</Empty> : result && result.outcome !== 'available' ? <Empty>{unavailable(result)}</Empty> : !load ? <button type="button" onClick={() => setLoad(true)} className="p-3 text-xs text-muted-foreground">Load diff</button> : <Empty>Loading…</Empty>)}
  </section>;
}
export function WorkBoardTab() {
  const chat = useOpenChat(), visible = useTabVisible(), navigate = useBbNavigate();
  const tasks = useQuery({ pluginId: 'work-board', contract: boardContract, method: 'threadTasks', input: { threadId: chat.threadId ?? '' }, enabled: visible && !!chat.threadId });
  useEffect(() => { if (visible && chat.threadId) void tasks.refetch(); }, [visible, chat.threadId, chat.revision]);
  if (!chat.threadId) return <Empty>No chat open</Empty>;
  if (tasks.error) return <Empty>Work Board unavailable</Empty>;
  if (!tasks.data) return <Empty>Loading…</Empty>;
  if (!tasks.data.tasks.length) return <Empty>No linked tasks</Empty>;
  return <div className="p-4"><InfoSection label="Work Board" count={tasks.data.tasks.length}><InfoList limit={5} items={tasks.data.tasks} getKey={task => task.key} renderItem={task => <InfoListRow leading={<Icon name="ListTodo" />} name={<span className={task.archived ? 'opacity-50' : undefined}>{task.key} {task.title}</span>} context={task.projectName} trailing={<span style={{ color: task.status.color }} className={`flex items-center gap-1 ${task.archived ? 'opacity-50' : ''}`}>{task.status.icon && <Icon name={task.status.icon} className="size-3" />}{task.status.name}</span>} onSelect={() => { if (task.url.startsWith('/plugins/work-board/')) navigate.openUrl(task.url); }} />} /></InfoSection></div>;
}
