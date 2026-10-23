# Tasks Plus

Source: [ShaatLa/bb-plugins](https://github.com/ShaatLa/bb-plugins/tree/main/plugins/tasks-plus). Install this collection entry with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin tasks-plus` after disabling built-in Tasks and completing any data import described below. Existing local-path Tasks Plus installations can be re-registered with `bb plugin install /path/to/collection --plugin tasks-plus` while retaining the same plugin ID and data.

Форк встроенного BB Tasks из BB 0.46.1. Сохраняет доску, списки, проекты, статусы, комментарии, вложения, пресеты и связи с тредами.

В карточке задачи появилась кнопка **Existing thread…**. Выбери существующий тред или вставь его ID. Занятый тред получит контекст задачи в очередь; свободный начнёт работу. Модель, права и окружение треда сохраняются. Пресет и привязка проекта для этого действия не нужны.

Кнопка выбора треда расположена над пресетом, обе занимают одинаковую ширину. В окне выбора **Use this thread by default** запоминает успешно выбранный тред для проекта на этом устройстве. Затем основная кнопка показывает его название и отправляет задачу напрямую; стрелка сразу открывает список тредов. Сброс **Clear default thread** находится в этом же окне. При неудачной отправке сохранённый выбор не меняется. Если к задаче уже привязан тред, основная кнопка меняется на **Go to thread** и открывает его без повторной отправки задачи.

Команда: `bb tasks dispatch ABC-12 --thread thr_existing --instructions "Дополнительные указания"`.
Для создания нового треда по-прежнему используется `--preset`; передавать оба флага нельзя.

В настройках **Tasks Plus → Open by default** выбирается стартовый экран: канбан последнего проекта (по умолчанию), список последнего проекта, все задачи или активные задачи. Последний выбранный проект запоминается на этом устройстве. Если он удалён, открывается первый доступный проект. Прямые ссылки продолжают открывать указанный в них экран.

Кнопка **Open kanban in side panel** в заголовке проекта открывает вкладку **Kanban** справа, рядом с Browser и Terminal, а в основной области показывает список задач. Вкладка также доступна в панели напрямую. Доска следует за выбранным проектом, сохраняет перетаскивание карточек и обновляется вместе со списком задач.

## Переключение со встроенного плагина

Tasks Plus использует ID `tasks-plus`: встроенный ID `tasks` зарезервирован BB. Команда `bb tasks` остаётся прежней, поэтому одновременно включать оба плагина нельзя.

Выполни из этого каталога после завершения записи задач работающими агентами:

```sh
bb plugin disable tasks
python3 scripts/import_tasks.py
bb plugin install .
```

Если предыдущие данные не нужны, пропусти импорт. Для другого каталога данных BB: `python3 scripts/import_tasks.py --data-dir /path/to/bb-data`.

Импорт выполняется **до установки Tasks Plus**: копирует SQLite через backup API, сохраняет ID, ключи, проекты, пресеты, комментарии, связи и файлы вложений. В скопированных описаниях и комментариях заменяет URL вложений на новый ID плагина. Оригинальные данные остаются на месте. Импорт откажется работать, если один из плагинов включён или каталог назначения уже существует. Настройки вида интерфейса и старые упоминания, адресованные ID встроенного плагина, не мигрируют.

После отключения встроенного плагина старые ссылки на вложения в истории чата могут перестать открываться; в перенесённых карточках задачи ссылки обновлены. Новые упоминания и карточки используют Tasks Plus.

Для возврата: `bb plugin disable tasks-plus`, затем `bb plugin enable tasks`. Новые изменения из Tasks Plus автоматически обратно не переносятся.

## Проверка и сборка

```sh
bun install
npm run typecheck
npm test
python3 -m unittest discover -s scripts -p 'test_*.py'
npm run build
```

Исходный релиз и лицензия: [UPSTREAM.md](UPSTREAM.md), [LICENSE](LICENSE).

---

## Документация исходного Tasks

# Tasks

Tasks is a Linear-style tracker inside bb for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

## Install

Install Tasks from the official plugins that BB includes:

```sh
bb plugin install tasks
```

The plugin adds the Tasks sidebar panel, the `bb tasks` command, and an agent
skill that teaches workers how to report progress back to tasks.

## Quick start

Install the plugin with `bb plugin install tasks`. Then use the `bb tasks` CLI
to create a tracker project. Link it to the bb project where delegated agents
will run:

```sh
bb tasks project create \
  --name "Product" \
  --prefix PROD \
  --link-bb-project proj_your_bb_project

bb tasks create \
  --project PROD \
  --title "Ship task delegation" \
  --description "Implement the flow and run focused validation." \
  --priority high

bb tasks list --project PROD
bb tasks show PROD-1
bb tasks preset list
bb tasks delegate PROD-1 --preset "GPT-5.6 · high"
```

When the CLI runs inside a linked bb project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive
at the CLI boundary. You can also delegate from a task's **Delegate** menu,
choose or create presets under **Manage → Presets**, and type `@` in the bb
composer to send a task mention to an agent.

The comment composer shows a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
authored the latest reply, resuming that thread when it is idle. Turn it off to
keep the comment in Tasks only. If no agent has replied, the disabled control
says so explicitly. Agents and scripts can use the same behavior with
`bb tasks comment PROD-1 --body "New context" --notify`.
The app and Tasks RPC return the saved comment before notification delivery,
with `notifiedCount` initially 0. Comment change events publish immediately and
again when delivery finishes. The CLI waits for delivery, so `--notify --json`
includes the final `notifiedCount`. Failed delivery leaves that count at 0.
When run from a thread, the CLI preserves that agent thread and any explicit
`--author`; notification still targets the prior latest responder rather than
the newly recorded agent comment itself.

## CLI reference

Run `bb tasks --help` or `bb tasks <command> --help` for exact options; help
works at every level, lists each option's accepted values and limits, and exits 0. Unknown commands and options are rejected with the nearest real name, every
missing required value is reported in one error, and a failing invocation that
carries `--json` prints `{ "ok": false, "error": { "code", "message", "hint"? } }`
on stdout while stderr keeps the readable text. Add `--json` to commands when
another command or agent will consume the output.

`--project` takes a tracker project prefix or id such as `PROD`, never a bb
project id (`proj_...`); `bb tasks project list` shows both columns. Repeatable
options (`--label`, `--status`, `--priority`, `--add-label`, `--remove-label`)
also accept one comma-separated list. File paths (`--file`, `--attach`,
`--out`, `--description-file`, `--body-file`) resolve on the invoking machine:
inside an agent thread that is the thread's machine, otherwise the server's
machine; pass `--machine <id-or-name>` to target another enrolled machine.

| Command                                        | Purpose                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bb tasks status`                              | Show the installed Tasks plugin name and version. Task workflow status lives on `bb tasks list --status` and `bb tasks update --status`.   |
| `bb tasks project create\|list\|show\|update`  | Manage tracker projects, folders, colors, prefixes, and bb-project links.                                                                  |
| `bb tasks folder create\|list\|update\|delete` | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted. |
| `bb tasks create`                              | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).          |
| `bb tasks list`                                | Page/filter tasks by project, status, priority, label, active agents, or search text; supports `--sort`, `--limit`, and `--cursor`.        |
| `bb tasks show <key-or-id>`                    | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                            |
| `bb tasks update <key-or-id>`                  | Update status, priority, title, description, due date, or labels.                                                                          |
| `bb tasks move <key-or-id>`                    | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.           |
| `bb tasks comment <key-or-id>`                 | Add a Markdown comment from inline text or a file; optionally notify the latest responding task agent.                                     |
| `bb tasks attachment add\|get\|list\|remove`   | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                      |
| `bb tasks preset list\|create\|update\|delete` | Manage reusable agent execution presets.                                                                                                   |
| `bb tasks delegate <key>`                      | Start and attach a new agent thread using a preset.                                                                                        |
| `bb tasks attach <key-or-id>`                  | Attach the current bb thread to a task when it was not delegated from Tasks.                                                               |
| `bb tasks detach <key-or-id>`                  | Detach the current bb thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                             |
| `bb tasks threads <key>`                       | List the bb threads attached to a task: live threads first, newest first.                                                                  |
| `bb tasks label create\|list\|delete`          | Manage project-scoped labels.                                                                                                              |
| `bb tasks seed-demo --yes`                     | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                               |

Statuses are `backlog`, `todo`, `in_progress`, `in_review`, `done`, and
`canceled`. Priorities are `urgent`, `high`, `medium`, `low`, and `none`.

Task lists default to 100 rows and accept `--limit 1-500`. JSON output is
`{ tasks, nextCursor, limit }`; human output prints the continuation option
when another page exists. The cursor is opaque and tied to the filters, sort,
and current task-list revision. If tasks are added, removed, reordered, or
updated between requests—or label links/names, active task threads, or project
prefixes change—the old cursor is rejected. Restart from the first page rather
than traversing an inconsistent snapshot.

## Agents, delegation, and presets

Linking a Tasks project to a bb project enables delegation. Open a task, choose
**Delegate**, select a preset, and optionally add instructions. A preset
defines the provider, model, reasoning level, optional service tier, permission
mode, and reusable instructions. Presets are user-defined, so create the worker profiles your team
uses repeatedly before dispatching work.

Delegation creates a worker thread in the linked bb project, attaches that
thread to the task, and advances a `backlog` or `todo` task to `in_progress`.
The worker receives the task description, subtasks, attachments, recent
comments, preset instructions, and a report-back contract. Its installed Tasks
skill tells it to inspect the task, leave substantive milestone comments,
attach artifacts, and move completed work to `in_review`.

If work begins outside the Delegate action, the agent can associate its current
thread with `bb tasks attach KEY`. The inverse is `bb tasks detach KEY
[--thread <id>]`, and each thread card on the task page has a detach control;
use either to drop a thread that died or moved on to other work. The task
page and `bb tasks threads` list live threads before completed or failed ones,
newest first.

## Task mentions

Type `@` in the bb composer and select **Tasks** to search by task key or title.
Sending the mention gives the agent the task's description, status, priority,
labels, subtasks, attachments, recent comments, attached threads, and CLI
action contract as context. Tasks linked to the current bb project rank first.

Inside a task description or comment, `@` also inserts a task pill. These
references are stored in Markdown as `[PROD-1](bbtask://PROD-1)`, so they remain
portable in task content.

Mentioning a task key such as `PROD-1` in an agent request also activates the
Tasks skill, which directs the worker to read and update the tracked task.

## Known limitations

- The **Auto** delegation preset is deferred; choose an explicit preset.
- List filters are local UI state and are not persisted in the URL.

## Fast follow

- Batch task-list enrichment for comments and attached-thread state.
- Add notifications and an inbox for task activity.
- Add a command palette entry for Tasks to cmd-K.
