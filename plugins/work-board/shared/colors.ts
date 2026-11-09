export const COLOR_PALETTE = [
  { value: "slateblue", label: "Indigo" },
  { value: "steelblue", label: "Blue" },
  { value: "lightseagreen", label: "Teal" },
  { value: "mediumseagreen", label: "Green" },
  { value: "goldenrod", label: "Yellow" },
  { value: "sandybrown", label: "Orange" },
  { value: "indianred", label: "Red" },
  { value: "palevioletred", label: "Pink" },
  { value: "mediumpurple", label: "Purple" },
  { value: "slategray", label: "Gray" },
  { value: "black", label: "Black" },
] as const;

export function paletteColor(value: string | undefined): string | undefined {
  // Keep saved values stable; monochrome status icons follow BB foreground in every theme.
  if (value === "black") return "var(--foreground)";
  return value === "slategray" ? "darkgray" : value;
}

