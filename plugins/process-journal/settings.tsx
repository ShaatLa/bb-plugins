import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { closestCenter, DndContext, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { z } from "zod";
import { boardColors, boardDisplayResultSchema, boardDisplaySchema, boardDisplayWriteSchema, boardIcons,
  type BoardColumnDisplay } from "./board-display-contract";
import type { methods, rpcContract } from "./contract";
import { JournalCheckbox, JournalSelect } from "./controls";
import { ScheduleSettings } from "./schedule-settings";
import { defaultColumns, defaultStatusName, StatusMark } from "./status-display";

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const input = `h-8 min-w-0 rounded-md border border-input bg-background px-2.5 text-sm ${focus} disabled:opacity-50`;
const button = `${input} shrink-0 hover:bg-state-hover`;
const rowGrid = "grid-cols-[2rem_1.25rem_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 px-3 @min-[40rem]:grid-cols-[2rem_1.25rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_5rem]";
const stayInList: Modifier = ({ transform, activeNodeRect, containerNodeRect }) => {
  const y = activeNodeRect && containerNodeRect
    ? Math.max(containerNodeRect.top - activeNodeRect.top, Math.min(transform.y, containerNodeRect.bottom - activeNodeRect.bottom))
    : transform.y;
  return { ...transform, x: 0, y };
};
const colorLabel: Record<BoardColumnDisplay["color"], string> = {
  default: "Default", slateblue: "Indigo", steelblue: "Blue", lightseagreen: "Teal", mediumseagreen: "Green",
  goldenrod: "Yellow", sandybrown: "Orange", indianred: "Red", palevioletred: "Pink", mediumpurple: "Purple",
  slategray: "Gray", black: "Monochrome",
};
const iconLabel: Record<BoardColumnDisplay["icon"], string> = {
  default: "Default", Circle: "Circle", Check: "Check", X: "Cross", Clock: "Clock", Search: "Search", Flag: "Flag",
  Pause: "Pause", Star: "Star",
};
const colors = boardColors.map(value => ({ value, label: colorLabel[value] }));
const icons = boardIcons.map(value => ({ value, label: iconLabel[value] }));
const message = (error: unknown) => error instanceof Error ? error.message : "The request failed";

export function JournalSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<z.output<typeof methods.projects.output>>();
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    rpc.call("projects", {}).then(value => { if (active) setProjects(value); },
      cause => { if (active) setError(message(cause)); });
    return () => { active = false; };
  }, [rpc]);
  if (error) return <p role="alert" className="text-sm text-destructive">{error}</p>;
  if (!projects) return <p className="text-sm text-muted-foreground">Loading projects…</p>;
  if (!projects.length) return <p className="text-sm text-muted-foreground">Enable Process Journal for a project to manage its settings.</p>;
  const project = projects.find(candidate => candidate.id === selected) ?? projects[0]!;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted-foreground">Project</span>
      <JournalSelect label="Project" value={project.id} options={projects.map(candidate => ({
        value: candidate.id, label: candidate.name,
      }))} onChange={setSelected} />
    </div>
    <div key={project.id} className="space-y-4">
      <StatusEditor projectId={project.id} />
      <ScheduleSettings projectId={project.id} managers={project.managers} />
    </div>
  </div>;
}

function StatusEditor({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [stored, setStored] = useState<z.output<typeof boardDisplaySchema>>();
  const [draft, setDraft] = useState<BoardColumnDisplay[]>(defaultColumns);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState(false);
  const [load, setLoad] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    setError("");
    rpc.call("config.get", { projectId, key: "boardDisplay" }).then(raw => {
      if (!active) return;
      const current = boardDisplaySchema.parse(raw);
      setStored(current);
      setDraft(current.columns ?? defaultColumns);
      setConflict(false);
    }).catch(cause => { if (active) setError(message(cause)); })
      .finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [rpc, projectId, load]);

  const edit = useCallback((id: BoardColumnDisplay["id"], patch: Partial<BoardColumnDisplay>) => {
    setDraft(columns => columns.map(column => column.id === id ? { ...column, ...patch } : column));
    setNotice("");
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  function move({ active, over }: DragEndEvent) {
    if (!over || active.id === over.id || busy) return;
    setDraft(columns => arrayMove(columns, columns.findIndex(column => column.id === active.id),
      columns.findIndex(column => column.id === over.id)));
    setNotice("");
  }
  async function save(columns: BoardColumnDisplay[] | null) {
    if (!stored || conflict || busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = boardDisplayWriteSchema.parse({ expectedRevision: stored.revision, columns });
      const saved = boardDisplayResultSchema.parse(await rpc.call("config.set", { projectId, key: "boardDisplay", value }));
      if (!saved.ok) {
        setConflict(true);
        setError("Another window changed these statuses. Reload to get the current settings.");
      } else {
        const current = { revision: saved.revision, columns: saved.columns };
        setStored(current);
        setDraft(current.columns ?? defaultColumns);
        setNotice(columns === null ? "Restored default statuses." : "Saved status display.");
      }
    } catch (cause) {
      setError(cause instanceof Error && "issues" in cause && Array.isArray(cause.issues)
        ? cause.issues.map(issue => issue.message).join(". ") : message(cause));
    } finally {
      setBusy(false);
    }
  }

  return <section aria-label="Statuses" className="space-y-3">
    <h2 className="text-sm font-semibold">Statuses</h2>
    {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
    {error && <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="alert" className="text-sm text-destructive">{error}</p>
      {(conflict || !stored) && <button type="button" className={button} disabled={busy} onClick={() => setLoad(value => value + 1)}>Reload</button>}
    </div>}
    {busy && !stored && <p className="text-sm text-muted-foreground">Loading statuses…</p>}
    {stored && <form className="space-y-3" onSubmit={(event: FormEvent) => { event.preventDefault(); void save(draft); }}>
      <div className="@container rounded-lg border border-border bg-card">
        <div aria-hidden="true" className={`${rowGrid} hidden border-b border-border-hairline bg-muted/25 py-2 text-xs font-medium text-muted-foreground @min-[40rem]:grid`}>
          <span className="col-start-3">Name</span><span>Icon</span><span>Color</span><span className="text-center">On board</span>
        </div>
        <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[stayInList]} onDragEnd={move}>
          <SortableContext items={draft} strategy={verticalListSortingStrategy}>
            <ol className="divide-y divide-border-hairline">
              {draft.map(column => <StatusRow key={column.id} column={column} busy={busy} edit={edit} />)}
            </ol>
          </SortableContext>
        </DndContext>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button className={button} type="submit" disabled={busy || conflict}>Save</button>
        <button className={button} type="button" disabled={busy || conflict} onClick={() => void save(null)}>Restore defaults</button>
      </div>
    </form>}
  </section>;
}


function StatusRow({ column, busy, edit }: {
  column: BoardColumnDisplay; busy: boolean; edit: (id: BoardColumnDisplay["id"], patch: Partial<BoardColumnDisplay>) => void;
}) {
  const original = defaultStatusName(column.id);
  const { attributes, listeners, isDragging, setActivatorNodeRef, setNodeRef, transform, transition } = useSortable({
    id: column.id, disabled: busy,
  });
  return <li ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform), transition }}
    className={`${rowGrid} relative grid gap-y-2 py-2 ${isDragging ? "z-20 rounded-md bg-background shadow-lift ring-1 ring-border" : ""}`}>
    <button type="button" ref={setActivatorNodeRef} {...attributes} {...listeners}
      aria-label={`Reorder ${original}`} disabled={busy}
      className={`grid size-8 touch-none cursor-grab place-items-center rounded-md text-muted-foreground hover:bg-state-hover active:cursor-grabbing disabled:opacity-50 ${focus}`}>
      <svg aria-hidden="true" viewBox="0 0 12 16" className="size-3.5 fill-current">
        <circle cx="4" cy="3" r="1" /><circle cx="8" cy="3" r="1" />
        <circle cx="4" cy="8" r="1" /><circle cx="8" cy="8" r="1" />
        <circle cx="4" cy="13" r="1" /><circle cx="8" cy="13" r="1" />
      </svg>
    </button>
    <span className="grid place-items-center"><StatusMark state={column.id} display={column} /></span>
    <input className={`${input} col-span-2 w-full @min-[40rem]:col-span-1`} aria-label={`${original} name`} disabled={busy} value={column.name}
      onChange={event => edit(column.id, { name: event.target.value })} />
    <div className="col-start-3 grid min-w-0 gap-1 @min-[40rem]:col-start-auto">
      <span className="text-xs text-muted-foreground @min-[40rem]:hidden">Icon</span>
      <JournalSelect label={`${original} icon`} disabled={busy} value={column.icon} options={icons}
        onChange={icon => edit(column.id, { icon })} />
    </div>
    <div className="grid min-w-0 gap-1">
      <span className="text-xs text-muted-foreground @min-[40rem]:hidden">Color</span>
      <JournalSelect label={`${original} color`} disabled={busy} value={column.color} options={colors}
        onChange={color => edit(column.id, { color })} />
    </div>
    <label className="col-span-2 col-start-3 flex min-h-8 w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground @min-[40rem]:col-span-1 @min-[40rem]:col-start-auto @min-[40rem]:justify-self-center"
      title="Show on board">
      <JournalCheckbox aria-label={`Show ${original} on board`} disabled={busy} checked={column.visible}
        onChange={event => edit(column.id, { visible: event.target.checked })} />
      <span className="@min-[40rem]:sr-only">Show on board</span>
    </label>
  </li>;
}
