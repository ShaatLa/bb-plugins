# Scheduled foundation (incomplete)

`recurrence.ts` exports `recurrenceSchema`, `Recurrence`, `nextOccurrence(rule: Recurrence, after: Date): Date | null`, `localSlotKey(at: Date, timezone: string): string`, and `isWithinGrace(due: Date, now: Date): boolean`. `nextOccurrence` is strictly after the supplied instant. Once rules use an ISO datetime with an explicit offset; daily and weekly rules use `HH:mm` and an IANA timezone. Weekly weekdays use 0–6, Sunday first. `localSlotKey` omits the offset so a fall-back fold shares one identity; persist it with the schedule identity when reserving an occurrence.

No scheduled tables, RPC contract, store, task cloning, lifecycle integration, or cleanup exist yet. This module alone must not be connected to dispatch. In particular, a slot key does not itself provide durable idempotency or transactional reservation.
