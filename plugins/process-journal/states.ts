export const openStates = ["proposed", "applied", "measuring"] as const;
export const boardStates = [...openStates, "kept", "reverted"] as const;
export type BoardState = typeof boardStates[number];
export const states = [...boardStates, "withdrawn"] as const;
export type State = typeof states[number];
export const isOpen = (value: State) => value === "proposed" || value === "applied" || value === "measuring";
