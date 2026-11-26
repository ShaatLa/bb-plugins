import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { BbLink } from "./bb-link";
import { Fragment, useEffect, useState } from "react";
import { Icon } from "@/components/ui/icon";

const TRAILING = /[.,;:!?)\]»”]+$/;
// `[label](target)` with one level of nested brackets in the label and of parentheses in the target, a bare web URL,
// or inline code: one backtick, a value without backticks or line breaks, one backtick. The leftmost match wins.
const LINK_PATTERN = /\[((?:[^[\]\n]|\[[^[\]\n]*\])+)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+"[^"]*")?\s*\)|https?:\/\/[^\s<>"'`]+|`([^`\n]+)`/g;
const WEB_TARGET = /^https?:\/\/[^\s\\]+$/;
// An in-app path: one leading slash, never `//` or a backslash, which browsers may read as another host.
const APP_PATH = /^\/(?![/\\])[^\s\\]*$/;
const LINK_CLASS = "text-primary underline underline-offset-2 [overflow-wrap:anywhere]";

type Span =
  | { kind: "text"; text: string }
  | { kind: "link"; label: string; href: string; app: boolean; markdown: boolean }
  // A Markdown link with a target we do not open: shown as written, its URL text not linked.
  | { kind: "plain"; text: string; label: string }
  // Inline code: `text` keeps the backticks as written, `code` is the value shown and copied.
  | { kind: "code"; text: string; code: string };

function spans(text: string): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const match of text.matchAll(LINK_PATTERN)) {
    const [whole, label, target, code] = match;
    let end = match.index + whole.length;
    let span: Span;
    if (code !== undefined) {
      span = { kind: "code", text: whole, code };
    } else if (label !== undefined) {
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

// A longer inline code value renders as its own block with a labeled Copy button: a small icon is easy to miss there.
export const BLOCK_CODE_MIN = 61;

function CopyCode({ code, labeled = false }: { code: string; labeled?: boolean }) {
  // A fresh object per attempt restarts the 2 s feedback even when the result repeats.
  const [result, setResult] = useState<{ state: "idle" | "copied" | "failed" }>({ state: "idle" });
  const { state } = result;
  const setState = (next: "copied" | "failed") => setResult({ state: next });
  useEffect(() => {
    if (result.state === "idle") return;
    const timer = window.setTimeout(() => setResult({ state: "idle" }), 2000);
    return () => window.clearTimeout(timer);
  }, [result]);
  const label = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code";
  return <>
    <button type="button" aria-label="Copy code" title={label}
      className={labeled
        ? "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        : "ml-0.5 inline-flex size-5 items-center justify-center rounded align-text-bottom text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"}
      onClick={async () => {
        // The copied text is the source value, never the DOM, so wrapping adds nothing.
        try { setState(await experimental_copyToClipboard({ text: code }) ? "copied" : "failed"); }
        catch { setState("failed"); }
      }}>
      <Icon name={state === "copied" ? "Check" : state === "failed" ? "X" : "Copy"} className="size-3" />
      {labeled && <span aria-hidden="true">{state === "idle" ? "Copy" : label}</span>}
    </button>
    <span role="status" className="sr-only">{state === "idle" ? "" : label}</span>
  </>;
}

/** Plain text with Markdown links and bare http(s) URLs rendered as links bb opens itself, and inline code with a copy button (a long value as its own block). */
export function LinkedText({ text, copy = true }: { text: string; copy?: boolean }) {
  return <>{spans(text).map((span, index) => span.kind === "code" && copy && span.code.length >= BLOCK_CODE_MIN
    // Spans only: the callers render this inside <p>, <legend> and <li>, where <div> and <pre> are invalid.
    ? <span key={index} data-code-block="" className="my-1 block w-full overflow-hidden rounded-md border border-border bg-muted text-left">
        <span className="flex justify-end border-b border-border px-1 py-0.5"><CopyCode code={span.code} labeled /></span>
        <code className="block px-2 py-1.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere]">{span.code}</code>
      </span>
    : span.kind === "code"
    ? <Fragment key={index}>
        <code className="rounded bg-muted px-1 font-mono text-[0.9em] whitespace-pre-wrap [overflow-wrap:anywhere]">{span.code}</code>
        {copy && <CopyCode code={span.code} />}
      </Fragment>
    : span.kind !== "link" ? <Fragment key={index}>{span.text}</Fragment>
    // An in-app path stays a plain anchor, so the task-link interceptor opens it in bb.
    : span.app ? <a key={index} href={span.href} className={LINK_CLASS}>{span.label}</a>
    : <BbLink key={index} href={span.href} className={LINK_CLASS}>{span.label}</BbLink>)}</>;
}
