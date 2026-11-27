# Process Journal

Record how a process failed, track proposed fixes, and decide what to keep after measuring the effect. In BB, open **Process Journal** to select a project and manager, see Entry columns and their proposal cards, and review three months of proposal history.

## Configure a project

Start with the project disabled. Set one field at a time, using BB project and thread IDs.

```sh
bb process-journal config set managers '["thr_example"]' --project proj_example
bb process-journal config set defaultManager thr_example --project proj_example
bb process-journal config set timeZone UTC --project proj_example
bb process-journal config set enabled true --project proj_example
bb process-journal config get --project proj_example
```

| Field | Purpose |
| --- | --- |
| `managers`, `defaultManager` | Allowed manager threads and the default assignment. |
| `timeZone`, `checkTime` | Project timezone and the local check time used for a date-only Work Board edit. |
| `graceMinutes`, `appliedMinutes` | Time between escalations and the initial deadline after Work Board confirms a fix. |
| `boardProject` | Optional Work Board project ID. Use a linked or unlinked board scoped to this project. Work Board 0.108.0 or newer supplies guarded writes. |
| `scheduleManager`, `scheduleSkill`, `scheduleTime` | Manager (defaults to the project's default manager), project skill, and local time of a review. |
| `catchUpMinutes`, `scheduleEnabled` | Frequency for checking missed runs and the schedule's independent enable switch. |
| `scheduleCoveredThrough` | Optional local `YYYY-MM-DD` of the last occurrence covered by an earlier workflow. The journal starts after this date. |

The schedule queues the configured manager once for the most recent eligible local date. An active run blocks later dispatches until it has an outcome. Review its status under **Scheduled reviews**, which flags unfinished runs once another occurrence is due. The manager submits results from the assigned thread with stable keys and finishes the run. Use the local CLI to close an abandoned run with a reason.

## Lifecycle

Create an Entry for the failure and its evidence. Record one or more fix proposals with a hypothesis, deadline, success metric and rollback condition. Move a proposal from Proposed to Applied with implementation evidence, then to Measuring with a check time and a later decision deadline. Record an observation before keeping or reverting. An urgent revert from Applied or Measuring requires an explicit override and reason. Record actual rollback evidence separately. Withdraw a superseded proposal with a reason.

Proposal deadlines and check times use Unix milliseconds in the CLI and RPC. The UI displays them in project time. Stable submission keys are optional for interactive Entries and proposals and required for scheduled run submissions.

A minute sweep runs checks and sends deadline reminders. If the obligation remains open, it reminds the manager and asks that thread to open an Agent Hub question. An unreachable manager or a request without acknowledgment falls back to a stable Agent Hub notice. Threads may have received a message if the plugin was interrupted before recording delivery. Look for its stable reference in the timeline before sending it manually. Notice delivery is tracked separately from question acknowledgment.

### Metrics

Use Markdown for a qualitative definition or observation. A quantitative metric can also have a unit, baseline, target and numeric observations. A trusted metric command must print exactly one finite number to stdout. Configure named commands in the plugin's native `metricCommands` setting as a JSON object.

```json
{
  "example-count": {
    "file": "/usr/bin/printf",
    "cwd": "/tmp",
    "args": ["0"],
    "timeoutMs": 1000
  }
}
```

A proposal references `example-count` by name. Process Journal launches commands without a shell, with a bounded runtime and output, and passes no proposal data to them. Assign commands only when you trust the executable and its directory. A failed or interrupted command leaves a timeline entry and requests a manual observation.

### Work Board

Link external evidence on the Entry or proposal. Use `fix-link` for an existing Work Board card or `fix-create` to create a fix card. Retry creation with the original key. A deleted or moved target needs review before you choose a new operation. All designated fix cards must be Done or have a confirmed linked merge to move a Proposed proposal to Applied.

Choose at most one deadline-source card per proposal. Its date and the measuring check timestamp synchronize in project time. If both changed independently, choose a date in the proposal details or use `fix-resolve-deadline`. A card date must correspond to a check before the decision deadline.

## CLI and RPC

Use `bb process-journal <operation> --input '<JSON object>'` inside a BB thread, or pass `--project` outside one. The CLI emits JSON and a nonzero exit code on failure. Run `bb process-journal --help` for commands. RPC uses dotted names such as `proposal.detail` and `fix.resolveDeadline` and a `projectId` field. Use the CLI inside the assigned manager thread for operations that require its identity, including owner-question acknowledgment and scheduled submissions.

```sh
bb process-journal list --project proj_example --input '{"view":"history","range":"quarter","limit":25}'
bb process-journal proposal-detail --project proj_example --input '{"proposalId":"proposal_example"}'
bb process-journal fix-create --project proj_example --input '{"proposalId":"proposal_example","revision":2,"key":"example-first-fix","deadlineSource":true}'
```

See [the Process Journal skill](skills/process-journal/SKILL.md) for mutation payloads.
