import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const NOTICE_PLUGIN_ID = "agent-hub";
export const NOTICE_SOURCE = "work-board";
/** The receiver's limit on `markdown`, in UTF-8 bytes. */
export const NOTICE_MAX_BYTES = 1024 * 1024;
export const NOTICE_TIMEOUT_MS = 5000;

const reply = z.object({ id: z.string().min(1), created: z.boolean() });
export type NoticeReply = z.infer<typeof reply>;

export type NoticePayload = { markdown: string } | { tooLarge: string };

/** The formatted notification when it fits the receiver's limit, otherwise the raw staged body; both too large means the report cannot be sent as a notice. */
export function choosePayload(formatted: string, raw: string): NoticePayload {
  const fits = (text: string) => text.length > 0 && Buffer.byteLength(text) <= NOTICE_MAX_BYTES;
  if (fits(formatted)) return { markdown: formatted };
  if (fits(raw)) return { markdown: raw };
  return { tooLarge: "Report too large for a notice (over 1 MiB, or empty)" };
}

export const noticeTitle = (prefix: string) => `Repository checks report · manager unavailable (${prefix})`;

/**
 * What a failed call proves. Only a coded refusal of the first call is definite: `invalid_input` (the receiver rejected the payload, and a
 * same-key replay would be rejected the same way) and `unknown_method` (an older receiver). Everything else, a caller-side parse error,
 * `invalid_output`, a 5xx, an uncoded 404, an abort or a timeout, may have stored the notice.
 */
export function classifyNoticeError(error: unknown): "refused" | "unavailable" | "possible" {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  if (code === "invalid_input") return "refused";
  if (code === "unknown_method") return "unavailable";
  return "possible";
}

export async function agentHubEnabled(bb: BbPluginApi, signal: AbortSignal): Promise<boolean> {
  try {
    return (await bb.sdk.plugins.list({ signal })).plugins.some((plugin) => plugin.id === NOTICE_PLUGIN_ID && plugin.enabled);
  } catch (error) {
    if (signal.aborted) throw error;
    return false;
  }
}

/** One call of the receiver. Rejects with the transport's error, or with a parse error for a reply that is not `{ id, created }`. */
export function callNotice(bb: BbPluginApi, signal: AbortSignal, input: { tickId: string; projectId: string; threadId: string | null; title: string; markdown: string }): Promise<NoticeReply> {
  const { threadId, ...rest } = input;
  return bb.sdk.plugins.callRpc({
    pluginId: NOTICE_PLUGIN_ID, method: "notice", outputSchema: reply,
    input: { source: NOTICE_SOURCE, ...rest, ...(threadId?.startsWith("thr_") ? { threadId } : {}) },
    signal: AbortSignal.any([signal, AbortSignal.timeout(NOTICE_TIMEOUT_MS)]),
  });
}
