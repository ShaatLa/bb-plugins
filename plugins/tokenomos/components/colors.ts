/**
 * Series colors by slot 1..5; in the provider view slot 1 is Claude (orange) and slot 2 Codex (blue), as the
 * owner asked. Fixed colors, not the host's `--chart-N` (theme-dependent, and bb's app stylesheet does not
 * define it anyway). `light-dark()` follows the host's `color-scheme`.
 */
const COLORS: Record<number, string> = {
  1: "light-dark(#ea580c, #fb923c)",
  2: "light-dark(#2563eb, #60a5fa)",
  3: "light-dark(#9333ea, #c084fc)",
  4: "light-dark(#e11d48, #fb7185)",
  5: "light-dark(#65a30d, #a3e635)",
};
export const seriesColor = (n: number) => COLORS[n]!;
