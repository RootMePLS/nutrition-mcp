# Nutrition MCP: read-only food-tracking audit

**Дата:** 2026-08-04  
**Репозиторий:** `/Users/fishhead/.workspace/projects/nutrition-mcp`  
**Аудируемый baseline:** `a1da3ee` (`main`, локальная ветка ahead of `origin/main` by 6 commits)  
**Режим:** read-only аудит. Production code не изменялся.

## Executive summary

Репозиторий уже имеет рабочий single-user Bun/TypeScript MCP-сервер на прямом PostgreSQL через `pg`, а миграция Supabase→локальный PG материализована в `db/migrations/001_initial_schema.sql`, `src/db.ts`, `src/index.ts` и `src/mcp.ts`. Pure/unit/MCP test suite на baseline проходит: **372 pass, 0 fail, 1,675 assertions, 19 files** (`bun test`). Однако новая предметная модель food tracking отсутствует: текущая `meals` — плоская строка на один агрегированный meal item, `update_meal` мутирует строку, raw media/parsing/provider provenance/version history/sync journal/backup lifecycle не существуют.

Рекомендация: не расширять `meals` набором nullable-полей. Добавить поверх существующей схемы отдельный append-only слой `meal_events` → `meal_event_versions` → `meal_event_items`/`meal_event_nutrition_estimates`/`meal_event_media`/`meal_event_sync_journal`, а существующие `meals` и аналитические read paths сохранить как compatibility/read-model слой до отдельной миграции. Первый bounded slice должен быть локальным и детерминированным: создать один meal event с несколькими позициями, сохранять raw text и media metadata, выпускать immutable version, считать три provider results + canonical result, и гарантировать idempotent retry. Внешнюю запись в MyFitnessPal и полноценную backup automation не включать в первый slice.

## 1. Текущее состояние (grounded)

### 1.1 Supabase → PostgreSQL migration

- Исторический план находится в `.hermes/plans/2026-08-04-supabase-to-pg-plan.md`; brief — `.hermes/plans/2026-08-04-supabase-to-pg-brief.md`.
- Текущий baseline уже содержит миграцию `db/migrations/001_initial_schema.sql`. Она описана как consolidated schema и создаёт `meals`, `profiles`, `nutrition_goals`, `water_log`, `weight_log`, `tool_analytics`, `food_cache`, индексы, partial unique idempotency indexes и `public_landing_stats()`.
- Миграция не является цепочкой upgrade migrations: это один bootstrap-файл с `CREATE TABLE IF NOT EXISTS`; отсутствуют migration ledger/version tracking и отдельная additive migration для уже поднятых баз. Будущую схему нужно добавлять forward-only migration (например, `002_meal_events.sql`), не переписывая `001`.
- Старые Supabase migrations всё ещё присутствуют в `supabase/migrations/` (12 SQL-файлов). Они полезны как source history, но не являются runtime migration path текущего локального приложения.
- `src/db.ts` использует `pg.Pool({ connectionString: process.env.DATABASE_URL })`, hardcoded `SINGLE_USER_ID`, parameterized SQL и explicit numeric conversion (`num`). Pool закрывается в `src/index.ts` при SIGTERM/SIGINT.
- Нет Docker Compose и нет контейнера PostgreSQL. `Dockerfile` (`FROM oven/bun:1`) запускает только Bun; эксплуатационная предпосылка — уже существующий PostgreSQL instance. `.env.example` содержит только `DATABASE_URL`, `OFF_USER_AGENT`, `PORT`.

### 1.2 Existing schema and database layer

- `db/migrations/001_initial_schema.sql:9-37`: `meals` — одна строка с `description`, `meal_type`, `logged_at`, calories/macros, notes и `idempotency_key`; отсутствуют event identity, version, source/provenance, raw inputs, items, provider results.
- `db/migrations/001_initial_schema.sql:34-37`: idempotency гарантируется только на `(user_id, idempotency_key)` при non-null key.
- `src/db.ts:45-80`: TypeScript `Meal`/`MealInput` отражают плоскую модель; `MealInput` имеет один description и один nutrition aggregate.
- `src/db.ts:136-198`: `insertMeal` сначала читает по idempotency key, затем вставляет; concurrent `23505` race разрешается повторным select. Это хорошая семантическая основа, но операция не объединена с media/version/provider writes в общей transaction.
- `src/db.ts:201-373`: date/range/search/export reads работают по `meals.logged_at`; это нельзя бездумно перенести на `consumed_at` без совместимого определения даты.
- `src/db.ts:386-481`: `updateMeal` выполняет SQL `UPDATE` существующей строки. Это прямо противоречит требованию corrections create versions для новой модели.
- `src/db.ts:1088-1120`: `deleteAllUserData` удаляет таблицы по очереди без transaction и удаляет transient `./exports/<user>/meals.csv`; нет permanent-delete orchestration для media, backups, sync journal или audit history.
- `public_landing_stats()` считает `meals`, поэтому новый event/read model потребует явного решения о compatibility count, иначе статистика будет расходиться.

### 1.3 Bun/TypeScript MCP server

- Entry point: `src/index.ts`; MCP adapter/tool registration: `src/mcp.ts`; domain DB functions: `src/db.ts`; pure import logic: `src/import.ts`; export: `src/export.ts`.
- `src/mcp.ts:977+` регистрирует tools на request и передаёт `userId`; в текущем single-user режиме это `SINGLE_USER_ID` (wiring в `src/mcp.ts` и `src/index.ts`).
- `log_meal` (`src/mcp.ts:990-1114`) вызывает только `insertMeal`, то есть одним вызовом создаёт одну плоскую запись. Description инструкции поддерживают photo-assisted conversational flow, но это LLM guidance: сервер не получает и не хранит photo/audio/raw transcript.
- `bulk_import_meals` использует `runImport` (`src/import.ts:1070+`) и adapter dependencies из `src/mcp.ts`. Есть dry-run, row validation, batch report, explicit `import:<digest>:<ordinal>` keys и replay-safe behavior.
- Важное ограничение import: `src/import.ts:1063-1068` прямо фиксирует, что writes не transactional; database failure после начала batch оставляет ранние строки. Это приемлемо для legacy bulk import, но не для атомарного создания event + version + items + estimates.
- `src/export.ts` пишет один CSV в `./exports/<userId>/meals.csv`, отдаёт route `src/index.ts:118-132`, очищает его через TTL sweep. Это transient export, а не durable media storage и не backup.
- Rate limit: `src/index.ts:101-116` keyed by the hardcoded single-user ID. Auth/OAuth удалены из runtime, несмотря на stale sections in README.

### 1.4 Tests

- `bun test --reporter dots` на baseline: **372 pass / 0 fail**, 19 test files.
- Тесты покрывают pure logic, MCP handlers, import/csv/search/insights/tz/units/rate-limit/widgets/net/alcohol/chunk и экспорт CSV (`src/*.test.ts`).
- `src/supabase.test.ts` уже тестирует чистые idempotency helpers и `fetchAllPages`, но название stale после migration; фактического live PostgreSQL integration suite в проверенном наборе нет.
- `src/export.test.ts` покрывает CSV format/alignment, но не durable media retention/backup behavior.
- Нет тестов для transactions, concurrent event creation, schema upgrade application, media path safety, provider disagreement/canonical algorithm, MFP sync retry, delete-vs-backup semantics или permanent delete.
- `package.json` содержит `typecheck` script (`scripts/typecheck.ts`) и `format:check`, но в данном аудите запускались `bun test`; DB integration не запускался, потому что `DATABASE_URL` в shell не задан.

### 1.5 Operator/docs state

- `Dockerfile` запускает Bun и не provisions PostgreSQL. `docker-compose.yml` отсутствует. План миграции правильно фиксирует same existing PG instance, но это не backup/restore policy.
- `README.md:29-35, 85-129, 150-169` по-прежнему описывает Supabase, OAuth, hosted migrations и старые endpoints — существенный documentation drift относительно текущего `src/index.ts`, `.env.example` и `db/migrations/001_initial_schema.sql`.
- `CLAUDE.md` содержит наиболее актуальные Bun/testing/MCP Apps conventions, включая правило: version in three places, default Bun, `bun test`, and read-only/import invariants. Он всё ещё описывает analytics as Supabase table, что также stale.
- В репозитории нет найденного operator document для PostgreSQL backups, media backups, restore drills, retention, permanent deletion или migration runner.
- `exports/` существует как runtime output directory; его нельзя использовать как durable media root без отдельной policy и access/path controls.

## 2. Target model: architectural conclusions

### 2.1 Keep one meal event, many positions

`meal_event` должен быть aggregate/root одной фактической eating occurrence, а не одной food row. Один event содержит `reported_at`, `consumed_at`, meal type/notes, provenance, lifecycle и current version pointer; позиции хранятся в child table. `consumed_at` по умолчанию равен `reported_at`, оба значения сохраняются явно.

Предлагаемая identity:

- `meal_events(id uuid PK, user_id, reported_at timestamptz, consumed_at timestamptz, meal_type, status, current_version, created_at, updated_at, idempotency_key, deleted_at)`.
- `meal_event_versions(event_id, version integer, correction_reason, created_at, created_by, source_precedence, raw_text_snapshot, ...)` с PK `(event_id, version)` и immutable rows.
- `meal_event_items(version_id, ordinal, raw_item_text, normalized_name, portion_value/unit, quantity, ...)` с PK `(version_id, ordinal)`.

Legacy `meals` должен оставаться compatibility surface в first slice. Не делать trigger-based dual write без явного consistency test: trigger усложнит provider orchestration и rollback. Предпочтительнее transaction service, который создаёт event model и при необходимости materializes legacy aggregate read row.

### 2.2 Text has precedence over photo

Raw inputs должны быть отдельными immutable artifacts, а не только `description`:

- raw text/transcript хранить в version/input table с `source_kind=text|audio_transcript|photo_ocr|model_note`, `content`, `content_hash`, `reported_at`, parser metadata;
- media — только metadata в Postgres (`media_id`, event/version, kind photo/audio, relative storage key, MIME, byte size, sha256, created_at, retention class); bytes — file-based storage;
- precedence — deterministic field in parsing contract: user-confirmed text > audio transcript > photo-derived OCR/vision > model assumption. Photo must not overwrite an explicit text fact. Store conflict/decision metadata rather than silently discard lower-precedence evidence.

Не хранить binary blobs в Postgres: это расходится с требованием file-based media и усложняет отдельно заданные media backups.

### 2.3 Three nutrition calculations and canonical result

Нужна normalized provider-result table, а не три columns in `meal_event`:

- `provider = nutrition-local | own | myfitnesspal`;
- `calculation_status = pending|succeeded|failed|unavailable`;
- provider request/input fingerprint, algorithm/model/version, response payload, normalized nutrients, calculated_at, error metadata;
- result scoped to `event_version` and item (or event aggregate when provider returns only aggregate).

Canonical result должен быть **derived, reproducible and stored** as a result of an explicit policy version:

1. Normalize units and missing values; never treat missing as zero for averaging.
2. Compare available provider values per nutrient, with a documented 10% relative-disagreement threshold (define zero/near-zero denominator explicitly).
3. If two providers agree within threshold and one is an outlier, use the average of the two agreeing values and mark the third as outlier; do not average all three.
4. If all three are available and no two-provider consensus exists, canonical value is the arithmetic mean of the available values, with `consensus_status=no_consensus` and provenance retained.
5. If fewer than two usable provider values exist, canonical result is pending/low-confidence (not fabricated).
6. Store selected provider set, excluded outlier(s), threshold, policy version and calculation timestamp in canonical row.

The requirement “canonical result — усреднённое значение” therefore means mean of the eligible values, with the special two-consensus/one-outlier rule taking precedence. Nutrient fields need nullable semantics and fixed precision; preserve source payloads for later recalculation.

### 2.4 Corrections are new versions

`update_meal` behavior must not be copied to event corrections. A correction creates `version = previous + 1`, copies/links immutable raw inputs and item set, applies a patch, reruns parsing/provider/canonical pipeline, and advances `current_version` atomically. Reads default to current version; history endpoint/read function exposes all versions. A stale retry must not create a second correction: idempotency key should be unique per event + correction request fingerprint.

### 2.5 External writes and sync journal

The phrase “добавь” authorizes an external write. The server must still make intent explicit in the event command (e.g. `external_write_authorized=true`, target `myfitnesspal`) and persist an outbox/sync journal before network I/O:

- `meal_event_sync_journal(id, event_version_id, system, direction, operation, idempotency_key, request_fingerprint, state, attempts, external_id, last_error, next_attempt_at, created_at, completed_at)`;
- unique `(system, operation, request_fingerprint)` prevents duplicate external writes;
- state machine: `pending → in_flight → succeeded|failed|dead_letter`; retry only safe states;
- MyFitnessPal write is not part of the DB transaction: commit event + journal, then worker/tool attempts external call and updates journal.

“Nutrition MCP sync” should be treated as the local system’s own integration/read-model journal, not as a second opaque source of truth. Do not claim delivery success until response/external id is stored.

### 2.6 Deletion and backups

Normal delete should be a user-visible soft delete/tombstone (or event deletion state) and must **not** delete backup artifacts. Permanent delete is a separately named, explicit destructive operation and must remove DB rows, media files, sync records and all backup copies according to documented storage provider capabilities; it needs confirmation and an auditable deletion receipt. This is materially different from current `deleteMeal` hard delete and `deleteAllUserData` best-effort sequential cleanup.

Backup policies:

- Postgres backup and media backup are separate jobs, roots, manifests and restore procedures.
- Daily retention: 30 days; monthly snapshots: forever.
- A backup manifest should record snapshot id, covered DB/WAL or file set, checksum, creation time, retention class.
- Media backup must preserve relative key, hash, MIME and event/version linkage; never reconstruct media paths from untrusted user input.
- “Permanent delete” must be tested against both live storage and backup indexes. Ordinary delete must be tested to leave backups untouched.

## 3. Gaps and constraints (prioritized)

### Critical gaps

1. No event/version/items schema; current `meals` cannot represent one meal with several positions or correction history (`db/migrations/001_initial_schema.sql`, `src/db.ts`).
2. No raw text/photo/audio ingestion or durable media metadata/file store.
3. No provider calculation abstraction or canonical consensus policy.
4. No sync journal/outbox or external MyFitnessPal writer.
5. Existing updates/deletes mutate/delete rows; they violate immutable correction and backup-preserving deletion requirements.
6. No transaction boundary spanning aggregate, version, items, media metadata, estimates and idempotency.
7. No backup/restore/permanent-delete operator contract.

### Important constraints

- Single user is hardcoded (`src/db.ts:SINGLE_USER_ID`; `src/mcp.ts`), so schema should still retain `user_id` to avoid a second migration when multi-user returns.
- Same existing PostgreSQL instance is an explicit user decision; do not introduce a second DB/container. Additive migrations need a deterministic runner or documented `psql` order.
- Bun conventions from `CLAUDE.md`: use Bun APIs/runtime; tests use `bun:test`; avoid Node package substitutions where Bun API is sufficient. Existing code nevertheless uses some `node:fs` APIs in export/db; new file store should standardize and test path handling.
- Current HTTP body limit is 1 MiB (`src/index.ts:47-54`), unsuitable for photo/audio upload. First slice should use staged local file ingestion or a separately bounded upload path, not silently raise the global limit.
- Current import is intentionally non-transactional (`src/import.ts:1063+`). Do not reuse it as the event transaction implementation.
- Current `meals` analytics and public landing stats are established compatibility consumers; replacing them immediately creates a broad regression surface.

## 4. Recommended bounded first slice

### Slice goal

Implement the durable local substrate and pure deterministic domain logic, without MyFitnessPal network writes, without automatic backup execution, and without deleting/replacing legacy `meals`.

### In scope

1. Add forward migration `db/migrations/002_meal_events.sql` in the same PostgreSQL database.
2. Add domain/service module (recommended `src/meal-events.ts`) with transaction-oriented create-event/version flow.
3. Add `src/meal-consensus.ts` as a pure module implementing normalization, 10% threshold, two-consensus outlier selection, and canonical averaging.
4. Add `src/media-store.ts` for safe file root/path/key generation and Bun file writes; persist only metadata in Postgres.
5. Add adapter-level MCP tool (recommended `log_meal_event`, leaving `log_meal` behavior unchanged) accepting one event with multiple positions, raw text, reported/consumed timestamps, media references and optional explicit external-write authorization. “add” intent is a caller contract, not an implicit auto-sync.
6. Implement idempotent create/retry and immutable correction primitive in the new model.
7. Add structured read response for current event/version, provider status and canonical result.
8. Add focused tests and migration/schema checks.

### Out of scope

- Actual MFP API/network integration and credentials.
- Automatic photo/audio transcription or model invocation inside the server.
- Full backfill of every legacy `meals` row.
- Replacing all existing summary/search/insights paths.
- Backup scheduler and cloud-specific implementation; only contracts/manifests/test seams in this slice.
- Hard/permanent delete implementation beyond data model and explicit guardrails.

### Proposed migration tables (bounded design)

- `meal_events`: root identity, `reported_at`, `consumed_at`, lifecycle, current version, idempotency key, user.
- `meal_event_versions`: immutable version rows, correction metadata, parser policy/version, created_by.
- `meal_event_items`: ordered positions and raw/normalized item fields.
- `meal_event_inputs`: raw text/transcript/OCR/vision evidence with precedence, hash and version link.
- `meal_event_media`: Postgres metadata plus safe relative file key.
- `meal_event_nutrition_results`: provider/item/version normalized nutrients, request fingerprint, algorithm/model version and status.
- `meal_event_canonical_results`: selected values, policy version, eligible providers, outliers and confidence/status.
- `meal_event_sync_journal`: durable local outbox/journal for Nutrition MCP and future MyFitnessPal.

Use foreign keys and `ON DELETE RESTRICT`/explicit tombstone semantics rather than cascading away history accidentally. Add unique keys for `(event_id, version)`, `(version_id, ordinal)`, provider result fingerprint and event creation idempotency. Add indexes on `user_id, consumed_at`, current version, status and sync retry state.

### Exact likely file targets

- **Create:** `db/migrations/002_meal_events.sql`
- **Create:** `src/meal-events.ts`, `src/meal-consensus.ts`, `src/media-store.ts`
- **Modify:** `src/mcp.ts` (new tool only; do not silently change legacy `log_meal`/`update_meal` semantics)
- **Modify:** `src/index.ts` only if a bounded media staging/download route is truly required; preserve 1 MiB general body limit and add route-specific limits.
- **Modify:** `src/db.ts` with transaction/query helpers or a narrowly scoped event repository; avoid putting all new domain SQL into the existing 1,149-line legacy module.
- **Create:** `src/meal-events.test.ts`, `src/meal-consensus.test.ts`, `src/media-store.test.ts`, and preferably `src/db.integration.test.ts` behind an explicit `DATABASE_URL`/test database gate.
- **Modify:** `README.md`, `.env.example`, `CLAUDE.md` only for the shipped contract; update stale Supabase/operator text in a dedicated docs slice if not included in implementation.
- **Create later:** `docs/operations/backups.md`, `scripts/backup-postgres.ts` or shell wrapper, `scripts/backup-media.ts`, `scripts/restore-check.ts`; these should not be represented as complete until executable and tested.

## 5. Test plan and acceptance criteria

### Pure consensus tests

- all three equal → same arithmetic value, all eligible;
- two values within 10%, third > threshold → average only agreeing pair, third marked outlier;
- exactly threshold boundary and just-over threshold;
- zero/near-zero denominator behavior is explicit and tested;
- missing/failed provider does not become zero;
- no consensus among three → arithmetic average of available values, status explains no consensus;
- one usable result → pending/low-confidence, never fabricated;
- calculation policy/version and selected provider list are serialized.

### Event/version/transaction tests

- one event with 2+ ordered positions is persisted and read in order;
- omitted `consumed_at` stores equal instant to `reported_at`; supplied values preserve both;
- explicit text beats photo/OCR evidence and lower-precedence evidence remains auditable;
- create retry with same idempotency key returns same event/version and creates no duplicate items/media/journal rows;
- concurrent create race yields one event;
- correction creates version 2, leaves version 1 byte/row immutable, advances current pointer atomically;
- failed provider does not roll back durable raw event, but canonical state is pending and failure metadata is present;
- failed transaction leaves no partial event/version/item rows;
- provider result retry is idempotent by request fingerprint.

### Media tests

- photo and audio metadata are persisted with hash, MIME, size and relative safe key;
- file bytes are written under configured media root, never via path traversal (`..`, absolute paths, symlink escape where applicable);
- raw media is retained indefinitely by default;
- absent file and checksum mismatch are surfaced as errors, not silently accepted.

### Sync/delete/backup contract tests

- “add” authorization creates a pending journal entry; no network success is claimed before external acknowledgment;
- retrying the same journal operation does not create duplicate entries;
- ordinary delete/tombstone does not remove media or backup manifest references;
- permanent-delete path requires explicit confirmation token/argument and targets live DB + media + backup manifests;
- daily/monthly retention values are represented in a policy object/config and tested (daily 30 days, monthly forever).

### Acceptance criteria for the first slice

- `bun test` remains green, with the new tests included;
- `bun run typecheck` and `bun run format:check` pass;
- fresh PostgreSQL applies `001` then `002` in order; an already initialized DB applies only `002` without rewriting existing data;
- event creation is one DB transaction and is idempotent under retry/concurrency;
- a single event can return multiple items, raw evidence, three calculation states and canonical result metadata;
- corrections never mutate prior versions;
- no MyFitnessPal network call is made by the bounded slice;
- legacy `log_meal`, import/export, summaries and search continue to pass their existing tests;
- documentation does not claim backup or external sync is shipped until those paths are executable and verified.

## 6. Risks and guardrails

| Risk                                     | Consequence                                   | Guardrail                                                               |
| ---------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| Reusing `meals` as event root            | Loses multi-item identity and history         | New append-only event tables; compatibility read model                  |
| Averaging null as zero                   | Systematic under-reporting                    | Nullable normalized nutrients; average only usable values               |
| Silent text/photo conflict               | User’s explicit fact is overwritten           | Precedence enum + preserve all evidence + conflict metadata             |
| Non-atomic provider writes               | Half-created event or duplicate estimates     | One DB transaction for local rows; fingerprinted provider results       |
| MFP retry after timeout                  | Duplicate external entry                      | Journal idempotency key + external id reconciliation                    |
| File path traversal                      | Arbitrary file write/read                     | Generated opaque keys, root containment check, no user path as filename |
| Large media through MCP body             | OOM/DoS or rejected uploads                   | Staged file flow and route-specific size/type limits                    |
| Hard delete of history                   | Corrections/audit/backups become unverifiable | Soft delete by default; separate permanent-delete command               |
| Treating local filesystem as backup      | Data loss on disk failure                     | Separate Postgres/media backup jobs and restore drills                  |
| Rewriting `001`                          | Breaks existing installations                 | Forward-only `002+` migrations and migration ledger/runner              |
| README/CLAUDE drift                      | Operators run obsolete Supabase commands      | Truth pass in same delivery cycle                                       |
| Assuming unit tests prove PG correctness | SQL/type/constraint regressions               | Disposable/local integration DB test with real migration chain          |

## 7. Follow-on sequence after first slice

1. Add migration runner/ledger and real PG integration harness.
2. Add extraction/parsing adapters: text-first, photo/audio evidence, explicit parser provenance.
3. Implement provider adapters for `nutrition-local`, own calculator and MyFitnessPal read/calculation path; persist raw responses and algorithm versions.
4. Add canonical recalculation/replay command and event-history reads.
5. Add Nutrition MCP sync worker/outbox delivery and MFP external write only when command authorization is explicit.
6. Add separate Postgres/media backup jobs, manifests, retention enforcement and restore verification.
7. Add normal-delete and permanent-delete workflows with confirmation/audit receipts.
8. Migrate summaries/search/export to current event version/read model, then decide whether/when legacy `meals` can be retired.

## 8. Verification performed for this audit

- Read `CLAUDE.md`, current plans, schema, Bun/TypeScript DB/MCP/import/export/index files, tests, package/env/Docker/operator surfaces.
- Checked baseline git state and recent migration commits (`de14dc0` through `a1da3ee`).
- Ran `bun test --reporter dots`: **372 pass, 0 fail, 1,675 assertions, 19 files**.
- Confirmed `psql` is available (`PostgreSQL 16.14`), but shell `DATABASE_URL` is not configured; no live DB integration or migration application was claimed.
- Confirmed no `docker-compose.yml`/compose file is tracked; Dockerfile is Bun-only.
- Confirmed report creation is the only requested write; production source was not changed.
