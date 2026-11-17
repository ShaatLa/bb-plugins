---
name: idle-compact
description: "Explain or control automatic compaction of Claude Code threads left idle for 50 minutes; exempt a thread that must keep its full context."
---

Idle Compact compacts a Claude Code thread after 50 minutes idle when its context is
100k tokens or more (the minimum is a plugin setting). It runs while Claude's one-hour
prompt cache is still warm, so the next wake rewrites only the summary instead of the
whole context. A thread found idle longer than 57 minutes (for example after the machine
slept) is left alone, because by then compacting costs as much as waking it.

It also compacts a thread on any provider whose context is at 80% of the model's window
or more (the share is a setting, 70–95% or off), as the former auto-compact plugin did:
a failed thread at once; an idle one just before its next message, which waits for the
compaction and then runs on the compacted context, or after 50 minutes idle if no message
comes. A full thread archived before its next message is never compacted, so a parent can
still read a child's final report with `bb thread output` (a compaction empties it). A
failed compaction is not retried until the context changes.

The Compact button in the open thread's header compacts that thread now, on any
provider and regardless of the settings or keep; it is enabled only while the thread is
idle or failed. Other plugins (Answers) can also queue a compaction during a turn: it runs
when the thread stops, before its next message. Agents compact a thread with `bb thread
compact` instead.

Commands:
- `bb idle-compact status [--json]`: settings, threads due for compaction and when, full
  threads waiting for their next message, and threads that keep their full context.
- `bb idle-compact keep [thread-id]`: never idle-compact this thread (defaults to the
  current thread). Use it for a thread whose exact earlier wording matters more than cost.
- `bb idle-compact release [thread-id]`: let the thread be idle-compacted again.

Compaction keeps Claude Code's summary of the conversation. Durable notes belong in Work
Board cards or thread storage, not only in the conversation.

Each check is logged in `~/.bb/plugins/idle-compact/logs/plugin.log`.
`scripts/measure.py` in the plugin reports idle gaps, wake rates and cache rewrites from
Claude transcripts, to compare before and after.
