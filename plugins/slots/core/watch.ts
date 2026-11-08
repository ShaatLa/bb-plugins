import type { Context, HostState, Input, Lease, UsageSubject } from "../contract.js";
import { settingsFor } from "./index.js";

// An agent alone is idle; running work typically exceeds this load.
const IDLE_CORES = 0.15;

type Alert = { reason: "unleased-load" | "idle-lease"; subject: UsageSubject; text: string; holderThreadId?: string };
export function updateWatch(host: HostState, leases: Lease[], input: Extract<Input, { type: "usage" }>, ctx: Context): Alert[] {
  const settings = settingsFor(ctx.settings, input.hostId), alerts: Alert[] = [];
  const w = host.watch ??= { lastEndAt: null, settings: "", heavyEndAt: {}, subjects: {} };
  if (w.lastEndAt !== null && input.endAt <= w.lastEndAt) return alerts;
  const signature = JSON.stringify([settings.watchPolicy, settings.watchCores, settings.watchWindowSeconds, settings.idleLeaseMinutes]);
  const changed = w.settings !== signature;
  const window = settings.watchWindowSeconds * 1000;
  const accepted = !changed && settings.watchPolicy !== "off" && input.valid && input.unknownCores < 0.5 && input.startAt === w.lastEndAt && input.endAt > input.startAt && input.endAt - input.startAt <= window;
  w.settings = signature; w.lastEndAt = input.endAt;
  const heavy = leases.filter(l => l.hostId === input.hostId && l.pool === "heavy");
  const resets = new Set(input.resetKeys);
  const changedFamilies = new Set<string>();
  for (const [key, previous] of Object.entries(w.subjects)) {
    const current = input.subjects.find(s => s.key === key);
    if (!current || JSON.stringify([...previous.threadIds].sort()) !== JSON.stringify([...current.threadIds].sort()) || JSON.stringify([...(previous.ancestorThreadIds ?? [])].sort()) !== JSON.stringify([...(current.ancestorThreadIds ?? [])].sort())) {
      for (const id of [...previous.threadIds, ...(previous.ancestorThreadIds ?? [])]) changedFamilies.add(id);
    }
  }
  for (const [key, s] of Object.entries(w.subjects)) {
    if (!accepted || resets.has(key) || !input.subjects.some(g => g.key === key)) { s.intervals = []; s.episode = false; }
    if (!input.subjects.some(g => g.key === key) && input.endAt - s.seenAt >= 86400000) delete w.subjects[key];
  }
  for (const subject of input.subjects) {
    const s = w.subjects[subject.key] ??= { threadIds: [], intervals: [], episode: false, lastAlertAt: null, seenAt: input.endAt };
    const membershipChanged = JSON.stringify([...s.threadIds].sort()) !== JSON.stringify([...subject.threadIds].sort()) || JSON.stringify([...(s.ancestorThreadIds ?? [])].sort()) !== JSON.stringify([...(subject.ancestorThreadIds ?? [])].sort());
    if (membershipChanged) resets.add(subject.key);
    s.seenAt = input.endAt; s.threadIds = [...subject.threadIds]; s.ancestorThreadIds = [...(subject.ancestorThreadIds ?? [])];
    if (membershipChanged || resets.has(subject.key)) { s.intervals = []; s.episode = false; }
    const usable = accepted && !membershipChanged && !resets.has(subject.key);
    const covered = [...subject.threadIds, ...(subject.ancestorThreadIds ?? [])].some(id => heavy.some(l => l.holderThreadId === id) || (w.heavyEndAt[id] ?? -1) > input.startAt);
    if (covered) { s.intervals = []; s.episode = false; }
    else if (usable) {
      s.intervals.push({ startAt: input.startAt, endAt: input.endAt, cores: subject.cores });
      const cutoff = input.endAt - window;
      s.intervals = s.intervals.filter(i => i.endAt > cutoff);
      if (s.intervals.length) s.intervals[0].startAt = Math.max(cutoff, s.intervals[0].startAt);
      // Short intervals cannot grow history without bound; restart rather than invent unobserved time.
      if (s.intervals.length > Math.ceil(window / 15000) + 2) s.intervals = [];
      const duration = s.intervals.reduce((sum, i) => sum + i.endAt - i.startAt, 0);
      if (duration === window) {
        const average = s.intervals.reduce((sum, i) => sum + (i.endAt - i.startAt) * i.cores, 0) / duration;
        if (average < settings.watchCores) s.episode = false;
        else if (!s.episode) {
          s.episode = true;
          if (s.lastAlertAt === null || input.endAt - s.lastAlertAt >= 1800000) {
            s.lastAlertAt = input.endAt;
            alerts.push({ reason: "unleased-load", subject, text: `Processes in this session's checkout used ~${average.toFixed(1)} cores for ${settings.watchWindowSeconds / 60} min without a heavy slot (${subject.threadIds.join(", ")}); a queued request does not cover this load. If that was not this session, ignore.` });
          }
        }
      }
    }
  }
  for (const l of heavy) {
    const family = input.subjects.filter(s => s.threadIds.includes(l.holderThreadId) || (s.ancestorThreadIds ?? []).includes(l.holderThreadId));
    const subject = family.find(s => s.threadIds.includes(l.holderThreadId)) ?? family[0];
    const idle = l.idle ??= { since: null, alerted: false };
    const s = subject && w.subjects[subject.key];
    if (!accepted || !subject || family.some(s => resets.has(s.key)) || changedFamilies.has(l.holderThreadId) || !s || input.startAt < (l.holdingSince ?? l.grantedAt) || family.reduce((sum, s) => sum + s.cores, input.unknownCores) >= IDLE_CORES) {
      idle.since = null; idle.alerted = false; continue;
    }
    idle.since ??= input.startAt;
    if (!idle.alerted && input.endAt - idle.since >= settings.idleLeaseMinutes * 60000) {
      idle.alerted = true;
      alerts.push({ reason: "idle-lease", subject, holderThreadId: l.holderThreadId, text: `Heavy lease ${l.id}: holder ${l.holderThreadId}, job ${l.job}; held for ${Math.floor((input.endAt - l.grantedAt) / 60000)} min, checkout idle for ${Math.floor((input.endAt - idle.since) / 60000)} min (${subject.threadIds.join(", ")}).` });
    }
  }
  for (const [id, at] of Object.entries(w.heavyEndAt)) if (at < input.endAt - window) delete w.heavyEndAt[id];
  return alerts;
}
