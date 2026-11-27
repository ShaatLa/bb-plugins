import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { taskMarkdownLink } from "../shared/task-link";
import { createOnceNotices, SURFACE_AFTER_MS, type NoticeRow, type Why } from "../notices/once";

type Database = ReturnType<BbPluginApi["storage"]["database"]>;
type PauseNoticeRow = NoticeRow & { pause_id: string; reason: string; started_at: string; until: string; expired_at: string };
export { SURFACE_AFTER_MS };
const markerOf = (pauseId: string) => `<!-- work-board-pause-expiry:${pauseId} -->`;

function noticeText(db: Database, row: PauseNoticeRow, why: Why): string {
  const others = [...new Set(db.prepare<[string], { signal: string }>("SELECT signal FROM task_pauses WHERE task_id=? AND applied=1").all(row.task_id).map(other => other.signal))];
  return [
    `The manual pause on ${taskMarkdownLink(row.task_key)} expired at ${row.until}. It waited for: ${row.reason}. Set by ${row.setter} at ${row.started_at}.`,
    others.length ? `Other pauses on the card are still active: ${others.join(", ")}.` : "",
    why === "archived" ? `You get this because ${row.setter} is archived or gone.` : why === "none" ? `You get this because ${row.setter} is archived or gone and no live parent was found.` : why === "owner" ? "You get this because the pause was set by the owner, not by a thread." : "",
  ].filter(Boolean).join(" ");
}

/** Sends what the expired manual pauses owe. One pass at a time, so a row is never claimed twice; failures are logged, never thrown. */
export const drainPauseExpiryNotices = createOnceNotices<PauseNoticeRow>({ table: "pause_expiry_notices", key: "pause_id", order: "expired_at", label: "Pause expiry notice", marker: row => markerOf(row.pause_id), text: noticeText });
