import { useTaskStatuses } from "../shell/task-statuses.js";
import { useState } from "react";
import { listAllTasks, useTasksQuery } from "../shell/data.js";
import { useTasksNavigation } from "../shell/routes.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { StatusIcon } from "../views/list/icons.js";

export function TaskSearch({ projectId }: { projectId: string | null }) {
  const { label: statusLabel } = useTaskStatuses(projectId);
  const navigation = useTasksNavigation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = search.trim();
  const results = useTasksQuery(
    async (rpc) => {
      if (!open || !term) return [];
      if (/^[a-z][a-z0-9]{0,9}-\d+$/i.test(term)) {
        const { task } = await rpc.call("getTaskByKey", { taskKey: term });
        if (task && (projectId === null || task.projectId === projectId))
          return [task];
      }
      return listAllTasks(rpc, {
        ...(projectId === null ? {} : { projectId }),
        search: term,
      });
    },
    ["tasks:changed", "projects:changed"],
    [open, term, projectId],
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-muted-foreground hover:text-foreground max-md:pointer-coarse:h-8"
        >
          <Icon name="Search" className="size-3" />
          Search tasks
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0">
        <Command label="Search tasks" shouldFilter={false}>
          <CommandInput
            aria-label="Search tasks"
            placeholder="Search by key, title or description…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList label="Task search results">
            {!term ? (
              <p className="p-3 text-xs text-muted-foreground">
                Search tasks, epics and sub-tasks
                {projectId ? " in this project" : " across all projects"}.
              </p>
            ) : results.isLoading ? (
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
            ) : results.data?.length === 0 ? (
              <p role="status" className="p-3 text-sm text-muted-foreground">
                No matching tasks.
              </p>
            ) : (
              results.data?.map((task) => (
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
        </Command>
      </PopoverContent>
    </Popover>
  );
}
