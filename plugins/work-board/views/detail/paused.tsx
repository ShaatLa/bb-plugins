import { Fragment, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import PauseCircleIcon from "@hugeicons/core-free-icons/PauseCircleIcon";
import { LinkedText } from "../../components/linked-text";
import { pauseHeading, pauseReasonText, type CardPause, type PauseTarget } from "../../shared/pause";
import type { TaskQuestion } from "../../shared/contract";
import { placeChecks } from "../../shared/check-flow";
import { taskHref } from "../../shared/task-link";
import { useNowTick } from "../activity/time";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

export const questionAnchor = (questionId: string) => `wb-question-${questionId}`;
const LINK = "text-primary underline underline-offset-2";
export type PauseDetails = { signal: string; reason: string; until: string | null; startedAt: string; threadId: string; source: string };

function Target({ target }: { target: PauseTarget }) {
  if (target.kind === "task") return <a href={taskHref(target.taskKey)} className={LINK}>{target.taskKey}</a>;
  const id = questionAnchor(target.questionId);
  return <a href={`#${id}`} className={LINK} onClick={(event) => {
    const element = event.currentTarget.ownerDocument.getElementById(id);
    if (!element) return;
    event.preventDefault();
    for (let details = element.closest("details"); details; details = details.parentElement?.closest("details") ?? null) details.open = true;
    element.scrollIntoView?.({ block: "nearest" });
  }}>{target.label}</a>;
}

function Reason({ pause, questions }: { pause: CardPause; questions: TaskQuestion[] }) {
  const targets = pause.targets;
  if (!targets) return pause.signal === "manual" ? <LinkedText text={pause.reason} copy={false} /> : <>{pause.reason}</>;
  if (!targets.length) {
    const id = /owner question (\S+)$/.exec(pause.reason)?.[1];
    const question = pause.signal === "owner_question" ? placeChecks(questions).find(q => q.id === id) : undefined;
    const prompt = question?.prompt.trim().replace(/\s+/g, " ") ?? "";
    const label = question?.kind === "check" ? `check ${question.number}` : `decision «${prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt}»`;
    return <>{pauseReasonText(pause)} {question && <Target target={{ kind: "question", questionId: question.id, label }} />}</>;
  }
  return <>{pause.signal === "held" ? "Waiting on " : "Waiting on the owner: "}{targets.map((target, index) => <Fragment key={target.kind === "task" ? target.taskKey : target.questionId}>{index > 0 && ", "}<Target target={target} /></Fragment>)}</>;
}

function clock(iso: string, now: number) {
  const date = new Date(iso);
  return date.toLocaleDateString() === new Date(now).toLocaleDateString() ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function PausedBlock({ pauses, details, names, questions = [], resume, extend, onError }: {
  pauses?: CardPause[]; details?: PauseDetails[]; names?: ReadonlyMap<string, string>; questions?: TaskQuestion[];
  resume?: () => Promise<unknown>; extend?: (reason: string, durationMs: number) => Promise<unknown>; onError?: (message: string) => void;
}) {
  const now = useNowTick();
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  if (!pauses?.length) return null;
  const manual = pauses.find(p => p.signal === "manual" && p.until);
  const canResume = pauses.some(p => p.signal === "manual" || p.signal === "background");
  const remaining = manual?.until ? Math.max(0, Date.parse(manual.until) - now) : 0;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try { await action(); setMenu(false); } catch (error) { onError?.(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const latestUntil = pauses.some(pause => !pause.until) ? null : pauses.map(pause => pause.until!).sort((x, y) => Date.parse(y) - Date.parse(x))[0] ?? null;
  return <section aria-label="Paused" className="mb-2 rounded-md border border-border px-3 py-2 text-xs">
    <div className="mb-1 flex items-center gap-1 text-warning">
      <HugeiconsIcon icon={PauseCircleIcon} aria-hidden className="size-3" />{pauseHeading(pauses, now)}
      {/* The end time sits on the header's right edge; with several timed pauses, the latest one. */}
      {latestUntil && <span className="ml-auto text-muted-foreground">until <time dateTime={latestUntil} title={new Date(latestUntil).toLocaleString()}>{clock(latestUntil, now)}</time></span>}
    </div>
    <ul className="space-y-2">{pauses.map((pause, index) => {
      const matches = details?.filter(row => row.signal === pause.signal && row.reason === pause.reason && (row.until === null || pause.until === null ? row.until === pause.until : Date.parse(row.until) === Date.parse(pause.until))) ?? [];
      const row = matches.length === 1 ? matches[0] : undefined;
      const elapsed = row && pause.until ? Math.max(0, Math.min(100, (now - Date.parse(row.startedAt)) / (Date.parse(pause.until) - Date.parse(row.startedAt)) * 100)) : null;
      return <li key={`${pause.signal}-${index}`} className="break-words">
        {elapsed !== null && Number.isFinite(elapsed) && <div aria-hidden="true" className="mb-1 h-1 rounded bg-muted"><div className="h-full rounded bg-warning" style={{ width: `${elapsed}%` }} /></div>}
        <div><Reason pause={pause} questions={questions} /></div>
        {row && <div className="mt-1.5 text-muted-foreground">{row.source === "auto" ? "paused automatically" : `paused by ${row.threadId === "owner" ? "the owner" : names?.get(row.threadId) ?? row.threadId}`} at <time dateTime={row.startedAt} title={new Date(row.startedAt).toLocaleString()}>{clock(row.startedAt, now)}</time></div>}
      </li>;
    })}</ul>
    {canResume && <div className="mt-2 flex items-start gap-2"><Button size="sm" variant="outline" className="h-7" disabled={busy} onClick={() => resume && void run(resume)}>Resume now</Button>{manual && <DropdownMenu open={menu} onOpenChange={setMenu}>
      {/* A popover over the card, so opening it never changes the block's height. */}
      <DropdownMenuTrigger asChild><Button size="sm" variant="outline" className="h-7" disabled={busy}>Extend ▾</Button></DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {[["+1 h", 3600000], ["+4 h", 14400000], ["+1 day", 86400000]].map(([label, extra]) => <DropdownMenuItem key={label} disabled={busy} onSelect={() => extend && void run(() => extend(manual.reason, Math.floor(remaining + Number(extra))))}>{label}</DropdownMenuItem>)}
        {pauses.some(p => p.signal === "background") && <div className="px-2 py-1 text-xs text-muted-foreground">Also ends the automatic pause.</div>}
      </DropdownMenuContent>
    </DropdownMenu>}</div>}
  </section>;
}

/** The `listPauses` rows to show for this card: none while a read runs or failed, or when the rows belong to another card. */
export function pauseDetailsFor<R>(query: { isFetching: boolean; error: unknown; data?: { taskId: string; rows: R[] } }, taskId: string): R[] | undefined {
  return !query.isFetching && !query.error && query.data?.taskId === taskId ? query.data.rows : undefined;
}
