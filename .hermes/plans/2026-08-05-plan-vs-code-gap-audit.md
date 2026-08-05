# Аудит планов против текущего кода

Дата среза: 2026-08-05

Репозиторий: `/Users/fishhead/.workspace/projects/nutrition-mcp`

Проверено: 42 существующих markdown-файла в `.hermes/plans`, текущий рабочий код, миграции `001`-`005`, MCP-регистрация, unit- и PostgreSQL-тесты, документация и git-история.

## Короткий вывод

Основная food-tracking кампания реализована. Append-only `meal_events`, capture lifecycle, calculation bundles, corrections, legacy adapters, provenance readback и DB acceptance gate существуют и проходят реальные тесты.

Но работа не закрыта полностью:

1. Calculation bundle принимает item-scoped результаты, но считает один общий consensus по всем scope и сохраняет canonical только для event scope. Это нарушает B3 и может смешать нутриенты блюда с нутриентами отдельных позиций.
2. Для capture media нет публичного MCP-инструмента, который записывает `meal_capture_media`. Фото или аудио можно провести только прямым вызовом repository-функции, не через полный MCP-путь.
3. Capture media хранит переданную метаинформацию, но не имеет обещанного capture-specific byte lifecycle: generated key, чтение байтов, проверка SHA-256 и cleanup файла при откате БД.
4. Большая часть последнего provenance enforcement находится только в dirty working tree, а не в `HEAD`. Код работает, но delivery не завершен.
5. Supabase/OAuth runtime удален, однако старые Supabase migrations, устаревший `CLAUDE.md`, `docs/google-auth-setup.md`, имя `src/supabase.test.ts` и старые комментарии остались.
6. Настоящая Hermes-side оркестрация и MyFitnessPal delivery adapter по-прежнему отсутствуют. Это не нужно встраивать в `nutrition-mcp`, но без отдельной реализации пользовательский путь не является полностью автоматическим.
7. Pending nutrition всё ещё превращается в `0` для основных макросов в summary/progress. Хранилище сохраняет `NULL` правильно, но публичная агрегация теряет различие между отсутствующим расчётом и настоящим нулём.
8. Legacy write tools не сообщают явно, что результат имеет статус `pending/compatibility`. Успешная запись выглядит как завершённый расчёт, хотя полного provider bundle нет.

## Состояние репозитория

- `HEAD`: `fdfa2e6` (`test: close acceptance gate gaps for meal event tooling`).
- `main` совпадает с `origin/main`.
- Рабочее дерево грязное: 24 tracked-файла изменены, 40 plan-файлов не отслеживаются, 2 старых plan-файла изменены.
- `get_calculation_provenance`, `commit_calculation_correction`, `readPersistedWriteStatus` и `getMealEventProvenance` есть в working tree, но отсутствуют в `HEAD`.

Это важно: текущий код содержит больше реализованного, чем последний коммит. Потеря или сброс working tree вернет проект к более слабому provenance-контракту.

## Реальные проверки

Запущено на текущем working tree:

- `bun run test:unit`: 445 pass, 84 DB-gated skip, 0 fail, 529 tests.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`: 82 pass, 0 skip, 0 fail, 82 tests в 7 DB suites.
- `bun run typecheck`: pass, `src/ typechecks clean`.
- `git diff --check`: pass.
- `bun run format:check`: fail только на 14 исторических `.hermes/plans/*.md`; production source и tests в список не попали.

## Планы против кода

| Семейство планов                                               | Статус                       | Что подтверждено в коде                                                                                                                                                    | Что осталось                                                                                               |
| -------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `2026-08-04-supabase-to-pg-*`                                  | Реализовано с cleanup-долгом | `pg`, `src/db.ts`, local PostgreSQL, no-auth `/mcp`, local CSV export, single-user ID, graceful `pool.end()`, schema and tests                                             | Старый `supabase/`, `src/supabase.test.ts`, Supabase/OAuth docs и комментарии; нет startup DB health check |
| `2026-08-04-food-tracking-{audit,implementation-plan,terra-*}` | Реализовано                  | `002_food_tracking.sql`, append-only events, versions, items, evidence, media metadata, provider/canonical rows, sync journal, corrections                                 | Исторические FAIL-планы не помечены superseded и выглядят как открытый backlog                             |
| `2026-08-04-food-tracking-full-campaign-plan.md`               | Почти полностью реализовано  | A1 validators, A2 lifecycle, atomic confirmation, B1 validation/fingerprint, B2 consensus, B3 persistence, B4 journal semantics, B5 MCP/docs, C1/C2/C3 gates               | Capture media byte lifecycle; item-scoped canonical persistence; отдельная Hermes-side оркестрация         |
| `food-tracking-a1-*`                                           | Реализовано                  | Fail-closed runtime validation, plain JSON metadata, MIME/hash/ID checks, proxy/revoked-proxy regressions                                                                  | Существенных открытых A1-пробелов не найдено                                                               |
| `food-tracking-a2-*`                                           | Реализовано частично         | Durable capture, row locks, user scope, read/cancel/expire, atomic confirm, concurrency, rollback, exact metadata match                                                    | Нет MCP media attach tool; нет byte staging/hash-read/cleanup path для capture media                       |
| `food-tracking-b1-*`                                           | Реализовано                  | Strict scope validation, full fingerprint, raw payload/provenance/source IDs, PostgreSQL round-trip, MCP validation                                                        | Item scope разрешен контрактом, но downstream canonical materialization реализована неправильно            |
| `food-tracking-b2-*`                                           | Реализовано для event scope  | Immutable correction, prior version, audit fields, backend consensus, idempotency, rollback, pending journal                                                               | Correction path повторяет тот же scope bug: canonical строится не отдельно для каждого ordinal             |
| `final-campaign-terra-fixes.md`                                | Реализовано                  | Capture mutators получают `userId`; cross-user MCP tests проходят                                                                                                          | План содержит старый FAIL и не помечен закрытым                                                            |
| `legacy-meal-tools-event-schema-fix-*`                         | Реализовано                  | Production SQL больше не обращается к `meals`; current-version projection, legacy reads/writes, append-only update, soft delete, export, cleanup и real MCP tests проходят | Только исторические migration fixtures обращаются к `meals`, это правильно                                 |
| `calculation-provenance-enforcement-*`                         | Реализовано в working tree   | Public readback, correction tool, strict structured output, null-vs-zero, exact provider provenance, canonical audit, deterministic DB gate                                | Не закоммичено; scope bug не пойман Terra 9; plan markdown formatting остается красным                     |

## Что реализовано надежно

### PostgreSQL и event model

- `001_initial_schema.sql` поднимает локальную single-user базу.
- `002_food_tracking.sql` удаляет flat `meals` и создает append-only event aggregate.
- `003_meal_captures.sql` добавляет durable capture state.
- `004_calculation_bundles.sql` добавляет source/provenance/fingerprint fields.
- `005_calculation_corrections.sql` добавляет correction и canonical audit fields.
- Migration harness и DB gate применяют полный порядок `001`-`005`.

### Capture lifecycle

- start, append message, answer, draft, get, cancel, expire и confirm существуют.
- Все mutators, которые доступны через MCP, user-scoped.
- Confirmation требует явного `добавь`, блокирует capture row, создает event aggregate и обновляет capture в одной транзакции.
- Concurrent confirmation дает один root и одну version.
- Failure injection доказывает rollback event/version/items/media rows.

### Provider evidence и canonical data

- Допустимы только `nutrition-local`, `own`, `myfitnesspal`.
- Failed/unavailable значения остаются nullable, а не превращаются в zero.
- Backend вызывает `computeConsensus`; caller proposal не является authoritative.
- Сохраняются source ID, request fingerprint, algorithm version, raw payload, provenance, basis, units и error fields.
- `get_calculation_provenance` читает current или historical version с user scope.
- `commit_calculation_correction` добавляет immutable version и сохраняет prior version/audit/journal semantics.

### Legacy MCP surface

- Старые meal tools используют event projection, а не удаленную таблицу `meals`.
- Reads выбирают только active current version и event-scope canonical row.
- `update_meal` создает correction version.
- `delete_meal` делает soft delete.
- Export использует current version.
- Pending nutrition остается `null`, explicit zero остается `0`.

## Что упущено и надо доделать

### P0. Исправить calculation bundle materialization по scope

Контракт разрешает `scope.ordinal: null | non-negative integer` в `src/nutrition-bundle-types.ts`.

Текущая реализация в `src/calculation-bundles.ts`:

- передает все `bundle.results` одним массивом в `computeConsensus`;
- вставляет provider rows с разными `ordinal`;
- выбирает source IDs только для `ordinal IS NULL`;
- сохраняет ровно один canonical row с `ordinal = NULL`.

В результате item-scoped provider rows могут повлиять на event canonical, а item canonical rows вообще не создаются. Это прямо расходится с B3: "one canonical row per scope".

Нужно:

1. Группировать provider results по scope: event и каждый item ordinal.
2. Вызывать `computeConsensus` отдельно для каждой группы.
3. Сохранять canonical row для каждого scope.
4. Формировать `source_result_ids` только из provider rows того же scope.
5. Сделать то же для `commitCalculationCorrection`.
6. Добавить PostgreSQL tests для event + двух item scopes, mixed statuses, retry, correction и rollback.
7. Добавить negative test, который доказывает, что item calories не меняют event calories.

### P0. Добавить MCP-путь для capture media

`saveCaptureMedia()` существует в `src/meal-captures.ts`, но `src/mcp.ts` не регистрирует соответствующий tool. Сейчас MCP-клиент может start/append/answer/save draft/confirm, но не может записать строку в `meal_capture_media`.

Если draft содержит media, confirmation сравнивает его с `meal_capture_media` и отклоняет capture, потому что MCP не дал способ заполнить таблицу.

Нужно:

1. Добавить additive tool, например `attach_meal_capture_media`.
2. Использовать strict input schema, user scope и стабильный idempotency key.
3. Возвращать structured content с capture ID, media identity и capture state.
4. Добавить real MCP + PostgreSQL test: start -> attach media -> save draft -> confirm.
5. Добавить cross-user, duplicate, malformed metadata и mismatched draft regressions.

### P0. Закрыть capture media byte lifecycle

Планы A3 обещали `stage -> verify -> attach -> cleanup`. Текущий capture path принимает `storage_key`, SHA-256 и размер как метаданные, но не читает файл, не проверяет содержимое и не удаляет staged file после DB rollback.

`src/media-store.ts` умеет generated event/version key и hash verification, но capture lifecycle с ним не связан.

Нужно выбрать и зафиксировать один контракт:

- либо backend получает bytes и сам делает capture-specific staging;
- либо Hermes/host staging adapter передает доказуемый opaque receipt, который backend проверяет через injected media-store interface.

В обоих случаях нужны:

- generated key, связанный с capture/event identity и SHA-256;
- реальная проверка byte size/hash перед commit;
- cleanup staged bytes при откате;
- retry-safe attach;
- file-level integration test, а не только проверка DB rows.

### P0. Зафиксировать текущую реализацию в git

Последний provenance slice существует только в working tree. В `HEAD` отсутствуют:

- `get_calculation_provenance`;
- `commit_calculation_correction`;
- `readPersistedWriteStatus`;
- `getMealEventProvenance`.

Нужно отделить feature changes от старых unrelated edits, повторить acceptance gate и сделать focused commit. До этого Terra 9 PASS описывает рабочее дерево, а не воспроизводимый commit.

### P0. Сохранить NULL-семантику основных макросов в публичных агрегатах

Pending canonical row правильно хранит `calories`, `protein_g` и другие nutrients как `NULL`. Затем `sumMeals()` в `src/mcp.ts` использует `?? 0`, а legacy integration test закрепляет `calories: 0` и `protein_g: 0` для pending meal.

Это нарушает исходное правило: отсутствие расчёта не равно настоящему нулю.

Нужно:

1. Утвердить presence contract для calories, protein, carbs и fat в summary, goal progress, trends и widgets.
2. Возвращать `null` или явный status, когда в выборке нет ни одного рассчитанного значения.
3. Сохранять настоящий provider-supplied `0` как `0`.
4. Добавить real MCP tests для fully pending, mixed pending+ready и explicit-zero meals.
5. Проверить те же правила в CSV export и legacy structured outputs.

### P1. Добавить concurrency acceptance для calculation bundle

План B3 требует, чтобы concurrent identical submissions сходились к одному набору rows. Код блокирует version row через `FOR UPDATE`, но текущий integration test проверяет только последовательный retry.

Нужно добавить `Promise.all`/two-client regression и проверить:

- один fingerprint;
- по одной provider row на provider+scope;
- одна canonical row на scope;
- один correction version при concurrent correction retry;
- отсутствие partial rows после проигравшей конфликтной транзакции.

### P1. Сделать legacy writes честными насчёт provenance status

`log_meal`, `bulk_import_meals` и `update_meal` возвращают meal/progress, но не говорят, что compatibility write ещё не является полным calculation bundle.

Нужно добавить в structured output:

- `provenance_status: "pending" | "compatibility" | "complete"`;
- текущую event version;
- признак наличия calculation bundle fingerprint;
- краткое пояснение, что provider evidence ещё не записан.

Integration tests должны проверять этот статус через настоящий MCP transport, а не только успешность вызова и числовые totals.

### P1. Дочистить Supabase/OAuth migration

Runtime уже локальный PostgreSQL, но старый слой все еще торчит в репозитории:

- `supabase/migrations/*` не удалены;
- `src/supabase.test.ts` не переименован;
- `CLAUDE.md` утверждает, что analytics пишется в Supabase;
- `docs/google-auth-setup.md` описывает уже несуществующий OAuth/Supabase deployment;
- `src/import.ts` и `src/mcp.test.ts` содержат старые Supabase-комментарии.

Это не ломает runtime, но ломает repo truth. Новый разработчик получает две несовместимые архитектуры одновременно. Надо удалить или явно архивировать legacy artifacts и обновить `CLAUDE.md`.

### P1. Добавить startup database readiness check

`/health` сейчас возвращает `ok` без проверки PostgreSQL. В Supabase-to-PG плане был startup probe с понятной ошибкой при остановленном PG или отсутствующей базе, но в коде его нет.

Нужно:

- выполнить `SELECT 1` перед началом приема трафика или добавить отдельный readiness endpoint;
- различать process health и DB readiness;
- выдавать понятную ошибку с `DATABASE_URL`, не печатая credentials;
- покрыть успешный и failed readiness path тестами.

### P1. Закрыть обещанную DB/MCP acceptance matrix

Зелёный DB gate подтверждает существующие suites, но несколько буквальных acceptance-пунктов планов тестами не закрыты:

- безопасный повторный запуск `005_calculation_corrections.sql`;
- correction rollback после записи новых version/provider/canonical rows;
- stale-version correction с новым idempotency key;
- direct cross-user correction attempt;
- real MCP + PostgreSQL correction round-trip;
- public `failed` provider с `error_code` и `error_message`;
- concurrent identical calculation bundles;
- event и item scopes в одном bundle.

Это не восемь новых подсистем. Это одна focused acceptance suite, которая должна ловить расхождение между контрактом и кодом до следующего Terra PASS.

### P1. Сделать capture MCP outputs машинно проверяемыми

Calculation tools имеют строгие output schemas, а capture lifecycle в основном возвращает JSON внутри text content без declared `outputSchema` и `structuredContent`.

Нужно унифицировать start/get/cancel/expire/append/answer/draft/confirm responses и добавить exact runtime schema tests. Это уберет парсинг JSON-строк на стороне Hermes.

### P2. Привести plan directory в состояние источника правды

В директории лежат промежуточные Terra FAIL artifacts, remediation notes и финальный PASS. Старые unchecked boxes и FAIL verdicts выглядят как действующий backlog, хотя большая часть уже закрыта.

Нужно:

- добавить индекс со статусом каждого семейства: superseded, implemented, accepted, open;
- не переписывать исторические verdicts, а ссылаться на более новый документ;
- отформатировать 14 markdown-файлов, которые делают global `format:check` красным;
- после этого включить plan formatting в реальный repository gate.

### P2. Дочистить operator docs и smoke artifact

- README self-hosting instructions всё ещё показывают только migrations `001` и `002`, хотя рабочая цепочка состоит из `001`-`005`.
- `scripts/mcp-smoke.ts` не вызывает все восемь legacy read paths. Не хватает `get_meals_today`, `get_meals_by_date_range`, `get_goal_progress`, `get_trends` и `get_meal_patterns`.
- Correction output schema остаётся alias общей bundle schema, хотя Terra требовала отдельный явный контракт.
- В `src/mcp-food-tracking.test.ts` два capture cross-user regression имеют одинаковое имя и завышают число уникальных сценариев.

Надо обновить README, расширить smoke и убрать дубликат теста. Иначе repo gate зелёный, а операторский путь всё ещё проверяет урезанную версию системы.

## Что осталось только вне этого репозитория

Эти пункты есть в планах, но их отсутствие в `nutrition-mcp` намеренное:

1. Telegram text/photo/voice receipt.
2. Text-first parsing и one-question-at-a-time clarification.
3. Hermes `own` estimate.
4. Вызовы `nutrition-local` и MyFitnessPal MCP.
5. Объяснение расхождений пользователю и подтверждение `добавь`.
6. Реальный MyFitnessPal writer, который читает pending journal и переводит его в succeeded/failed после внешнего ответа.
7. STT/OCR/vision workers.
8. Реальный backup scheduler, cloud retention и restore drills.
9. Публичная operational-команда permanent delete, которая удаляет реальные backup copies после подтверждения.

Их нельзя "доделать" прямыми imports или Telegram webhook внутри `nutrition-mcp`. Нужен отдельный Hermes workflow/adapter. В `nutrition-mcp` уже есть storage и journal seam, но `nullExternalWriter` намеренно падает, а UI честно пишет, что external sync еще не реализован.

## Что не надо возвращать

- Flat `meals` table/view.
- Supabase auth/RLS runtime.
- Telegram bot или provider callers внутри domain layer.
- Fabricated provider rows для отсутствующих расчетов.
- `0` вместо `NULL`.
- `synced` для pending journal row.

## Рекомендуемый порядок следующей работы

1. Исправить per-scope calculation bundle persistence и добавить DB/MCP regressions.
2. Исправить NULL-семантику core macros и явные legacy provenance statuses.
3. Добавить MCP capture media tool и реальный staged-byte lifecycle.
4. Закрыть недостающую DB/MCP acceptance matrix.
5. Повторить unit, DB, typecheck, targeted format и diff gates.
6. Сделать focused commit текущего provenance/capture scope, не затягивая unrelated dirty files.
7. Удалить Supabase/OAuth repo drift и добавить DB readiness.
8. Отдельно реализовать Hermes orchestration и injected MyFitnessPal delivery adapter.
9. Обновить operator docs, smoke artifact и plan index.

## Финальная оценка

Backend не является пустым scaffold. Большая часть сложной работы сделана и подтверждена реальным PostgreSQL. Но два продуктовых пути пока обрываются:

- item-scoped calculation bundle теряет правильную canonical materialization;
- photo/audio capture не проходит полный public MCP + byte provenance lifecycle.

Плюс последний provenance hardening все еще живет в незакоммиченном working tree. Это уже не "осталось написать код когда-нибудь", а конкретный список, который можно разрезать на три bounded slices и закрыть без очередной археологической экспедиции по 42 планам.
