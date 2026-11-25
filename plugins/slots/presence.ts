import { z } from "zod";
import { defineRpcContract } from "@get-bb/plugin-sdk";

/** One machine's raw presence probes; null is a probe that failed, timed out or printed something unparsable. */
export const rawPresenceSchema = z.object({
  idleSeconds: z.number().nonnegative().nullable(),
  displayAsleep: z.boolean().nullable(),
  /** Media holders from `pmset -g assertions` (empty when none). */
  media: z.array(z.string()).nullable(),
  memFreePct: z.number().min(0).max(100).nullable(),
  load1: z.number().nonnegative().nullable(),
  cores: z.number().int().positive(),
});
export type RawPresence = z.infer<typeof rawPresenceSchema>;
export const presenceHostContract = defineRpcContract({
  presence: { input: z.object({}).strict(), output: rawPresenceSchema },
});

/** `"HIDIdleTime" = <ns>` from `ioreg -c IOHIDSystem`. */
export function parseIdle(text: string): number | null {
  const match = /"HIDIdleTime" = (\d+)/.exec(text);
  return match ? Number(match[1]) / 1e9 : null;
}
/** `CGDisplayIsAsleep(CGMainDisplayID())` printed by osascript: exactly 0 or 1. */
export function parseDisplay(text: string): boolean | null {
  const value = text.trim();
  return value === "1" ? true : value === "0" ? false : null;
}

const DISPLAY_SLEEP = new Set(["PreventUserIdleDisplaySleep", "NoDisplaySleepAssertion"]);
/** Agents' headless renders hold a display assertion named "Capturing"; matched by exact process name only. */
const HEADLESS = new Set(["chrome-headless-shell", "Google Chrome for Testing"]);
/**
 * Media holders in `pmset -g assertions`: any coreaudiod context (audio from any app, display on or off),
 * a "Playing audio" assertion, and any display-sleep assertion except a headless render. Null when unparsable
 * or truncated: real output always ends the process list with a `Kernel Assertions:` section, so without it
 * the list may be incomplete and must not read as "no media". When no process holds an assertion, the output has no
 * `Listed by owning process:` section at all: `Assertion status system-wide:` is followed directly by
 * `Kernel Assertions:`. That output means no holders (`[]`) only when every status row parses as `<name> <count>`
 * and every count is 0; an active or unparsable row, or no rows, is null.
 */
export function parseAssertions(text: string): string[] | null {
  const start = text.indexOf("Listed by owning process:");
  if (start < 0) {
    const status = text.indexOf("Assertion status system-wide:");
    const kernel = status < 0 ? -1 : text.indexOf("Kernel Assertions:", status);
    if (kernel < 0) return null;
    const rows = text.slice(status, kernel).split("\n").slice(1).filter(row => row.trim());
    return rows.length && rows.every(row => /^\s*\w+\s+0\s*$/.test(row)) ? [] : null;
  }
  const end = text.indexOf("Kernel Assertions:", start);
  if (end < 0) return null;
  const media = new Set<string>();
  for (const line of text.slice(start, end).split("\n").slice(1)) {
    if (!/^\s*pid /.test(line)) continue;
    const match = /^\s*pid \d+\((.+?)\): (?:\[0x[0-9a-fA-F]+\] )?(?:[\d:]+ )?(\w+) named: "(.*)"\s*$/.exec(line);
    if (!match) return null;
    const [, process, type, name] = match;
    if (process === "coreaudiod") media.add("audio");
    else if (name === "Playing audio" || (DISPLAY_SLEEP.has(type) && !(HEADLESS.has(process) && name === "Capturing"))) media.add(process);
  }
  return [...media];
}

export interface Presence { away: boolean; idleMinutes: number | null; media: string[]; reason: string }
/** Fail closed: any failed probe makes the whole reading present. Away = (idle ≥ threshold or display asleep) and no media. */
export function decidePresence(raw: RawPresence | null, awayMinutes: number): Presence {
  if (!raw || raw.idleSeconds === null || raw.displayAsleep === null || raw.media === null) return { away: false, idleMinutes: raw?.idleSeconds == null ? null : Math.floor(raw.idleSeconds / 60), media: [], reason: "presence unknown (probe failed)" };
  const idleMinutes = Math.floor(raw.idleSeconds / 60);
  if (raw.media.length) return { away: false, idleMinutes, media: raw.media, reason: `media playing (${raw.media.join(", ")})` };
  if (raw.displayAsleep) return { away: true, idleMinutes, media: [], reason: "display asleep" };
  if (raw.idleSeconds >= awayMinutes * 60) return { away: true, idleMinutes, media: [], reason: `no input ${idleMinutes} min` };
  return { away: false, idleMinutes, media: [], reason: `input ${idleMinutes} min ago` };
}
