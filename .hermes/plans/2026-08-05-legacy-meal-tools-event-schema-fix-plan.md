# Legacy Meal Tools → Append-Only Meal Events Implementation Plan

> **For Hermes:** execute this plan through the mandatory planner-fable → coder-kimi → reviewer-terra workflow. This is a plan only; do not implement production code in the planning stage. Preserve the existing dirty working tree and do not reset, stash, or overwrite unrelated changes.

**Goal:** migrate every meal-facing MCP path that still reads or writes the deleted `meals` table to the existing append-only `meal_events` model, while preserving the public legacy tool contracts where they can be represented honestly.

**Architecture:** `meal_events` is the sole meal source of truth. Read adapters join active events to `meal_event_versions` at `meal_events.current_version`, ordered `meal_event_items`, and event-scope (`ordinal IS NULL`) `meal_event_canonical_results`; historical versions remain available only for correction/history APIs. Writes must create/correct/delete event aggregates through the existing transactional event repository rather than reintroducing a flat compatibility table. The MCP layer remains the orchestration boundary: no Telegram, STT, OCR/vision, provider worker, or direct external MyFitnessPal implementation is added here.

**Tech stack:** Bun, TypeScript, `bun:test`, PostgreSQL via `pg`, MCP SDK `McpServer` + `Client` + `InMemoryTransport`, SQL migrations `001`–`005`, existing Zod MCP schemas.

---

## Why this slice now

The real MCP smoke test reached `tools/list` (48 tools) but 8 selected read-only tools fail with `relation "meals" does not exist`: `get_meals_today`, `get_meals_by_date`, `get_meals_by_date_range`, `get_nutrition_summary`, `get_goal_progress`, `get_trends`, `get_meal_patterns`, and `search_meals`. The failure is expected from the live schema: `db/migrations/002_food_tracking.sql` deliberately deletes `meals` and creates the append-only event model.

The old flat model is explicitly not needed. Do **not** restore `meals`, add a compatibility table, or add a view pretending to be the old table. The implementation must instead add an event-backed read/write adapter and prove it through a real PostgreSQL test database and an MCP client/transport.

## Current repository truth

Already present and reusable:

- `db/migrations/002_food_tracking.sql`: `meal_events`, immutable `meal_event_versions`, ordered `meal_event_items`, raw `meal_event_inputs`, media metadata, per-provider nutrition results, canonical results, and sync journal; the migration irreversibly drops `meals`.
- `db/migrations/004_calculation_bundles.sql` and `005_calculation_corrections.sql`: provider provenance/bundle fingerprints plus correction provenance and canonical audit fields.
- `src/meal-types.ts`: event/item/evidence/media/provider contracts, nullable nutrient fields, and explicit confirmation/sync vocabulary.
- `src/meal-events.ts`: transactional idempotent create, correction/versioning, current aggregate reads, canonical/provider/journal persistence, and journal state operations.
- `src/meal-captures.ts`: user-scoped capture confirmation already calls `createMealEvent` with `external_write_authorized: true`.
- `src/mcp-food-tracking.test.ts`, `src/meal-events.test.ts`, and `src/db.integration.test.ts`: real-MCP and real-PostgreSQL patterns, all gated by `DATABASE_URL_TEST` and explicitly skipped when it is absent.

The existing legacy layer is still wired through `src/db.ts` and `src/mcp.ts`. `src/insights.ts`, `src/export.ts`, and `src/import.ts` consume the legacy `Meal` shape, so changing only the eight failing handlers would leave other meal tools broken.

## Exact old `meals` query paths

All production SQL references found by repository inspection are in `src/db.ts`:

- `insertMeal`: select/insert/retry select at lines 170–216.
- `getMealsByDate`: select by `logged_at` range at lines 220–239.
- `getMealsInRange`: select by `logged_at` range at lines 241–261.
- `countMeals`: count at lines 263–273.
- `existingIdempotencyKeys`: lookup at lines 275–299.
- `getAllMeals`: paginated select at lines 314–335.
- `searchMeals`: description/notes `ILIKE` queries at lines 337–395.
- `deleteMeal`: hard delete at lines 397–406.
- `updateMeal`: select/`UPDATE ... RETURNING` at lines 408–503.
- `deleteAllUserData`: delete from `meals` at lines 1129–1150.

`src/db.integration.test.ts` intentionally inserts a legacy row into `meals` only to prove migration `002` removes it; that migration regression fixture must remain legacy-specific and must not be repurposed as application behavior.

Indirect affected paths:

- `src/mcp.ts`: `log_meal`, `bulk_import_meals`, `get_meals_today`, `get_meals_by_date`, `get_meals_by_date_range`, `search_meals`, `get_nutrition_summary`, `get_goal_progress`, `get_trends`, `get_meal_patterns`, `delete_meal`, and `update_meal` call the legacy DB functions. `buildMealProgress` also calls `getMealsByDate`.
- `src/insights.ts`: `DailyBucket` and all trend/pattern calculations are typed as legacy `Meal[]`; they need an event-backed projection with identical required fields or a new event projection type.
- `src/export.ts`: `getAllMeals` and the CSV shape depend on `Meal`.
- `src/import.ts` and `src/mcp.ts` bulk import: `runImport` accepts an `insert` callback and currently passes `insertMeal`; `countMeals` and `existingIdempotencyKeys` enforce import limits/idempotency.
- `src/db.ts` `deleteAllUserData`: the meal portion must delete event roots (and their children through an explicit dependency-safe strategy) without deleting unrelated profiles/goals/water/weight/analytics.

## Public contracts that must remain covered

The following output contracts are defined in `src/mcp.ts` and must continue to validate:

- Meal lines used by `get_meals_today`, `get_meals_by_date`, and the date-range tool: date/time, meal type, description/items, nutrients, notes, and stable event identifier. Preserve empty-result wording and date grouping.
- `get_nutrition_summary`: `start_date`, `end_date`, `logged_days`, `drink_unit`, nullable `goals`, `averages`, `recorded_days`, per-day totals/counts, and `meals` breakdown (`TOTALS_ITEM`, `MEAL_BREAKDOWN_ITEM` schemas near the top of `src/mcp.ts`). Preserve nullable fiber/sugar/alcohol coverage semantics.
- `get_goal_progress`: date, meal/water counts, drink unit, goals, totals, weight payload, and meal breakdown. Water/weight remain sourced from their existing tables.
- `get_trends`: existing text and structured daily series/widgets; calories/protein/carbs/fat/water count every calendar day while fiber/sugar/alcohol count only days with data. Preserve `src/insights.ts` behavior and the current 7/14/30-day widget series contract.
- `get_meal_patterns`: preserve recurring variation grouping/count/last-logged/typical-macro behavior and user/time-window scoping.
- `search_meals`: preserve the actual MCP input `queries: string[]` (plus optional `days`/`limit`), OR alternatives, AND tokens within an alternative, description/notes matching, newest-first ordering, and existing formatted variation response.
- `log_meal` and `bulk_import_meals`: preserve idempotent retry, row limits/control totals, alcohol display gating, and response/widget schemas where the adapter can provide a truthful event ID/version.
- `update_meal` and `delete_meal`: no in-place child mutation or physical root deletion; they must become correction/soft-delete operations with current-version reads.
- `export_meals`: preserve CSV compatibility as a projection; event IDs may be emitted as the existing `id` column, but item/event semantics must be decided explicitly (see decisions below).

## Event-to-legacy projection mapping

Implement one repository-level projection/query boundary (preferably a new `src/meal-event-projection.ts`, or an equivalently isolated section of `src/meal-events.ts`; coder must choose one and keep SQL out of MCP handlers). It should return a documented projection type used by all read-side legacy adapters.

For an active event `e`:

| Legacy projection field | Event schema source / rule |
|---|---|
| `id` | `meal_events.id` (stable aggregate identifier) |
| `user_id` | `meal_events.user_id`; every query predicates it explicitly |
| `logged_at` | `meal_events.consumed_at` (the user-facing eating time; do not use `created_at`) |
| `meal_type` | `meal_events.meal_type` |
| `description` | Deterministic rendering of current-version `meal_event_items` in ordinal order, preferably `normalized_name` when present and otherwise `raw_item_text`; retain raw text and do not invent a parser |
| `calories` … `alcohol_g` | Current-version event-scope canonical row in `meal_event_canonical_results` (`ordinal IS NULL`); preserve NULLs rather than converting missing values to zero before existing display/aggregation rules |
| `notes` | No direct event-root equivalent. Candidate is the current-version item notes joined/rendered, or a documented empty/null value. This requires a product decision because search and export currently promise meal-level notes |
| `idempotency_key` | `meal_events.idempotency_key` |
| current version | `meal_events.current_version`; expose internally for correction/read consistency, not necessarily in every old text response |
| deleted status | Exclude `status = 'deleted'` from normal reads; never expose a deleted root as an active meal |

The query must join `meal_event_versions` on `(event_id, version = current_version)`, left join the event-scope canonical result, and aggregate current-version items in ordinal order. It must never select stale version rows or sum item canonical rows in addition to the event aggregate. If event-scope canonical data is absent/pending, return nullable nutrients and let the established formatter show missing data; do not fabricate zeroes or recompute provider consensus in the read adapter.

For item-aware output, retain an internal `items` array containing ordinal/raw/normalized/portion/notes. `description` is only a compatibility rendering for legacy consumers. Search should match both rendered item text and current-version raw evidence (`raw_text_snapshot` / `meal_event_inputs.content`) only if the behavior is explicitly documented and tested; do not broaden matching accidentally.

## Scope decision: what must migrate in this bounded slice

All old `meals` paths must be removed from production code in this slice, not just the eight smoke-test reads. Otherwise the next call to `log_meal`, `bulk_import_meals`, `update_meal`, `delete_meal`, `export_meals`, or account deletion fails against the same missing relation.

In scope:

1. A current-version event projection and date/range/search/count/idempotency repository methods.
2. The eight observed read failures plus `get_meal_patterns` using the projection.
3. `log_meal` and `bulk_import_meals` writes through the event model.
4. `update_meal` as an append-only correction path and `delete_meal` as a user-scoped soft delete.
5. Export, import limits/idempotency, progress helpers, and delete-all-data cleanup.
6. Real MCP client regression coverage and real PostgreSQL migration/schema coverage.

Out of scope: Telegram/webhook ingestion, STT, OCR/vision, provider calls/workers, external MyFitnessPal delivery, new capture orchestration, backup jobs, or restoring any legacy table/view.

## Design decisions and guardrails

1. **Single read source:** current-version event projections only; no mixed reads from `meals` and events.
2. **Append-only corrections:** an update creates version `current_version + 1` with correction metadata and new items/results/canonical row; prior versions are untouched. Reuse `correctMealEvent` or the calculation-correction boundary rather than writing child rows directly.
3. **Deletion:** set `meal_events.status = 'deleted'`, `deleted_at`, and `updated_at` in a user-scoped transaction. Do not physically delete an event because versions, evidence, results, and journal rows are intentionally retained.
4. **Idempotency:** creation keys remain `(user_id, idempotency_key)`; correction keys remain per event; bulk import must derive stable event-create keys without collapsing identical rows that are intentionally distinct in one source batch.
5. **Canonical truth:** old reads use the persisted event-scope canonical result at the current version. They must not infer a total from provider rows or treat failed/unavailable provider values as zero.
6. **User scoping:** every event read, correction, delete, count, search, export, and cleanup query must constrain `user_id`; an event ID alone is never authorization.
7. **Timezone:** date/range boundaries continue to use `zonedDayStartUtc`/`zonedNextDayStartUtc` and compare against `consumed_at`.
8. **Alcohol:** preserve the existing display-only opt-in; stored canonical `alcohol_g` remains hidden when tracking is off.
9. **No hidden parser/provider:** the compatibility adapter may render a one-item event, but it must not invent a Telegram parser or call providers.

## Open contradictions requiring Dmitrii's decision before coding

These are real contract mismatches, not implementation details:

1. **How should legacy `log_meal` become an event?** Its public input supplies one description and optional precomputed nutrients, but `CreateMealEventCommand` requires `items`, evidence, parser policy/creator, and provider results. Decide whether to:
   - wrap the description as one `raw_item_text`, store nutrients as an explicitly named compatibility/provider result and derive canonical from it;
   - route legacy `log_meal` to a new prepared-event MCP tool and change the public contract; or
   - retire `log_meal` in favor of `log_meal_event`/capture confirmation.
   The recommended bounded approach is the first, with a clearly labeled compatibility source and no claim of multi-provider consensus.
2. **What is the legacy `Meal.notes` mapping?** The event model has item notes and raw evidence but no meal-level notes. Decide whether to render/join current-version item notes, add a root-note field via a migration, or make notes unavailable in legacy search/export. Do not silently lose notes.
3. **What does `update_meal` correction mean for fields omitted by the old patch API?** A correction needs a complete new version. Decide whether the adapter must read the current projection, merge the patch, and write a complete one-item version, or whether the public tool should be changed to accept a full event correction payload.
4. **How should `delete_meal` report idempotent/not-found cases?** Existing code always says deleted after `DELETE` regardless of row count. Decide whether soft delete should preserve that response, return “not found,” or expose `deduplicated/already_deleted`.
5. **How should multi-item events be exported?** A flat CSV row cannot represent one event with multiple items without either one row per event with rendered description or one row per item with duplicated event totals. Recommended: one row per event, rendered current-version item description, event-scope canonical totals, and event ID in `id`; document that re-import recreates a one-item compatibility event unless the importer format is extended.
6. **What is the required behavior when canonical is pending/missing?** Reads can return nullable nutrients, but legacy formatters currently treat several fields as numeric totals. Decide whether to show an explicit “nutrition pending/unavailable” marker, return nulls in structured output, or exclude the event from nutrition totals while still listing it.
7. **Should old mutators be kept at all?** The brief requires checking them; it does not explicitly say whether compatibility tools may change shape. Dmitrii should confirm “migrate and keep” versus “remove/deprecate.” This plan assumes keep-and-adapt for one bounded release.

If Dmitrii does not resolve these choices, coder-kimi must stop at the boundary rather than invent behavior. The recommended defaults above may be used only after explicit approval.

## File-by-file implementation plan

### 1. Add the event-backed projection/repository boundary

**Files:**
- Create: `src/meal-event-projection.ts` (recommended) or modify `src/meal-events.ts` if the repository convention requires one module.
- Modify: `src/meal-types.ts` only if a shared projection/compatibility type is needed.
- Tests: new `src/meal-event-projection.test.ts` plus PostgreSQL cases in `src/meal-events.test.ts` or a focused integration file.

Implement parameterized queries for:

- `getMealsByDate(userId, date, tz)` and `getMealsInRange(userId, startDate, endDate, tz)` against `consumed_at`.
- `countMeals(userId)` against active events.
- `existingIdempotencyKeys(userId, keys)` against active/all roots according to the chosen retry policy.
- `getAllMeals(userId)` with stable `(consumed_at, id)` pagination.
- `searchMeals(userId, queries, { limit, sinceIso })` against current-version rendered item text/notes, with exact existing token semantics.
- `getMealEvent`/projection by ID with user scope for mutators.

Tests must seed two users, multiple versions for one event, item-level and event-level canonical rows, deleted events, null nutrients, and a boundary timestamp around a timezone day. Assert only current-version active rows appear and cross-user IDs return no data.

### 2. Convert the compatibility write path

**Files:**
- Modify: `src/db.ts` to remove production `meals` SQL and either delegate legacy function names to the event adapter or replace call sites with event repository functions.
- Modify: `src/mcp.ts` for `log_meal`, `bulk_import_meals`, `update_meal`, `delete_meal`, and `buildMealProgress` dependency wiring.
- Modify: `src/import.ts` only where the insert/idempotency callback types need an event-backed result.
- Tests: `src/mcp-food-tracking.test.ts`, `src/mcp.test.ts`, and focused repository tests.

Write the red MCP tests first. Through `McpServer` + linked `InMemoryTransport`, call the public legacy tools and assert they create/read event rows, never query `meals`, preserve idempotency, and keep user scope. Use the approved compatibility policy for one-item events, evidence, provider/canonical status, and notes.

For `update_meal`, read the current event projection, merge the requested fields, create a new immutable version, advance `current_version`, and return the new current projection. For `delete_meal`, soft-delete the root and verify subsequent reads/aggregates omit it while history remains queryable by the event repository.

For bulk import, preserve dry-run/control-total behavior and source-row idempotency, but inject an event-backed insert callback. Verify duplicate-looking rows in one batch retain the existing documented occurrence behavior.

### 3. Migrate insights and all eight read tools

**Files:**
- Modify: `src/mcp.ts` handlers and helper types/formatters.
- Modify: `src/insights.ts` to consume the event projection (or introduce a conversion function at the repository boundary with tests proving no information-changing accidental zeroing).
- Tests: `src/mcp.test.ts` and new real-DB MCP regression cases in `src/mcp-food-tracking.test.ts`.

Keep the public schemas/text stable. Confirm:

- three date/list tools format current-version item descriptions and event canonical totals;
- summary and goal progress count events once and use event-scope canonical results;
- trends and patterns use active current-version events only;
- search accepts `queries: string[]` and returns the existing grouping/variation contract;
- widgets receive finite, schema-valid structured content, with pending/null policy applied consistently.

`get_meal_patterns` must be inspected at its exact handler and aggregation path during coding; do not assume it is covered merely because `get_trends` is fixed.

### 4. Migrate export, cleanup, and destructive account deletion

**Files:**
- Modify: `src/export.ts` to consume the event projection and document one-row-per-event behavior.
- Modify: `src/db.ts` `deleteAllUserData` to delete event roots in dependency-safe order or use a transaction that removes child rows before roots, while preserving unrelated tables and export-file cleanup.
- Tests: `src/export.test.ts`, `src/db.integration.test.ts`, and MCP tests for export/delete-all if present.

Ensure export never resurrects `meals`, leaks another user, or emits stale correction totals. For account deletion, verify event children/journal/history are removed only for the requested user, and profiles/goals/water/weight/analytics behavior remains the existing contract.

### 5. Regression-proof migration/test database setup

**Files:**
- Modify: `src/db.integration.test.ts` only to add event-backed compatibility fixtures and ensure the complete `001 → 002 → 003 → 004 → 005` chain is applied.
- Modify: `src/meal-events.test.ts` / `src/mcp-food-tracking.test.ts` for real MCP + DB coverage.
- Do not modify `db/migrations/002_food_tracking.sql` to restore `meals`; add a new migration only if one of the approved decisions requires a root notes/compatibility column.

Every DB suite must use an explicit `DATABASE_URL_TEST` gate. The test database is disposable: tests may `DROP SCHEMA public CASCADE`, apply migrations, and must never use production `DATABASE_URL`. A missing `DATABASE_URL_TEST` is a loud skip, not evidence of success.

## Suggested TDD order

### Slice A — projection contract (RED → GREEN)

1. Add pure projection/rendering tests for one event, multiple ordered items, null canonical, current-version selection, and note policy.
2. Add real PostgreSQL tests for date/range/current-version/user filtering.
3. Implement the repository projection and run focused tests.

### Slice B — read tools through real MCP transport

1. Add DB-gated MCP tests for all 8 smoke-test failures with seeded events and a second user.
2. Assert exact existing input schemas, empty responses, structured output schemas, date/timezone boundaries, and no stale-version totals.
3. Implement handler wiring and insights adaptation; run `bun test src/mcp-food-tracking.test.ts src/mcp.test.ts` with `DATABASE_URL_TEST`.

### Slice C — writes and correction semantics

1. Add failing MCP tests for `log_meal`, `bulk_import_meals`, `update_meal`, `delete_meal`, and duplicate retries.
2. Add direct DB assertions for append-only versions, current pointer advancement, soft deletion, canonical rows, and user isolation.
3. Implement compatibility writes only after Dmitrii approves the open decisions.

### Slice D — export/import/account cleanup

1. Add failing projection export/import/delete-all tests.
2. Implement and verify one-row-per-event export, event-backed import limits/idempotency, and dependency-safe per-user cleanup.

### Slice E — independent reviewer verification

Reviewer-terra must inspect the final diff against this plan and the brief, specifically checking for any remaining production `meals` SQL, stale-version reads, physical deletes, missing user predicates, skipped DB tests, altered MCP schemas, fabricated canonical values, or unrelated working-tree changes.

## Acceptance criteria

All must be true before this slice is considered complete:

- No production application path contains SQL against `meals`; the only remaining `meals` references are migration-compatibility comments/fixtures and explicitly documented CSV wording where appropriate.
- No `meals` table, compatibility view, or compatibility table is restored.
- All 8 observed failures pass through a real MCP client/transport against PostgreSQL with `DATABASE_URL_TEST` set.
- `get_meals_today`, `get_meals_by_date`, and `get_meals_by_date_range` list active current-version events, with correct timezone boundaries, stable event IDs, item rendering, canonical totals, and existing empty-result behavior.
- `get_nutrition_summary`, `get_goal_progress`, `get_trends`, and `get_meal_patterns` count each active event once, use current-version event-scope canonical data, preserve null/coverage/alcohol semantics, and return schema-valid structured content/widgets.
- `search_meals` accepts the actual `queries: string[]` shape and preserves token/alternative/limit/lookback semantics while being user-scoped and current-version-only.
- `log_meal` and `bulk_import_meals` no longer fail on the missing relation, preserve approved idempotency/control-total behavior, and write event roots/versions/items/canonical results according to the approved compatibility policy.
- `update_meal` appends an immutable correction version; it never updates historical child rows or mutates a prior version in place.
- `delete_meal` is a user-scoped soft delete; deleted events disappear from ordinary reads/aggregates but retained history is not physically destroyed.
- `export_meals`, `deleteAllUserData`, progress helpers, and all indirect meal paths operate without `meals` and preserve their documented contracts.
- Cross-user reads, searches, updates, deletes, exports, and cleanups cannot access or mutate another user's events.
- Idempotent create/retry and correction retry do not duplicate roots, versions, canonical rows, or sync journal entries.
- Existing append-only, current-version, correction, idempotency, canonical-consensus, and explicit-confirmation semantics remain intact; no external provider or Telegram/STT/OCR worker is introduced.
- Fresh and rerun migration tests pass for `001 → 002 → 003 → 004 → 005`; no migration is changed to recreate legacy `meals`.
- Focused tests, full test suite, `bun run typecheck`, `bun run format:check` (with unrelated pre-existing failures reported separately if still present), and `git diff --check` are run. DB claims are invalid if `DATABASE_URL_TEST` was not set.
- The final diff contains only the approved implementation/test/docs changes; all pre-existing dirty files and unrelated untracked plans remain intact.

## Verification commands

Run from `/Users/fishhead/.workspace/projects/nutrition-mcp` with a disposable PostgreSQL URL in the environment (never a placeholder and never production):

```bash
DATABASE_URL_TEST="$REAL_SCRATCH_POSTGRES_URL" bun test src/meal-event-projection.test.ts src/meal-events.test.ts src/mcp-food-tracking.test.ts src/db.integration.test.ts
DATABASE_URL_TEST="$REAL_SCRATCH_POSTGRES_URL" bun test
bun run typecheck
bun run format:check
bunx prettier --check src/db.ts src/meal-events.ts src/mcp.ts src/insights.ts src/export.ts src/import.ts src/meal-event-projection.ts
 git diff --check
```

Also run the real MCP smoke/regression script used to produce the brief against the local server after applying migrations, and verify all selected read-only calls plus the mutating compatibility calls. Record the exact pass/skip/fail counts; do not report skipped DB suites as passing.

## Risks and guardrails

- **Semantic loss from flattening:** one event can contain many items while old outputs expect one description. Keep an internal item array and make the rendering/export rule explicit and tested.
- **Incorrect totals:** use only event-scope canonical rows at `current_version`; never sum item rows or provider rows for the legacy aggregate.
- **Pending canonical data:** preserve nulls and an explicit pending/unavailable policy; never turn absent nutrition into zero.
- **Correction regressions:** lock the root, append a version, write all children/results/canonical data atomically, and update the root pointer only in the same transaction.
- **Authorization leaks:** every repository query accepts user ID and binds it in SQL; verify cross-user MCP calls with real transport.
- **Test lies:** all DB tests are opt-in via `DATABASE_URL_TEST`; migration harnesses must apply all current migrations and inspect that `meals` is absent.
- **Dirty tree damage:** inspect `git status --short` before and after; do not format or modify unrelated existing files.

## Follow-on work (not this slice)

- Agent-facing capture/parser/provider orchestration remains owned by Hermes and may use the existing capture/event/bundle tools.
- Real nutrition provider adapters and MyFitnessPal worker delivery remain separate slices behind the existing raw-result and sync-journal boundaries.
- If Dmitrii chooses a root-level event notes field or a new multi-row export/import format, plan that schema/contract change separately unless it is explicitly approved as part of this slice.
