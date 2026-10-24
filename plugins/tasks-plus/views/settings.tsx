import { TasksRefreshProvider } from "../shell/refresh.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { useProjects, useTasksRpc } from "../shell/data.js";
import {
  DEFAULT_TASK_STATUSES,
  TASK_STATUSES,
  taskStatusesSchema,
  type TaskStatusDefinition,
} from "../shared/statuses.js";
import type { Project } from "../shared/contract.js";
import { errorMessage } from "../shared/errors.js";

function ProjectStatuses({ project }: { project: Project }) {
  const rpc = useTasksRpc();
  const [statuses, setStatuses] = useState<TaskStatusDefinition[]>(
    () => project.statuses ?? DEFAULT_TASK_STATUSES,
  );
  const [saved, setSaved] = useState(statuses);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(statuses) !== JSON.stringify(saved);
  const changeOrder = (index: number, delta: number) =>
    setStatuses((current) => {
      const next = [...current];
      [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
      return next;
    });
  const add = () => {
    const statusId =
      id.trim() ||
      name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "");
    const next = [...statuses];
    next.splice(
      Math.max(
        0,
        next.findIndex((status) => status.id === "done"),
      ),
      0,
      { id: statusId, name: name.trim() },
    );
    const parsed = taskStatusesSchema.safeParse(next);
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setStatuses(parsed.data);
    setName("");
    setId("");
    setError(null);
  };
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const parsed = taskStatusesSchema.parse(statuses);
      const result = await rpc.call("updateProject", {
        projectId: project.id,
        statuses: parsed,
      });
      const next = result.project.statuses ?? parsed;
      setStatuses(next);
      setSaved(next);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-xs text-muted-foreground">
        Each project has its own workflow. New stages stay open; Done and
        Canceled keep their completion meaning. System IDs are fixed. A status
        used by tasks cannot be deleted.
      </p>
      <fieldset disabled={saving} className="space-y-1.5">
        {statuses.map((status, index) => (
          <div key={status.id} className="flex items-center gap-1.5">
            <Input
              aria-label={`Status name ${status.id}`}
              className="h-7 min-w-0 flex-1 text-xs"
              value={status.name}
              onChange={(event) =>
                setStatuses((current) =>
                  current.map((entry) =>
                    entry.id === status.id
                      ? { ...entry, name: event.target.value }
                      : entry,
                  ),
                )
              }
            />
            <span
              className="w-28 shrink-0 truncate font-mono text-xs text-muted-foreground"
              title={status.id}
            >
              {status.id}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Move ${status.name} up`}
              disabled={index === 0}
              onClick={() => changeOrder(index, -1)}
            >
              <Icon name="ChevronUp" className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Move ${status.name} down`}
              disabled={index === statuses.length - 1}
              onClick={() => changeOrder(index, 1)}
            >
              <Icon name="ChevronDown" className="size-3.5" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={`Remove ${status.name}`}
              disabled={(TASK_STATUSES as readonly string[]).includes(
                status.id,
              )}
              onClick={() =>
                setStatuses((current) =>
                  current.filter((entry) => entry.id !== status.id),
                )
              }
            >
              <Icon name="Trash2" className="size-3.5" />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5 pt-2">
          <Input
            aria-label="New status name"
            placeholder="In testing"
            className="h-7 min-w-32 flex-1 text-xs"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Input
            aria-label="New status ID"
            placeholder="in_testing (optional)"
            className="h-7 w-44 font-mono text-xs"
            value={id}
            onChange={(event) => setId(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2.5"
            disabled={!name.trim() || statuses.length >= 32}
            onClick={add}
          >
            Add status
          </Button>
        </div>
      </fieldset>
      <div className="flex items-center gap-2 pt-1">
        <Button
          type="button"
          size="sm"
          className="h-7 px-2.5"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save statuses"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2.5"
          disabled={!dirty || saving}
          onClick={() => {
            setStatuses(saved);
            setError(null);
          }}
        >
          Reset changes
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {!dirty && !error ? (
        <p role="status" className="text-xs text-muted-foreground">
          Statuses saved.
        </p>
      ) : null}
    </div>
  );
}

function TasksSettingsContent() {
  const navigate = useBbNavigate();
  const projects = useProjects();
  const [projectId, setProjectId] = useState("");
  const project =
    projects.data?.find((entry) => entry.id === projectId) ??
    projects.data?.[0];
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Send tasks to existing threads from the task card. Busy threads
          receive the task in their queue using their current settings.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="h-7 px-2.5"
            variant="outline"
            onClick={() => navigate.toPluginPanel("tasks")}
          >
            Open Tasks
          </Button>
          <Button
            size="sm"
            className="h-7 px-2.5"
            variant="outline"
            onClick={() =>
              navigate.toPluginPanel("tasks", { subPath: "manage" })
            }
          >
            Manage projects and presets
          </Button>
        </div>
      </div>
      <section
        aria-label="Project task statuses"
        className="space-y-3 border-t border-border pt-4"
      >
        <h3 className="text-sm font-medium">Task statuses</h3>
        {projects.error ? (
          <p role="alert" className="text-xs text-destructive">
            {projects.error}{" "}
            <Button size="sm" variant="ghost" onClick={projects.refresh}>
              Retry
            </Button>
          </p>
        ) : null}
        {project ? (
          <>
            <label className="flex items-center gap-2 text-xs">
              Project
              <Select value={project.id} onValueChange={setProjectId}>
                <SelectTrigger
                  aria-label="Statuses project"
                  className="h-7 w-56 text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {projects.data?.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
            <ProjectStatuses
              key={`${project.id}:${JSON.stringify(project.statuses)}`}
              project={project}
            />
          </>
        ) : !projects.error ? (
          <p className="text-xs text-muted-foreground">
            {projects.data
              ? "Create a project to configure its workflow."
              : "Loading projects…"}
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function TasksSettings() {
  return (
    <TasksRefreshProvider>
      <TasksSettingsContent />
    </TasksRefreshProvider>
  );
}
