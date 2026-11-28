Delegation presets are user-defined; Tasks ships with none. Before dispatching
work, use `bb work-board preset list` and create a preset if the required one does
not already exist. Dispatch takes exactly one of `--preset` (a new thread,
parented to the invoking thread unless `--no-parent`; `--parent-notifications
auto|stuck|off`) or `--thread` (an existing thread, no preset needed).

Create or update the same execution selection exposed in the Tasks UI with
`--provider`, `--model`, `--reasoning`, and optional
`--service-tier <tier>`. A tier is an id the provider lists for the model
(`default`, `fast`, or another such as Codex `ultrafast`; see
`bb provider models <provider> --json`):

```sh
bb work-board preset create --name "Codex high" --provider codex \
  --model gpt-5.6-sol --reasoning high --service-tier fast \
  --permission auto
```

`preset update` accepts the same flags; `--clear-service-tier` clears a tier.
Do not combine it with `--service-tier`; `none` is a literal tier id.

## Schedule a start

A card can start its session later, for example at night when the load is lower or
when capacity is short. At the time Work Board launches the session itself, so
nothing runs on your side and **nothing is sent to the session before it starts**:
it does not exist until then.

```sh
# Spawn Gate project: the builder's arguments go after `--`
bb work-board schedule EXA-1 --at +3h --gate -- --card EXA-1 --role impl
# A project without Spawn Gate's Script mode: any provider and model it lists, with an optional brief
bb work-board schedule EXA-1 --at 2026-11-29T02:00:00+03:00 --agent codex/gpt-5 --reasoning high --brief-file brief.md
# or an agent preset (the project's default environment is used for --agent)
bb work-board schedule EXA-1 --at +3h --preset "Night worker"
# Create and schedule in one call
bb work-board create --project EXA --title "Nightly run" --start-at +6h --start-gate
```

- `--at` is an ISO time with an offset, or `+30m`, `+2h`, `+1d`, at least 2 minutes ahead.
- Give exactly one of `--gate`, `--agent <provider>/<model>` and `--preset`. `--agent` takes
  `--reasoning <level>` and `--permission accept-edits|auto|full` (default `auto`); the model must be
  one the provider lists (a refusal names its reason code), otherwise use `bb thread spawn` for a
  one-off. In a Spawn Gate project the gate chooses the agent, so `--agent` is refused there.
- `--gate` with no arguments uses the project's `scheduledStartArgs` setting, else
  `--card KEY --role impl`. The builder runs as a dry run when you schedule, so
  arguments it refuses are returned at once with their reason code and nothing is stored.
- A card has one active start: `schedule show KEY`, `schedule change KEY [--at …]`,
  `schedule cancel KEY [--reason …]`. The setter, the project's manager and the owner
  may change or cancel; once the launch is in progress they are refused.
- The launch goes through the project's Spawn Gate (admission, pace, provider rules
  still apply). A refused launch is written on the card and the setter, else its nearest
  live parent, else the manager, is told once. Nothing is retried.
- If the answer to the launch was lost, the start is `unknown`: a session may exist. Look
  at the project's threads and run `schedule resolve KEY --launched thr_… | --not-launched`.
  A new schedule on that card waits for the answer.
- `schedule log [KEY] [--project P] [--json]` lists every schedule, change, cancel, launch,
  refusal and resolution. The card's comments carry the same events.
