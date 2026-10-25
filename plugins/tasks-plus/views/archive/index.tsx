import { useState } from "react";
import { useProjects, useTasksQuery, useTasksRpc } from "../../shell/data";
import { useTasksNavigation } from "../../shell/routes";
import { useTaskStatuses } from "../../shell/task-statuses";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import type { TaskDateFilters } from "../../shared/task-dates";
import { errorMessage } from "../../shared/errors";

export function ArchiveView() {
  const rpc = useTasksRpc();
  const projects = useProjects();
  const navigation = useTasksNavigation();
  const [projectId, setProjectId] = useState("all");
  const [search, setSearch] = useState("");
  const [dateField, setDateField] =
    useState<NonNullable<TaskDateFilters["dateField"]>>("archived");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [limit, setLimit] = useState("100");
  const [page, setPage] = useState<{
    query: string;
    cursors: (string | undefined)[];
  }>({ query: "", cursors: [undefined] });
  const query = JSON.stringify([
    projectId,
    search,
    dateField,
    dateFrom,
    dateTo,
    limit,
  ]);
  const cursors = page.query === query ? page.cursors : [undefined];
  const cursor = cursors.at(-1);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { label } = useTaskStatuses(projectId === "all" ? null : projectId);
  const tasks = useTasksQuery(
    (rpc) =>
      rpc.call("listTasks", {
        archive: "archived",
        ...(projectId === "all" ? {} : { projectId }),
        search,
        dateField,
        ...(dateFrom ? { dateFrom } : {}),
        ...(dateTo ? { dateTo } : {}),
        sort: "newest",
        limit: Number(limit),
        ...(cursor ? { cursor } : {}),
      }),
    ["tasks:changed"],
    [projectId, search, dateField, dateFrom, dateTo, limit, cursor],
  );
  const mutate = async (taskId?: string) => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      if (taskId) {
        const result = await rpc.call("archiveTask", {
          taskId,
          archived: false,
          authorName: "You",
        });
        if (!result.ok) throw new Error(result.error.message);
        setMessage(`${result.task.key} restored.`);
      } else {
        const result = await rpc.call("archiveCompleted", {
          projectId,
          authorName: "You",
        });
        setMessage(`Archived ${result.archivedCount} tasks.`);
      }
      setPage({ query, cursors: [undefined] });
      tasks.refresh();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger
            className="h-7 w-48 text-xs"
            aria-label="Archive project"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.data?.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={busy || projectId === "all"}
          onClick={() => void mutate()}
        >
          Archive completed
        </Button>
        <Input
          aria-label="Search archived tasks"
          placeholder="Search archived tasks"
          className="ml-auto h-7 w-64 max-w-full text-xs"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3 border-b border-border px-3 py-2 text-xs">
        <label className="space-y-1">
          Date
          <Select
            value={dateField}
            onValueChange={(value) => setDateField(value as typeof dateField)}
          >
            <SelectTrigger
              aria-label="Archive date field"
              className="h-7 w-28 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="archived">Archived</SelectItem>
              <SelectItem value="created">Created</SelectItem>
              <SelectItem value="updated">Updated</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="space-y-1">
          From (UTC)
          <Input
            aria-label="Archive from date"
            type="date"
            className="h-7 w-36 text-xs"
            value={dateFrom}
            max={dateTo || undefined}
            onChange={(event) => setDateFrom(event.target.value)}
          />
        </label>
        <label className="space-y-1">
          To (UTC)
          <Input
            aria-label="Archive to date"
            type="date"
            className="h-7 w-36 text-xs"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => setDateTo(event.target.value)}
          />
        </label>
        <label className="space-y-1">
          Latest
          <Select value={limit} onValueChange={setLimit}>
            <SelectTrigger
              aria-label="Archive latest count"
              className="h-7 w-20 text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["25", "50", "100", "500"].map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <Button
          size="sm"
          variant="ghost"
          className="h-7"
          onClick={() => {
            setSearch("");
            setDateFrom("");
            setDateTo("");
            setPage({ query, cursors: [undefined] });
          }}
        >
          Clear filters
        </Button>
      </div>
      {error || tasks.error ? (
        <p role="alert" className="p-3 text-sm text-destructive">
          {error ?? tasks.error}
        </p>
      ) : null}
      {message ? (
        <p role="status" className="px-3 pt-3 text-xs text-muted-foreground">
          {message}
        </p>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!tasks.data ? (
          <p>Loading archive…</p>
        ) : !tasks.data.tasks.length ? (
          <p className="text-sm text-muted-foreground">No archived tasks.</p>
        ) : (
          tasks.data.tasks.map((task) => (
            <div
              key={task.id}
              className="flex items-center gap-3 border-b border-border py-2 text-sm"
            >
              <button
                className="min-w-0 flex-1 text-left hover:underline"
                onClick={() =>
                  navigation.go({ kind: "task", taskKey: task.key })
                }
              >
                <span className="mr-2 text-xs text-muted-foreground">
                  {task.key}
                </span>
                {task.title}
              </button>
              <span className="text-xs text-muted-foreground">
                {label(task.status)}
              </span>
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {(dateField === "archived"
                  ? task.archivedAt
                  : dateField === "created"
                    ? task.createdAt
                    : task.updatedAt
                )?.slice(0, 10)}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={busy}
                aria-label={`Restore ${task.key}`}
                onClick={() => void mutate(task.id)}
              >
                Restore
              </Button>
            </div>
          ))
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-border p-3">
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={cursors.length === 1}
          onClick={() => setPage({ query, cursors: cursors.slice(0, -1) })}
        >
          Previous
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7"
          disabled={!tasks.data?.nextCursor || Boolean(tasks.error)}
          onClick={() => {
            if (tasks.data?.nextCursor)
              setPage({ query, cursors: [...cursors, tasks.data.nextCursor] });
          }}
        >
          Next
        </Button>
        <span className="text-xs text-muted-foreground">
          {tasks.data?.tasks.length ?? 0} tasks · newest first
        </span>
        {tasks.error && cursor ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            onClick={() => setPage({ query, cursors: [undefined] })}
          >
            Restart results
          </Button>
        ) : null}
      </div>
    </section>
  );
}
