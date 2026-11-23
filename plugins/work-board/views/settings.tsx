import { GitSyncSettings } from "./git-sync-settings";
import { formatRelativeTime } from "./activity/time.js";
import { StorageSettings } from "./storage-settings";
import { AttentionSettings } from "./attention-settings";
import { ChecksSettings } from "./checks-settings";
import { TasksRefreshProvider } from "../shell/refresh.js";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { COLOR_PALETTE } from "../shared/colors.js";
import { StatusIcon, StatusColorDot } from "../components/status-icon.js";
import { useProjects, useTasksRpc } from "../shell/data.js";
import {
  DEFAULT_TASK_STATUSES,
  TASK_STATUSES,
  STATUS_ICONS,
  statusIconSchema,
  taskStatusesSchema,
  type TaskStatusDefinition,
} from "../shared/statuses.js";
import type { Project } from "../shared/contract.js";
import { errorMessage } from "../shared/errors.js";
import type { archiveSettingSchema, autoArchiveAfterDaysSchema, planningSchema, statusNotificationsSchema, staleIdleThresholdSchema } from "../shared/project-settings";
import type { z } from "zod";
import { NewProjectDialog } from "./manage/new-project-dialog.js";

/** `onBusy` reports a save in flight or a rejected draft, so the editor is not closed over a draft or an error. */
function ProjectStatuses({ project, onBusy }: { project: Project; onBusy: (busy: boolean) => void }) {
  const rpc = useTasksRpc();
  const [statuses, setStatuses] = useState<TaskStatusDefinition[]>(
    () => project.statuses ?? DEFAULT_TASK_STATUSES,
  );
  const [saved, setSaved] = useState(statuses);
  const [colorPicker, setColorPicker] = useState<string | null>(null);
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
  // A rejection with nothing left to correct (a refused removal) does not hold the editor open.
  const failedDraft = error !== null && (adding || JSON.stringify(statuses) !== JSON.stringify(saved));
  useEffect(() => {
    onBusy(saving || failedDraft);
    return () => onBusy(false);
  }, [saving, failedDraft]);
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
        System statuses stay; statuses used by tasks cannot be deleted.
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
            <Select
              value={status.icon ?? "default"}
              disabled={saving || adding || draggedId !== null}
              onValueChange={(value) => {
                const { icon: _icon, ...definition } = status;
                const updated = value === "default"
                  ? definition
                  : { ...definition, icon: statusIconSchema.parse(value) };
                void save(statuses.map((entry) => entry.id === status.id ? updated : entry));
              }}
            >
              <SelectTrigger aria-label={`Icon for ${status.name}`} className="h-7 w-12 shrink-0 px-1.5">
                <SelectValue>
                  <StatusIcon status={status.id} icon={status.icon} color={status.color} />
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  <span className="flex items-center gap-2"><StatusIcon status={status.id} color={status.color} />Default</span>
                </SelectItem>
                {STATUS_ICONS.map((icon) => (
                  <SelectItem key={icon.id} value={icon.id}>
                    <span className="flex items-center gap-2"><StatusIcon status={status.id} icon={icon.id} color={status.color} />{icon.name}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Popover open={colorPicker === status.id} onOpenChange={(open) => setColorPicker(open ? status.id : null)}>
              <PopoverTrigger asChild>
                <Button type="button" variant="outline" aria-label={`Color for ${status.name}`} className="h-7 w-12 shrink-0 gap-1 px-1.5" disabled={saving || adding || draggedId !== null}>
                  <StatusColorDot status={status.id} color={status.color} />
                  <Icon name="ChevronDown" className="size-3 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" className="w-auto p-2" mobileTitle={`Color for ${status.name}`}>
                <div className="grid grid-cols-5 gap-1">
                  {COLOR_PALETTE.filter((color) => color.value !== "lightseagreen").map((color) => (
                    <button
                      key={color.label}
                      type="button"
                      aria-label={color.label}
                      title={color.label}
                      aria-pressed={status.color === color.value}
                      className={cn("flex size-8 items-center justify-center rounded-md hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", status.color === color.value && "ring-1 ring-ring")}
                      onClick={() => {
                        const updated = { ...status, color: color.value };
                        setColorPicker(null);
                        void save(statuses.map((entry) => entry.id === status.id ? updated : entry));
                      }}
                    >
                      <StatusColorDot status={status.id} color={color.value} />
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
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
              className="ml-[142px] h-7 min-w-0 flex-1 text-xs"
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

type SectionProps = { project: Project; onSaved: () => void };
type ProjectChanges = {
  autoArchiveAfterDays?: z.infer<typeof autoArchiveAfterDaysSchema>;
  staleIdleMinutes?: z.infer<typeof staleIdleThresholdSchema>;
  statusNotifications?: z.infer<typeof statusNotificationsSchema>;
  archiveThreadsOnClose?: z.infer<typeof archiveSettingSchema>;
  archiveReviewerOnApproval?: z.infer<typeof archiveSettingSchema>;
  planning?: z.infer<typeof planningSchema>;
  statuses?: TaskStatusDefinition[];
};

/** Saves one project setting at a time and reports the failure beside the section's controls. */
function useProjectUpdate(project: Project, onSaved: () => void) {
  const rpc = useTasksRpc();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = async (changes: ProjectChanges) => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call("updateProject", { projectId: project.id, ...changes });
      onSaved();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, update };
}

function SelectRow<T extends string>({ label, value, options, disabled, onChange, hint }: {
  label: string; value: T; options: readonly (readonly [T, string])[]; disabled: boolean; onChange: (value: T) => void; hint: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <label className="flex flex-wrap items-center justify-between gap-2 text-sm">
        {label}
        <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
          <SelectTrigger aria-label={label} className="h-8 w-48"><SelectValue /></SelectTrigger>
          <SelectContent>
            {options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}
          </SelectContent>
        </Select>
      </label>
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function SwitchRow({ label, checked, disabled, onChange, hint }: {
  label: string; checked: boolean; disabled: boolean; onChange: (checked: boolean) => void; hint: ReactNode;
}) {
  const id = useId();
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <label htmlFor={id} className="cursor-pointer">{label}</label>
        <Switch id={id} aria-label={label} aria-describedby={`${id}-hint`} checked={checked} disabled={disabled} onCheckedChange={onChange} />
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

function StatusesSection({ project }: SectionProps) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const statuses: TaskStatusDefinition[] = project.statuses ?? DEFAULT_TASK_STATUSES;
  return (
    <section aria-label="Project task statuses" className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Statuses</h3>
        <Button size="sm" variant="outline" className="h-7 px-2.5" aria-expanded={editing} disabled={editing && busy}
          aria-label={editing ? "Done editing statuses" : "Edit statuses"} onClick={() => setEditing(!editing)}>
          {editing ? "Done" : "Edit"}
        </Button>
      </div>
      {editing ? <ProjectStatuses key={`${project.id}:${JSON.stringify(project.statuses)}`} project={project} onBusy={setBusy} /> : (
        <ol aria-label="Status order" className="flex flex-wrap items-center gap-x-1 gap-y-1.5 text-xs">
          {statuses.map((status, index) => (
            <li key={status.id} className="inline-flex items-center gap-1">
              {index ? <Icon name="ChevronRight" aria-hidden className="size-3 text-muted-foreground" /> : null}
              <span className="inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2">
                <StatusIcon status={status.id} projectId={project.id} icon={status.icon} color={status.color} />
                {status.name}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function PlanningSection({ project, onSaved }: SectionProps) {
  const { busy, error, update } = useProjectUpdate(project, onSaved);
  const statuses: TaskStatusDefinition[] = project.statuses ?? DEFAULT_TASK_STATUSES;
  const marked = statuses.filter((status) => status.requiresApprovedPlan === true && status.id !== "canceled");
  const unmarked = statuses.filter((status) => status.requiresApprovedPlan !== true);
  const setFlag = (id: string, on: boolean) => void update({ statuses: statuses.map((status) => (status.id === id ? { ...status, requiresApprovedPlan: on } : status)) });
  const planning = project.planning ?? "off";
  return (
    <section aria-label="Project planning" className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Planning</h3>
      <SelectRow label="Mode" value={planning} disabled={busy} onChange={(value) => void update({ planning: value })}
        options={[["off", "Off"], ["optional", "Optional"], ["required", "Required"]]}
        hint="Off hides plans for this project (existing plans are kept). Optional turns on plans and their review. Required keeps a card out of the statuses below until its plan is approved; epics are exempt." />
      <p className="text-xs text-muted-foreground">Only you change the planning mode and the statuses that need an approved plan; agents cannot.</p>
      {project.planningChangedAt ? (
        <p className="text-xs text-muted-foreground" data-testid="planning-changed">
          Changed <time dateTime={project.planningChangedAt} title={project.planningChangedAt}>{formatRelativeTime(project.planningChangedAt, Date.now())}</time>, was {project.planningPrevious ?? "off"}
        </p>
      ) : null}
      {planning === "required" ? (
        <div className="space-y-2" data-testid="plan-gated-statuses">
          <h4 className="text-sm font-medium">Statuses that need an approved plan</h4>
          <div className="flex flex-wrap items-center gap-1.5">
            {marked.map((status) => (
              <span key={status.id} className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border pl-2 pr-1 text-xs">
                <StatusIcon status={status.id} projectId={project.id} icon={status.icon} color={status.color} />
                {status.name}
                <Button type="button" variant="ghost" size="icon" className="size-5" disabled={busy} aria-label={`Remove ${status.name}`} onClick={() => setFlag(status.id, false)}>
                  <Icon name="X" className="size-3" />
                </Button>
              </span>
            ))}
            {unmarked.some((status) => status.id !== "canceled") ? (
              <Select value="" disabled={busy} onValueChange={(id) => setFlag(id, true)}>
                <SelectTrigger aria-label="Add status" className="h-7 w-auto gap-1 text-xs"><SelectValue placeholder="+ Add status" /></SelectTrigger>
                <SelectContent>
                  {unmarked.filter((status) => status.id !== "canceled").map((status) => (
                    <SelectItem key={status.id} value={status.id}>{status.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground" data-testid="plan-free-statuses">
            Without an approved plan a card stays in: {unmarked.map((status) => status.name).join(", ")}
          </p>
        </div>
      ) : null}
      {planning !== "off" ? (
        <SwitchRow label="Archive the plan reviewer after approval" checked={(project.archiveReviewerOnApproval ?? "on") === "on"} disabled={busy}
          onChange={(on) => void update({ archiveReviewerOnApproval: on ? "on" : "off" })}
          hint="A reviewer thread submitted with --dedicated-reviewer is archived after it approves a plan. A reused thread is never archived." />
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ArchivingSection({ project, onSaved }: SectionProps) {
  const { busy, error, update } = useProjectUpdate(project, onSaved);
  return (
    <section aria-label="Project archiving" className="space-y-4 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Archiving</h3>
      <SelectRow label="Archive completed tasks after" value={project.autoArchiveAfterDays ?? "off"} disabled={busy}
        onChange={(value) => void update({ autoArchiveAfterDays: value })}
        options={[["off", "Off"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"], ["30", "30 days"]]}
        hint="Checks hourly for this project. Task, comment, attachment or question activity restarts the interval. Unfinished children, unanswered questions and working agents prevent archival." />
      <SwitchRow label="Archive threads of closed cards" checked={(project.archiveThreadsOnClose ?? "on") === "on"} disabled={busy}
        onChange={(on) => void update({ archiveThreadsOnClose: on ? "on" : "off" })}
        hint="When a card goes to Done or Canceled, the sessions Work Board created for it are archived once they are idle. Sessions made outside Work Board, or linked to another open card, are kept." />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function ActivitySection({ project, onSaved }: SectionProps) {
  const { busy, error, update } = useProjectUpdate(project, onSaved);
  return (
    <section aria-label="Project activity and notifications" className="space-y-4 border-t border-border pt-4">
      <h3 className="text-sm font-medium">Activity and notifications</h3>
      <SelectRow label="Flag idle threads after" value={project.staleIdleMinutes ?? "45"} disabled={busy}
        onChange={(value) => void update({ staleIdleMinutes: value })}
        options={[["off", "Off"], ["30", "30 minutes"], ["45", "45 minutes"], ["60", "60 minutes"], ["120", "2 hours"]]}
        hint="Display an amber marker for idle attached threads in this project. No messages are sent to the thread." />
      <SelectRow label="Notify me of status changes" value={project.statusNotifications ?? "off"} disabled={busy}
        onChange={(value) => void update({ statusNotifications: value })}
        options={[["off", "Off"], ["all", "All status changes"], ["done", "Done only"]]}
        hint="Applies only to this project and uses the enabled channels in BB Push notifications. Status changes you make yourself in the board are not notified." />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <AttentionSettings projectId={project.id} />
    </section>
  );
}

/** The project sections in page order. Add a section by adding one entry; it receives the selected project. */
const PROJECT_SECTIONS: { id: string; Section: ComponentType<SectionProps> }[] = [
  { id: "statuses", Section: StatusesSection },
  { id: "planning", Section: PlanningSection },
  { id: "archiving", Section: ArchivingSection },
  { id: "activity", Section: ActivitySection },
  { id: "git", Section: ({ project }) => <GitSyncSettings projectId={project.id} /> },
  { id: "checks", Section: ({ project }) => <ChecksSettings projectId={project.id} /> },
];

function TasksSettingsContent() {
  const navigate = useBbNavigate();
  const projects = useProjects();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const project = projects.data?.find((entry) => entry.id === projectId) ?? projects.data?.[0];
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        {project ? <Select value={project.id} onValueChange={setProjectId}>
          <SelectTrigger aria-label="Settings project" className="h-8 w-56"><SelectValue /></SelectTrigger>
          <SelectContent>{projects.data?.map((entry) => (
            <SelectItem key={entry.id} value={entry.id}>{entry.name}</SelectItem>
          ))}</SelectContent>
        </Select> : null}
        <Button size="sm" variant="outline" className="h-8 px-2.5" onClick={() => setNewProjectOpen(true)}>
          <Icon name="Plus" className="size-3.5" />New project
        </Button>
        <Button size="sm" variant="outline" className="h-8 px-2.5"
          onClick={() => navigate.toPluginPanel("work-board", { subPath: "manage" })}>Manage labels and presets</Button>
      </div>
      {projects.error ? <div role="alert" className="text-xs text-destructive">
        {projects.error}<Button size="sm" variant="ghost" onClick={projects.refresh}>Retry</Button>
      </div> : null}
      {newProjectOpen ? <NewProjectDialog open onOpenChange={setNewProjectOpen}
        onCreated={(created) => { setProjectId(created.id); projects.refresh(); }} /> : null}
      {project ? PROJECT_SECTIONS.map(({ id, Section }) => (
        <Section key={`${id}:${project.id}`} project={project} onSaved={projects.refresh} />
      )) : !projects.error ? <p className="text-xs text-muted-foreground">
        {projects.data ? "Create a project to configure its workflow." : "Loading projects…"}
      </p> : null}
      <StorageSettings />
      <div className="flex flex-wrap gap-2 border-t border-border pt-4">
        <Button size="sm" className="h-7 px-2.5" variant="outline"
          onClick={() => navigate.toPluginPanel("work-board", project ? { subPath: project.id } : undefined)}>Open Work Board</Button>
      </div>
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
