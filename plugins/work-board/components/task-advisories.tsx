import { BbLink } from "./bb-link";
import { useEffect, useState } from "react";
import { experimental_Icon as Icon, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { useTasksNavigation } from "../shell/routes";
import { advisoryText, type TaskAdvisory } from "../shared/task-advisories";

export function TaskAdvisories({ items, compact = false }: { items?: readonly TaskAdvisory[]; compact?: boolean }) {
  const navigation = useTasksNavigation(), navigate = useBbNavigate();
  const [clock, setClock] = useState(Date.now);
  const now = Math.max(clock, Date.now());
  const current = items?.filter(item => Date.parse(item.validUntil) > now) ?? [];
  useEffect(() => {
    const expiry = Math.min(...(items ?? []).map(item => Date.parse(item.validUntil)).filter(at => at > Date.now()));
    if (!Number.isFinite(expiry)) return;
    // Expire cached advice once, without adding a polling loop or a network request per card.
    const timer = setTimeout(() => setClock(Date.now()), Math.min(expiry - Date.now() + 1, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [items, clock]);
  if (!current.length) return null;
  const label = `Needs attention · ${current.length}`;
  const summary = <><Icon name="AlertTriangle" aria-hidden className="size-3 shrink-0" />{label}</>;
  if (compact) return <span tabIndex={0} title={current.map(advisoryText).join("\n")} aria-label={current.map(advisoryText).join("\n")} className="inline-flex items-center gap-1 text-warning">{summary}</span>;
  return <details className="group/advisories mt-2 border-t border-border pt-2 text-2xs">
    <summary className="flex cursor-pointer list-none items-center gap-1 rounded text-warning outline-none focus-visible:ring-1 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <Icon name="ChevronRight" aria-hidden className="size-3 shrink-0 transition-transform group-open/advisories:rotate-90 motion-reduce:transition-none" />
      {summary}
    </summary>
    <ul className="mt-2 space-y-3">{current.map((item, index) => <li key={`${item.kind}:${index}`} className="space-y-1">
      <p>{item.kind === "merged-predecessor" ? "Predecessor has a merged delivery PR. Check acceptance criteria or remaining work before marking it Done." : "In Progress without a live attached session. Consider reassigning or queueing."}</p>
      {item.kind === "merged-predecessor" ? <>
        <button type="button" className="block text-left underline" onClick={() => navigation.go({ kind: "task", taskKey: item.predecessor.key })}>{item.predecessor.key} · {item.predecessor.title} ({item.predecessor.status})</button>
        <BbLink className="block underline" href={item.pr.url}>{item.pr.repository}#{item.pr.number}</BbLink>
        <p className="break-all text-muted-foreground">Merge {item.pr.mergeSha} · {item.pr.mergedAt}</p>
      </> : <>
        {item.lastAttachment ? <button type="button" className="block text-left underline" onClick={() => navigate.toThread(item.lastAttachment!.threadId)}>Last attachment: {item.lastAttachment.title || item.lastAttachment.threadId} · {item.lastAttachment.attachedAt}</button> : <p>No attachment history retained.</p>}
        <p className="text-muted-foreground">Last task activity: {item.lastActivityAt}</p>
      </>}
      <p className="text-muted-foreground">Checked {item.checkedAt} · valid until {item.validUntil}</p>
    </li>)}</ul>
  </details>;
}
