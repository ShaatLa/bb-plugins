# Process Journal

Record how a process failed, track proposed fixes, and decide what to keep after measuring the effect. In BB, open **Process Journal** to select a project and manager. The board groups proposal cards by **Proposed**, **Applied**, **Measuring**, **Kept** and **Reverted**. Kept and Reverted show the last three months. Open a proposal card to see the proposal and its Entry on a dedicated page. **History** also includes Withdrawn proposals.

## Status display

Open **Settings → Plugins → Process Journal → Statuses** and select an enabled project. Edit column names, icons and colors, then drag a row by its handle to reorder it. With the handle focused, press Space, use the arrow keys, then press Space to drop or Escape to cancel. Display changes save automatically. A name saves when you leave its field or press Enter. Hidden columns are available from **Hidden columns** on the board, with a count and paginated proposal list for each. Hidden states also remain available in the **History** filter. Display edits keep every proposal in its existing state with its original deadline.

The keyed CLI read `bb process-journal config get boardDisplay --project proj_example` returns `{revision, columns}`. An unset setting returns revision 0 and null columns. A save takes `{expectedRevision, columns}` with all five canonical IDs (`proposed`, `applied`, `measuring`, `kept`, `reverted`) exactly once, in display order. Each row includes `id`, `name`, `icon`, `color` and `visible`. Use `default` for the built-in icon or color. Use null columns to restore the defaults, passing the revision you read.

```sh
bb process-journal config set boardDisplay '{"expectedRevision":1,"columns":null}' --project proj_example
```

On `board_display_conflict`, reload the setting before writing again. The keyed `config.get` and `config.set` RPCs use the same shape. Ordinary keyless config reads retain the existing project configuration. The `list` input optionally accepts `withTotal: true` to include the total across pages under the same filters.

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

Use **Settings → Plugins → Process Journal → Self-compound** to set the daily time and the project skill that supplies the launch instructions. Save the skill and configure an effective manager before enabling the schedule. Enabling can queue the most recent eligible run immediately. **Review runs** in the settings opens the selected project's run history.

The schedule queues the configured manager once for the most recent eligible local date. An active run blocks later dispatches until it has an outcome. **Review runs** shows each automatic review’s status and outcome and flags unfinished runs once another occurrence is due. The manager submits results from the assigned thread with stable keys and finishes the run. Use the local CLI to close an abandoned run with a reason.

## Lifecycle

Create an Entry for the failure and its evidence. Record one or more fix proposals with a hypothesis, deadline, success metric and rollback condition. Get independent hypothesis approval in Proposed before applying the fix. Record the implementation evidence in Applied, then move to Measuring with a check time and a later decision deadline. Record an observation before keeping or reverting. An independent review of the measured result is required before Kept. An urgent revert from Applied or Measuring requires an explicit override and reason. Record actual rollback evidence separately. Withdraw a superseded proposal with a reason.

Proposal deadlines and check times use Unix milliseconds in the CLI and RPC. The UI displays them in project time. On an open proposal, use the pencil beside the deadline to edit it. In Measuring, the check time has its own pencil. Open both fields to save the changes together. A check date tied to a Work Board card reconciles on the next normal pass; diverging updates use the conflict controls on the proposal. Stable submission keys are optional for interactive Entries and proposals and required for scheduled run submissions.

A minute sweep runs checks and sends deadline reminders. If the obligation remains open, it reminds the manager and asks that thread to open an Agent Hub question. An unreachable manager or a request without acknowledgment falls back to a stable Agent Hub notice. Threads may have received a message if the plugin was interrupted before recording delivery. Look for its stable reference in the timeline before sending it manually. Notice delivery is tracked separately from question acknowledgment.

### Independent review

The proposal manager assigns an existing independent thread in the same project. Work Board can keep using its own admissions and worktrees. A thread can review multiple proposals. The author, assigned managers and executors cannot approve the proposal. A child of the current manager can review when otherwise independent. The ancestry checks still exclude descendants of other recorded participants and of verified Work Board executors, including a manager whose work on a linked fix was previously verified.

1. The manager runs `review-assign` with `proposalId`, `revision`, `reviewerId`, `generation` (initially zero) and `reason`.
2. The manager runs `review-submit` with `proposalId`, `revision`, the assignment `generation`, the stage's `baseVersion` (initially zero) and `submission: {"stage":"hypothesis"}`. For a result, use `"stage":"result"` with a `conclusion` and `observationIds` (event sequence numbers from `proposal-detail`).
3. From the assigned reviewer thread, read `proposal-detail` and record `review-decide` with `proposalId`, `stage`, `version`, `generation`, `verdict` (`approved` or `changes_requested`) and free-text `feedback`. Review feedback can be written in any language.

A hypothesis approval carries into Applied while the snapshot is current. Deadline and check date changes and archiving the reviewer preserve the approval. Reassigning the reviewer reopens the current stage and preserves approved prior stages. Substantive edits require a new approval and supersede any result approval. A result review freezes the selected observations, including qualitative notes and evidence links. New observations stay in the timeline and can be included in a fresh result submission.

On first upgrade, proposals already in Applied or Measuring can use the existing experiment and evidence at result review. The next Kept transition needs result approval. A substantive change to an existing experiment needs hypothesis approval first. A proposal first applied during a later downgrade also needs hypothesis approval after upgrading again. The board shows the current review status and the proposal page shows the reviewer, versions, snapshots and feedback. If a transition lacks its current approval, the CLI returns `review_required` and RPC returns a conflict with that issue.

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

Link external evidence on the Entry or proposal. Use `fix-link` for an existing Work Board card or `fix-create` to create a fix card. Retry creation with the original key. A deleted or moved target needs review before you choose a new operation. When the next reconciliation sees both an approved hypothesis and completion of every linked fix card (Done or a confirmed PR merge), the proposal moves to Applied. If all the fixes finish while the proposal is still waiting for hypothesis approval, the journal alerts its manager through the normal reminder queue.

Choose at most one deadline-source card per proposal. Its date and the measuring check timestamp synchronize in project time. If both changed independently, choose a date in the proposal details or use `fix-resolve-deadline`. A card date must correspond to a check before the decision deadline.

## CLI and RPC

Use `bb process-journal <operation> --input '<JSON object>'` inside a BB thread, or pass `--project` outside one. The CLI emits JSON and a nonzero exit code on failure. Run `bb process-journal --help` for commands. RPC uses dotted names such as `proposal.detail` and `fix.resolveDeadline` and a `projectId` field. Use the CLI inside the assigned manager thread for operations that require its identity, including owner-question acknowledgment and scheduled submissions.

```sh
bb process-journal list --project proj_example --input '{"view":"history","range":"quarter","limit":25}'
bb process-journal proposal-detail --project proj_example --input '{"proposalId":"proposal_example"}'
bb process-journal fix-create --project proj_example --input '{"proposalId":"proposal_example","revision":2,"key":"example-first-fix","deadlineSource":true}'
```

See [the Process Journal skill](skills/process-journal/SKILL.md) for mutation payloads.
