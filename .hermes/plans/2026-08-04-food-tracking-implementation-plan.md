# Food Tracking: первый bounded slice — implementation plan

> **Для Hermes:** выполнять план по staged workflow и TDD: planner → coder → reviewer. Production code пишет только coder. Этот документ — план, не реализация.

**Goal:** заменить плоскую legacy-модель `meals` на чистый append-only food-tracking substrate: один `meal_event` с несколькими позициями, immutable versions/corrections, raw evidence и media metadata, три nutrition calculation results, детерминированный canonical result, idempotency и sync journal.

**Architecture:** новая схема является единственным источником истины для food tracking; legacy `meals` и старые nutrition meal-данные удаляются в dev/test reset и forward migration, обратная совместимость не поддерживается. В первом slice нет Telegram/photo/vision pipeline, реальной записи в MyFitnessPal и automatic backup jobs: вместо этого фиксируются доменные контракты, transaction boundary, authorization и durable journal seams.

**Tech stack:** Bun, TypeScript, `bun:test`, PostgreSQL через `pg`, SQL forward migration, Zod только на MCP boundary.

---

## 1. Grounded repository state

Audit: `.hermes/plans/2026-08-04-food-tracking-audit.md`.

Текущий baseline — `a1da3ee` на ветке `main`, single-user Bun/TypeScript MCP server с прямым PostgreSQL через `pg`. Существуют:

- `db/migrations/001_initial_schema.sql` с legacy `meals`, profiles, goals, water, weight, analytics и `food_cache`;
- `src/db.ts` с `Meal`, `MealInput`, mutable `insertMeal`/`updateMeal`, legacy reads и `deleteAllUserData`;
- `src/mcp.ts` с `log_meal`, `update_meal`, summaries/search/import tools;
- `src/import.ts` с legacy bulk meal import;
- `src/export.ts` с legacy CSV export;
- `src/index.ts` с runtime startup и HTTP limits;
- текущая чистая проверка baseline из audit: `bun test` — 372 pass, 0 fail.

В репозитории нет runtime migration runner/ledger, нет нового event schema, provider consensus, media store, sync journal или backup lifecycle. План должен не притворяться, что эти части уже существуют.

Пользовательские решения, обязательные для реализации:

1. Новая чистая модель; legacy meals и backward compatibility не нужны.
2. Старые nutrition meal-данные удаляются. Для dev/test допустим полный reset; для воспроизводимости production/deployed DB используется forward migration.
3. Один `meal_event` содержит несколько ordered positions/items.
4. Текст пользователя важнее фото/OCR/vision и иных производных источников.
5. Сохраняются `consumed_at` и `reported_at`.
6. Corrections не мутируют прошлое: immutable versioning.
7. Хранятся raw text/photo/audio metadata; binary media лежат на диске, metadata — в PostgreSQL.
8. Расчёты представлены тремя провайдерами: `nutrition-local`, собственный calculator (`own`), `myfitnesspal`.
9. 10% — threshold disagreement.
10. Два согласных и один outlier → автоматически среднее двух согласных.
11. Canonical result хранится явно, с provenance/policy metadata.
12. Слово/intent «добавь» означает разрешение на внешнюю запись, но не является доказательством успешной доставки.
13. Создание, correction, provider result и journal operations idempotent.
14. Sync journal записывается до внешнего вызова; локальная запись не откатывается при sync failure.
15. DB и media backups раздельны: daily retention 30 days, monthly snapshots forever.
16. Permanent delete должен удалять live rows/media и backup copies; ordinary delete не должен удалять backups.

---

## 2. Slice boundary

### In scope

- Forward migration `002` с новой schema и удалением legacy nutrition data.
- Чистые TypeScript domain contracts для event, version, item, raw input, media metadata, provider result, canonical result, sync journal и backup/delete policy.
- Pure consensus calculation с 10% threshold и точным outlier rule.
- Transactional local create/correction repository, включая idempotent retry.
- File-based media store contract с safe generated keys; в Postgres только metadata.
- Durable sync-journal creation and state transitions; external transport — injectable interface/fake only.
- MCP `log_meal_event` (или эквивалентное новое имя) для текста и уже подготовленных metadata/estimates, без Telegram/vision orchestration.
- Targeted unit tests, schema/migration integration tests и сохранение существующих non-food tests.

### Explicitly out of scope

- Реальный Telegram adapter, file download from Telegram, speech-to-text, OCR, vision model и automatic parsing pipeline.
- Реальный MyFitnessPal API, credentials, network calls и worker/cron.
- Automatic PostgreSQL/media backup jobs, cloud provider implementation, restore automation.
- Legacy import/backfill, legacy `log_meal`, `update_meal`, `meals` search/summary/export compatibility.
- Новые UI widgets и broad rewrite of all existing insights. Если старые tools остаются на время перехода, это только до migration/reset и не является compatibility contract для новой модели.
- Полноценный destructive-delete UI; в slice реализуются DB/domain contracts и explicit deletion service seam, а не unattended deletion.

### Non-negotiable safety boundary

`"добавь"` может выставить `external_write_authorized=true` и создать pending journal entry, но первый slice **никогда не вызывает MyFitnessPal**. Ответ может быть только `journaled/pending`, не `synced/succeeded`. Любая sync failure после commit оставляет event и canonical state в базе.

---

## 3. Target schema

Создать `db/migrations/002_food_tracking.sql` (не изменять `001_initial_schema.sql`). Migration должна быть forward-only, повторно безопасной (`IF NOT EXISTS` там, где это уместно) и пригодной для fresh DB (`001` затем `002`) и existing DB.

### 3.1 Reset semantics

Так как пользователь отказался от legacy data и обратной совместимости:

- `002` в deployed/existing DB сначала удаляет nutrition legacy data: `DELETE FROM meals;` затем удаляет `meals` (или делает `DROP TABLE IF EXISTS meals` после явного удаления зависимостей, если на момент реализации зависимости подтверждены отсутствующими).
- Не удалять profiles/goals/water/weight/analytics без отдельного требования.
- Удаление должно быть явно прокомментировано как irreversible nutrition-data reset и покрыто migration test.
- Для dev/test test harness предпочитает `DROP/CREATE schema` или clean database + `001` + `002`, а не подбор отдельных residual tables.
- `public_landing_stats()` из `001` must be replaced/redefined so it counts `meal_events` current versions, not nonexistent `meals`. If first slice does not ship landing stats, the migration must still leave the database valid by replacing the function.

### 3.2 Tables and constraints

#### `meal_events`

Root aggregate, one eating occurrence:

- `id uuid primary key default gen_random_uuid()`;
- `user_id text not null`;
- `reported_at timestamptz not null`;
- `consumed_at timestamptz not null`;
- `meal_type text null` with existing four-value constraint if retained;
- `status text not null` (`active`, `deleted`, `pending` only if needed; avoid speculative states);
- `current_version integer not null default 1`;
- `idempotency_key text not null`;
- `external_write_authorized boolean not null default false`;
- `created_at`, `updated_at`, optional `deleted_at`;
- unique `(user_id, idempotency_key)`;
- checks: `current_version >= 1`, `consumed_at`/`reported_at` valid; no silent defaulting of user-supplied timestamps.

`consumed_at` defaults to the same instant as `reported_at` in the service contract, and is stored explicitly.

#### `meal_event_versions`

Append-only version header:

- `event_id uuid references meal_events(id) on delete restrict`;
- `version integer not null`;
- `correction_idempotency_key text null`;
- `correction_reason text null`;
- `raw_text_snapshot text null`;
- `parser_policy_version text not null`;
- `created_by text not null`;
- `created_at timestamptz not null`;
- primary key `(event_id, version)`;
- unique `(event_id, correction_idempotency_key)` where key is non-null.

No SQL `UPDATE` is used for historical version rows. A correction inserts a new version and updates only the root pointer `meal_events.current_version` atomically.

#### `meal_event_items`

Ordered positions within a version:

- `event_id`, `version`, `ordinal` as stable identity;
- `raw_item_text text not null`;
- `normalized_name text null`;
- `quantity numeric null`, `portion_value numeric null`, `portion_unit text null`;
- optional item-level notes;
- primary key `(event_id, version, ordinal)`;
- check `ordinal >= 0`; unique position through the primary key.

Nutrition values belong to provider result tables, not duplicated as mutable columns here.

#### `meal_event_inputs`

Immutable evidence/provenance:

- `id uuid primary key`;
- event/version FK;
- `source_kind`: `user_text`, `audio_transcript`, `photo_ocr`, `photo_vision`, `model_assumption`;
- `content text not null` for text/transcript/derived textual evidence;
- `content_hash text not null`;
- `precedence integer not null` with documented order user text > audio transcript > photo-derived > assumption;
- `metadata jsonb not null default '{}'`;
- `created_at`;
- unique `(event_id, version, source_kind, content_hash)`.

The lower-precedence input is retained and never silently discarded when text conflicts with it.

#### `meal_event_media`

Metadata only; no binary column:

- `id uuid primary key`;
- event/version FK;
- `kind` (`photo`, `audio`);
- `storage_key text not null` (generated opaque relative key, never caller path);
- `mime_type text not null`;
- `byte_size bigint not null check >= 0`;
- `sha256 text not null`;
- optional duration/width/height metadata;
- `created_at`;
- unique `(event_id, version, sha256)`.

#### `meal_event_nutrition_results`

Raw and normalized calculation results:

- event/version and optional `ordinal` (nullable for event aggregate);
- `provider` enum/check: `nutrition-local`, `own`, `myfitnesspal`;
- `status`: `succeeded`, `failed`, `unavailable`;
- `request_fingerprint text not null`;
- `algorithm_version text not null`;
- `raw_payload jsonb not null default '{}'`;
- nullable normalized nutrients: calories, protein, carbs, fat, fiber, sugar, alcohol;
- `error_code`, `error_message` nullable;
- `calculated_at`;
- unique `(event_id, version, ordinal, provider, request_fingerprint)` with a NULL-safe design (use a normalized scope key or separate event/item constraints; do not assume ordinary NULL uniqueness is sufficient).

Missing values remain NULL and are not converted to zero for consensus.

#### `meal_event_canonical_results`

One canonical row per event version and scope:

- event/version and optional ordinal scope;
- nullable canonical nutrient columns;
- `status`: `pending`, `ready`, `low_confidence`;
- `consensus_status`: `two_agree_one_outlier`, `all_agree`, `no_consensus`, `insufficient_data`;
- `eligible_providers text[]`, `outlier_providers text[]`, `threshold_percent numeric not null default 10`;
- `policy_version text not null`;
- `source_result_ids uuid[]` or equivalent provenance references;
- `created_at`;
- unique version/scope.

#### `meal_event_sync_journal`

Durable outbox/journal, independent from external success:

- `id uuid primary key`;
- event/version FK;
- `system text not null` (`myfitnesspal` in this slice; allow local sync only if needed);
- `operation text not null`;
- `request_fingerprint text not null`;
- `authorization_source text not null` (`explicit_add_intent` or equivalent);
- `state`: `pending`, `in_flight`, `succeeded`, `failed`, `dead_letter`;
- `attempts integer not null default 0`;
- `external_id`, `last_error`, `next_attempt_at`, timestamps;
- unique `(system, operation, request_fingerprint)`;
- index on retryable state and `next_attempt_at`.

No journal row means no claim of an authorized external write. A failed attempt updates journal state; it never deletes or rolls back local event data.

#### `backup_manifests`

Contract/index for future separately-run backups, not a scheduler:

- `id uuid primary key`;
- `backup_kind`: `postgres`, `media`;
- `retention_class`: `daily`, `monthly`;
- `snapshot_key`, checksum, created_at, covered-through metadata;
- deletion/tombstone status if required by permanent-delete receipt;
- unique kind/snapshot key.

The migration must not create jobs or claim that backups are operational. It only gives permanent-delete code an explicit index to target.

### 3.3 Delete semantics

- Ordinary delete is a tombstone (`meal_events.status='deleted'`, `deleted_at`) and does not delete versions, raw evidence, media files or backup manifests.
- Permanent delete is a separate explicit domain command requiring confirmation token/flag; it deletes live DB rows, invokes media deletion, and invokes backup-deletion adapter for both DB and media manifest entries.
- Backup deletion is an injected interface in this slice. If the adapter cannot confirm removal, permanent delete returns failure/partial receipt rather than claiming success.
- Never use broad `deleteAllUserData` as the implementation for a single event.

---

## 4. Exact file targets

### Create

- `db/migrations/002_food_tracking.sql` — forward schema, legacy data reset/drop, function update.
- `src/meal-types.ts` — shared branded/domain types and enums (no DB/network side effects).
- `src/meal-consensus.ts` — pure normalized nutrient consensus policy.
- `src/meal-events.ts` — repository/service contracts and transaction orchestration.
- `src/media-store.ts` — safe generated keys, file write/read/delete interface using Bun APIs.
- `src/backup-policy.ts` — daily/monthly retention policy and deletion adapter contracts only.
- `src/meal-events.test.ts` — domain/repository contract and transaction tests.
- `src/meal-consensus.test.ts` — exhaustive threshold/outlier tests.
- `src/media-store.test.ts` — file path/hash/metadata tests.
- `src/backup-policy.test.ts` — retention and permanent-delete contract tests.
- `src/db.integration.test.ts` — opt-in real PostgreSQL migration/transaction tests; skipped with a clear message when `DATABASE_URL_TEST` is absent.

### Modify

- `src/db.ts` — add a narrowly scoped `withTransaction`/client helper only; do not add the new repository into the legacy meal section and do not preserve `Meal`/`MealInput` as the new contract.
- `src/mcp.ts` — register new event tool and response schema; leave old registration out of the new model and do not silently reinterpret `log_meal`.
- `src/index.ts` — only wire required media root/config or route-specific bounded staging; preserve global 1 MiB body limit unless a separately tested route is introduced.
- `.env.example` — add `DATABASE_URL_TEST` and `MEDIA_ROOT` (non-secret examples only), plus explicit note that backup roots are separate and not automated in this slice.
- `README.md` — remove claims that legacy meal writes are the current food model; document new tool/scope and prominently state MFP sync/backups are not shipped yet.
- `CLAUDE.md` — update only stale food-tracking/migration statements necessary to keep implementation instructions truthful.
- `package.json` — add only dependencies/scripts actually required by implementation (prefer existing Bun/pg; no speculative SDK).

### Do not modify in this slice unless a test proves it is required

- `src/import.ts`, `src/export.ts`, `src/insights.ts`, widgets and all legacy meal tests. They should be removed or rewritten only after the new read model exists in a later bounded slice.

---

## 5. TDD implementation order

Every task below follows **Red → run failing test → Green minimal implementation → focused test → commit**. No production code before the corresponding failing test.

### Task 1 — Establish migration/reset contract

**Files:** create `db/migrations/002_food_tracking.sql`, `src/db.integration.test.ts`; modify `src/db.ts` only if transaction helper is needed.

**Red tests:**

- fresh DB applies `001` then `002` and exposes all new tables/constraints;
- existing DB with a legacy `meals` row applies `002`, removes the row/table, preserves profiles/goals/water/weight;
- rerunning `002` is safe or fails with an explicit already-applied contract, never half-applies;
- `public_landing_stats()` remains callable and counts current event versions.

**Green:** implement SQL and the smallest test harness/migration application command. Do not add automatic migration on server boot unless the repository chooses and tests a real ledger; an explicit `psql -f` sequence is acceptable for this first slice.

**Verification:** `DATABASE_URL_TEST=... bun test src/db.integration.test.ts -t migration`.

### Task 2 — Freeze domain contracts

**Files:** create `src/meal-types.ts`, `src/meal-events.test.ts`.

**Red tests:** compile-time/runtime contract fixtures for:

- one event with two ordered items;
- explicit `reported_at` and `consumed_at`, with omitted consumed time resolved equal to reported time;
- input precedence (`user_text > audio_transcript > photo_ocr/photo_vision > model_assumption`);
- provider names/statuses and nullable nutrient semantics;
- journal authorization and state transitions;
- correction request fingerprint distinct from initial create fingerprint.

**Green:** define exported types/interfaces and validation helpers. Keep raw payloads `unknown`/JSON-compatible and avoid embedding Telegram/vision SDK types.

### Task 3 — Implement consensus policy first

**Files:** create `src/meal-consensus.ts`, `src/meal-consensus.test.ts`.

**Red cases (must all exist before implementation):**

1. all three equal → canonical same value, `all_agree`;
2. two values within 10%, third beyond threshold → average only the agreeing pair and mark third outlier;
3. exactly 10% boundary is explicitly defined and tested; just-over threshold is disagreement;
4. zero/near-zero denominator uses a documented absolute epsilon rule, not division by zero;
5. missing/failed result is excluded, never treated as zero;
6. no two-provider consensus with three usable values → arithmetic mean of all eligible values and `no_consensus`;
7. one usable result → `pending`/`low_confidence`, no fabricated canonical number;
8. each nutrient is evaluated independently, and policy version/selected providers/outliers are emitted.

**Green algorithm contract:** normalize provider results, compare relative disagreement at 10%, select a pair when exactly two agree, average agreeing pair, otherwise average all available values, preserving NULL and provenance. Define rounding only at serialization/storage boundary; do not round before comparison.

**Verification:** `bun test src/meal-consensus.test.ts`.

### Task 4 — Implement safe media storage contract

**Files:** create `src/media-store.ts`, `src/media-store.test.ts`.

**Red tests:**

- bytes are written under configured `MEDIA_ROOT` with generated event/version key;
- returned metadata contains MIME, byte size and SHA-256;
- absolute names, `..`, separators and symlink/root escapes cannot select arbitrary paths;
- read verifies expected checksum;
- missing file/checksum mismatch is an explicit error;
- delete uses only generated key and is idempotent.

**Green:** use Bun file APIs and a root containment check; never use user-provided filename as a path. Persisting metadata belongs to event transaction, while byte write ordering must be explicit: stage/write/verify bytes first, then DB commit; cleanup staged bytes on DB failure.

**Verification:** `bun test src/media-store.test.ts`.

### Task 5 — Add transactional create event

**Files:** modify `src/db.ts`; create/modify `src/meal-events.ts`, `src/meal-events.test.ts`.

**Red integration tests:**

- create one event with two positions and all raw input/media metadata in one transaction;
- omitted `consumed_at` is stored equal to `reported_at`;
- same `(user_id, idempotency_key)` retry returns the original event/version and creates no duplicate child rows;
- concurrent same-key creates yield one root/version/items set;
- injected DB failure rolls back root, version, items, inputs, results and journal together;
- provider failure is represented as failed/unavailable result while raw event remains committed; local write is not rolled back because a provider/sync call failed.

**Green:** add transaction-scoped `pg.PoolClient` operations. The service must insert root, version, items, raw evidence, media metadata, provider results, canonical result and optional journal in one DB transaction. Resolve idempotency using a unique constraint and select existing aggregate on `23505`, not an unsafe check-then-insert only path.

**Verification:** `DATABASE_URL_TEST=... bun test src/meal-events.test.ts -t create`.

### Task 6 — Add immutable corrections/versioning

**Files:** modify `src/meal-events.ts`; extend `src/meal-events.test.ts`.

**Red tests:**

- correction creates version 2 and advances root `current_version` atomically;
- version 1 rows and serialized raw inputs remain unchanged;
- reads return current version by default and history returns both versions;
- repeated correction fingerprint returns version 2 rather than version 3;
- failed correction leaves version 1 as current and creates no partial version 2.

**Green:** implement correction as insert-only child rows plus one atomic root pointer update. Do not expose `UPDATE meal_event_versions`, `UPDATE meal_event_items` or legacy `updateMeal` semantics for this model.

**Verification:** `DATABASE_URL_TEST=... bun test src/meal-events.test.ts -t correction`.

### Task 7 — Add journal and explicit “добавь” authorization

**Files:** modify `src/meal-events.ts`; extend `src/meal-events.test.ts`; later wire `src/mcp.ts`.

**Red tests:**

- authorized add intent inserts one `pending` journal row before an external adapter would run;
- absent authorization does not create external-write journal row;
- same operation fingerprint is deduplicated;
- injected external failure changes journal to `failed`, leaves event/version/canonical rows present;
- retry increments attempts and does not create a duplicate journal row;
- no test may make a real network request.

**Green:** implement `SyncJournalWriter`/`ExternalWriter` interfaces and persistence state transitions. Keep the external adapter as a fake/null implementation in this slice. Ensure the transaction commits before any future external call; state `in_flight` must never be used to imply success.

**Verification:** `bun test src/meal-events.test.ts -t journal`.

### Task 8 — Add backup/delete policy contracts

**Files:** create `src/backup-policy.ts`, `src/backup-policy.test.ts`; extend `src/meal-events.ts` only through interfaces.

**Red tests:**

- policy returns independent DB/media targets;
- daily retention is exactly 30 days;
- monthly retention is forever/no expiry;
- ordinary tombstone leaves media and backup manifest references untouched;
- permanent delete refuses without explicit confirmation;
- permanent delete calls both DB and media backup deletion adapters and reports an unconfirmed/partial result if either adapter fails.

**Green:** implement pure retention and deletion orchestration contracts. Do not schedule jobs, upload snapshots, or claim backup execution. Keep deletion receipt/audit data sufficient to prove which live and backup targets were requested/deleted.

**Verification:** `bun test src/backup-policy.test.ts`.

### Task 9 — Wire the bounded MCP tool

**Files:** modify `src/mcp.ts`, optionally `src/index.ts`; add `src/mcp-food-tracking.test.ts`.

**Red tests:**

- `log_meal_event` accepts one event with multiple items, raw text, optional prepared photo/audio metadata, timestamps and provider inputs;
- returned payload includes event ID, version, positions, raw evidence summary, provider statuses, canonical result and journal state;
- explicit `add`/external authorization returns `pending`, not `synced`;
- no photo/vision pipeline is invoked;
- validation rejects duplicate ordinals, invalid MIME/negative sizes, malformed timestamps and empty item list;
- old legacy tool tests remain unchanged or are explicitly removed as part of the reset decision, never silently redirected.

**Green:** register one new tool with Zod boundary and call the domain service. Keep description honest: caller supplies already available text/metadata/results; tool does not inspect Telegram attachments or call MFP.

**Verification:** `bun test src/mcp-food-tracking.test.ts`.

### Task 10 — Truth pass and closeout

**Files:** `README.md`, `.env.example`, `CLAUDE.md`, `package.json` only as needed; all new tests.

**Checks:** remove obsolete claims that `meals` is the new model; state that legacy nutrition data is intentionally reset; state MFP network sync and automatic backups are future slices. Do not document unimplemented backup/restore commands.

**Verification:**

```bash
bun test
bun run typecheck
bun run format:check
```

If the repository has no `test` script, use the documented direct command `bun test`; do not invent a passing `bun run test` result.

---

## 6. Acceptance criteria

1. `002_food_tracking.sql` applies after `001` on a fresh DB and to an existing DB without rewriting `001`.
2. Applying the forward migration intentionally removes legacy `meals` nutrition rows/table; profiles/goals/water/weight are not accidentally deleted.
3. The new model has no dependency on legacy `Meal`/`MealInput` and has one `meal_event` aggregate with multiple ordered positions.
4. `reported_at` and `consumed_at` are distinct persisted fields; omitted consumed time equals reported time by explicit service behavior.
5. Raw user text, audio transcript metadata and photo/OCR/vision evidence are retained; precedence is deterministic and explicit text wins.
6. Media bytes are on disk below a configured root; Postgres stores only safe relative key and metadata including MIME, size and checksum.
7. Three provider namespaces exist: `nutrition-local`, `own`, `myfitnesspal`; unavailable/failed/missing values remain distinguishable from numeric zero.
8. Canonical calculation uses the 10% policy; two agreeing providers plus an outlier yields the average of the agreeing pair and records the outlier. Other cases retain an explicit status and provenance.
9. Creation and correction are transactionally persisted and idempotent under retry/concurrency.
10. Corrections create new versions; previous versions cannot be mutated or deleted by normal correction flow.
11. Explicit “add” intent creates a pending sync journal row; first slice makes no real MyFitnessPal network call.
12. Sync failure leaves the local event, raw data, provider results and canonical result intact.
13. Ordinary delete is a tombstone and does not remove backups/media. Permanent delete is explicit and calls deletion adapters for live data plus both DB/media backup manifests.
14. Backup policy is represented as separate DB/media daily (30 days) and monthly (forever) contracts, without automatic jobs in this slice.
15. `bun test`, `bun run typecheck` and `bun run format:check` pass; integration tests pass with a real test PostgreSQL URL.
16. Existing non-food tests remain green, and documentation does not claim unimplemented Telegram/vision, MFP sync or backup automation.

---

## 7. Verification commands

Run from `/Users/fishhead/.workspace/projects/nutrition-mcp`:

```bash
# Inspect clean state before implementation
pwd
git status --short
git log --oneline -8

# Pure TDD slices
bun test src/meal-consensus.test.ts
bun test src/media-store.test.ts
bun test src/backup-policy.test.ts
bun test src/meal-events.test.ts
bun test src/mcp-food-tracking.test.ts

# Real migration/repository integration (use an actual local test DB URL, not a placeholder)
DATABASE_URL_TEST='postgresql://...real-local-test-db...' bun test src/db.integration.test.ts

# Full gates
bun test
bun run typecheck
bun run format:check

# Optional direct migration smoke test against a disposable DB
psql "$DATABASE_URL_TEST" -v ON_ERROR_STOP=1 -f db/migrations/001_initial_schema.sql
psql "$DATABASE_URL_TEST" -v ON_ERROR_STOP=1 -f db/migrations/002_food_tracking.sql
```

The placeholder in the example above is documentation only; when executing, substitute the real local DSN. Never report integration success when `DATABASE_URL_TEST` is unavailable.

---

## 8. Follow-on slices

1. Add an explicit migration ledger/runner if more than this one forward migration is needed.
2. Implement text-first extraction and attachment ingestion as a separate bounded slice with route-specific size limits.
3. Implement the three real calculators/adapters and replayable canonical recalculation.
4. Implement the MyFitnessPal writer/worker against the journal, with idempotent external reconciliation.
5. Implement separate DB/media backup jobs, manifests, retention enforcement and restore drills.
6. Implement user-facing ordinary/permanent delete and verified backup deletion.
7. Build new event-based summaries/search/export; only then remove any remaining legacy code paths.

This ordering prevents a fake “full pipeline” from being declared complete before the durable event, provenance, consensus, correction and deletion contracts are real.
