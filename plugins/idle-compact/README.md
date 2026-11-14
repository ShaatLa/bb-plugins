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
- Settings: on/off and the minimum context in tokens.

## Limitation

bb has no conditional compaction. The server checks that the thread is idle and then
dispatches the compaction a few awaits later without checking again. A turn that starts
in that moment (a message sent exactly at the 50-minute mark, or a plugin reload in the
middle of a check) can coincide with a compaction. The same holds for `bb thread compact`.
The plugin re-checks the idle period right before the call and runs one call per thread
at a time, which keeps the window to that server-side moment.

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
