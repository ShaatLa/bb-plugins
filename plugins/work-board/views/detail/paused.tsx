import { Fragment } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import PauseCircleIcon from "@hugeicons/core-free-icons/PauseCircleIcon";
import { LinkedText } from "../../components/linked-text";
import { formatUntil, PAUSE_RESOLVED_NOTE, type CardPause, type PauseTarget } from "../../shared/pause";
import { taskHref } from "../../shared/task-link";
import { useNowTick } from "../activity/time";

/** The DOM id of a question block on its card, for the links that scroll to it. */
export const questionAnchor = (questionId: string) => `wb-question-${questionId}`;

const LINK = "text-primary underline underline-offset-2";

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

function Reason({ pause }: { pause: CardPause }) {
  const targets = pause.targets;
  if (!targets) return pause.signal === "manual" ? <LinkedText text={pause.reason} copy={false} /> : <>{pause.reason}</>;
  if (!targets.length) return <>{pause.reason} <span className="text-muted-foreground">({PAUSE_RESOLVED_NOTE})</span></>;
  return <>{pause.signal === "held" ? "Waiting on " : "Waiting on the owner: "}{targets.map((target, index) => <Fragment key={target.kind === "task" ? target.taskKey : target.questionId}>{index > 0 && ", "}<Target target={target} /></Fragment>)}</>;
}

/** The card's pauses, styled like the other rail sections. */
export function PausedBlock({ pauses }: { pauses?: CardPause[] }) {
  const now = useNowTick();
  if (!pauses?.length) return null;
  return <section aria-label="Paused" className="mb-2 rounded-md border border-border px-3 py-2 text-xs">
    <div className="mb-1 flex items-center gap-1 text-muted-foreground"><HugeiconsIcon icon={PauseCircleIcon} aria-hidden className="size-3" />Paused</div>
    <ul className="space-y-1">{pauses.map((pause, index) => <li key={`${pause.signal}-${index}`} className="break-words">
      <Reason pause={pause} />
      {pause.until ? <span className="text-muted-foreground"> · <time dateTime={pause.until} title={new Date(pause.until).toLocaleString()}>until {formatUntil(pause.until, now)}</time></span> : null}
    </li>)}</ul>
  </section>;
}
