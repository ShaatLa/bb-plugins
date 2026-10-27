import { useTaskStatuses } from "../shell/task-statuses.js";
import { useEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command as CommandPrimitive } from "cmdk";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { useTasksQuery } from "../shell/data.js";
import type { Task } from "../shared/contract.js";
import { useTasksNavigation } from "../shell/routes.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Command,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { StatusIcon } from "../views/list/icons.js";

interface SearchResults {
  term: string;
  tasks: Task[];
  more: boolean;
}

export function TaskSearch({ projectId }: { projectId: string | null }) {
  const { label: statusLabel, prefix } = useTaskStatuses(projectId);
  const navigation = useTasksNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeProps = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = search.trim();
  const [debouncedTerm, setDebouncedTerm] = useState(term);
  const cache = useRef(new Map<string, SearchResults>());
  const cacheKey = (value: string) => JSON.stringify([projectId, value.toLowerCase()]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedTerm(term), 150);
    return () => clearTimeout(timer);
  }, [term]);
  const results = useTasksQuery<SearchResults>(
    async (rpc, publish) => {
      const term = debouncedTerm;
      if (!open || !term) return { term: "", tasks: [], more: false };
      const key = cacheKey(term);
      const cached = cache.current.get(key);
      if (cached) publish({ ...cached, term });
      const remember = (tasks: Task[], more = false) => {
        const result = { term, tasks, more };
        cache.current.delete(key);
        cache.current.set(key, result);
        if (cache.current.size > 20) cache.current.delete(cache.current.keys().next().value!);
        return result;
      };
      const taskKey = /^\d+$/.test(term) && prefix ? `${prefix}-${term}` : term;
      if (/^[a-z][a-z0-9]{0,9}-\d+$/i.test(taskKey)) {
        const { task } = await rpc.call("getTaskByKey", { taskKey });
        if (task && (projectId === null || task.projectId === projectId))
          return remember([task]);
      }
      const page = await rpc.call("listTasks", {
        ...(projectId === null ? {} : { projectId }),
        search: term,
        limit: 25,
      });
      return remember(page.tasks, !!page.nextCursor);
    },
    ["tasks:changed", "projects:changed"],
    [open, debouncedTerm, projectId, prefix],
  );
  const current = results.data?.term === term
    ? results.data
    : cache.current.get(cacheKey(term));
  const updating = term !== debouncedTerm || results.isFetching;

  return (
    <Command
      label="Search tasks"
      shouldFilter={false}
      className="h-auto w-44 shrink-0 overflow-visible bg-transparent"
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <Popover.Root open={open && !!term} onOpenChange={setOpen}>
        <Popover.Anchor asChild>
          <label className="flex h-6 items-center gap-1.5 rounded-md border border-input px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring max-md:pointer-coarse:h-8">
            <Icon name="Search" className="size-3 shrink-0" />
            <CommandPrimitive.Input
              ref={inputRef}
              aria-label="Search tasks"
              aria-expanded={open && !!term}
              placeholder="Search tasks"
              autoComplete="off"
              className="h-full w-full min-w-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground max-md:pointer-coarse:text-base"
              value={search}
              onFocus={() => { if (term) setOpen(true); }}
              onValueChange={(value) => {
                setSearch(value);
                setOpen(!!value.trim());
              }}
            />
          </label>
        </Popover.Anchor>
        <Popover.Portal>
          <Popover.Content
            {...scopeProps}
            role="presentation"
            align="start"
            sideOffset={4}
            className="z-50 w-80 max-w-[calc(100vw-2rem)] rounded-md border border-border bg-popover p-0 text-popover-foreground shadow-md"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (event.target === inputRef.current) event.preventDefault();
            }}
          >
            <CommandList label="Task search results">
              {!current && (updating || !results.error) ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  Searching tasks…
                </p>
              ) : !current && results.error ? (
                <div className="space-y-2 p-3 text-sm">
                  <p role="alert">{results.error}</p>
                  <Button variant="outline" size="sm" onClick={results.refresh}>
                    Retry
                  </Button>
                </div>
              ) : current?.tasks.length === 0 ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  No matching tasks.
                </p>
              ) : (
                current?.tasks.map((task) => (
                  <CommandItem
                    key={task.id}
                    value={task.id}
                    className="items-start"
                    onSelect={() => {
                      setOpen(false);
                      setSearch("");
                      navigation.go({ kind: "task", taskKey: task.key });
                    }}
                  >
                    <span className="mt-0.5">
                      <StatusIcon status={task.status} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {task.key} · {task.title}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {task.type === "epic"
                          ? "Epic"
                          : task.parentTaskId
                            ? "Sub-task"
                            : "Task"}{" "}
                        · {statusLabel(task.status, task.projectId)}
                      </span>
                    </span>
                  </CommandItem>
                ))
              )}
              {current && updating ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Updating results…</p> : null}
              {current?.more ? <p className="p-3 text-xs text-muted-foreground">Showing the first 25 matches. Refine your search to find more.</p> : null}
              {current && results.error && !updating ? <p role="alert" className="p-3 text-xs text-destructive">{results.error}</p> : null}
            </CommandList>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Command>
  );
}
