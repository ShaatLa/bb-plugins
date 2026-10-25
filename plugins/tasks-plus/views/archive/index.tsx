import { useState } from "react";
import {
  useProjects,
  useTasksQuery,
  useTasksRpc,
  listAllTasks,
} from "../../shell/data";
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
import { errorMessage } from "../../shared/errors";

export function ArchiveView() {
  const rpc = useTasksRpc();
  const projects = useProjects();
  const navigation = useTasksNavigation();
  const [projectId, setProjectId] = useState("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { label } = useTaskStatuses(projectId === "all" ? null : projectId);
  const tasks = useTasksQuery(
    (rpc) =>
      listAllTasks(rpc, {
        archive: "archived",
        ...(projectId === "all" ? {} : { projectId }),
        search,
      }),
    ["tasks:changed"],
    [projectId, search],
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
        ) : !tasks.data.length ? (
          <p className="text-sm text-muted-foreground">No archived tasks.</p>
        ) : (
          tasks.data.map((task) => (
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
                {task.archivedAt?.slice(0, 10)}
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
    </section>
  );
}
