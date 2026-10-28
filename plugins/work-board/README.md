# Work Board

Source: [ShaatLa/bb-plugins](https://github.com/ShaatLa/bb-plugins/tree/main/plugins/work-board). Install this collection entry with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board` after disabling built-in Tasks and completing any data import described below. Existing local-path Work Board installations can be re-registered with `bb plugin install /path/to/collection --plugin work-board` while retaining the same plugin ID and data.

Трекер проектов для совместной работы людей и AI-агентов внутри BB. Основан на встроенном BB Tasks из BB 0.46.1 и сохраняет его проекты, комментарии, вложения, пресеты и связи с тредами.

- Списки и канбан в основной и правой панели, эпики и сабтаски, поиск, фильтры и настраиваемые статусы каждого проекта.
- Передача задач существующим тредам и отдельные Owner actions для ручных действий владельца.
- Вопросы с одиночным или множественным выбором, рекомендуемыми вариантами и сохранением ответов прямо в задаче.
- Связи с GitHub PR, наблюдение за CI и push-workflows после merge, структурированные свидетельства ревью и QA, шаблоны описаний.
- Поисковый архив завершённых задач, ручная и массовая архивация, опциональная автоматическая архивация.
- Детерминированный экспорт и импорт проекта с комментариями, вложениями, вопросами и связями — для хранения истории в Git. Работа через UI и `bb work-board` CLI.

В карточке задачи появилась кнопка **Existing thread…**. Выбери существующий тред или вставь его ID. Занятый тред получит контекст задачи в очередь; свободный начнёт работу. Модель, права и окружение треда сохраняются. Пресет и привязка проекта для этого действия не нужны.

Кнопка выбора треда расположена над пресетом, обе занимают одинаковую ширину. В окне выбора **Use this thread by default** запоминает успешно выбранный тред для проекта на этом устройстве. Затем основная кнопка показывает его название и отправляет задачу напрямую; стрелка сразу открывает список тредов. Сброс **Clear default thread** находится в этом же окне. При неудачной отправке сохранённый выбор не меняется. Если к задаче уже привязан тред, основная кнопка меняется на **Go to thread** и открывает его без повторной отправки задачи.

Команда: `bb work-board dispatch ABC-12 --thread thr_existing --instructions "Дополнительные указания"`.
Для создания нового треда по-прежнему используется `--preset`; передавать оба флага нельзя.

В настройках **Work Board → Open by default** выбирается стартовый экран: канбан последнего проекта (по умолчанию), список последнего проекта, все задачи или активные задачи. Последний выбранный проект запоминается на этом устройстве. Если он удалён, открывается первый доступный проект. Прямые ссылки продолжают открывать указанный в них экран.

Кнопка **Open kanban in side panel** в заголовке проекта открывает вкладку **Kanban** справа, рядом с Browser и Terminal, а в основной области показывает список задач. Вкладка также доступна в панели напрямую. Доска следует за выбранным проектом, сохраняет перетаскивание карточек и обновляется вместе со списком задач.

Вкладка **Work Board** в правой панели треда по умолчанию показывает доску проекта Work Board, связанного с BB-проектом этого треда. Карточки на доске и новые задачи открываются в той же вкладке; **Back to project board** возвращает к доске. Ключ и кнопка назад находятся в заголовке самой карточки, над названием; кнопка копирования стоит рядом с ключом и копирует только ключ; отдельная верхняя полоса задачи в боковой панели не занимает место. Открытие конкретной задачи из сообщения сохраняется. Стрелка в заголовке открывает доску или задачу в основном разделе Work Board. Если связь проектов отсутствует, панель предлагает **Manage projects**, не подменяя её последним просмотренным проектом.

Доска в основном экране и правой панели использует общие фильтры **Type**, **Status**, **Priority**, **Label** и кнопку **Clear**. Выбор сохраняется для проекта вместе с фильтрами списка задач; ручной порядок карточек и перетаскивание сохраняются.

Поле **Search tasks** в списке и на доске сразу принимает текст и показывает результаты под полем после ввода. Оно ищет по ключу, названию и описанию, включая эпики, подзадачи и завершённые задачи. Поиск не ограничивается фильтрами текущего вида. В проекте он ограничен этим проектом; в All tasks и Active ищет во всех проектах. Точный ключ также распознаёт прежние ключи перемещённых задач. Результат открывается прямо в текущей панели; выбор поддерживает клавиатуру. В выбранном проекте можно вводить только номер задачи: он проверяется напрямую по ключу. При открытии вида заранее загружается индекс активных задач, включая эпики, сабтаски и описания. Ввод фильтрует его локально, без задержки перед запросом и без RPC на каждую букву; обновления точечно подгружаются в фоне. Текстовый поиск показывает первые 25 совпадений и сообщает, когда запрос нужно уточнить. Прежние ключи перемещённых задач и точные ключи архивных задач по-прежнему разрешаются сервером, если их нет в локальном индексе.


## Переход с Agent Board / Tasks Plus на Work Board (0.11.0)

Это смена ID плагина, а не установка второй независимой доски. Новый ID и папка коллекции — `work-board`, команда — **`bb work-board …`**. Старых CLI-алиасов нет. Сначала обновите потребителей команды: автоматизации, роли агентов и строгие проверки экспорта. Маркер `project.json.format` теперь `bb-work-board`; структура и версия **v8** прежние. Импорт принимает также `bb-agent-board` и `bb-tasks-plus` (v1–v8).

Сохраните настройки (`bb plugin config agent-board --json`) и сделайте резервную копию БД через SQLite backup API и копию `blobs`. Остановите старый плагин перед переносом; каталог назначения не должен существовать:

```sh
bb plugin disable agent-board
python3 scripts/import_tasks.py --source-plugin agent-board
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board
bb work-board status --json
```

Если установлен Tasks Plus, используйте `tasks-plus` вместо `agent-board` в командах сохранения настроек, отключения и `--source-plugin`. Помощник находится в новой папке `plugins/work-board/scripts`.

Помощник копирует БД в `~/.bb/plugins/work-board`, сохраняет ID и все таблицы, переносит вложения и меняет только старые URL вложений на новый ID, включая ссылки в вопросах и JSON-истории. Исходник остаётся нетронутым; повторный перенос поверх существующих данных запрещён. Через `bb plugin config work-board set …` восстановите сохранённые значения `autoArchiveAfterDays` и `defaultScreen`. PR-настройки и связи находятся в самой БД: переносите их актуальные значения на момент переключения. Старый плагин оставьте выключенным до проверки переноса и экспорта, затем удалите его регистрацию; резервные копии сохраняйте отдельно.

При откате после новых записей переносите **последние** данные назад, а не заменяйте их старым снимком. Отключите Work Board, сохраните оба каталога и освободите каталог назначения, затем используйте `--source-plugin work-board --destination-plugin agent-board` (или `tasks-plus`); установите прежний замороженный релиз и восстановите настройки. Параметр `--data-dir` поддерживает другой каталог BB.

Последний проект, вид, фильтры и предпочитаемые тред/пресет переносятся на устройстве один раз; текущие предпочтения Agent Board приоритетнее старых Tasks Plus. Старые значения сохраняются для отката, кеши не переносятся. Исторические сообщения и сериализованные упоминания в BB не переписываются. Директива `::task{key="ABC-1"}` сохраняется. Старые ссылки вложений внутри импортируемых архивов нормализуются; архивы с данными аккаунтов и токенами не создаются.

## Загрузка карточки

Карточка показывает локальные данные задачи, сохранённые треды и комментарии, не ожидая GitHub и уточнения метаданных агентов. Эти данные обновляются независимо в фоне: карточка остаётся доступной, открытые редакторы и вводимый заголовок сохраняются. Загрузка Git обозначается вращающейся стрелкой в блоке Pull requests; синхронизация не блокирует добавление и редактирование PR-ссылок. В Activity сначала отображаются последние 20 записей; **Show earlier activity** раскрывает более ранние порциями по 20, не удаляя историю. Обычные комментарии читает штатный Markdown-рендер BB вместо отдельного редактора на каждый комментарий; старые специальные ссылки плагина продолжают работать.

Evidence сначала показывает последние 15 записей. **Show earlier evidence** раскрывает историю порциями по 15; группировка по PR и head и отметки superseded сохраняются. Ограничение касается отображения, вся история остаётся в данных и экспорте.

Доска показывает первую страницу задач сразу, не дожидаясь метаданных, вопросов, PR и Git. При повторном открытии использует сохранённый набор задач и обновляет его в фоне. Доска, обычный список и поиск делят одну загрузку активных задач, включая сабтаски; фильтры списка и поиск работают локально. Страницы UI допускают изменения данных во время чтения и уточняются событиями; CLI по умолчанию сохраняет строгую проверку ревизии курсора.

Колонки виртуализированы: в DOM находятся карточки видимой области с запасом, остальные представлены пространством для прокрутки. Высота карточек измеряется; раскрытые сабтаски сохраняют состояние. Прокрутка и перетаскивание используют координаты всей колонки.

Счётчики вложений и активные связи с тредами читаются пакетами по 500 ID, максимум четыре RPC одновременно. Вопросы и сводки PR обновляются точечно. Сводки PR читают только нужные JSON-поля из SQLite, без разбора полных CI-отчётов. Git-поллинг отправляет отдельные события для проверенных PR, а не инвалидирует все задачи проекта. Формат экспорта, CLI и данные задач не изменены.

## Статусы проекта

В **Settings → Plugins → Work Board → Task statuses** выберите проект. Кнопка **+ Add status** добавляет строку с названием нового этапа (например, **In testing**). ID создаётся автоматически. Название сохраняется по Enter или при выходе из поля; добавленные статусы удаляются корзиной. Перетаскивание за маркер слева меняет порядок статусов и колонок на доске. С клавиатуры: пробел, стрелки, затем пробел или Enter; Escape отменяет перенос. Сохранение автоматическое. Настройки относятся только к выбранному проекту и используются в списке, основной и правой досках, фильтрах и меню карточки.

ID статуса — постоянная ссылка, имя можно менять. Разрешены 1–64 строчных латинских символа, цифры и `_`, первый символ — буква. Имя: 1–80 символов. В проекте 6–32 статуса, ID и имена уникальны. Шесть системных ID (`backlog`, `todo`, `in_progress`, `in_review`, `done`, `canceled`) сохраняются; названия и порядок менять можно. Новые этапы считаются незавершёнными. Завершение задач и уведомления owner по-прежнему привязаны к `done`, отмена — к `canceled`.

Удаление статуса с задачами отклоняется: сначала перенесите их в другой статус. Перенос задачи/эпика между проектами сохраняет статус и отклоняется целиком, если в целевом проекте нет нужного ID.

```sh
bb work-board project show ANV --json
bb work-board create --project ANV --title 'Проверить сборку' --status in_testing
bb work-board update ANV-8 --status in_testing
bb work-board list --project ANV --status in_testing
bb work-board list --project ANV --exclude-status done,canceled
bb work-board project update ANV --statuses-file ./statuses.json
```

Файл `statuses.json` — полный упорядоченный массив `[{"id":"backlog","name":"Backlog"}, …]` со всеми системными ID. Он читается на вызывающей машине; для удалённой машины поддерживается `--machine`. RPC: `updateProject({projectId, statuses:[{id,name},…]})`; поле `project.statuses` есть в JSON проекта. Экспорт **v6** сохраняет этот массив в `project.json`, `task.status` содержит ID. Импорт v1–v5 восстанавливает исходные шесть статусов. Другие файлы архива не меняются.

## Защита от секретов

Начиная с **0.1.1**, создание и изменение задач и эпиков, запись комментариев (включая агентские) и импорт проверяют новые заголовки, описания и тела комментариев на известные форматы ключей GitHub, AWS, Slack, Google, Anthropic, OpenAI, JWT и блоки приватных ключей. Запись отклоняется целиком; ошибка называет поле и формат, не раскрывая значение. Обходного флага нет, `import --overwrite` тоже не отключает проверку.

Проверка распознаёт форматы, а не все возможные секреты. Вложения и уже сохранённые данные она не сканирует; проверку перед отправкой в Git следует сохранить.

## Вопросы с выбором ответа

В карточке задачи или эпика откройте **Add question** в правом баре (в узкой карточке — среди свойств сверху). Добавьте текст и 2–20 вариантов; **Allow multiple answers** включает множественный выбор. Ответ сохраняется кнопкой **Save answer**; **Clear selection → Save answer** очищает его. Это текущее решение по вопросу, не опрос с отдельными голосами каждого пользователя. Изменения ответов записываются в историю задачи. У вопроса и каждого варианта свои постоянные ID; подписи не используются как ссылки. Конкурирующий ответ со старой revision отклоняется.

```sh
bb work-board question add ANV-8 --prompt 'Какой размер?' --option 'Маленький' --option 'Большой' --json
bb work-board question add ANV-8 --prompt 'Какие платформы?' --option macOS --option Linux --multiple --json
bb work-board question list ANV-8 --json
bb work-board question answer ANV-8 --question <question-id> --answer <option-id> --revision 1
bb work-board question answer ANV-8 --question <question-id> --clear --revision 2
bb work-board question delete ANV-8 --question <question-id> --revision 3
```

Для множественного выбора повторите `--answer`. Вопросы видны в центральной и боковой карточке, в `show --json`, контексте делегирования и упоминаниях задач. Экспорт переносит вопросы вместе с вариантами, выбранными ID, автором ответа и revision. Защита от секретов действует на текст вопросов, вариантов и метаданные ответа.


После изменения ответа плагин уведомляет первый закреплённый рабочий тред (активные идут первыми), иначе — последнего ответившего агента. Занятый тред получает сообщение в очередь; повторное сохранение того же ответа не уведомляет снова. Ошибка доставки сохраняет ответ и отображает предупреждение. Перед продолжением агент перечитывает актуальное решение. На карточках и строках показывается иконка вопроса со счётчиком и подсказкой; фильтр **Needs answer** работает в списке, центральной и правой досках и запоминается для проекта.

Свободный ответ: создатель включает **Allow other answer** или `question add --allow-other`. Пользователь выбирает **Other answer**, вводит текст и сохраняет. Для single текст заменяет выбор варианта, для multiple их можно сочетать. CLI: `bb work-board question answer KEY --question ID --revision N --text "Ответ"`. Экспорт v3 сохраняет `allowOther`, `answerText` и `history`; импорт v1/v2 поддерживается.

Редактирование: **Edit question** в карточке, либо `bb work-board question update KEY --question ID --revision N --prompt "Новый текст"`. `--options-file` читает JSON-массив `[{"id":"существующий ULID","label":"Новое название"},{"label":"Новый вариант"}]` на вызывающей машине; существующие ID сохраняйте, для новых вариантов ID не указывайте. `--mode single|multiple`, `--allow-other` / `--no-other` меняют режим. У отвеченного вопроса требуется явное **Clear the saved answer and request a new decision** или `--reopen`: прежний ответ остаётся в **History**, текущий очищается и снова появляется Needs answer. Старая revision отклоняется. Каждое изменение сохраняет прежний снимок; отмена и повторное сохранение одинакового содержимого историю не меняют.

Рекомендуемый вариант показывается жирным, без метки и автоматического выбора. В редакторе включите **Recommend** рядом с вариантом; необязательное поле **Recommendation reason** объясняет рекомендацию. CLI: `bb work-board question add KEY --prompt 'Вопрос?' --option A --option B --recommend 1 --recommendation-reason 'Обоснование'`; номера при создании начинаются с 1. Изменение по постоянному ID: `question update KEY --question ID --revision N --recommend OPTION_ID [--recommendation-reason TEXT]`; повторяйте `--recommend` для multiple, `--no-recommendation` очищает рекомендации. В options JSON допустимы optional `recommended: true` и `recommendationReason`. У single максимум один рекомендуемый вариант, у multiple — несколько; обоснование допустимо только для recommended=true. Секреты проверяются и в обосновании. Экспорт v4 сохраняет эти поля также в history; импорт v1–v3 поддерживается. Старые явные суффиксы «(рекомендую)» / «(recommended)» отображаются жирным без суффикса, сохранённые подписи не меняются автоматически.

## Evidence и шаблоны описаний

`bb work-board comment` без `--kind` остаётся обычным комментарием. `--kind review|qa|merge|deploy|exemption` добавляет проверенные структурированные данные; `--body` / `--body-file` по-прежнему содержит свободное замечание. Все SHA — ровно 40 hex-символов. Evidence сохраняется как необязательное поле `evidence` комментария; верхнеуровневый `kind` остаётся `user`, `agent` или `system`.

```sh
bb work-board comment ANV-8 --kind review --pr 123 --head <full-sha> --verdict approve --thread thr_review --lens correctness --body 'Ревью пройдено'
bb work-board comment ANV-8 --kind qa --head <full-sha> --verdict partial --thread thr_qa --pr 123 --target localenv --note docs/qa.md --body 'Замечания в отчёте'
bb work-board comment ANV-8 --kind merge --pr 123 --head <full-sha> --merge <full-sha> --part 1/2 --body 'Слито'
bb work-board comment ANV-8 --kind deploy --merge <full-sha> --run <ci-run-id-or-url> --env development --body 'Развёрнуто'
bb work-board comment ANV-8 --kind exemption --row qa --reason 'Только документация' --owner-quote 'QA не требуется' --date 2026-10-23 --body 'Согласовано'
bb work-board evidence ANV-8 --pr 123 --kind review --kind qa --json
```

Для review обязательны PR, head, verdict и thread. Для qa — head, verdict и thread. Для merge — PR, head и merge. Для deploy — merge, run и env. Для exemption — row и reason; owner-quote и date передаются только вместе. Evidence находится над историей в карточке и над Comments в `show`; `--json` сохраняет полные SHA и все поля. Группировка идёт по PR и head, предыдущие heads отмечены superseded. Поздний carry-over verdict по уже встреченному head не объявляет его новым head. Deploy связывается с PR по сохранённому merge. Индекс ничего не решает о полноте проверок и не меняет статус. PR-ссылка появляется, когда её URL уже доступен среди связей карточки с PR; при отсутствии URL показывается номер.

### Целостность evidence

Evidence автоматически сохраняет записавший thread (для UI — null); `--thread` остаётся thread проверяющего. Карточка и `show --json` предупреждают о проверке автором PR и об отсутствии approve/pass на merged head; при неизвестном авторе предупреждения нет. Данные сохраняются в экспорте комментариев, старые архивы совместимы. Предупреждения не блокируют запись.

Новые записи дополняют историю; существующий evidence-комментарий нельзя заменить через импорт даже с `--overwrite`. Проверка секретов распространяется и на структурированные поля.

```sh
bb work-board template set --project ANV --name task --body-file templates/task.md
bb work-board template show --project ANV --name task
bb work-board template list --project ANV --json
bb work-board create --project ANV --title 'Новая задача' --template task --description 'Дополнительные критерии'
bb work-board template delete --project ANV --name task
```

Шаблоны хранятся по ID внутри проекта, содержат Markdown и переносятся через архив. `--description` добавляется после шаблона. Необязательный `template set --label <имя>` привязывает шаблон к существующей метке того же проекта по её ID. При создании задачи без `--template` применяется шаблон привязанной метки; неоднозначность требует явного `--template`. Проверок заполнения шаблона и автоматических переходов статуса нет.

Ссылки `::task{key="ANV-8"}` теперь отображаются компактными плашками с коротким названием и полным названием при наведении. Синтаксис остаётся отдельной leaf-директивой; размещение внутри предложения требует поддержки со стороны BB. Колонки доски растут на доступную ширину с минимумом 230 px; узкая панель сохраняет горизонтальную прокрутку.

## Эпики

При создании выбери **Type → Epic**. В списке доступен фильтр **Type → Epic**; на доске эпики помечены молнией. В свойствах обычной задачи поле **Epic** добавляет её в эпик того же проекта. В карточке эпика видны задачи и прогресс завершения, кнопка **Add task** создаёт новую входящую задачу. Подзадачи остаются у обычных задач и наследуют контекст эпика через родителя.

Эпики используют общую нумерацию проекта, статусы, описание, комментарии, вложения и привязку тредов. Статус эпика меняется вручную; прогресс считается по завершённым входящим задачам. Агент получает описание эпика вместе с контекстом своей задачи.

```sh
bb work-board create --project ABC --title "Big initiative" --type epic
bb work-board create --project ABC --title "First task" --epic ABC-1
bb work-board update ABC-2 --epic ABC-1
bb work-board list --type epic
bb work-board list --epic ABC-1
bb work-board show ABC-1
bb work-board update ABC-2 --no-epic
```

Перенос эпика в другой проект переносит его задачи вместе с подзадачами, сохраняя связи и старые ключи. Перенос отдельной задачи снимает её связь с прежним эпиком. Удаление эпика сохраняет входящие задачи. Вложенные эпики не поддерживаются; изменить тип можно после удаления связей и дочерних задач. Существующие записи при обновлении остаются обычными задачами.

## Хранение проекта в Git

```sh
bb work-board export --project ANV --out .bb/tasks/<project-id>
bb work-board import --from .bb/tasks/<project-id>
# Replace conflicting imported records explicitly:
bb work-board import --from .bb/tasks/<project-id> --overwrite
```

`--project` принимает префикс или ID. `--out` задаёт отдельный каталог, который ещё не существует, пуст либо уже содержит выгрузку этого же проекта. Пути относятся к машине вызывающего треда; вне треда — к серверу BB. Для другой машины есть `--machine <id-or-name>`. Относительные пути считаются от рабочего каталога вызова.

```text
.bb/tasks/<project-id>/
  project.json
  tasks/<task-id>.json
  attachments/<attachment-id>
```

`project.json` содержит маркер формата `bb-work-board`, версию `8`, проект, его метки, родительские папки, список ID задач и `templates`. Файл задачи содержит все сохранённые поля задачи или эпика, Markdown-описание, ID меток, комментарии (включая необязательное `evidence`), `questions`, связи с тредами, старые ключи и метаданные вложений с SHA-256. Имена задач и вложений остаются данными, не используются в путях. Двоичные вложения задач и комментариев находятся в `attachments/` под своими ID. Новых каталогов для вопросов, evidence и шаблонов нет. Локальные пути хранилища и время запуска экспорта не записываются; одинаковые данные дают одинаковые файлы. Импорт поддерживает архивы v1/v2/v3/v4: отсутствующие вопросы, шаблоны и history считаются пустыми, allowOther — false, answerText — null. Архив v5 добавляет в `task` поля `executionTarget` (`agent`/`owner`, по умолчанию `agent`) и `requesterThreadId` (BB thread ID или null, по умолчанию null). Импорт старых архивов подставляет эти значения. Проверки формата в автоматизации должны принимать v5 перед обновлением до 0.5.x.

Выгрузка сначала собирается во временном каталоге и затем заменяет предыдущую копию. При ошибке записи или замены предыдущая копия сохраняется. Посторонние файлы в каталоге выгрузки запрещены: исходники репозитория нужно хранить за его пределами.

Импорт проверяет формат, связи, владельцев ID и целостность вложений, затем изменяет базу одной транзакцией. Новые записи добавляются, одинаковые пропускаются. Отличающиеся существующие записи требуют `--overwrite`; коллизии ID между разными проектами или владельцами не разрешаются даже этим флагом. Отсутствующие в выгрузке задачи, комментарии, метки и вложения не удаляются. У импортированной задачи поле `labelIds` задаёт её набор меток; его изменение также требует `--overwrite`. Счётчик номеров задач только увеличивается.

При экспорте каталог отражает текущее состояние BB: сначала импортируй нужные изменения из Git, чтобы не заменить их данными из BB. Команды не делают commit/push и не запускают агентов. Связи с тредами сохраняются как ссылки; полные чаты, внешнее содержимое PR, глобальные пресеты и настройки BB в снимок проекта не входят.

## Переключение со встроенного плагина

Work Board использует ID `work-board`: встроенный ID `tasks` зарезервирован BB. Команда `bb work-board` остаётся прежней, поэтому одновременно включать оба плагина нельзя.

Выполни из этого каталога после завершения записи задач работающими агентами:

```sh
bb plugin disable tasks
python3 scripts/import_tasks.py
bb plugin install .
```

Если предыдущие данные не нужны, пропусти импорт. Для другого каталога данных BB: `python3 scripts/import_tasks.py --data-dir /path/to/bb-data`.

Импорт выполняется **до установки Work Board**: копирует SQLite через backup API, сохраняет ID, ключи, проекты, пресеты, комментарии, связи и файлы вложений. В скопированных описаниях и комментариях заменяет URL вложений на новый ID плагина. Оригинальные данные остаются на месте. Импорт откажется работать, если один из плагинов включён или каталог назначения уже существует. Настройки вида интерфейса и старые упоминания, адресованные ID встроенного плагина, не мигрируют.

После отключения встроенного плагина старые ссылки на вложения в истории чата могут перестать открываться; в перенесённых карточках задачи ссылки обновлены. Новые упоминания и карточки используют Work Board.

Для возврата: `bb plugin disable work-board`, затем `bb plugin enable tasks`. Новые изменения из Work Board автоматически обратно не переносятся.

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

## Daily workflow

Work Board is a Linear-style tracker inside bb for planning work, delegating it to
agents, and keeping the task record connected to the threads doing the work.
It provides projects and folders, task keys, statuses and priorities, labels,
subtasks, Markdown comments, attachments, agent presets, and a full CLI.

## Install

Install Work Board from this collection after completing any required migration:

```sh
bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board
```

The plugin adds the Work Board sidebar panel, the `bb work-board` command, and an agent
skill that teaches workers how to report progress back to tasks.

## Quick start

Install the plugin with `bb plugin install git:https://github.com/ShaatLa/bb-plugins.git@main --plugin work-board`. Then use the `bb work-board` CLI
to create a tracker project. Link it to the bb project where delegated agents
will run:

```sh
bb work-board project create \
  --name "Product" \
  --prefix PROD \
  --link-bb-project proj_your_bb_project

bb work-board create \
  --project PROD \
  --title "Ship task delegation" \
  --description "Implement the flow and run focused validation." \
  --priority high

bb work-board list --project PROD
bb work-board show PROD-1
bb work-board preset list
bb work-board delegate PROD-1 --preset "GPT-5.6 · high"
```

When the CLI runs inside a linked bb project, `create` and `list` infer the
tracker project, so `--project` can be omitted. Task keys are case-insensitive
at the CLI boundary. You can also delegate from a task's **Delegate** menu,
choose or create presets under **Manage → Presets**, and type `@` in the bb
composer to send a task mention to an agent.

The comment composer shows a **Notify last responding agent** switch. When the
task has an agent reply, leave it on to send the new comment to the thread that
authored the latest reply, resuming that thread when it is idle. Turn it off to
keep the comment in Work Board only. If no agent has replied, the disabled control
says so explicitly. Agents and scripts can use the same behavior with
`bb work-board comment PROD-1 --body "New context" --notify`.
The app and Work Board RPC return the saved comment before notification delivery,
with `notifiedCount` initially 0. Comment change events publish immediately and
again when delivery finishes. The CLI waits for delivery, so `--notify --json`
includes the final `notifiedCount`. Failed delivery leaves that count at 0.
When run from a thread, the CLI preserves that agent thread and any explicit
`--author`; notification still targets the prior latest responder rather than
the newly recorded agent comment itself.

## CLI reference

Run `bb work-board --help` or `bb work-board <command> --help` for exact options; help
works at every level, lists each option's accepted values and limits, and exits 0. Unknown commands and options are rejected with the nearest real name, every
missing required value is reported in one error, and a failing invocation that
carries `--json` prints `{ "ok": false, "error": { "code", "message", "hint"? } }`
on stdout while stderr keeps the readable text. Add `--json` to commands when
another command or agent will consume the output.

`--project` takes a tracker project prefix or id such as `PROD`, never a bb
project id (`proj_...`); `bb work-board project list` shows both columns. Repeatable
options (`--label`, `--status`, `--exclude-status`, `--priority`, `--add-label`, `--remove-label`)
also accept one comma-separated list. File paths (`--file`, `--attach`,
`--out`, `--description-file`, `--body-file`) resolve on the invoking machine:
inside an agent thread that is the thread's machine, otherwise the server's
machine; pass `--machine <id-or-name>` to target another enrolled machine.

| Command                                        | Purpose                                                                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `bb work-board status`                              | Show the installed Work Board plugin name and version. Task workflow status lives on `bb work-board list --status` and `bb work-board update --status`.   |
| `bb work-board project create\|list\|show\|update`  | Manage tracker projects, folders, colors, prefixes, and bb-project links.                                                                  |
| `bb work-board folder create\|list\|update\|delete` | Organize tracker projects into nested folders. Deleting a folder moves its projects and subfolders to the top level; no tasks are deleted. |
| `bb work-board create`                              | Create a task with description, priority, labels, due date, optional parent, and file attachments (repeatable `--attach <path>`).          |
| `bb work-board list`                                | Page/filter tasks by project, status, priority, label, active agents, or search text; supports `--sort`, `--limit`, and `--cursor`.        |
| `bb work-board show <key-or-id>`                    | Show the complete task record, including comments, attachments, subtasks, and attached threads.                                            |
| `bb work-board update <key-or-id>`                  | Update status, priority, title, description, due date, or labels.                                                                          |
| `bb work-board move <key-or-id>`                    | Move a task and its sub-tasks to `--project`. Moved tasks get new keys; old keys keep resolving, and labels are matched by name.           |
| `bb work-board comment <key-or-id>`                 | Add a Markdown comment from inline text or a file; optionally notify the latest responding task agent.                                     |
| `bb work-board attachment add\|get\|list\|remove`   | Add, fetch, list, or remove attachments. Referenced attachments require `remove --remove-references`.                                      |
| `bb work-board preset list\|create\|update\|delete` | Manage reusable agent execution presets.                                                                                                   |
| `bb work-board delegate <key>`                      | Start and attach a new agent thread using a preset.                                                                                        |
| `bb work-board attach <key-or-id>`                  | Attach the current bb thread to a task when it was not delegated from Work Board.                                                               |
| `bb work-board detach <key-or-id>`                  | Detach the current bb thread (or `--thread <id>`) from a task, for example a dead predecessor after a respawn.                             |
| `bb work-board threads <key>`                       | List the bb threads attached to a task: live threads first, newest first.                                                                  |
| `bb work-board label create\|list\|delete`          | Manage project-scoped labels.                                                                                                              |
| `bb work-board seed-demo --yes`                     | Create sample folders, projects, labels, tasks, and comments for evaluation.                                                               |

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

Linking a Work Board project to a bb project enables delegation. Open a task, choose
**Delegate**, select a preset, and optionally add instructions. A preset
defines the provider, model, reasoning level, optional service tier, permission
mode, and reusable instructions. Presets are user-defined, so create the worker profiles your team
uses repeatedly before dispatching work.

Delegation creates a worker thread in the linked bb project, attaches that
thread to the task, and advances a `backlog` or `todo` task to `in_progress`.
The worker receives the task description, subtasks, attachments, recent
comments, preset instructions, and a report-back contract. Its installed Work Board
skill tells it to inspect the task, leave substantive milestone comments,
attach artifacts, and move completed work to `in_review`.

If work begins outside the Delegate action, the agent can associate its current
thread with `bb work-board attach KEY`. The inverse is `bb work-board detach KEY
[--thread <id>]`, and each thread card on the task page has a detach control;
use either to drop a thread that died or moved on to other work. The task
page and `bb work-board threads` list live threads before completed or failed ones,
newest first.

## Task mentions

Type `@` in the bb composer and select **Work Board** to search by task key or title.
Sending the mention gives the agent the task's description, status, priority,
labels, subtasks, attachments, recent comments, attached threads, and CLI
action contract as context. Work Board linked to the current bb project rank first.

Inside a task description or comment, `@` also inserts a task pill. These
references are stored in Markdown as `[PROD-1](bbtask://PROD-1)`, so they remain
portable in task content.

Mentioning a task key such as `PROD-1` in an agent request also activates the
Work Board skill, which directs the worker to read and update the tracked task.

## Known limitations

- The **Auto** delegation preset is deferred; choose an explicit preset.
- List filters are local UI state and are not persisted in the URL.

## Fast follow

- Batch task-list enrichment for comments and attached-thread state.
- Add notifications and an inbox for task activity.
- Add a command palette entry for Work Board to cmd-K.


## Owner action

Исполнитель хранится отдельно от типа задачи: `executionTarget: agent | owner`. Задача для owner может входить в эпик, иметь подзадачи, обычные статусы, приоритет и метки. На доске её выделяют иконка человека, Owner и тонкая цветная полоса; фильтр Executor → All / Agent / Owner работает в списке, основной и боковой досках. Создание и свойства карточки позволяют выбрать исполнителя.

```sh
bb work-board create --project ABC --title 'Выдать доступ к registry' --executor owner   --description 'Агент не может изменить IAM. Готово, когда тестовый pull проходит.'
bb work-board list --project ABC --executor owner
bb work-board update ABC-12 --executor owner --requester-thread thr_requester
bb work-board update ABC-12 --status done
```

CLI сохраняет инициирующий тред автоматически при создании Owner action или переводе в Owner; `--requester-thread` задаёт его явно. UI использует текущий тред, когда он доступен; в свойствах можно выбрать Use this thread as requester. Ссылка Requester thread открывает инициатора. При создании вне треда получатель может отсутствовать, и уведомление не отправляется.

Кнопки запуска агента скрыты; оба dispatch API и CLI запрещают запуск Owner action. Перевод задачи с работающим агентом в Owner требует сначала остановить агента. Агент может создать запрос, добавить описание и комментарии, отслеживать результат; не выполняет ручное действие и не подтверждает его за owner. В описании укажите действие, причину обращения и проверяемый результат; отдельной валидации заполнения нет.

Переход в Done через свойства, список, доску или CLI атомарно записывает комментарий о завершении, затем уведомляет сохранённый тред через queue-if-active. Повторный Done не дублирует уведомление; после переоткрытия новое завершение уведомляет снова. Недоступный тред или ошибка доставки не откатывают статус; предупреждение сохраняется в Activity и возвращается как `notification: not_sent` (при успехе `sent`). Автоматической повторной доставки нет. Импорт только восстанавливает данные, не рассылает уведомления.


### Исключение статусов в CLI

```sh
bb work-board list --project ANV --exclude-status done --json
bb work-board list --project ANV --exclude-status done,canceled --json
bb work-board list --project ANV --status todo,done --exclude-status done --json
```

Флаг можно повторять. Исключения вычитаются из `--status`, а без него — из всех статусов. Если не осталось статусов, результат пустой. Фильтр применяется до пагинации и сочетается с остальными фильтрами. Формат архива остаётся v5.


Кнопка копирования рядом с ключом карточки копирует ключ и актуальное название как `ABC-12 · Название задачи`. Работает в основном экране и боковой панели; успешное копирование отмечается галочкой, ошибка — сообщением.


Вопросы саб-тасок видны на обеих досках и во вкладке Kanban через карточку родителя. Верхний счётчик складывает вопросы родителя и его подзадач; подсказка показывает разбивку. Нажмите счётчик, чтобы раскрыть саб-таски, либо **Sub-tasks · готово/всего**. В раскрытом списке — ключ, название, статус и счётчик вопросов; задачи с вопросами идут первыми. Нажатие открывает саб-таску в текущей панели. Фильтр **Needs answer** сохраняет родителя при вопросах внутри подзадачи и автоматически раскрывает только подзадачи, ожидающие ответа, включая завершённые. После ответа счётчик и фильтр обновляются. Саб-таски не становятся отдельными карточками/колонками и не участвуют в перетаскивании доски.


### Archived worker threads (0.7.2)

Work Board keep multiple worker links. Opening a task's thread list, notifying a worker, and BB's archive event check actual thread state. Archived, deleted and missing workers are detached; an available replacement stays attached. If none remains, follow the latest worker's `parentThreadId` chain to the nearest available ancestor, up to the root. If that ancestor is later archived, continue up its parent chain. The task becomes unassigned only when the chain has no available ancestor. Cycles, missing threads and private side-chat boundaries stop traversal. Transient lookup failures preserve the links for a later check.

New and replacement workers should run `bb work-board attach KEY`; this preserves other current workers. `bb work-board detach KEY --thread thr_old` detaches explicitly, without automatic parent fallback. Attachments and detachments are recorded as system events in Activity with thread links; these comments also survive export/import in the unchanged archive v6. Unarchiving a detached worker does not reattach it automatically. Notifications never retry a failed send to another worker, avoiding duplicate deliveries.


### Task archive (0.8.0)

The **Archive** section keeps completed cards off working lists and both boards. Archiving is manual: open a Done/Canceled card and click **Archive task**, or select a project in **Archive** and click **Archive completed**. A family with unfinished children stays on the board. Archiving a task or epic archives its completed children too; restoring it restores the family. Individually archived sub-tasks whose parent is archived require restoring that parent first. Status, IDs, descriptions, questions, evidence, comments, attachments and worker history are preserved. Completing a card does not immediately archive it. In plugin settings, **Automatically archive completed tasks** offers Off (default), 7, 14 or 30 days. The hourly check requires the whole active family to be Done/Canceled and inactive for that period. Task edits, comments, attachments and question changes restart the inactivity period. Unanswered questions and working agents prevent automatic archival. A restored card gets a fresh inactivity period.

The archive has project filtering, search, card links and **Restore**. Archived cards remain directly accessible by key. Agents use `bb work-board archive KEY`, `bb work-board restore KEY`, `bb work-board archive-completed --project PREFIX`, and `bb work-board list --project PREFIX --archived [--search TEXT] --json`. `--include-archived` lists both scopes; the two flags are mutually exclusive. `bb work-board show KEY` also works for archived cards. Dispatch requires restoring the card first.

Export v7 always includes both archived and live cards, with required `task.archivedAt` (`null` or a UTC ISO timestamp with milliseconds). Import v1–v6 defaults an absent timestamp to null. No task is deleted by archiving or restoration.

### Archive queries and automatic retention (0.8.1)

The Archive view supports project and text search (key, title or description), inclusive UTC date bounds, a date field (archived, created or updated), and pages of the latest 25/50/100/500 matching cards. Use equal start/end dates for one day. Previous/Next browse further results; restart results if a concurrent write makes a pagination cursor stale.

Agents can combine these with the existing status, executor, type, priority and label filters:

```sh
bb work-board show ANV-8 --json
bb work-board list --project ANV --archived --latest 20 --json
bb work-board list --project ANV --archived --search "registry access" --json
bb work-board list --project ANV --archived --on 2026-10-24 --json
bb work-board list --project ANV --archived --from 2026-10-01 --to 2026-10-24 --latest 50 --json
bb work-board list --project ANV --archived --date-field created --on 2026-10-01 --json
```

`--latest N` selects newest order and the page size (1–500); a `nextCursor` permits continuing with the same filters. `--sort newest` also works with `--limit`. Dates are `YYYY-MM-DD`, inclusive in UTC. With `--archived`, the default date field is archived; otherwise it is created. `--date-field updated` selects last task-record modification (including archival/restoration), not the last comment. `--on` cannot be combined with `--from`/`--to`. Exact key/ID lookup is `show`, which reads either archive scope. The RPC uses `dateField`, `dateFrom`, `dateTo`, `sort: "newest"` and the existing `limit`/`cursor`.

Automatic retention is a device/plugin setting, applies to all tracker projects, and is disabled until enabled. It runs while BB has the plugin loaded; missed checks are caught by the next hourly sweep. It preserves the existing manual and bulk actions. Export stays v7, includes all records, and carries no device settings.


### PR file overlaps

Open linked PRs in the same repository show shared files across different tasks. Configure up to 50 `overlapRules` in Git/PR Advanced settings or `git-config --file`, for example `[{"pattern":"migrations/**","match":"added"},{"pattern":"docs/traceability/*.json","match":"changed"}]`. `changed` highlights shared matching paths; `added` highlights matching additions or rename targets even when their names differ. Patterns support `*`, `**` and `?`. Cards show a marker and PR details list matched files; `show --json` and `pr list --json` include `overlaps`. File lists are fetched during sync only when the PR head changes, capped at 3,000 files with `truncated` recorded. Cached files and overlap results are local and not exported; rules round-trip in export v8.

### GitHub PR/CI synchronization (0.9.0, export v8)

Open **Work Board settings** with the gear icon next to Refresh on the Work Board page, or use **Settings → Plugins → Work Board**. Choose a tracker project, then **Git and pull requests**. Each tracker project has its own repository list (`owner/repo`), optional periodic synchronization (off initially, five minutes when enabled), title discovery, lookback and check/workflow settings. Select GitHub repositories discovered in BB projects with checkboxes. **Other repositories** expands a manual `owner/repo` field, an **Add** button and a removable repository list. Switches control periodic sync and title discovery; **Advanced settings** contains lookback, post-merge observation, required checks and workflow names. Multiple projects can watch the same repository; multiple repositories and PRs per task are supported. The first connector supports public and private repositories on github.com. Other hosting providers and GitHub Enterprise hosts are not implemented.

The connector reads GitHub using `GH_TOKEN`, `GITHUB_TOKEN`, then the server's existing `gh auth token --hostname github.com`; public repositories can use anonymous access. It never switches accounts, writes PR comments/labels, merges PRs or changes a local checkout. Private repositories need read access to PRs, contents/commit statuses, checks and (for post-merge observation) Actions. Optional protection/review metadata can remain unknown if unavailable; a required-check override avoids requiring additional administration access. Tokens and account data never enter exports.

The compact **Pull requests** list appears below the task properties in the right column (below the content in narrow panels). PR, check, workflow and evidence links use BB’s native URL navigation. Expand a PR row for checks, merge/review details and link actions; the header icons refresh or add a link. **Link PR** in a task card accepts a full canonical GitHub PR URL, a role (**delivers**, **design**, **related**) and optional delivery part `k/m`. Explicit links are confirmed. Whole keys in PR titles and worker-environment metadata produce suggested related links. A single-repository project's structured evidence `--pr` can also suggest a reference; bare numbers are ambiguous across multiple repositories. Ordinary PR-body/comment mentions and branch names do not create delivery links. Task key aliases work after prefix changes. Confirm/edit a suggested link to choose its role. **Exclude** persists across polling; **Relink** explicitly restores it. Links survive thread archival and task title changes, and include immutable task/remote PR IDs. Renamed GitHub repositories update their configured path after a successful direct lookup.

Cards in the list, central board and side board show a compact PR/CI summary. Task details on both surfaces show every linked PR, current head SHA, check states, required/optional/unknown requirements, review decision, merge state/queue, unresolved-thread count when available, freshness and errors. CI uses the current PR head, latest check IDs and latest commit statuses; failed, pending, skipped, neutral and cancelled checks stay distinct. Green CI is not a merge approval. These checks describe the PR head; test-merge/merge-group check evaluation and complete signing/ruleset diagnostics are not claimed. GitHub's reported merge blockers are displayed separately.

Task statuses remain owner/agent controlled, including after merge. Notifications, automatic merge evidence and automatic workflow transitions are not implemented in this observation release. No generic definition of “task complete” is inferred from discovered PRs or their roles.

```sh
bb work-board git-config --project ABC --json
bb work-board git-config --project ABC --file ./git-sync.json
bb work-board pr link ABC-12 --url https://github.com/example/service/pull/42 --role delivers --part 1/2
bb work-board pr list ABC-12 --json
bb work-board pr unlink ABC-12 --url https://github.com/example/service/pull/42
bb work-board sync --project ABC --json
bb work-board show ABC-12 --json
```

A configuration file accepts `enabled`, `repositories`, `pollMinutes` (1–60, default 5), `lookbackDays` (1–365, default 30), `titleDiscovery` (default true), `requiredChecks` (up to 50 unique names, empty reads available GitHub requirements), `postMergeWorkflows` (up to 10 unique names or workflow ID strings) and `postMergeDays` (1–90, default 7). Omitted settings use their defaults. `git-config --file` replaces the whole configuration, not a partial patch. CLI file paths use the invoking machine or `--machine`; credentials belong on the BB server. `pr list --json` includes snapshots and errors; `show --json` exposes the same data as `prLinks` in addition to legacy environment PR metadata. The public RPC contract exposes get/setGitSyncConfig, linkPr, unlinkPr, listPrLinks, prSummaries and syncGit.

Periodic scans share repository discovery, revalidate current checks independently of PR updatedAt, retain last good snapshots on errors, use conditional authenticated REST requests and rate-limit backoff, and stop writes after disposal/configuration changes. All open PRs and recent closed/merged PRs are discoverable, within bounded pages (100/page, up to 20). Linked PRs are fetched directly. Old merged PRs stop background fetching after the post-merge window; old unmerged closed links are rechecked hourly to catch reopening. Manual Sync bypasses these observation intervals. A large repository/window can exceed the bounded discovery limit; narrow the lookback or explicitly link a PR. Failed discovery never removes an established link. Snapshots indicate stale state rather than treating an unavailable API as success/closure.

**Post-merge workflows** are optional, read-only push-run observation on the PR base branch. Configure exact workflow names or stable workflow ID strings. A cancelled run remains pending; a later run covers it only if it is the same workflow/base branch/repository and the compare API confirms its commit contains the merge commit. The card then shows **Superseded … covered by run X on commit C**, with the covering run's pending/passed/failed/skipped result. Diverged/behind commits do not cover it. Ambiguous names across workflow IDs yield unknown. This records workflow coverage, not a task-completion or deployment guarantee.

Export v8 adds required top-level `project.json.gitSync` and `tasks/<id>.json.pullRequests` arrays (including exclusions), preserves v7 archival fields, and contains no CI snapshots, credentials, HTTP caches, cursors or last-poll timestamps. Files/directories are unchanged. Imports accept v1–v8; legacy imports without these fields preserve existing local sync settings/links. Conflicting imported links/config require `--overwrite`; missing links are not deletions. Imported snapshots are never trusted—remote state is fetched again. Coordinate any downstream strict export checker before activating the v8 exporter.

## Dispatch и иерархия тредов

`bb work-board dispatch KEY --preset NAME`, вызванный из треда, делает новый тред дочерним для вызывающего (`BB_THREAD_ID`), поэтому уведомления о жизненном цикле и архивация следуют иерархии. `--parent-notifications auto|stuck|off` задаёт, какие ходы потомка будят родителя (без флага действует значение bb по умолчанию); `--no-parent` запускает тред вне иерархии (флаги взаимоисключающие). Запуск из UI человеком и `--thread` не меняют родителя. Рекомендации агентам — в разделе «Building a hierarchy without burning provider limits» в `skills/work-board/SKILL.md`.

## Sequence claims

Create a project sequence with `bb work-board seq create registry_version --project ANV --next 234 --format '1.{n}'`. Use `seq list`, `seq show`, `seq set-next` and `seq delete` with `--project`. Claim with `bb work-board claim registry_version --project ANV --task ANV-12 [--pr URL] [--another]`; plain output is the rendered value. Release with `claim release registry_version 234 --project ANV --reason 'reason'`. Active claims appear on the task. Claims are idempotent per task unless `--another` is supplied; released values are never reused. `set-next --force` permits a lower counter, but allocation remains blocked until it exceeds all prior claims. Sequence state is not exported or imported, and PR close or merge does not release claims automatically.
