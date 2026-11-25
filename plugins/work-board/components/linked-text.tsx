import { BbLink } from "./bb-link";
import { Fragment } from "react";

const TRAILING = /[.,;:!?)\]»”]+$/;
// `[label](target)` with one level of nested brackets in the label and of parentheses in the target, or a bare web URL.
const LINK_PATTERN = /\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+"[^"]*")?\s*\)|https?:\/\/[^\s<>"'`]+/g;
const WEB_TARGET = /^https?:\/\/[^\s\\]+$/;
// An in-app path: one leading slash, never `//` or a backslash, which browsers may read as another host.
const APP_PATH = /^\/(?![/\\])[^\s\\]*$/;
const LINK_CLASS = "text-primary underline underline-offset-2 [overflow-wrap:anywhere]";

type Span =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; href: string; app: boolean; markdown: boolean }
  // A Markdown link with a target we do not open: shown as written, its URL text not linked.
  | { kind: "plain"; text: string; label: string };

function spans(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const [whole, label, target] = match;
    let end = match.index + whole.length;
    let span: Span;
    if (label !== undefined) {
      span = WEB_TARGET.test(target!) || APP_PATH.test(target!)
        ? { kind: "link", label, href: target!, app: target!.startsWith("/"), markdown: true }
        : { kind: "plain", text: whole, label };
    } else {
      const trailing = TRAILING.exec(whole)?.[0] ?? "";
      const url = trailing ? whole.slice(0, -trailing.length) : whole;
      end = match.index + url.length;
      span = { kind: "link", label: url, href: url, app: false, markdown: false };
    }
    if (match.index > last) out.push({ kind: "text", text: text.slice(last, match.index) });
    out.push(span);
    last = end;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

/** The text with every target of a link we render dropped (a Markdown label kept), so a target-only edit compares equal. */
export function withoutLinkTargets(text: string): string {
  return spans(text).map((span) => span.kind !== "link" ? span.text : span.markdown ? `[${span.label}]()` : "").join("");
}

/** Plain text with Markdown links and bare http(s) URLs rendered as links bb opens itself. */
export function LinkedText({ text }: { text: string }) {
  return <>{spans(text).map((span, index) => span.kind !== "link" ? <Fragment key={index}>{span.text}</Fragment>
    // An in-app path stays a plain anchor, so the task-link interceptor opens it in bb.
    : span.app ? <a key={index} href={span.href} className={LINK_CLASS}>{span.label}</a>
    : <BbLink key={index} href={span.href} className={LINK_CLASS}>{span.label}</BbLink>)}</>;
}
