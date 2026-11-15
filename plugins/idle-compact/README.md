# Idle Compact

Compacts a Claude Code thread in bb after it has been idle for 50 minutes with a context
of 100k tokens or more.

Claude's prompt cache lives one hour. A thread woken after that writes its whole context
to the cache again. Compacting at 50 minutes, while the cache is warm, costs a cache read
and the summary; the wake then writes only the summary. Threads found idle for more than
57 minutes (a sleeping machine fires timers late) are skipped, since compacting a cold
thread costs as much as waking it.

- Starts a timer when a thread goes idle; going active, failing or being archived cancels it.
- At the timer it compacts only if the thread is still idle, runs on Claude Code, is not
  exempt, and its context is at or above the minimum.
- Timers survive a plugin restart: the idle start time is kept in plugin storage.
- Like the former auto-compact plugin, it also compacts at once any thread (any provider)
  that goes idle or fails with its context at 80% of the model's window or more, while the
  cache is warm, instead of mid-turn at the provider's own limit. Keep exempts it too.
- The stop that ends a compaction this plugin started runs no checks, so a thread still
  over the threshold after compaction waits for a real turn before the next one.
- Settings: on/off, the minimum context in tokens for the 50-minute check, and the window
  share for compacting at once (70–95%, default 80%, or off).
- A Compact button in the open thread's header compacts that thread now, on any provider,
  whatever the settings, context size or keep. It is enabled only while the thread is idle
  or failed, since bb compacts nothing else; the stop ending that compaction runs no checks.

## Compact from other plugins

Other plugins call these through `bb.sdk.plugins.callRpc` (plugin `idle-compact`, from 0.4.0):

```
compact { threadId, queue?: boolean } -> { ok: true, queued?: true }
cancelQueuedCompact { threadId } -> { ok: true }
compactState { threadId } -> { queued: boolean, running: boolean }
```

- `compact` compacts the thread now, like the header button, and is logged as `manual`.
  Without `queue` a thread in a turn is refused, as bb refuses it.
- With `queue: true` a thread in a turn gets the compaction at its next stop (idle or
  failed) instead, and the call returns `queued: true`. A repeat call is a no-op, and so is
  a call while a compaction of the thread is already running (`ok` without `queued`). The
  request survives a plugin restart.
- Until that compaction's own turn ends, a message that would start the thread's next turn
  waits in bb's queue (through the `message.dispatch` hook, shown as "Idle Compact is
  compacting the context first"), so it runs on the compacted context. A steer into the
  running turn is not held. Send now on the waiting message bypasses the wait, as bb
  intends; the compaction then waits for the stop after that turn.
- A refusal other than "not idle" (a provider that cannot compact, for one) drops the
  request and releases the waiting message.
- `cancelQueuedCompact` drops a queued request and releases what waited on it.
- `compactState.running` is true from the dispatch of any compaction this plugin made until
  its turn ends. Poll it; there is no change notification.

## Limitation

bb has no conditional compaction. The server checks that the thread is idle and then
dispatches the compaction a few awaits later without checking again. Anything that
starts a turn in that moment still goes through alongside the compaction:

- A message, queued message or agent message that arrives while a check runs. The
  window-share check runs the moment a thread stops (goes idle or fails); the other runs
  around the 50-minute mark, and a delayed timer or a reschedule after a restart can move
  it later.
- A second compaction after a plugin reload. The reload does not cancel a call the old
  instance already sent, and the new instance can check the same thread and send another
  before the first dispatch lands. The plugin's one-call-per-thread guard holds only
  within one plugin instance.

The same holds for `bb thread compact`. The plugin re-checks the idle period right before
its call, so the window stays at that server-side moment; closing it needs a conditional
dispatch in bb.

## Compaction log

Other plugins can read the compactions this plugin made through the RPC method
`compactions.list` (`bb.sdk.plugins.callRpc`, plugin `idle-compact`). It is read-only;
Idle Compact works the same whether anything reads it.

```
input:  { since?: number /* ms, exclusive */, after?: string /* nextCursor */, limit?: number /* 1–500, default 100 */ }
output: { items: { id, threadId, at, trigger: "idle" | "threshold" | "manual", usedTokensBefore: number | null, contextWindow: number | null }[], nextCursor?: string }
```

- An entry is written when the server accepts the compaction (`at`, ms). Refused or failed
  attempts, and compactions started by anything else, are not logged.
- `trigger` is `idle` for the 50-minute check, `threshold` for compacting at once by
  window share and `manual` for the header button. `usedTokensBefore` is null only for
  `manual`, when bb does not know the context size. The size after compaction is not known
  here; read it from the thread.
- Items are in log order, which is time order unless the clock moved back. `at` is the
  real acceptance time; `id` is unique and stable across reloads, and a new entry always
  sorts after every entry already readable, so paging with `after` never skips one.
  Within one plugin instance only: a compaction that resolves after a reload is logged by
  the old instance and can land behind the new one's entries.
- Entries whose `at` is more than 30 days old by the current clock are not returned, and
  are deleted, at most 20 per new entry. The log holds one entry per compaction for 30
  days: 10 threads compacting twice an hour around the clock is about 14,400 entries.
  Each read and write lists them all.

## Commands

```
bb idle-compact status [--json]
bb idle-compact keep [thread-id]      # exempt a thread
bb idle-compact release [thread-id]   # undo keep
```

## Measuring

```
python3 scripts/measure.py --hours 48
```

Reads `~/.claude/projects` transcripts and reports, per context band, idle gaps over 55
minutes, how many woke, the cache written by the first turn after waking, and how many
gaps contained a compaction.

## Development

```
npm install
npm run typecheck
npm test
npm run build
```
