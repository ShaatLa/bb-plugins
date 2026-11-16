# Antigravity Tokens for Tokenomos

English | [Русский](TOKEN_USAGE.ru.md)

Tested on November 15, 2026, with `~/.local/bin/agy` **1.5.9** installed.
The live token source is available. All changes are confined to this worktree;
the version has not been updated, and neither the push nor the plugin installation steps were executed.

## Primary Sources and Findings

| Source | What was confirmed | Mapping and stability |
| --- | --- | --- |
| `agy --help`, `agy help acp` | Found `acp`, `--output-format stream-json`, `--conversation`, `--log-file`. No `stats`, `usage`, or `export` subcommands appear in the help. `/usage`, which the plugin already uses, returns quotas, not request tokens. | Help from the installed binary; no separate public contract for token usage found. |
| Native `agy acp`, actual `session/prompt` | The response includes `usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens }`. In the sample: 8831 input, 1 output, other counters are 0. The model is selected via `session/set_model`; the usage object itself does not contain a model ID. | `sessionId` of the native ACP session. The current BB shim generates its own ACP session ID, so this is a different identifier. Confirmed on 1.5.9; the BB SDK does not currently map this response to `tokenUsage`. |
| Native ACP notifications | Two `usage_update` events: `{used:0,size:1048576}` and `{used:8832,size:1048576}`. | `params.sessionId`; this reflects context filling, not a total of paid requests. No cache/reasoning/model data in the notification. |
| `agy --output-format stream-json` | A completed `step_update.step_update` contains `conversation_id`, `step_index`, `state: DONE`, `duration_seconds`, `usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`. `init.init.model` contains the selected CLI model ID. | Native conversation ID + step index. This is the source we use: a discrete completed generation, without recalculating cumulative conversation totals. Verified on fresh and resumed conversations. The schema is observable but not guaranteed by the public versioned API. |
| `stream-json result.result` | Same snake_case usage fields, `conversation_id`, `duration_seconds`, `num_turns`. **Counters and duration are accumulated per conversation**, not per current run. Fresh input/output: 9598/1; after resuming: 11853/2, cache 7555, num_turns 2. For a single new step only: 2255/1, cache 7555. | Do not simply append the final result on every BB turn: this would double-count previous requests. |
| `~/.gemini/antigravity-cli/conversations/*.db` | Tables `steps(metadata BLOB)`, `gen_metadata(data BLOB,size)`. From installed binary descriptors: `CortexStepMetadata.model_usage` = field 9; `ModelUsageStats`: model=1, input_tokens=2, output_tokens=3, cache_write_tokens=4, cache_read_tokens=5, thinking_output_tokens=9, response_output_tokens=10. Also includes timestamps, execution ID, model info. Example: output=1007, thinking=644, response=363. | DB name is the native conversation ID; the persisted `sessions/<ACP-id>.json` then links it to the BB `providerThreadId`. The model is an internal enum, not a ready-to-use CLI ID. Internal protobuf and SQLite structures have no compatibility guarantee. Not used in the implementation. |
| `gen_metadata` | Built-in `ChatModelMetadata` descriptors contain usage, model enum, `response_model` and `response_model_full`, timing, and retry info. The BLOB contains nested structures, including prompt/context; a custom parser/backfill has not been added. | Same DB. Internal format; the `steps.metadata` tokens are already sufficient for our analysis. |
| `stderr`, `cli.log`, `history.jsonl` | The `stderr` sample has no separate token record. In 149 local log files, no `input_tokens`/`output_tokens`/`thinking_output_tokens`/`cache_read_tokens`/`usage_update` fields were found. History contains `display`, `timestamp`, `workspace`, `conversationId`; no tokens in the checked entries. | History provides the conversation ID; logs do not provide a usable ledger. Absence in the checked logs does not guarantee absence in all future versions/modes. |
| `~/.gemini/antigravity` | The `conversations` directory was empty at the time of checking; the active CLI DBs are located in `antigravity-cli`. | Do not mix the two data directories. |
| `~/.bb/bb.db` | No `tokenUsage`/`contextWindowUsage` events for Antigravity appear in the read snapshot. `thread/identity.data.providerThreadId` contains the ACP ID. | Verified mapping: thread `thr_hfnpz6vtia` → ACP `0a27d231-22b1-4c7a-b01e-2b9c805a57c3`. In the shim, the ACP ID **does not match** the native `agy` conversation ID. |

SQLite was read without writing (`immutable=1`); this is a snapshot of the main file without unapplied WAL changes, not a transactionally consistent snapshot of a running BB. Protobuf descriptors were extracted using a custom, lightweight wire-reader from the installed binary; third-party downloaded research code was not executed.

## Probe Cost

Three trivial Gemini 3.8 Flash Low generations, outside BB, cwd `/tmp/agy-token-probe`:

- stream fresh: 9598 input + 1 output, cache 0;
- native ACP fresh: 8831 input + 1 output, cache 0;
- stream resume: 2255 input + 7555 cache read + 1 output.

Total **28239 prompt tokens, including 7555 cached, and 3 completion tokens**;
reasoning 0. The CLI did not report the monetary cost; it cannot be reliably derived from these token counts for a subscription. Actual BB threads for the probe messages were not created.
Raw outputs remain in `/tmp/agy-token-probe/{stream,acp,resume}.jsonl`.

## Implementation and exact contract

RPC plugin **`antigravity`**, method **`usage.list`**, read-only:

```ts
input: { after?: string; limit?: number } | null // default 200, integer 1..1000
output: { entries: Entry[]; nextCursor: string | null }
type Entry = {
  id: string;
  ts: number; // epoch ms when the completed step is received
  source: "thread";
  threadId: string | null;
  providerThreadId: string | null;
  model: string;
  promptTokens: number; // input_tokens + cache_read_tokens
  cachedTokens: number; // cache_read_tokens
  completionTokens: number; // output_tokens, reasoning already included
  reasoningTokens: number | null; // thinking_tokens, null if absent
  durationMs: number | null; // duration_seconds * 1000, rounded to ms
}
```

`id = ACP-session-id + ':' + native-conversation-id + ':' + step_index`.
`threadId` is taken from `BB_THREAD_ID`, `providerThreadId` — from the `session.id` shim.
If the BB thread id is unavailable, Tokenomos can link the providerThreadId via
`thread/identity`; if neither link is available, consumption cannot be attributed to a thread.
The model is taken from `init.init.model`, otherwise the session's selected model is used;
this is the CLI-selected model, not proof of backend routing during fallback.

Order is oldest first: `(ts,id)`. The cursor is opaque to the consumer; pass the
last received `nextCursor` without parsing it. It denotes the position after
returned entries and is **not null even on the last non-empty page**.
Only an empty page returns null: when polling, you must preserve the previous
non-empty cursor. Duplicate entries with the same id are collapsed on read. If the cursor entry
has already been deleted by rotation, reading starts from the oldest saved entry;
the consumer must deduplicate by id.

`shim.ts` saves only DONE steps with valid counters to the private
`bridge-data/usage.jsonl`; once it exceeds 8 MiB, the file is renamed
to `usage.1.jsonl`, replacing the previous archive. The RPC reads both files. The asynchronous write queue is not expected
on the response path; write errors are swallowed. On normal shutdown, up to 500 ms
is allowed for the queue to finish. The log does not contain prompt text, responses, or credentials.
`server.ts` registers the RPC; `token-usage.ts` contains the schema, reader, and writer.
Tests: `token-usage.test.ts`, with additions to `shim.test.ts`, `server.test.ts`,
`test/fake-agy.mjs`.

Checks completed with exit 0: **`npm run typecheck`**, **`npm test`**
(18 Node tests + 5 Vitest tests). The CLI cancellation check ran with normal
process visibility: inside the sandbox `ps` does not see the detached fixture process.

## Installation and Limitations

After reviewing the changes, the owner can run the following commands from `plugins/provider-antigravity`:

```sh
bb plugin build .
bb plugin install .
```

Then start a new bridge/shim session: a running process already holds the old code and won't automatically pick up the new build. Installation and live testing of the updated plugin were not performed as part of this work.

- The RPC reads the journal of the **local BB server host** as a file source.
  Journals from remote execution hosts are not aggregated by this RPC.
- Historical backfill from SQLite is not implemented. Usage tracking starts when the new shim is launched; older agy versions without step usage will not generate records.
- Forceful termination, disk failure, or cancellation before DONE may result in lost usage data.
  Asynchronous writes appear in the RPC with a slight delay; this is best effort.
- Only the current journal and one archive are kept, each up to ~8 MiB plus the last record. Older history is removed during the next rotation; if the cursor falls outside the saved history, reading restarts from the beginning. The reader loads both files in full. Rotation, like writing, is best effort during I/O failures and concurrent writes from multiple shim processes.
- Internal retries and helper backend requests that are not exposed as completed usage steps are not visible separately. Counters reflect the report generated by agy, not an independent reconciliation with Google billing.
- The stream-json format is confirmed for 1.5.9. If field formats change, the validator will skip invalid records instead of fabricating a zero-usage entry.
