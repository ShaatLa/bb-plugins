import { useEffect, useState } from "react";
import type { DependencyTask, Task } from "../../shared/contract";
import { useTasksQuery, useTasksRpc } from "../../shell/data";
import { useTasksNavigation } from "../../shell/routes";
import { errorMessage } from "../../shared/errors";
import { DependencyWarning } from "../../components/dependency-warning";
import { StatusIcon } from "../../components/status-icon";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";

function AddDependency({ task, direction, onSelect }: { task: Task; direction: "blockedBy" | "blocks"; onSelect: (id: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
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
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><Button variant="outline" size="sm" className="h-6 px-2 text-2xs" aria-label={direction === "blockedBy" ? "+ Blocked by" : "+ Blocks"}><Icon name="Plus" className="size-3" />Add</Button></PopoverTrigger>
    <PopoverContent align="start" className="w-80 p-0">
      <Command shouldFilter={false}>
        <CommandInput placeholder="Search task key or title…" value={input} onValueChange={setInput} />
        <CommandList>
          <CommandEmpty>{query.error ?? (query.isFetching ? "Searching…" : "No matching tasks.")}</CommandEmpty>
          <CommandGroup>{(query.data ?? []).filter(row => row.id !== task.id).map(row => <CommandItem key={row.id} value={row.id} onSelect={() => {
            void onSelect(row.id).then(() => setOpen(false));
          }}><StatusIcon projectId={row.projectId} status={row.status} /><span className="truncate">{row.key} · {row.title}</span></CommandItem>)}</CommandGroup>
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>;
}

export function DependenciesSection({ task, onError, query }: { task: Task; onError: (message: string) => void; query: { data?: { blockedBy: DependencyTask[]; blocks: DependencyTask[] }; error: string | null; refresh: () => void } }) {
  const rpc = useTasksRpc();
  const navigation = useTasksNavigation();
  const [pending, setPending] = useState(false);
  async function change(otherId: string, direction: "blockedBy" | "blocks", remove: boolean) {
    if (pending) return;
    setPending(true);
    try {
      const input = direction === "blockedBy" ? { taskId: task.id, blockingTaskId: otherId } : { taskId: otherId, blockingTaskId: task.id };
      await rpc.call(remove ? "removeTaskDependency" : "addTaskDependency", input);
      await query.refresh();
    } catch (error) { onError(errorMessage(error)); }
    finally { setPending(false); }
  }
  const blockedBy = query.data?.blockedBy.filter(row => row.status !== "done");
  function rows(items: DependencyTask[], direction: "blockedBy" | "blocks") {
    return items.map(row => <div key={row.id} className="flex min-w-0 items-start gap-1 py-1">
      <button type="button" className="flex min-w-0 flex-1 items-start gap-1.5 text-left hover:underline" title={`${row.key} · ${row.title} (${row.status})`} onClick={() => navigation.go({ kind: "task", taskKey: row.key })}>
        <StatusIcon projectId={row.projectId} status={row.status} />
        <span className="min-w-0"><span className="block truncate">{row.key} · {row.title}</span><span className="text-2xs text-muted-foreground">{row.status === "done" ? "Done" : direction === "blockedBy" ? "Waiting for Done" : "Dependent task"}</span></span>
      </button>
      {!task.archivedAt ? <Button variant="ghost" size="icon" className="size-5 shrink-0" disabled={pending} aria-label={`Remove ${direction === "blockedBy" ? "dependency on" : "blocking link to"} ${row.key}`} onClick={() => void change(row.id, direction, true)}><Icon name="X" className="size-3" /></Button> : null}
    </div>);
  }
  return <section aria-label="Task dependencies" aria-busy={pending || undefined} className="@container mb-6 mt-5 border-t border-border pt-6 text-xs">
    <div className="mb-1 flex flex-wrap items-center gap-2"><h3 className="font-medium">Dependencies</h3><DependencyWarning blockedBy={blockedBy} /></div>
    {blockedBy?.length ? <p className="mb-3 text-2xs text-muted-foreground">Waiting for predecessors to reach Done. Work is still allowed.</p> : null}
    {query.error ? <p role="status" className="text-warning">Could not load dependencies.</p> : null}
    <div className="grid gap-4 @[36rem]:grid-cols-2">
      {(["blockedBy", "blocks"] as const).map(direction => <div key={direction} className="min-w-0">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h4 className="text-2xs font-medium text-muted-foreground">{direction === "blockedBy" ? "Blocked by" : "Blocks"}</h4>
          {!task.archivedAt ? <fieldset disabled={pending}><AddDependency task={task} direction={direction} onSelect={id => change(id, direction, false)} /></fieldset> : null}
        </div>
        {query.data?.[direction].length ? rows(query.data[direction], direction) : query.data ? <p className="text-2xs text-muted-foreground">None</p> : null}
      </div>)}
    </div>
  </section>;
}
