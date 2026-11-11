import { useEffect, useState } from "react";
import type { DependencyTask, Task } from "../../shared/contract";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { useTasksNavigation } from "../../shell/routes";
import { useTaskStatuses } from "../../shell/task-statuses";
import { errorMessage } from "../../shared/errors";
import { DependencyWarning } from "../../components/dependency-warning";
import { StatusIcon } from "../../components/status-icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";

type LinkKind = "blockedBy" | "blocks" | "related";
const LINK_LABELS: Record<LinkKind, string> = { blockedBy: "Blocked by", blocks: "Blocks", related: "Related" };

const LINK_KINDS = ["blockedBy", "blocks", "related"] as const;

function AddLink({ task, onSelect }: { task: Task; onSelect: (id: string, kind: LinkKind) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<LinkKind>("related");
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    // Search only the open picker and coalesce typing instead of loading a whole project.
    if (!open) return;
    const timer = setTimeout(() => setSearch(input.trim()), 200);
    return () => clearTimeout(timer);
  }, [input, open]);
  const query = useTasksQuery(
    async rpc => (await rpc.call("listTasks", { projectId: task.projectId, archive: "all", search, limit: 20 })).tasks,
    [], [task.projectId, search], { enabled: open },
  );
  // Each pick starts from the non-blocking type so a blocker is always a deliberate choice.
  return <Popover open={open} onOpenChange={next => { if (next) setKind("related"); setOpen(next); }}>
    <PopoverTrigger asChild><Button variant="outline" size="sm" className="h-6 px-2 text-2xs" aria-label="Add linked task"><Icon name="Plus" className="size-3" />Add</Button></PopoverTrigger>
    <PopoverContent align="end" className="w-80 p-0">
      <div role="radiogroup" aria-label="Link type" className="flex gap-1 border-b border-border p-1.5">
        {LINK_KINDS.map(option => <Button key={option} type="button" role="radio" aria-checked={kind === option} variant={kind === option ? "secondary" : "ghost"} size="sm" className="h-6 flex-1 px-2 text-2xs" onClick={() => setKind(option)}>{LINK_LABELS[option]}</Button>)}
      </div>
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search task key or title…" value={input} onValueChange={setInput} />
        <CommandList>
          <CommandEmpty>{query.error ?? (query.isFetching ? "Searching…" : "No matching tasks.")}</CommandEmpty>
          <CommandGroup>{(query.data ?? []).filter(row => row.id !== task.id).map(row => <CommandItem key={row.id} value={row.id} onSelect={() => {
            void onSelect(row.id, kind).then(() => setOpen(false));
          }}><StatusIcon projectId={row.projectId} status={row.status} /><span className="truncate">{row.key} · {row.title}</span></CommandItem>)}</CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}

export function DependenciesSection({ task, onError, query }: { task: Task; onError: (message: string) => void; query: { data?: { blockedBy: DependencyTask[]; blocks: DependencyTask[]; related: DependencyTask[] }; error: string | null; refresh: () => void } }) {
  const rpc = useTasksRpc();
  const { label: statusLabel } = useTaskStatuses(task.projectId);
  const navigation = useTasksNavigation();
  const [pending, setPending] = useState(false);
  async function change(otherId: string, direction: LinkKind, remove: boolean) {
    if (pending) return;
    setPending(true);
    try {
      if (direction === "related") await rpc.call(remove ? "removeTaskRelation" : "addTaskRelation", { taskId: task.id, relatedTaskId: otherId });
      else {
        const input = direction === "blockedBy" ? { taskId: task.id, blockingTaskId: otherId } : { taskId: otherId, blockingTaskId: task.id };
        await rpc.call(remove ? "removeTaskDependency" : "addTaskDependency", input);
      }
      await query.refresh();
    } catch (error) { onError(errorMessage(error)); }
    finally { setPending(false); }
  }
  const blockedBy = query.data?.blockedBy.filter(row => row.status !== "done");
  const links = LINK_KINDS.flatMap(kind => (query.data?.[kind] ?? []).map(row => ({ kind, row })));
  return <section aria-label="Task dependencies" aria-busy={pending || undefined} className="mb-6 mt-5 border-t border-border pt-6 text-xs">
    <div className="mb-1 flex items-center gap-2">
      <h3 className="font-medium">Dependencies</h3><DependencyWarning blockedBy={blockedBy} />
      {!task.archivedAt ? <fieldset disabled={pending} className="ml-auto"><AddLink task={task} onSelect={(id, kind) => change(id, kind, false)} /></fieldset> : null}
    </div>
    {blockedBy?.length ? <p className="mb-2 text-2xs text-muted-foreground">Waiting for predecessors to reach Done. Work is still allowed.</p> : null}
    {query.error ? <p role="status" className="text-warning">Could not load dependencies.</p> : null}
    {links.length ? <div className="divide-y divide-border-hairline">{links.map(({ kind, row }) => <div key={`${kind}:${row.id}`} className="flex min-w-0 items-center gap-3 py-1.5">
      <span className="w-16 shrink-0 text-2xs text-muted-foreground">{LINK_LABELS[kind]}</span>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline" title={`${row.key} · ${row.title} (${statusLabel(row.status)})`} onClick={() => navigation.go({ kind: "task", taskKey: row.key })}>
        <span className="flex shrink-0 items-center gap-1 text-2xs text-muted-foreground"><StatusIcon projectId={row.projectId} status={row.status} className="size-3" /><span className="truncate">{statusLabel(row.status)}</span></span>{" "}
        <span className="min-w-0 truncate">{row.key} · {row.title}</span>
      </button>
      {!task.archivedAt ? <Button variant="ghost" size="icon" className="size-5 shrink-0" disabled={pending} aria-label={`Remove ${kind === "blockedBy" ? "dependency on" : kind === "blocks" ? "blocking link to" : "related link to"} ${row.key}`} onClick={() => void change(row.id, kind, true)}><Icon name="X" className="size-3" /></Button> : null}
    </div>)}</div> : query.data ? <p className="text-2xs text-muted-foreground">No linked tasks</p> : null}
  </section>;
}
