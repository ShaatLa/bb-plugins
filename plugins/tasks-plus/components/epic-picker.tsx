import { useState } from "react";
import { listAllTasks, useTasksQuery } from "../shell/data.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

export function EpicPicker({
  projectId,
  value,
  onChange,
  className,
}: {
  projectId: string | null;
  value: string | null;
  onChange: (epicId: string | null) => void;
  className: string;
}) {
  const [open, setOpen] = useState(false);
  const query = useTasksQuery(
    (rpc) =>
      projectId
        ? listAllTasks(rpc, { projectId, type: "epic" })
        : Promise.resolve([]),
    ["tasks:changed"],
    [projectId],
  );
  const epics = (query.data ?? []).filter(
    (task) => task.type === "epic" && task.projectId === projectId,
  );
  const selected = epics.find((epic) => epic.id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Epic"
          className={cn("inline-flex items-center whitespace-nowrap", className)}
        >
          <Icon name="Zap" className="size-3.5 shrink-0" />
          <span className="truncate">
            {selected
              ? `Epic: ${selected.key} · ${selected.title}`
              : value
                ? "Epic…"
                : "Add to epic"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <Command>
          <CommandInput placeholder="Choose an epic…" />
          <CommandList>
            <CommandEmpty>
              {query.error ??
                (query.isLoading ? "Loading epics…" : "No matching epics.")}
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                No epic
              </CommandItem>
              {epics.map((epic) => (
                <CommandItem
                  key={epic.id}
                  value={`${epic.key} ${epic.title}`}
                  onSelect={() => {
                    onChange(epic.id);
                    setOpen(false);
                  }}
                >
                  <span className="flex-1 truncate">
                    {epic.key} · {epic.title}
                  </span>
                  {epic.id === value ? (
                    <Icon name="Check" className="size-3.5" />
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
