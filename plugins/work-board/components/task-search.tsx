import { useTaskStatuses } from "../shell/task-statuses.js";
import { useEffect, useMemo, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Command as CommandPrimitive } from "cmdk";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { patchTasks, useTasksQuery } from "../shell/data.js";
import { evictFullTaskDataset, loadTaskDataset, taskDatasetSnapshot } from "../shell/task-dataset";
import { signalTaskIds } from "../shell/signal-scheduler.js";
import { type Task } from "../shared/contract.js";
import { errorMessage } from "../shared/errors.js";
import { useTasksNavigation } from "../shell/routes.js";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Command,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { StatusIcon } from "../views/list/icons.js";

type BodyStatus = { status: "pending" | "done" } | { status: "failed"; message: string };
const BODY_PENDING: BodyStatus = { status: "pending" };
const BODY_DONE: BodyStatus = { status: "done" };
const BODY_FALLBACK_DELAY_MS = 250;

export function TaskSearch({ projectId }: { projectId: string | null }) {
  const { label: statusLabel, prefix } = useTaskStatuses(projectId);
  const navigation = useTasksNavigation();
  const inputRef = useRef<HTMLInputElement>(null);
  const scopeProps = usePortalScopeProps();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = search.trim();
  const index = useTasksQuery<Task[]>(
    (rpc, publish) => loadTaskDataset(rpc, projectId, publish),
    ["tasks:changed", "projects:changed"],
    [projectId],
    {
      snapshot: taskDatasetSnapshot(projectId),
      applySignals: (rpc, current, signals) => signals.some((signal) => signal.channel === "projects:changed")
        ? Promise.resolve(null)
        : patchTasks(rpc, current, signalTaskIds(signals, "tasks:changed"), (task) => !task.archivedAt && (projectId === null || task.projectId === projectId)),
    },
  );
  // Description text is a separate, lazily loaded body source; the light rows above stay the only row source.
  const [wantBodies, setWantBodies] = useState(false);
  const [body, setBody] = useState<BodyStatus>(BODY_PENDING);
  const bodyRun = useRef(0);
  const full = useTasksQuery<Task[]>(
    (rpc, publish) => {
      // Only the latest body fetch may report its outcome (a cleared box invalidates the in-flight one).
      const run = ++bodyRun.current;
      setBody(BODY_PENDING);
      return loadTaskDataset(rpc, projectId, publish, true).then(
        (tasks) => { if (run === bodyRun.current) setBody(BODY_DONE); return tasks; },
        (error: unknown) => { if (run === bodyRun.current) setBody({ status: "failed", message: errorMessage(error) }); throw error; },
      );
    },
    ["tasks:changed", "projects:changed"],
    [projectId],
    {
      enabled: wantBodies,
      applySignals: (rpc, current, signals) => signals.some((signal) => signal.channel === "projects:changed")
        ? Promise.resolve(null)
        : patchTasks(rpc, current, signalTaskIds(signals, "tasks:changed"), (task) => !task.archivedAt && (projectId === null || task.projectId === projectId), true),
    },
  );
  const bodies = useMemo(
    () => new Map(wantBodies ? full.data?.map((task) => [task.id, task.description.toLowerCase()] as const) : undefined),
    [wantBodies, full.data],
  );
  const searchable = useMemo(() => index.data?.map((task) => ({
    task,
    key: task.key.toLowerCase(),
    text: `${`${task.key} ${task.title}`.toLowerCase()} ${bodies.get(task.id) ?? ""}`,
  })), [index.data, bodies]);
  const taskKey = /^\d+$/.test(term) && prefix ? `${prefix}-${Number(term)}` : term;
  // A bare number is a task number in the project scope, known before listProjects supplies the prefix.
  const numberLookup = /^\d+$/.test(term) && projectId !== null;
  const exact = searchable?.find((entry) => entry.key === taskKey.toLowerCase() || (numberLookup && !prefix && entry.task.number === Number(term)))?.task;
  const keyShaped = /^[a-z][a-z0-9]{0,9}-\d+$/i.test(term) || numberLookup;
  const lightSettled = !!index.data && !index.isFetching;
  // A body read is scheduled for every term the light rows cannot answer; a key-shaped term waits until they can rule out an exact match.
  const fallbackDue = !!term && !wantBodies && !exact && (!keyShaped || lightSettled);
  useEffect(() => {
    if (!term) {
      bodyRun.current++;
      setBody(BODY_PENDING);
      if (wantBodies) evictFullTaskDataset(projectId); // the next lookup starts its own read instead of joining the abandoned one
      setWantBodies(false);
      return;
    }
    if (!fallbackDue) return;
    const timer = setTimeout(() => setWantBodies(true), BODY_FALLBACK_DELAY_MS);
    return () => clearTimeout(timer);
  }, [term, fallbackDue]);
  const bodiesPending = wantBodies && body.status === "pending";
  const bodiesError = wantBodies && body.status === "failed" ? body.message : null;
  const bodiesScheduled = bodiesPending || fallbackDue;
  const matches = useMemo(() => {
    if (!term) return [];
    if (exact) return [exact];
    const words = term.toLowerCase().split(/\s+/);
    return searchable?.filter((entry) => !entry.task.archivedAt && words.every((word) => entry.text.includes(word)))
      .map((entry) => entry.task) ?? [];
  }, [term, exact, searchable]);
  // Historical keys can point to a different canonical key after a project move.
  const alias = useTasksQuery<{ query: string; task: Task | null }>(
    async (rpc) => {
      if (!open || !index.data || exact || !/^[a-z][a-z0-9]{0,9}-\d+$/i.test(taskKey))
        return { query: taskKey, task: null };
      const { task } = await rpc.call("getTaskByKey", { taskKey });
      return { query: taskKey, task: task && (projectId === null || task.projectId === projectId) ? task : null };
    },
    [],
    [open, taskKey, exact?.id, index.data === undefined, projectId],
  );
  const aliasTask = alias.data?.query === taskKey ? alias.data.task : null;
  const found = aliasTask ? [aliasTask] : matches;
  const current = index.data ? { tasks: found.slice(0, 25), more: found.length > 25 } : undefined;
  const error = index.error ?? alias.error ?? bodiesError;
  const retry = () => { if (alias.error) alias.refresh(); if (index.error) index.refresh(); if (bodiesError) full.refresh(); };
  const updating = index.isFetching;

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
              {(!current || (current.tasks.length === 0 && (alias.isFetching || index.isFetching || bodiesScheduled))) && !error ? (
                <p role="status" className="p-3 text-sm text-muted-foreground">
                  Searching tasks…
                </p>
              ) : (!current || current.tasks.length === 0) && error ? (
                <div className="space-y-2 p-3 text-sm">
                  <p role="alert">{error}</p>
                  <Button variant="outline" size="sm" onClick={retry}>
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
                      <StatusIcon projectId={task.projectId} status={task.status} />
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
              {current && current.tasks.length > 0 && bodiesScheduled ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Searching descriptions…</p> : null}
              {current && updating ? <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Updating results…</p> : null}
              {current?.more ? <p className="p-3 text-xs text-muted-foreground">Showing the first 25 matches. Refine your search to find more.</p> : null}
              {current && current.tasks.length > 0 && error && !updating ? <p role="alert" className="p-3 text-xs text-destructive">{error}</p> : null}
            </CommandList>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </Command>
  );
}
