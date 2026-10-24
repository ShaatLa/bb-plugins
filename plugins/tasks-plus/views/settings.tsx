import { TasksRefreshProvider } from "../shell/refresh.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useId, useLayoutEffect, useRef, useState } from "react";
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
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [didSave, setDidSave] = useState(false);
  const drag = useRef<{
    id: string;
    initial: TaskStatusDefinition[];
    current: TaskStatusDefinition[];
    pointerId: number | null;
  } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const dragInstructions = useId();
  const fieldset = useRef<HTMLFieldSetElement>(null);
  useLayoutEffect(() => {
    if (draggedId)
      fieldset.current
        ?.querySelector<HTMLButtonElement>(
          `[data-status-id="${draggedId}"] button`,
        )
        ?.focus({ preventScroll: true });
  }, [draggedId, statuses]);
  const save = async (next: TaskStatusDefinition[]) => {
    if (JSON.stringify(next) === JSON.stringify(saved)) return;
    setSaving(true);
    setError(null);
    try {
      const parsed = taskStatusesSchema.parse(next);
      const result = await rpc.call("updateProject", {
        projectId: project.id,
        statuses: parsed,
      });
      const updated = result.project.statuses ?? parsed;
      setStatuses(updated);
      setSaved(updated);
      setAdding(false);
      setName("");
      setDidSave(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const add = () => {
    if (!name.trim()) {
      setAdding(false);
      return;
    }
    let base = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "");
    if (!/^[a-z]/.test(base)) base = `status_${base}`;
    base = base.slice(0, 58).replace(/_$/g, "");
    let id = base;
    for (
      let suffix = 2;
      statuses.some((status) => status.id === id);
      suffix++
    ) {
      id = `${base}_${suffix}`;
    }
    const next = [...statuses];
    next.splice(
      next.findIndex((status) => status.id === "done"),
      0,
      {
        id,
        name: name.trim(),
      },
    );
    void save(next);
  };
  const startDrag = (id: string, pointerId: number | null) => {
    drag.current = { id, initial: statuses, current: statuses, pointerId };
    setDraggedId(id);
  };
  const moveDrag = (target: number) => {
    const current = drag.current;
    if (!current || target < 0 || target >= current.current.length) return;
    const next = [...current.current];
    const index = next.findIndex((status) => status.id === current.id);
    if (index === target) return;
    next.splice(target, 0, next.splice(index, 1)[0]!);
    current.current = next;
    setStatuses(next);
  };
  const finishDrag = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDraggedId(null);
    setStatuses(current.initial);
    if (commit) void save(current.current);
  };
  return (
    <div className="max-w-2xl space-y-2">
      <p className="text-xs text-muted-foreground">
        Changes save automatically. System statuses stay; statuses used by tasks
        cannot be deleted.
      </p>
      <p id={dragInstructions} className="sr-only">
        Drag to reorder. With the keyboard, press Space to pick up, use arrow
        keys, then Space or Enter to save. Escape cancels.
      </p>
      <p className="sr-only" role="status">
        {draggedId
          ? `${statuses.find((status) => status.id === draggedId)?.name}, position ${statuses.findIndex((status) => status.id === draggedId) + 1} of ${statuses.length}`
          : ""}
      </p>
      <fieldset
        ref={fieldset}
        onPointerMove={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          const rows = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>(
              "[data-status-id]",
            ),
          );
          let target = 0;
          let distance = Infinity;
          rows.forEach((row, rowIndex) => {
            const rect = row.getBoundingClientRect();
            const nextDistance = Math.abs(
              event.clientY - (rect.top + rect.height / 2),
            );
            if (nextDistance < distance) {
              distance = nextDistance;
              target = rowIndex;
            }
          });
          moveDrag(target);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId === event.pointerId) finishDrag(true);
        }}
        onPointerCancel={() => finishDrag(false)}
        onLostPointerCapture={() => finishDrag(false)}
        disabled={saving}
        className="w-80 min-w-0 max-w-full space-y-1.5"
      >
        {statuses.map((status, index) => (
          <div
            key={status.id}
            data-status-id={status.id}
            className={`flex items-center gap-1.5 rounded ${draggedId === status.id ? "bg-state-hover ring-1 ring-border" : ""}`}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 touch-none cursor-grab active:cursor-grabbing"
              aria-label={`Move ${status.name}`}
              aria-describedby={dragInstructions}
              aria-pressed={draggedId === status.id}
              disabled={adding}
              onPointerDown={(event) => {
                if (event.button !== 0 || drag.current) return;
                event.preventDefault();
                fieldset.current!.setPointerCapture(event.pointerId);
                startDrag(status.id, event.pointerId);
              }}
              onBlur={() => {
                if (drag.current?.pointerId === null) finishDrag(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  finishDrag(false);
                } else if (event.key === " " || event.key === "Enter") {
                  event.preventDefault();
                  if (drag.current) finishDrag(true);
                  else startDrag(status.id, null);
                } else if (
                  drag.current?.pointerId === null &&
                  (event.key === "ArrowUp" || event.key === "ArrowDown")
                ) {
                  event.preventDefault();
                  moveDrag(index + (event.key === "ArrowUp" ? -1 : 1));
                }
              }}
            >
              <svg aria-hidden="true" viewBox="0 0 12 16" className="size-3.5 fill-current text-muted-foreground">
                <circle cx="4" cy="3" r="1" />
                <circle cx="8" cy="3" r="1" />
                <circle cx="4" cy="8" r="1" />
                <circle cx="8" cy="8" r="1" />
                <circle cx="4" cy="13" r="1" />
                <circle cx="8" cy="13" r="1" />
              </svg>
            </Button>
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
              onBlur={() => {
                if (!drag.current) void save(statuses);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setStatuses(saved);
                  setError(null);
                }
              }}
            />
            {(TASK_STATUSES as readonly string[]).includes(status.id) ? (
              <span className="size-7 shrink-0" />
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Remove ${status.name}`}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() =>
                  void save(statuses.filter((entry) => entry.id !== status.id))
                }
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
        {adding ? (
          <div className="flex items-center gap-1.5">
            <Input
              autoFocus
              aria-label="New status name"
              placeholder="Status name"
              className="ml-[34px] h-7 min-w-0 flex-1 text-xs"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={add}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") {
                  setAdding(false);
                  setName("");
                  setError(null);
                }
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Cancel new status"
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                setAdding(false);
                setName("");
                setError(null);
              }}
            >
              <Icon name="Trash2" className="size-3.5" />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2.5"
            disabled={statuses.length >= 32}
            onClick={() => setAdding(true)}
          >
            <Icon name="Plus" className="size-3.5" />
            Add status
          </Button>
        )}
      </fieldset>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : saving || didSave ? (
        <p role="status" className="text-xs text-muted-foreground">
          {saving ? "Saving…" : "Statuses saved."}
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
