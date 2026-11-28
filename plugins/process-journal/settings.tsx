import { useCallback, useEffect, useState, type FormEvent } from "react";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import type { z } from "zod";
import { boardColors, boardDisplayResultSchema, boardDisplaySchema, boardDisplayWriteSchema, boardIcons,
  type BoardColumnDisplay } from "./board-display-contract";
import type { methods, rpcContract } from "./contract";
import { ScheduleSettings } from "./schedule-settings";
import { defaultColumns, defaultStatusName, StatusMark } from "./status-display";

const input = "min-w-0 rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring";
const button = `${input} shrink-0 hover:bg-muted disabled:opacity-50`;
const colorLabel: Record<BoardColumnDisplay["color"], string> = {
  default: "Default", slateblue: "Indigo", steelblue: "Blue", lightseagreen: "Teal", mediumseagreen: "Green",
  goldenrod: "Yellow", sandybrown: "Orange", indianred: "Red", palevioletred: "Pink", mediumpurple: "Purple",
  slategray: "Gray", black: "Monochrome",
};
const iconLabel: Record<BoardColumnDisplay["icon"], string> = {
  default: "Default", Circle: "Circle", Check: "Check", X: "Cross", Clock: "Clock", Search: "Search", Flag: "Flag",
  Pause: "Pause", Star: "Star",
};
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
    <label className="flex flex-wrap items-center gap-2 text-sm">
      Project
      <select className={input} value={project.id} onChange={event => setSelected(event.target.value)}>
        {projects.map(candidate => <option value={candidate.id} key={candidate.id}>{candidate.name}</option>)}
      </select>
    </label>
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
  function move(from: number, to: number) {
    setDraft(columns => {
      const next = [...columns];
      const [column] = next.splice(from, 1);
      if (column) next.splice(to, 0, column);
      return next;
    });
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
      <ol className="divide-y divide-border-hairline rounded-lg border border-border bg-card">
        {draft.map((column, index) => {
          const original = defaultStatusName(column.id);
          return <li className="flex flex-wrap items-end gap-x-3 gap-y-2 p-3" key={column.id}>
            <div className="flex items-center gap-1 self-center">
              <button type="button" className={button} aria-label={`Move ${original} up`} disabled={busy || index === 0}
                onClick={() => move(index, index - 1)}><Icon name="ArrowUp" className="size-3.5" /></button>
              <button type="button" className={button} aria-label={`Move ${original} down`} disabled={busy || index === draft.length - 1}
                onClick={() => move(index, index + 1)}><Icon name="ArrowDown" className="size-3.5" /></button>
              <StatusMark state={column.id} display={column} />
            </div>
            <label className="flex min-w-36 flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Name
              <input className={input} aria-label={`${original} name`} disabled={busy} value={column.name}
                onChange={event => edit(column.id, { name: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Icon
              <select className={input} aria-label={`${original} icon`} disabled={busy} value={column.icon}
                onChange={event => edit(column.id, { icon: event.target.value as BoardColumnDisplay["icon"] })}>
                {boardIcons.map(icon => <option key={icon} value={icon}>{iconLabel[icon]}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
              Color
              <select className={input} aria-label={`${original} color`} disabled={busy} value={column.color}
                onChange={event => edit(column.id, { color: event.target.value as BoardColumnDisplay["color"] })}>
                {boardColors.map(color => <option key={color} value={color}>{colorLabel[color]}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1.5 self-center text-xs text-muted-foreground">
              <input type="checkbox" aria-label={`Show ${original} on board`} disabled={busy} checked={column.visible}
                onChange={event => edit(column.id, { visible: event.target.checked })} />
              Show on board
            </label>
          </li>;
        })}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <button className={button} type="submit" disabled={busy || conflict}>Save</button>
        <button className={button} type="button" disabled={busy || conflict} onClick={() => void save(null)}>Restore defaults</button>
      </div>
    </form>}
  </section>;
}
