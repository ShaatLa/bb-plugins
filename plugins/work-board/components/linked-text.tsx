import { Fragment } from "react";
import { UrlLink } from "@get-bb/plugin-sdk/app";

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING = /[.,;:!?)\]»”]+$/;

/** Plain text with bare http(s) URLs rendered as links bb opens itself. */
export function LinkedText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const trailing = TRAILING.exec(match[0])?.[0] ?? "";
    const url = trailing ? match[0].slice(0, -trailing.length) : match[0];
    parts.push(text.slice(last, match.index), (
      <UrlLink key={match.index} href={url} className="text-primary underline underline-offset-2 [overflow-wrap:anywhere]">{url}</UrlLink>
    ));
    last = match.index + url.length;
  }
  parts.push(text.slice(last));
  return <>{parts.map((part, index) => <Fragment key={index}>{part}</Fragment>)}</>;
}
