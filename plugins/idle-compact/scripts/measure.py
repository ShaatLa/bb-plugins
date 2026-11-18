#!/usr/bin/env python3
"""Idle gaps, wakes and cache rewrites in Claude Code transcripts, to measure Idle Compact.

A gap is a pause of more than 55 minutes between two API calls of the main conversation
(sidechains are skipped). The context before a gap is the previous call's full input. A gap
"woke" when another call followed it; that call's cache_creation_input_tokens is what the
wake rewrote. A gap "compacted" when a compact_boundary record falls inside it.

Usage: python3 measure.py [--hours 48] [--projects ~/.claude/projects]
"""
import argparse, json, os, time
from datetime import datetime

GAP_S = 55 * 60
BANDS = (50_000, 100_000, 150_000)


def ts(record):
    return datetime.fromisoformat(record["timestamp"].replace("Z", "+00:00")).timestamp()


def gaps(path, since):
    """Yield (context, woke, rewritten, compacted) for each gap after `since` in one transcript."""
    last = None  # (time, context) of the previous main-conversation API call
    compacted = False
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            if '"usage"' not in line and "compact_boundary" not in line:
                continue
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if record.get("isSidechain") or "timestamp" not in record:
                continue
            if record.get("subtype") == "compact_boundary":
                compacted = True
                continue
            usage = (record.get("message") or {}).get("usage") if record.get("type") == "assistant" else None
            if not usage:
                continue
            at = ts(record)
            context = usage.get("input_tokens", 0) + usage.get("cache_read_input_tokens", 0) + usage.get("cache_creation_input_tokens", 0)
            if last and at - last[0] > GAP_S and last[0] >= since:
                yield last[1], True, usage.get("cache_creation_input_tokens", 0), compacted
            compacted = False
            last = (at, context)
    if last and time.time() - last[0] > GAP_S and last[0] >= since:
        yield last[1], False, 0, compacted


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--hours", type=float, default=48)
    parser.add_argument("--projects", default=os.path.expanduser("~/.claude/projects"))
    args = parser.parse_args()
    since = time.time() - args.hours * 3600
    rows = []
    for root, _dirs, files in os.walk(args.projects):
        for name in files:
            path = os.path.join(root, name)
            if name.endswith(".jsonl") and os.path.getmtime(path) >= since:
                rows.extend(gaps(path, since))
    print(f"Idle gaps over {GAP_S // 60} min in the last {args.hours:g} h (threads still idle count as not woken)")
    print(f"{'context':>9} {'gaps':>6} {'woke':>6} {'rate':>6} {'rewritten':>11} {'compacted':>10} {'rewritten after compaction':>27}")
    for band in BANDS:
        band_rows = [r for r in rows if r[0] >= band]
        woke = [r for r in band_rows if r[1]]
        compacted = [r for r in band_rows if r[3]]
        rate = f"{len(woke) / len(band_rows):.0%}" if band_rows else "-"
        after = [r[2] for r in woke if r[3]]
        print(f"{'>=' + str(band // 1000) + 'k':>9} {len(band_rows):>6} {len(woke):>6} {rate:>6} {sum(r[2] for r in woke) / 1e6:>10.1f}M {len(compacted):>10} "
              f"{(f'{sum(after) / len(after) / 1000:.0f}k avg over {len(after)}' if after else '-'):>27}")


if __name__ == "__main__":
    main()
