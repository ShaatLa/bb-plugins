# Токены Antigravity для Tokenomos

[English](TOKEN_USAGE.md) | Русский

Проверено 15 ноября 2026, установленный `~/.local/bin/agy` **1.5.9**.
Источник реальных токенов есть. Изменения находятся только в этом worktree;
версия не изменена, push и установка рабочего плагина не выполнялись.

## Первичные источники и результаты

| Источник | Что подтверждено | Привязка и стабильность |
| --- | --- | --- |
| `agy --help`, `agy help acp` | Есть `acp`, `--output-format stream-json`, `--conversation`, `--log-file`. Подкоманд stats/usage/export в help нет. `/usage`, который уже использует плагин, возвращает квоты, а не токены запросов. | Help установленного бинарника; отдельного публичного контракта token usage не найдено. |
| Нативный `agy acp`, реальный `session/prompt` | Ответ содержит `usage: { inputTokens, outputTokens, cachedReadTokens, cachedWriteTokens, thoughtTokens, totalTokens }`. В пробе: 8831 input, 1 output, остальные счётчики 0. Модель выбирается через `session/set_model`; в самом usage model id нет. | `sessionId` нативной ACP-сессии. Текущий BB shim создаёт собственный ACP session id, поэтому это другой идентификатор. Подтверждено на 1.5.9; SDK BB сейчас не переводит этот ответ в tokenUsage. |
| Нативные ACP notifications | Два `usage_update`: `{used:0,size:1048576}` и `{used:8832,size:1048576}`. | `params.sessionId`; это заполнение контекста, не сумма оплаченных запросов. Cache/reasoning/model в notification нет. |
| `agy --output-format stream-json` | Завершённый `step_update.step_update` содержит `conversation_id`, `step_index`, `state: DONE`, `duration_seconds`, `usage: {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}`. `init.init.model` содержит выбранный CLI model id. | Нативный conversation id + индекс шага. Это используемый источник: отдельная завершённая генерация, без повторного подсчёта итогов беседы. Проверено на fresh и resumed conversation. Схема наблюдаемая, не гарантированная публичным versioned API. |
| `stream-json result.result` | Те же snake_case usage, `conversation_id`, `duration_seconds`, `num_turns`. **Счётчики и duration накоплены по беседе**, не по текущему запуску. Fresh input/output: 9598/1; после продолжения result: 11853/2, cache 7555, num_turns 2. Только новый шаг: 2255/1, cache 7555. | Нельзя просто append итоговый result на каждом BB turn: это удвоит предыдущие запросы. |
| `~/.gemini/antigravity-cli/conversations/*.db` | Таблицы `steps(metadata BLOB)`, `gen_metadata(data BLOB,size)`. В дескрипторах установленного бинарника: `CortexStepMetadata.model_usage` = поле 9; `ModelUsageStats`: model=1, input_tokens=2, output_tokens=3, cache_write_tokens=4, cache_read_tokens=5, thinking_output_tokens=9, response_output_tokens=10. Также timestamps, execution id, model info. Пример: output=1007, thinking=644, response=363. | Имя DB = нативный conversation id; далее persisted `sessions/<ACP-id>.json` связывает его с BB providerThreadId. Model — внутренний enum, не готовый CLI id. Внутренний protobuf и SQLite не имеют гарантии совместимости. Не используем их в реализации. |
| `gen_metadata` | Встроенные дескрипторы `ChatModelMetadata` содержат usage, model enum, response_model и response_model_full, timing, retry info. BLOB содержит вложенные структуры, включая prompt/context; собственный parser/backfill не добавлен. | Та же DB. Внутренний формат; токены `steps.metadata` уже достаточны для исследования. |
| stderr, `cli.log`, `history.jsonl` | В stderr проб нет отдельного token record. В 149 локальных log-файлах нет полей input_tokens/output_tokens/thinking_output_tokens/cache_read_tokens/usage_update. History содержит display, timestamp, workspace, conversationId; токенов в проверенных записях нет. | History даёт conversation id, логи не дают пригодного ledger. Отсутствие в проверенных логах не гарантирует отсутствие во всех будущих версиях/режимах. |
| `~/.gemini/antigravity` | Каталог conversations пуст на момент проверки; актуальные CLI DB находятся в `antigravity-cli`. | Не смешивать два каталога данных. |
| `~/.bb/bb.db` | Для Antigravity нет tokenUsage/contextWindowUsage events в прочитанном snapshot. `thread/identity.data.providerThreadId` содержит ACP id. | Проверенная связка: thread `thr_hfnpz6vtia` → ACP `0a27d231-22b1-4c7a-b01e-2b9c805a57c3`. В shim ACP id **не равен** нативному agy conversation id. |

SQLite читалась без записи (`immutable=1`); это snapshot основного файла без
неприменённых WAL-изменений, не транзакционно полный снимок работающего BB.
Дескрипторы protobuf извлечены собственным небольшим wire-reader из установленного
бинарника; сторонний скачанный исследовательский код не запускался.

## Стоимость проб

Три тривиальных генерации Gemini 3.8 Flash Low, вне BB, cwd `/tmp/agy-token-probe`:

- stream fresh: 9598 input + 1 output, cache 0;
- native ACP fresh: 8831 input + 1 output, cache 0;
- stream resume: 2255 input + 7555 cache read + 1 output.

Итого **28239 prompt tokens, включая 7555 cached, и 3 completion tokens**;
reasoning 0. Денежную стоимость CLI не сообщил, её нельзя достоверно вывести
из этих токенов для подписки. Реальные BB-треды probe-сообщений не получали.
Сырые выводы остались в `/tmp/agy-token-probe/{stream,acp,resume}.jsonl`.

## Реализация и точный контракт

RPC плагина **`antigravity`**, метод **`usage.list`**, read-only:

```ts
input: { after?: string; limit?: number } | null // default 200, integer 1..1000
output: { entries: Entry[]; nextCursor: string | null }
type Entry = {
  id: string;
  ts: number; // epoch ms при получении завершённого шага
  source: "thread";
  threadId: string | null;
  providerThreadId: string | null;
  model: string;
  promptTokens: number; // input_tokens + cache_read_tokens
  cachedTokens: number; // cache_read_tokens
  completionTokens: number; // output_tokens, reasoning уже включён
  reasoningTokens: number | null; // thinking_tokens, null если отсутствует
  durationMs: number | null; // duration_seconds * 1000, округление до ms
}
```

`id = ACP-session-id + ':' + native-conversation-id + ':' + step_index`.
`threadId` берётся из `BB_THREAD_ID`, `providerThreadId` — из session.id shim.
Если BB thread id недоступен, Tokenomos может связать providerThreadId через
`thread/identity`; при отсутствии обеих связок нельзя приписывать расход треду.
Модель берётся из `init.init.model`, иначе используется выбранная модель сессии;
это выбранная модель CLI, а не доказательство backend routing при fallback.

Порядок oldest first: `(ts,id)`. Курсор — opaque для потребителя; передавать
последний полученный `nextCursor` без разбора. Он обозначает позицию после
возвращённых записей и **не null даже на последней непустой странице**.
Только пустая страница возвращает null: при polling надо сохранить предыдущий
непустой курсор. Повторы записей с одинаковым id схлопываются при чтении. Если запись курсора
уже удалена ротацией, чтение начинается с самой старой сохранённой записи;
потребитель должен исключать повторы по id.

`shim.ts` сохраняет только DONE-шаги с валидными счётчиками в приватный
`bridge-data/usage.jsonl`; после превышения 8 MiB файл переименовывается
в `usage.1.jsonl`, заменяя предыдущий архив. RPC читает оба файла. Асинхронная очередь записи не ожидается
на пути ответа; ошибка записи поглощается. При штатном выходе есть до 500 ms
на завершение очереди. В журнале нет текста prompts, ответов и credentials.
`server.ts` регистрирует RPC; `token-usage.ts` содержит схему, reader и writer.
Тесты: `token-usage.test.ts`, дополнения `shim.test.ts`, `server.test.ts`,
`test/fake-agy.mjs`.

Проверки завершились с exit 0: **`npm run typecheck`**, **`npm test`**
(18 Node tests + 5 Vitest tests). Проверка отмены CLI запускалась с обычной
видимостью процессов: внутри sandbox `ps` не видит detached fixture process.

## Установка и ограничения

После просмотра изменений владелец может выполнить из `plugins/provider-antigravity`:

```sh
bb plugin build .
bb plugin install .
```

Затем начать новую bridge/shim-сессию: уже запущенный процесс содержит старый
код и сам по себе сборку не подхватит. Установка и live-проверка заменённого
плагина в этой работе не выполнялись.

- RPC читает journal **локального BB server host**, как файловый источник.
  Journals удалённых execution hosts этим RPC не агрегируются.
- Исторический backfill из SQLite не реализован. Учёт начинается с запуска
  нового shim; старые версии agy без step usage не создадут записи.
- Принудительное завершение, сбой диска или отмена до DONE могут потерять usage.
  Асинхронная запись появляется в RPC с небольшой задержкой; это best effort.
- Хранятся текущий журнал и один архив, каждый примерно до 8 MiB плюс
  последняя запись. Более старая история удаляется при следующей ротации;
  курсор за пределами сохранённой истории запускает чтение заново. Читатель
  загружает оба файла целиком. Ротация, как и запись, best effort при сбоях I/O
  и одновременных записях нескольких shim-процессов.
- Внутренние retries/вспомогательные backend-запросы, не представленные как
  завершённые usage-шаги, отдельно не видны. Счётчики отражают отчёт agy,
  а не независимую сверку с биллингом Google.
- Формат stream-json подтверждён на 1.5.9. При изменении полей validator
  пропустит неподходящую запись, а не создаст выдуманный нулевой расход.
