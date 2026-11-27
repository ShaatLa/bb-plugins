export const openStates = ["proposed", "applied", "measuring"] as const;
export const states = [...openStates, "kept", "reverted", "withdrawn"] as const;
export type State = typeof states[number];
export const isOpen = (value: State) => value === "proposed" || value === "applied" || value === "measuring";
