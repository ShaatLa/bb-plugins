/**
 * Rewrites bb thread URLs in Markdown into `@thread:<id>` references. The SDK
 * `Markdown` component renders those as native thread pills (icon, resolved
 * title, bb navigation) but leaves URLs inside links as plain links.
 */

const THREAD_PATH =
  /^\/(?:projects\/[A-Za-z0-9_-]+\/)?threads\/(thr_[A-Za-z0-9_-]+)\/?$/;
const MESSAGE_HASH = /^#msg=(?:0|[1-9]\d*)$/;

// Spans left untouched: inline code, link/image destinations, reference definitions.
const PROTECTED = /`[^`\n]*`|\]\([^)]*\)|^[ \t]{0,3}\[[^\]\n]+\]:.*$/gm;
// `<url>` autolinks, plus bare absolute URLs and bare `/projects/…/threads/…` paths.
const CANDIDATE =
  /<(https?:\/\/[^\s<>]+)>|(?<=^|[\s(])(https?:\/\/[^\s<>()[\]]+|\/(?:projects\/[^\s<>()[\]/]+\/)?threads\/[^\s<>()[\]]+)/g;
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;

/** `@thread:` reference for a same-origin bb thread URL or internal path, else null. */
function threadReference(ref: string, origin: string | null): string | null {
  const base = origin ?? "http://bb.invalid";
  let url: URL;
  try {
    url = new URL(ref, base);
  } catch {
    return null;
  }
  if (url.origin !== base || url.search !== "") return null;
  if (url.hash !== "" && !MESSAGE_HASH.test(url.hash)) return null;
  const id = THREAD_PATH.exec(url.pathname)?.[1];
  return id === undefined ? null : `@thread:${id}${url.hash}`;
}

function rewriteLine(line: string, origin: string | null): string {
  let out = "";
  let last = 0;
  const rewrite = (text: string) =>
    text.replace(CANDIDATE, (match, angle?: string, bare?: string) => {
      if (angle !== undefined) return threadReference(angle, origin) ?? match;
      const ref = bare as string;
      const trailing = TRAILING_PUNCTUATION.exec(ref)?.[0] ?? "";
      const core = trailing ? ref.slice(0, -trailing.length) : ref;
      const mention = threadReference(core, origin);
      return mention === null ? match : mention + trailing;
    });
  for (const span of line.matchAll(PROTECTED)) {
    out += rewrite(line.slice(last, span.index)) + span[0];
    last = span.index + span[0].length;
  }
  return out + rewrite(line.slice(last));
}

/**
 * Same-origin absolute thread URLs and internal thread paths become native
 * thread mentions. Everything else, including external sites that merely
 * look similar, labeled links and code, is returned unchanged.
 * shortcut: indented code blocks and multi-backtick spans are not detected;
 * upgrade if such a body ever needs a thread URL kept literal.
 */
export function withNativeThreadMentions(
  body: string,
  origin: string | null,
): string {
  if (!body.includes("thread")) return body;
  let fence: string | null = null;
  return body
    .split("\n")
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence !== null) {
        if (
          marker !== undefined &&
          marker[0] === fence[0] &&
          marker.length >= fence.length
        ) {
          fence = null;
        }
        return line;
      }
      if (marker !== undefined) {
        fence = marker;
        return line;
      }
      return rewriteLine(line, origin);
    })
    .join("\n");
}
