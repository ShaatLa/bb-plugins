import { useEffect, useState } from "react";
import { defaultWorkflow } from "./ci-insights";

/** One Workflow/Event choice per repository, shared by both history charts and CI run timings. Undefined = the default; "all" = pooled. */
export type CiChoice = { workflow?: number | "all"; event?: string };
export type FilterWorkflow = { id: number; name: string; total: number; successMs: number; events?: { event: string; total: number }[] };
const KEY = "ci-dashboard:ci-filter";
const LEGACY_KEY = "ci-dashboard:history-charts";
// Storage may be unavailable: memory keeps the choice for this window.
let memory: Record<string, CiChoice> = {};

function readAll(): Record<string, CiChoice> {
  try {
    const saved: unknown = JSON.parse(globalThis.localStorage.getItem(KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).map(([repository, entry]) => {
      const { workflow, event } = (entry ?? {}) as CiChoice;
      return [repository, { ...(workflow === "all" || Number.isInteger(workflow) ? { workflow } : {}), ...(typeof event === "string" ? { event } : {}) }];
    }));
  } catch { return memory; }
}
function writeChoice(repository: string, choice: CiChoice) {
  memory = { ...readAll(), [repository]: choice };
  try { globalThis.localStorage.setItem(KEY, JSON.stringify(memory)); } catch { /* the choice just will not persist */ }
}

/** The workflow, its events (only when it has several) and the event that every picker shows and every chart filters by. */
export function effectiveFilter(workflows: FilterWorkflow[], choice: CiChoice) {
  const workflow = choice.workflow === "all" ? null : workflows.find((entry) => entry.id === choice.workflow) ?? defaultWorkflow(workflows) ?? null;
  const events = workflow?.events && workflow.events.length >= 2 ? workflow.events : [];
  const event = choice.event !== undefined && (choice.event === "all" || events.some((entry) => entry.event === choice.event)) ? choice.event : events[0]?.event ?? "all";
  return { workflow, events, event };
}

/** Before the shared choice, each chart card stored its own workflow and event: the first one that names a workflow of this repository becomes its choice. */
function migrateLegacy(workflows: FilterWorkflow[]): CiChoice | null {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage.getItem(LEGACY_KEY) ?? "null");
    if (!Array.isArray(raw)) return null;
    const mine = (entry: unknown): entry is { workflow: number; event?: unknown } => typeof entry === "object" && entry !== null
      && workflows.some((workflow) => workflow.id === (entry as { workflow?: unknown }).workflow);
    const first = raw.find(mine);
    if (!first) return null;
    globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify(raw.map((entry) => { if (!mine(entry)) return entry; const { workflow: _w, event: _e, ...rest } = entry as Record<string, unknown>; return rest; })));
    return { workflow: first.workflow, ...(typeof first.event === "string" ? { event: first.event } : {}) };
  } catch { return null; }
}

export type CiFilter = ReturnType<typeof useCiFilter>;
export function useCiFilter(repository: string, workflows: FilterWorkflow[]) {
  const [choice, setChoice] = useState<CiChoice>(() => readAll()[repository] ?? {});
  const loaded = workflows.length > 0;
  useEffect(() => {
    if (!loaded || readAll()[repository]) return;
    const migrated = migrateLegacy(workflows) ?? {};
    writeChoice(repository, migrated);
    setChoice(migrated);
    // Once per repository: the stored entry, even an empty one, ends the migration.
  }, [repository, loaded]);
  const update = (next: CiChoice) => { setChoice(next); writeChoice(repository, next); };
  return {
    ...effectiveFilter(workflows, choice), workflows,
    setWorkflow: (value: number | "all") => {
      const next = workflows.find((entry) => entry.id === value)?.events ?? [];
      // The stored event only survives a workflow switch if the new workflow has it.
      update({ workflow: value, ...(choice.event === undefined || choice.event === "all" || next.some((entry) => entry.event === choice.event) ? { event: choice.event } : {}) });
    },
    setEvent: (event: string) => update({ ...choice, event }),
  };
}
