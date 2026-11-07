# Scheduled Tasks integration

Concrete foundation: `shared/scheduled.ts` is the standalone Zod RPC contract (use `useRpc<ScheduledRpcContract>()`, NOT usePluginRpc). No methods are added to tasksRpcContract. Existing `useTasksQuery` may capture this separate RPC client and ignore its tasks RPC argument; `schedules:changed` is already supported by shell/data and signal-scheduler. Root owns server registration.

## Store

`createScheduledStore(bb, store: TasksApiStore)` returns synchronous methods, backed by migration 20 (applied by createStore):
- get(scheduleId): Schedule; detail(id): {schedule,task: API Task,dependencyIds}; create(input, now?: Date): Schedule; update({scheduleId,...partial fields},now?): Schedule; setEnabled(id,enabled,now?): Schedule; remove(id): boolean (actual delete of schedule/template, use ONLY after runtime cancel checks).
- list({projectId?,search?,needsAttention?,limit?,cursor?}): {schedules,nextCursor}; runs({projectId?,scheduleId?,search?,needsAttention?,limit?,cursor?}): {runs,nextCursor}; results({projectId?,scheduleId?,search?,limit?,cursor?}): {results:[{task,source}],nextCursor}. Offset cursors, max100/default50, detail descriptions fetched via detail/template task rather than copied into list records.
- run(id): ScheduleRun; reserve(scheduleId, occurrenceKey, scheduledForISO, now?): {run,created}. MUST reserve before any external action; created=false means return existing, never send twice. Old successful run sources retain occurrenceKey so history expiry cannot enable duplicate send.
- createRunTask(runId): StoredTask. Idempotent clone of template title/description/priority/label links/dependencies/attachment metadata with new attachment IDs and rewritten inline references; no prior comments/PRs; immutable blob paths shared. This creates a HIDDEN source startedAt=null, does NOT attach a thread or set in_progress. Call only AFTER preflight succeeds.
- updateRun(id, patch, now?): ScheduleRun, saveRun(run): ScheduleRun; markStarted(runId,{threadId,requestId,title,presetName},now?): ScheduleRun atomically sets actual startedAt, source startedAt, in_progress and working task_threads link. Idempotent. No SDK in store.
- due(now?,limit=25): Schedule[] uses enabled/next_due_at index; advance(id, expectedDue, nextDue|null,now?): boolean is SQL compare-and-swap. Runtime must place advance+reserve in store.transaction before SDK dispatch, fast-forward stale periods with nextOccurrence(rule,now) rather than unbounded catch-up loop.
- pending(threadId?,limit=100): ScheduleRun[] (max500), only operational starting/queued/running/delivery_unknown/cancel_pending, excludes historical=true. Runtime needs fairness if more than a batch and no all-history scanning.
- resolve(runId,note,now?): ScheduleRun records resolvedAt, refuses still-active states. Unknown resolution is not proof of no execution.
- cleanup(now?): number deletes only completed history >=30d since finishedAt and resolved skipped/failed/canceled >=7d since resolvedAt. Never deletes sources/tasks/comments/blobs, never age-deletes unknown/active.
- source(taskId): ScheduleSource|null; setSource(source): void; overlaps(scheduleId): unfinished source runIds (max100); preview(rule, after?:Date,count=3): ISO[] max10; apiTask(StoredTask): API Task.

`scheduled/recurrence.ts`: recurrenceSchema/Recurrence re-exported from shared/scheduled; nextOccurrence strictly-after Date|null; localSlotKey (fold identity), isWithinGrace inclusive30min. Daily and weekly cron-parser DST default: spring shift, fall once; weekly Sunday=0.

## Tables and provenance

`task_schedules`: id UUID PK, project_id FK projects CASCADE, template_task_id FK tasks (restrict), rule/target JSON, enabled integer, next_due_at, created_at, updated_at.
`task_scheduled_sources`: task_id FK tasks CASCADE PK, schedule_id UUID (NO FK, original source identity survives schedule deletion), schedule_title, role template|recurring_run|one_time_run, scheduled_for|null, started_at|null, run_id|null, occurrence_key|null. Unique(schedule_id,occurrence_key) for non-null, indexed schedule_id/role/task_id.
`task_schedule_runs`: id UUID PK, schedule_id UUID NO FK, project_id FK projects CASCADE, occurrence_key, state, resolved_at, finished_at, thread_id plus payload JSON of full ScheduleRun. Unique(schedule_id,occurrence_key); indexed pending states and history/retention. No raw large events/session logs retained.

Run states/fields are EXACTLY in shared/scheduled.ts. execution is a small JSON record of applied settings, pushState not_attempted|sent|failed, pushChannels and pushError. historical=true makes imported history non-operational. Sources and instances remain accessible via Results, even if schedule and run-history rows no longer exist. Existing taskSchema now permits ordinaryVisible:false for direct lookups; listTasks has includeScheduled=false by default. Root ordinary filtering/patchTasks support preserves explicit direct task access.

## Runtime/API worker

Implement `scheduledService(bb,store)` and `createScheduledHandlers(bb,store)` / `registerScheduled(bb,store)` in service.ts/index.ts using the standalone `scheduledRpcContract`. Export `registerScheduled` for root server.ts. registerScheduled must synchronously register events/RPC/background schedule before fire-and-forget bounded startup reconciliation. Reuse the store methods above and match ALL contract methods. CLI can call `bb.sdk.plugins.callRpc({pluginId:"work-board",method,input,outputSchema:scheduledRpcContract[method].output})` so it does not depend on your in-progress module.

For getSchedule return scheduled.detail(); list/create/update/preview/source/runs/results are direct store-backed. Runtime owns run/retry/cancel/delete safety, SDK/push, run state sync, coalescing. Template task is available to ordinary attachment/question/dependency/comment tools. All methods parse shared boundary schemas.

## Archive worker

Capture these three tables in bulk per project; do not call getters per task. Schedules need template title from JOIN tasks; sources must include runId and occurrenceKey, and results whose schedule was deleted. Runs parse payload schema. Export/import v13 retains old v1–12 compatibility. Restore source and row payload fields after all tasks exist. Imported schedules enabled=false,next_due_at=null; imported runs historical=true, threadId/queueId/requestId cleared (or only kept separately as historical metadata), NEVER resume operational queued runs. Preserve original role/provenance even if schedule absent. Validate project/task refs before deletion. Root API/db list defaults preserve internal unfiltered task reads for capture.

Focused foundation checks: scheduled/recurrence.test.ts and scheduled/store.test.ts. Root runs full suite/build/install.

Import clarification: scheduleTargetSchema also accepts `{kind:"unassigned"}` as the explicit imported/unresolved target. Imported schedules use it with enabled=false; enabling without choosing a real thread/preset is refused. It is a target-resolution state, not a third execution mode. Frontend must render Choose target for this case.
