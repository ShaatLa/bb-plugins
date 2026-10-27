import { useTaskStatuses } from "../shell/task-statuses.js";
import { useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command as CommandPrimitive } from "cmdk";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { listAllTasks, useTasksQuery } from "../shell/data.js";
import { useTasksNavigation } from "../shell/routes.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Command,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { StatusIcon } from "../views/list/icons.js";

export function TaskSearch({ projectId }: { projectId: string | null }) {
  const { label: statusLabel } = useTaskStatuses(projectId);
  const navigation = useTasksNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeProps = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = search.trim();
  const results = useTasksQuery(
    async (rpc) => {
      if (!open || !term) return { term, tasks: [] };
      if (/^[a-z][a-z0-9]{0,9}-\d+$/i.test(term)) {
        const { task } = await rpc.call("getTaskByKey", { taskKey: term });
        if (task && (projectId === null || task.projectId === projectId))
          return { term, tasks: [task] };
      }
      const tasks = await listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        search: term,
      });
      return { term, tasks };
    },
    ["tasks:changed", "projects:changed"],
    [open, term, projectId],
  );

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
          <label className="flex h-6 items-center gap-1.5 rounded-md border border-border px-2.5 text-muted-foreground focus-within:ring-1 focus-within:ring-ring max-md:pointer-coarse:h-8">
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
              {results.isFetching || (!results.error && results.data?.term !== term) ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  Searching tasks…
                </p>
              ) : results.error ? (
                <div className="space-y-2 p-3 text-sm">
                  <p role="alert">{results.error}</p>
                  <Button variant="outline" size="sm" onClick={results.refresh}>
                    Retry
                  </Button>
                </div>
              ) : results.data?.tasks.length === 0 ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  No matching tasks.
                </p>
              ) : (
                results.data?.tasks.map((task) => (
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
            </CommandList>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Command>
  );
}
