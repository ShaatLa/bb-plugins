import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { BoardColumnDisplay } from "./board-display-contract";
import { boardStates, type State } from "./states";

const defaultColor: Record<State, string> = {
  proposed: "text-muted-foreground", applied: "text-blue-500", measuring: "text-amber-500",
  kept: "text-emerald-500", reverted: "text-rose-500", withdrawn: "text-muted-foreground",
};

export const defaultStatusName = (state: State) => state[0]!.toUpperCase() + state.slice(1);
export const defaultColumns: BoardColumnDisplay[] = boardStates.map(id => ({
  id, name: defaultStatusName(id), visible: true, icon: "default", color: "default",
}));

export function displayName(state: State, columns: BoardColumnDisplay[]) {
  return columns.find(column => column.id === state)?.name || defaultStatusName(state);
}

function statusColor(state: State, value?: BoardColumnDisplay["color"]) {
  const className = !value || value === "default" ? defaultColor[state] : "";
  const color = value === "black" ? "var(--foreground)" : value === "slategray" ? "darkgray"
    : value === "default" ? undefined : value;
  return { className, color };
}

export function StatusColorDot({ state, value }: { state: State; value: BoardColumnDisplay["color"] }) {
  const { className, color } = statusColor(state, value);
  return <span aria-hidden className={`size-3.5 shrink-0 rounded-full bg-current ${className}`} style={{ color }} />;
}

export function StatusMark({ state, display }: { state: State; display?: BoardColumnDisplay }) {
  const { className, color } = statusColor(state, display?.color);
  if (display && display.icon !== "default") return <span aria-hidden="true" className={`shrink-0 ${className}`} style={{ color }}>
    <Icon name={display.icon} className="size-3.5" />
  </span>;
  return <span aria-hidden="true" className={`inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-current ${className} ${state === "proposed" ? "border-dashed" : ""}`} style={{ color }}>
    {state !== "proposed" && <span className="size-1.5 rounded-full bg-current" />}
  </span>;
}
