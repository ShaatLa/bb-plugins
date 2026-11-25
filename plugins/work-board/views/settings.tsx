import { GitSyncSettings } from "./git-sync-settings";
import { formatRelativeTime } from "./activity/time.js";
import { GeneralSettings } from "./general-settings";
import { SelectRow, SettingsCard, SwitchRow, useSaveStatus } from "./settings-card";
import { SETTINGS_MARKER, useHideNativeSettings } from "./native-settings";
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
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { COLOR_PALETTE } from "../shared/colors.js";
import { StatusIcon, StatusColorDot } from "../components/status-icon.js";
import { useProjects, useTasksRpc } from "../shell/data.js";
import {
  DEFAULT_TASK_STATUSES,
  STALE_STATUSES,
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

type Addition = { key: number; name: string };
/** A status id from its name, unique among `taken`; ids are never derived any other way. */
function statusId(name: string, taken: readonly string[]) {
  let base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (!/^[a-z]/.test(base)) base = `status_${base}`;
  base = base.slice(0, 58).replace(/_$/g, "");
  let id = base;
  for (let suffix = 2; taken.includes(id); suffix++) id = `${base}_${suffix}`;
  return id;
}
/** Renames and additions replayed by status id onto the latest stored statuses, so a flag changed meanwhile is kept. */
function withDrafts(latest: TaskStatusDefinition[], renames: Record<string, string>, additions: Addition[]) {
  const next = latest.map((status) => (renames[status.id] === undefined ? status : { ...status, name: renames[status.id]! }));
  const added: TaskStatusDefinition[] = [];
  for (const { name } of additions) {
    if (!name.trim()) continue;
    added.push({ id: statusId(name, [...next, ...added].map((status) => status.id)), name: name.trim() });
  }
  const done = next.findIndex((status) => status.id === "done");
  next.splice(done < 0 ? next.length : done, 0, ...added);
  return next;
}

type TasksRpc = ReturnType<typeof useTasksRpc>;
/**
 * Writes `change` applied to the stored statuses it was built on. The server refuses it when they changed meanwhile
 * (a planning flag, another editor), so the change is applied once more to the reread list and nothing is undone.
 */
async function writeStatuses(rpc: TasksRpc, projectId: string, base: TaskStatusDefinition[], change: (latest: TaskStatusDefinition[]) => TaskStatusDefinition[]) {
  const send = (from: TaskStatusDefinition[]) => rpc.call("updateProject", { projectId, baseStatuses: from, statuses: taskStatusesSchema.parse(change(from)) });
  try {
    return await send(base);
  } catch (error) {
    if (!errorMessage(error).includes(STALE_STATUSES)) throw error;
    const { projects } = await rpc.call("listProjects", {});
    return send(projects.find((entry) => entry.id === projectId)?.statuses ?? DEFAULT_TASK_STATUSES);
  }
}

/**
 * Names and new statuses are drafts until Save; icon, color, order and removal are written at once, each on the latest
 * stored statuses, so the drafts survive them. `onBusy` reports a save in flight or unsaved drafts, so the editor is not
 * closed over them.
 */
function ProjectStatuses({ project, onBusy }: { project: Project; onBusy: (busy: boolean) => void }) {
  const rpc = useTasksRpc();
  const stored = project.statuses ?? DEFAULT_TASK_STATUSES;
  const [persisted, setPersisted] = useState<TaskStatusDefinition[]>(stored);
  useEffect(() => setPersisted(stored), [JSON.stringify(stored)]);
  const [renames, setRenames] = useState<Record<string, string>>({});
  const [additions, setAdditions] = useState<Addition[]>([]);
  const nextKey = useRef(0);
  const [dragOrder, setDragOrder] = useState<TaskStatusDefinition[] | null>(null);
  const [colorPicker, setColorPicker] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [didSave, setDidSave] = useState(false);
  const named = withDrafts(persisted, renames, []);
  const statuses = dragOrder ?? named;
  const dirty = persisted.some((status) => renames[status.id] !== undefined && renames[status.id] !== status.name) || additions.length > 0;
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
  useEffect(() => {
    onBusy(saving || dirty);
    return () => onBusy(false);
  }, [saving, dirty]);
  /** Writes `change(latest stored statuses)`; resolves whether it was stored. */
  const write = async (change: (latest: TaskStatusDefinition[]) => TaskStatusDefinition[]) => {
    const next = change(persisted);
    if (JSON.stringify(next) === JSON.stringify(persisted)) return true;
    setSaving(true);
    setError(null);
    try {
      const result = await writeStatuses(rpc, project.id, persisted, change);
      setPersisted(result.project.statuses ?? DEFAULT_TASK_STATUSES);
      setDidSave(true);
      return true;
    } catch (error) {
      setError(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  };
  const replace = (id: string, change: (status: TaskStatusDefinition) => TaskStatusDefinition) =>
    void write((latest) => latest.map((entry) => (entry.id === id ? change(entry) : entry)));
  const save = async () => {
    const drafts = { renames, additions };
    if (await write((latest) => withDrafts(latest, drafts.renames, drafts.additions))) {
      setRenames({});
      setAdditions([]);
    }
  };
  const discard = () => {
    setRenames({});
    setAdditions([]);
    setError(null);
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
    setDragOrder(next);
  };
  const finishDrag = (commit: boolean) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    setDraggedId(null);
    setDragOrder(null);
    const order = current.current.map((status) => status.id);
    const rank = (status: TaskStatusDefinition) => (order.includes(status.id) ? order.indexOf(status.id) : order.length);
    if (commit) void write((latest) => [...latest].sort((a, b) => rank(a) - rank(b)));
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
              disabled={saving || draggedId !== null}
              onValueChange={(value) => replace(status.id, ({ icon: _icon, ...definition }) =>
                value === "default" ? definition : { ...definition, icon: statusIconSchema.parse(value) })}
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
                <Button type="button" variant="outline" aria-label={`Color for ${status.name}`} className="h-7 w-12 shrink-0 gap-1 px-1.5" disabled={saving || draggedId !== null}>
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
                        setColorPicker(null);
                        replace(status.id, (entry) => ({ ...entry, color: color.value }));
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
              onChange={(event) => setRenames((current) => ({ ...current, [status.id]: event.target.value }))}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") void save();
                if (event.key === "Escape") {
                  setRenames(({ [status.id]: _dropped, ...rest }) => rest);
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
                onClick={() => void write((latest) => latest.filter((entry) => entry.id !== status.id))}
              >
                <Icon name="Trash2" className="size-3.5" />
              </Button>
            )}
          </div>
        ))}
        {additions.map((addition) => (
          <div key={addition.key} className="flex items-center gap-1.5">
            <Input
              autoFocus
              aria-label="New status name"
              placeholder="Status name"
              className="ml-[142px] h-7 min-w-0 flex-1 text-xs"
              value={addition.name}
              onChange={(event) => setAdditions((current) => current.map((entry) => (entry.key === addition.key ? { ...entry, name: event.target.value } : entry)))}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Enter") void save();
                if (event.key === "Escape") setAdditions((current) => current.filter((entry) => entry.key !== addition.key));
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Cancel new status"
              onClick={() => setAdditions((current) => current.filter((entry) => entry.key !== addition.key))}
            >
              <Icon name="Trash2" className="size-3.5" />
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1.5 px-2.5"
          disabled={statuses.length + additions.length >= 32}
          onClick={() => setAdditions((current) => [...current, { key: nextKey.current++, name: "" }])}
        >
          <Icon name="Plus" className="size-3.5" />
          Add status
        </Button>
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" className="h-7 px-2.5" disabled={saving || !dirty} onClick={() => void save()}>Save</Button>
        {dirty ? <Button size="sm" variant="ghost" className="h-7 px-2.5" disabled={saving} onClick={discard}>Discard</Button> : null}
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved names</span> : null}
      </div>
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
  checkReceipt?: Project["checkReceipt"];
  checkReadiness?: z.infer<typeof archiveSettingSchema>;
  doneRequiresReview?: z.infer<typeof archiveSettingSchema>;
  archiveReviewerOnApproval?: z.infer<typeof archiveSettingSchema>;
  planning?: z.infer<typeof planningSchema>;
};

/** Saves one project setting at a time; the card's save status shows the write and offers Retry when it fails. */
function useProjectUpdate(project: Project, onSaved: () => void) {
  const rpc = useTasksRpc();
  const { status, busy, track } = useSaveStatus();
  // `key` names the setting, so a failure stays until that setting saves, whatever the others do.
  const run = (key: string, action: () => Promise<unknown>) => track(async () => { await action(); onSaved(); }, undefined, key);
  const update = (changes: ProjectChanges) => run(Object.keys(changes).join(), () => rpc.call("updateProject", { projectId: project.id, ...changes }));
  return { busy, status, update, run, rpc };
}
type ProjectUpdate = ReturnType<typeof useProjectUpdate>;

function StatusesBlock({ project }: { project: Project }) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const heading = useId();
  const statuses: TaskStatusDefinition[] = project.statuses ?? DEFAULT_TASK_STATUSES;
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 id={heading} className="text-sm font-medium">Statuses</h4>
        <Button size="sm" variant="outline" className="h-7 px-2.5" aria-expanded={editing} disabled={editing && busy}
          aria-label={editing ? "Done editing statuses" : "Edit statuses"} onClick={() => setEditing(!editing)}>
          {editing ? "Done" : "Edit"}
        </Button>
      </div>
      {editing ? <ProjectStatuses project={project} onBusy={setBusy} /> : (
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

function ReceiptBlock({ project, updater }: { project: Project; updater: ProjectUpdate }) {
  const saved = project.checkReceipt;
  const [enabled, setEnabled] = useState(Boolean(saved));
  const [validatorId, setValidator] = useState(saved?.validatorId ?? "");
  const [hint, setHint] = useState(saved?.hint ?? "");
  const [timeout, setTimeoutSeconds] = useState(String(saved?.timeoutSeconds ?? 60));
  const [pattern, setPattern] = useState(saved?.linkPathPattern ?? "");
  const [wrappers, setWrappers] = useState(saved?.linkWrappers?.join("\n") ?? "");
  return <div className="space-y-2">
    <SwitchRow label="Check receipt" checked={enabled} disabled={updater.busy}
      onChange={async on => {
        if (!on && saved && !(await updater.update({ checkReceipt: null }))) return;
        setEnabled(on);
      }}
      hint="When on, an agent's check or reopen needs a receipt that this command accepts. Work Board runs the command on this machine without a shell. Your own actions are never blocked." />
    {enabled && <fieldset disabled={updater.busy} className="grid gap-2 text-sm">
      <p className="text-xs text-muted-foreground">Register the program and its working directory in <code>~/.bb/work-board-receipt-validators.json</code> on the primary host. Work Board reads this file on each validation. Keep it and its dependencies outside agent-edited files. The validator may inspect the caller worktree as data only.</p>
      <label>Registered validator ID<Input value={validatorId} onChange={e => setValidator(e.target.value)} /></label>
      <label>Receipt timeout (seconds)<Input type="number" min={5} max={300} value={timeout} onChange={e => setTimeoutSeconds(e.target.value)} /></label>
      <label>Receipt production hint<Input value={hint} onChange={e => setHint(e.target.value)} /></label>
      <label>Link path pattern<Input value={pattern} onChange={e => setPattern(e.target.value)} /></label>
      <label>Link wrappers (one per line)<textarea className="block w-full rounded border" value={wrappers} onChange={e => setWrappers(e.target.value)} /></label>
      <Button size="sm" disabled={!validatorId || !hint} onClick={() => void updater.update({ checkReceipt: {
        validatorId, hint, timeoutSeconds: Number(timeout), ...(pattern ? { linkPathPattern: pattern } : {}),
        ...(wrappers.trim() ? { linkWrappers: wrappers.trim().split(/\r?\n/).map(line => line.trim()) } : {}),
      } })}>Save check receipt</Button>
    </fieldset>}
  </div>;
}

function PlanningBlock({ project, updater }: { project: Project; updater: ProjectUpdate }) {
  const { busy, update, run, rpc } = updater;
  const heading = useId();
  const statuses: TaskStatusDefinition[] = project.statuses ?? DEFAULT_TASK_STATUSES;
  const marked = statuses.filter((status) => status.requiresApprovedPlan === true && status.id !== "canceled");
  const unmarked = statuses.filter((status) => status.requiresApprovedPlan !== true);
  const setFlag = (id: string, on: boolean) => void run(`plan:${id}`, () => writeStatuses(rpc, project.id, statuses,
    (latest) => latest.map((status) => (status.id === id ? { ...status, requiresApprovedPlan: on } : status))));
  const planning = project.planning ?? "off";
  return (
    <section aria-labelledby={heading} className="space-y-3 border-t border-border pt-4">
      <h4 id={heading} className="text-sm font-medium">Planning</h4>
      <SelectRow label="Mode" value={planning} disabled={busy} onChange={(value) => void update({ planning: value })}
        options={[["off", "Off"], ["optional", "Optional"], ["required", "Required"]]}
        hint="Off hides plans for this project (existing plans are kept). Optional turns on plans and their review. Required keeps a task out of the statuses below until its plan is approved; epics are exempt." />
      <p className="text-xs text-muted-foreground">Only you change the planning mode and the statuses that need an approved plan; agents cannot.</p>
      {project.planningChangedAt ? (
        <p className="text-xs text-muted-foreground" data-testid="planning-changed">
          Changed <time dateTime={project.planningChangedAt} title={project.planningChangedAt}>{formatRelativeTime(project.planningChangedAt, Date.now())}</time>, was {project.planningPrevious ?? "off"}
        </p>
      ) : null}
      {planning === "required" ? (
        <div className="space-y-2" data-testid="plan-gated-statuses">
          <h5 className="text-sm font-medium">Statuses that need an approved plan</h5>
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
            Without an approved plan a task stays in: {unmarked.map((status) => status.name).join(", ")}
          </p>
        </div>
      ) : null}
      <SwitchRow label="Check readiness" checked={project.checkReadiness === "on"} disabled={busy}
        onChange={(on) => void update({ checkReadiness: on ? "on" : "off" })}
        hint="Before an agent asks you to check something, it records a quick smoke test of what it sends and lists anything built beyond the approved plan and design." />
      <ReceiptBlock key={project.id + JSON.stringify(project.checkReceipt)} project={project} updater={updater} />
      <SwitchRow label="Done after review" checked={project.doneRequiresReview === "on"} disabled={busy}
        onChange={(on) => void update({ doneRequiresReview: on ? "on" : "off" })}
        hint="An agent can move a card to Done only after it passed In Review or In Testing since it last entered In Progress, or after an approving review is recorded. Your own moves are never blocked." />
      {planning !== "off" ? (
        <SwitchRow label="Archive the plan reviewer after approval" checked={(project.archiveReviewerOnApproval ?? "on") === "on"} disabled={busy}
          onChange={(on) => void update({ archiveReviewerOnApproval: on ? "on" : "off" })}
          hint="A reviewer thread submitted with --dedicated-reviewer is archived after it approves a plan. A reused thread is never archived." />
      ) : null}
    </section>
  );
}

function ArchivingSection({ project, onSaved }: SectionProps) {
  const { busy, status, update } = useProjectUpdate(project, onSaved);
  return (
    <SettingsCard title="Archiving" description="When completed tasks and the threads of closed tasks are archived." save={status}>
      <SelectRow label="Archive completed tasks after" value={project.autoArchiveAfterDays ?? "off"} disabled={busy}
        onChange={(value) => void update({ autoArchiveAfterDays: value })}
        options={[["off", "Off"], ["3", "3 days"], ["7", "7 days"], ["14", "14 days"], ["30", "30 days"]]}
        hint="Checks hourly for this project. Task, comment, attachment or question activity restarts the interval. Unfinished children, unanswered questions and working agents prevent archival." />
      <SwitchRow label="Archive threads of closed tasks" checked={(project.archiveThreadsOnClose ?? "on") === "on"} disabled={busy}
        onChange={(on) => void update({ archiveThreadsOnClose: on ? "on" : "off" })}
        hint="When a task goes to Done or Canceled, the sessions Work Board created for it are archived once they are idle. Sessions made outside Work Board, or linked to another open task, are kept." />
    </SettingsCard>
  );
}

function ActivitySection({ project, onSaved }: SectionProps) {
  const { busy, status, update } = useProjectUpdate(project, onSaved);
  return (
    <SettingsCard title="Activity and notifications" description="Idle-thread markers and your notifications for this project." save={status}>
      <SelectRow label="Flag idle threads after" value={project.staleIdleMinutes ?? "45"} disabled={busy}
        onChange={(value) => void update({ staleIdleMinutes: value })}
        options={[["off", "Off"], ["30", "30 minutes"], ["45", "45 minutes"], ["60", "60 minutes"], ["120", "2 hours"]]}
        hint="Display an amber marker for idle attached threads in this project. No messages are sent to the thread." />
      <SelectRow label="Notify me of status changes" value={project.statusNotifications ?? "off"} disabled={busy}
        onChange={(value) => void update({ statusNotifications: value })}
        options={[["off", "Off"], ["all", "All status changes"], ["done", "Done only"]]}
        hint="Applies only to this project and uses the enabled channels in BB Push notifications. Status changes you make yourself in the board are not notified." />
    </SettingsCard>
  );
}

function WorkflowSection({ project, onSaved }: SectionProps) {
  const updater = useProjectUpdate(project, onSaved);
  return (
    <SettingsCard title="Workflow" description="The statuses of this project's tasks and whether they need an approved plan." save={updater.status}>
      <StatusesBlock project={project} />
      <PlanningBlock project={project} updater={updater} />
    </SettingsCard>
  );
}

/** The project sections in page order. Add a section by adding one entry; it receives the selected project. */
const PROJECT_SECTIONS: { id: string; Section: ComponentType<SectionProps> }[] = [
  { id: "workflow", Section: WorkflowSection },
  { id: "archiving", Section: ArchivingSection },
  { id: "activity", Section: ActivitySection },
  { id: "manager", Section: ({ project }) => <AttentionSettings projectId={project.id} /> },
  { id: "git", Section: ({ project }) => <GitSyncSettings projectId={project.id} /> },
  { id: "checks", Section: ({ project }) => <ChecksSettings projectId={project.id} /> },
];

function TasksSettingsContent() {
  const navigate = useBbNavigate();
  const projects = useProjects();
  const root = useRef<HTMLDivElement>(null);
  useHideNativeSettings(root);
  const general = useId();
  const projectHeading = useId();
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const project = projects.data?.find((entry) => entry.id === projectId) ?? projects.data?.[0];
  return (
    <div ref={root} {...{ [SETTINGS_MARKER]: "" }} className="space-y-8">
      <section aria-labelledby={general} className="space-y-3">
        <h2 id={general} className="text-base font-semibold">General</h2>
        <GeneralSettings />
      </section>
      <section aria-labelledby={projectHeading} className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id={projectHeading} className="mr-1 text-base font-semibold">Project</h2>
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
        {project ? (
          <div data-testid="project-settings" className="space-y-4 rounded-xl border-l-2 border-primary/40 bg-muted/30 p-3">
            {/* shortcut: a section remounts on a project switch, so a save that fails after the switch loses its draft and
                Retry; local RPCs settle in milliseconds. Keep the section mounted if saves ever become slow. */}
            {PROJECT_SECTIONS.map(({ id, Section }) => (
              <Section key={`${id}:${project.id}`} project={project} onSaved={projects.refresh} />
            ))}
          </div>
        ) : !projects.error ? <p className="text-xs text-muted-foreground">
          {projects.data ? "Create a project to configure its workflow." : "Loading projects…"}
        </p> : null}
      </section>
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
