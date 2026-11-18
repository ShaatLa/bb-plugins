// How a failed send reads. bb refusing the message (a 4xx status, or an RPC input, permission or lookup error) means it was
// not sent and can simply be retried; anything else (a dropped connection, a server error) may have reached the thread.
const REFUSED = ['invalid', 'invalid_json', 'invalid_input', 'forbidden', 'not_found', 'conflict', 'unknown_method'];
export function deliveryError(error: unknown) {
  const detail = error as { status?: unknown; code?: unknown } | null, text = error instanceof Error ? error.message : String(error);
  const refused = (typeof detail?.status === 'number' && detail.status >= 400 && detail.status < 500) || (typeof detail?.code === 'string' && REFUSED.includes(detail.code));
  // Already worded by the server's own delivery (see deliver in server.ts).
  if (/^(Not sent|Delivery uncertain)\b/.test(text)) return text;
  return refused ? `Not sent: ${text}` : `Delivery uncertain — check the thread before retrying. ${text}`;
}
