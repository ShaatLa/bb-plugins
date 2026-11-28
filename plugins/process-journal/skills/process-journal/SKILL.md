---
name: process-journal
description: Record process failures and handle Process Journal proposals, deadlines, evidence, escalations and scheduled reviews.
---

# Process Journal

Record the failure in the same turn. Spell out the evidence, the gap in the process and what the fix would change. Keep an assigned manager and a future deadline on every open proposal. Use `bb process-journal` inside the project thread or pass a BB project ID with `--project`.

## Operations

Supply a JSON object in `--input`. Output is JSON. Get the current revision with `proposal-detail` before a revision-checked edit. Use Unix milliseconds for deadline and check timestamps.

| Command | Input |
| --- | --- |
| `entry-add` | `title`, `failure`, `gap`, optional `links`, stable `key`, `runId`, and first `proposal` object. |
| `entry-list` | Optional `unproposed`, `limit` and `offset`. |
| `proposal-add` | `entryId`, `proposal`, optional `runId`. |
| `list` | Optional `managerId`, `state`, `view` (`board` or `history`), `range` (`week`, `month`, `quarter`), `overdue`, `limit` and `offset`. Follow `nextOffset`. |
| `proposal-detail` | `proposalId` and optional timeline cursor `before`. |
| `proposal-update` | `proposalId`, `revision` and `patch`; for example `{"managerId":"thr_example"}`. |
| `review-assign` | From the proposal manager thread: `proposalId`, `revision`, existing project `reviewerId`, current `generation` (0 initially) and `reason`. |
| `review-submit` | From the manager: `proposalId`, `revision`, `generation`, `baseVersion` (0 initially) and `submission` with `stage` (`hypothesis` or `result`). For a result, include `conclusion` and `observationIds` from the proposal detail timeline. |
| `review-decide` | From the reviewer thread: `proposalId`, `stage`, `version`, `generation`, `verdict` (`approved` or `changes_requested`) and free-text `feedback`. |
| `proposal-transition` | `proposalId`, `revision` and `transition` with `state`, `reason`, future `deadlineAt` for Applied or Measuring, and `checkAt` for Measuring. Use `override:true` only for an urgent revert before measuring. |
| `proposal-measure` | `proposalId`, `revision`, `observation` with a finite number in `value` or Markdown `note`, and optional `evidence` URLs. |
| `proposal-comment`, `proposal-rollback` | `proposalId` and `body` or rollback `evidence`, respectively. |
| `fix-create`, `fix-link` | `proposalId`, `revision`, and stable create `key` or existing `taskKey`. Mark at most one card `deadlineSource:true`. |
| `fix-resolve-deadline` | `proposalId`, `revision`, `taskId`, `prefer` (`journal` or `card`). |
| `digest` | Optional `managerId`. |
| `run-list`, `run-finish` | List accepts `limit`, `offset`, and `managerId`. Finish accepts `runId`, `status` (`completed` or `failed`), and optional `note`. |

A proposal object requires `title`, `hypothesis`, `rollbackCondition`, `deadlineAt` and `metric` with a `definition`. It accepts `managerId`, `links`, and a stable `key`. A metric accepts a `unit`, numeric `baseline` and `target`, or a configured metric `command` name. Include a stable `key` with each scheduled submission. Use the CLI in the run manager thread for its results and owner-question acknowledgments. The RPC caller context identifies a BB client or plugin and does not carry a manager thread.

## Board display

In Process Journal settings, a project can customize status names, icons, colors, order and visibility. **Hidden columns** on Board lists hidden proposals and their counts; History still offers all status filters. Continue using canonical lifecycle IDs in commands and transitions.

Read `bb process-journal config get boardDisplay --project proj_example` for the current display revision and columns. Set the field with JSON `{"expectedRevision":1,"columns":null}` to reset from revision 1, or pass an ordered list containing all five board status IDs with their presentation fields. On a conflict, reload before retrying. Use `withTotal:true` in list input when you need a filtered total across pages.

## Independent review

Before Applied, get an independent hypothesis approval covering the incident, fix, metric and rollback condition. Independent reviewers are existing same-project threads outside the author, manager and executor chains. Once Measuring has evidence, get a result approval before Kept. Submit exact observation IDs, including qualitative notes with links when applicable. Use the submitted snapshot, not the live metric view, when reviewing. Use the latest stage version and generation from the proposal detail. If a substantive edit invalidates a review, submit a new version. Older Applied and Measuring proposals can review the measured result using their existing experiment. Work Board reconciliation applies a completed linked fix only when its hypothesis has a current approval.

## Escalation and scheduled reviews

On a deadline message, look up the proposal and record the measure, decision or new deadline. For an owner question, first look in Agent Hub for an existing question matching the stable proposal and effect references. Use `agent_hub_ask` in the manager thread and record the returned ID with `proposal-ack` using `proposalId`, `effectId` and `questionId`. Use the associated Work Board card for owner decisions on project rules.

On the proposal page, use **Edit dates** to update the deadline and the Measuring check in the project's timezone. A linked Work Board due date is handled by the next reconciliation.

Use **Settings → Plugins → Process Journal → Self-compound** to save the daily time, select the named project skill that supplies the launch instructions, and enable or disable scheduled runs. The effective schedule manager and project timezone come from the existing project config.

On a scheduled review, run the named project skill, page through open proposals, and submit any findings with the supplied run ID. Finish the run even if there are no new findings. Keep a failed run's explanation in its outcome so the next occurrence can dispatch.
