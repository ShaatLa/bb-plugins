/**
 * Series colors by slot 1..5. The owner's rule is the host token `--chart-N`, but bb 0.49's app stylesheet does
 * not define it (only inline-vis synthesises it). The fallback is bb's own inline-vis chart palette
 * (slot 1 = the host's `--timeline-accent`), so the bars stay visible until the host ships real tokens.
 * `light-dark()` follows the host's `color-scheme`.
 */
const FALLBACK: Record<number, string> = {
  1: "var(--timeline-accent)",
  2: "light-dark(#d97706, #fbbf24)",
  3: "light-dark(#9333ea, #c084fc)",
  4: "light-dark(#e11d48, #fb7185)",
  5: "light-dark(#65a30d, #a3e635)",
};
export const seriesColor = (n: number) => `var(--chart-${n}, ${FALLBACK[n]})`;
