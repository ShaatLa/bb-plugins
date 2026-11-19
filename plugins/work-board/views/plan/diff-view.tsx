import { useMemo, useState } from "react";
import { diffLines, diffWordsWithSpace } from "diff";
import { cn } from "@/lib/utils";

interface Segment {
  text: string;
  changed: boolean;
}
export interface DiffRow {
  kind: "same" | "add" | "del";
  text: string;
  /** Word-level pieces, present on the lines of a changed pair. */
  segments?: Segment[];
}

const CONTEXT = 3;

const splitLines = (value: string) => {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
};

/**
 * Line diff of two Markdown sources. A block of removed lines followed by added lines is paired line by line,
 * and each pair gets word-level highlights (the way Plannotator shows a revised paragraph).
 */
export function buildDiffRows(from: string, to: string): DiffRow[] {
  const parts = diffLines(from, to);
  const rows: DiffRow[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part.added && !part.removed) {
      for (const text of splitLines(part.value)) rows.push({ kind: "same", text });
      continue;
    }
    const removed = part.removed ? splitLines(part.value) : [];
    const next = part.removed ? parts[i + 1] : undefined;
    const added = part.added ? splitLines(part.value) : next?.added ? splitLines(next.value) : [];
    if (next?.added) i++;
    const delRows: DiffRow[] = removed.map((text) => ({ kind: "del", text }));
    const addRows: DiffRow[] = added.map((text) => ({ kind: "add", text }));
    for (let k = 0; k < Math.min(removed.length, added.length); k++) {
      const words = diffWordsWithSpace(removed[k]!, added[k]!);
      delRows[k]!.segments = words.filter((word) => !word.added).map((word) => ({ text: word.value, changed: !!word.removed }));
      addRows[k]!.segments = words.filter((word) => !word.removed).map((word) => ({ text: word.value, changed: !!word.added }));
    }
    rows.push(...delRows, ...addRows);
  }
  return rows;
}

const ROW_TONE = { same: "", add: "bg-success/10", del: "bg-destructive/10" } as const;
const MARK = { same: " ", add: "+", del: "−" } as const;

function RowText({ row }: { row: DiffRow }) {
  if (!row.segments) return <>{row.text}</>;
  const tone = row.kind === "add" ? "bg-success/25" : "bg-destructive/25";
  return (
    <>
      {row.segments.map((segment, index) => {
        if (!segment.changed) return segment.text;
        const Mark = row.kind === "add" ? "ins" : "del";
        return <Mark key={index} className={cn("rounded-sm no-underline", tone)}>{segment.text}</Mark>;
      })}
    </>
  );
}

/** Rows to show: changed lines plus a few around them; the rest folds into "Show N unchanged lines". */
function foldRows(rows: readonly DiffRow[]): ({ row: DiffRow; index: number } | { fold: number; count: number })[] {
  const keep = rows.map((row) => row.kind !== "same");
  const near = keep.map((_, index) => keep.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some(Boolean));
  const out: ({ row: DiffRow; index: number } | { fold: number; count: number })[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (near[i]) {
      out.push({ row: rows[i]!, index: i });
      continue;
    }
    let end = i;
    while (end < rows.length && !near[end]) end++;
    out.push({ fold: i, count: end - i });
    i = end - 1;
  }
  return out;
}

/** Monospace source diff of two plan versions, with added and removed backgrounds from the theme. */
export function PlanDiffView({ from, to }: { from: string; to: string }) {
  const rows = useMemo(() => buildDiffRows(from, to), [from, to]);
  const items = useMemo(() => foldRows(rows), [rows]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  if (!rows.some((row) => row.kind !== "same")) {
    return <p role="status" className="p-4 text-sm text-muted-foreground">No differences between these versions.</p>;
  }
  const renderRow = (row: DiffRow, key: number) => (
    <div key={key} data-diff={row.kind} className={cn("flex gap-2 px-2", ROW_TONE[row.kind])}>
      <span aria-hidden className="w-3 shrink-0 select-none text-muted-foreground">{MARK[row.kind]}</span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]"><RowText row={row} /></span>
    </div>
  );
  return (
    <div aria-label="Plan changes" role="group" className="overflow-hidden rounded-lg border border-border font-mono text-xs leading-5">
      {items.map((item) => {
        if ("row" in item) return renderRow(item.row, item.index);
        if (expanded.has(item.fold)) return rows.slice(item.fold, item.fold + item.count).map((row, offset) => renderRow(row, item.fold + offset));
        return (
          <button
            key={`fold-${item.fold}`}
            type="button"
            className="block w-full bg-muted/50 px-2 py-0.5 text-left text-muted-foreground hover:bg-state-hover"
            onClick={() => setExpanded((current) => new Set(current).add(item.fold))}
          >
            Show {item.count} unchanged {item.count === 1 ? "line" : "lines"}
          </button>
        );
      })}
    </div>
  );
}
