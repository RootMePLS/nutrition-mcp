# S9 — Operator docs and smoke truth: kimi handoff

- Date: 2026-08-06
- Scope: Slice S9 of
  `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` (lines 597-635)
  only. No S10 work started.
- Base: `c7b8286` (`docs: accept S8 repository truth cleanup`), clean tree.
- Changed files: `README.md` (commit 1), `scripts/mcp-smoke.ts` + this handoff
  (commit 2). No runtime, migration, schema, provider, version, or unrelated
  files touched.

## RED (before edits)

Current smoke executed at the base commit:

```
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run scripts/mcp-smoke.ts
```

Result: exit 0, but only 10 steps. Grep inventory of tool coverage in
`scripts/mcp-smoke.ts` at base (call-name occurrences; 0 = path absent):

- Present: `log_meal`, `bulk_import_meals`, `update_meal`,
  `get_meals_by_date`, `search_meals`, `get_nutrition_summary`,
  `export_meals`, `delete_meal`.
- Absent (RED): `get_meals_today`: 0, `get_meals_by_date_range`: 0,
  `get_goal_progress`: 0, `get_trends`: 0, `get_meal_patterns`: 0,
  `start_meal_capture`: 0, `attach_meal_capture_media`: 0,
  `save_meal_capture_draft`: 0, `confirm_meal_capture`: 0,
  `get_meal_capture`: 0.

So 5 of the 8 legacy reads and the entire capture media path were not
exercised by the operator smoke.

README at base documented only `001` + `002` in the migration command block
and `001..003` in the order sentence; `004_calculation_bundles.sql` and
`005_calculation_corrections.sql` existed in `db/migrations/` but were not
copy-pasteable from the README.

## GREEN

```
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run scripts/mcp-smoke.ts
```

Exit 0; every step names its tool. Full output:

```
smoke ok: log_meal
smoke ok: bulk_import_meals
smoke ok: update_meal
smoke ok: get_meals_today
smoke ok: get_meals_by_date
smoke ok: get_meals_by_date_range
smoke ok: search_meals
smoke ok: get_nutrition_summary
smoke ok: get_goal_progress
smoke ok: get_trends
smoke ok: get_meal_patterns
smoke ok: export_meals
smoke ok: export csv content
smoke ok: delete_meal
smoke ok: read excludes deleted
smoke ok: start_meal_capture
smoke ok: attach_meal_capture_media
smoke ok: attach staged bytes on disk
smoke ok: save_meal_capture_draft
smoke ok: confirm_meal_capture
smoke ok: get_meal_capture re-read
smoke ok: get_meals_by_date shows confirmed capture
smoke ok: confirmed event media persisted
MCP smoke: all steps passed — log_meal, bulk_import_meals, update_meal, get_meals_today, get_meals_by_date, get_meals_by_date_range, search_meals, get_nutrition_summary, get_goal_progress, get_trends, get_meal_patterns, export_meals, delete_meal, start_meal_capture, attach_meal_capture_media, save_meal_capture_draft, confirm_meal_capture, get_meal_capture.
```

## Per-tool inventory and assertions

Order follows the governing checklist
(log→today→by_date→by_date_range→search→summary→goal_progress→trends→patterns→export→delete),
with bulk/update retained before the reads and the capture round trip after
delete. All calls go through the real MCP transport (`InMemoryTransport`
linked pair against `registerTools`). Every response is asserted non-error;
`structuredContent` presence and key identity/state fields are asserted for
every exercised S6 contract.

1. `log_meal` — structuredContent: `action` = "logged", `date` = smoke day,
   `provenance_status` = "compatibility", `event_version` = 1,
   `has_calculation_bundle` = false; text contains the description.
2. `bulk_import_meals` — structuredContent `summary.created` = 1.
3. `update_meal` — structuredContent `action` = "updated"; text contains the
   corrected 350 kcal.
4. `get_meals_today` — text contains both smoke meals (no outputSchema; text
   contract). Clock frozen at UTC noon (`setSystemTime`, restored in
   `finally`) so server-side "today" is deterministic — same approach as the
   S8 clock-freeze regression test.
5. `get_meals_by_date` — text contains both meals and "Calories: 350".
6. `get_meals_by_date_range` — text contains the day header and both meals.
7. `search_meals` — text contains "smoke oatmeal".
8. `get_nutrition_summary` — structuredContent: `logged_days` = 1, `days`
   length 1, `meals` length 2.
9. `get_goal_progress` — structuredContent: `date` = smoke day,
   `meal_count` = 2.
10. `get_trends` — structuredContent: `end_date` = smoke day, `days` length 30.
11. `get_meal_patterns` — non-error, text contains "Patterns" (no
    outputSchema; text contract).
12. `export_meals` — text reports "2 meal"; the exported CSV on disk contains
    "smoke oatmeal" and ",350,".
13. `delete_meal` — non-error; `get_meals_by_date` re-read excludes the
    deleted meal and still shows the bulk-imported one.
14. `start_meal_capture` — structuredContent: `state` = "receiving",
    `capture_id` string, `event_id`/`version` null.
15. `attach_meal_capture_media` — 12-byte PNG fixture as `bytes_base64`
    through the public tool boundary; structuredContent: `capture_id` echo,
    `media_id` string, `storage_key` = `capture/<capture_id>/photo-<sha256>`,
    `sha256` matches the fixture hash, `byte_size` = 12, `capture_state` =
    "receiving", `deduplicated` = false. Staged file bytes on disk re-hashed
    to the same SHA-256.
16. `save_meal_capture_draft` — draft echoes the attach identity (`kind`,
    `storage_key`, `mime_type`, `byte_size`, `sha256`, `metadata`);
    structuredContent `state` = "ready_to_confirm".
17. `confirm_meal_capture` — structuredContent: `state` = "confirmed",
    `event_id` string, `version` = 1, `provenance_status` in the S6 enum,
    `compatibility` boolean.
18. Persisted/re-read proof: `get_meal_capture` returns `state` = "confirmed"
    with one media entry; `get_meals_by_date` shows the confirmed capture's
    item text ("smoke capture oats"); `meal_event_media` has exactly one row
    for the confirmed event at version 1.

Uniqueness/cleanup: a per-run `RUN` suffix makes every idempotency key unique
(`smoke-log-<RUN>`, `smoke-capture-<RUN>`, `smoke-attach-<RUN>`,
`smoke-confirm-<RUN>`). Media bytes stage under a per-run `mkdtemp` scratch
root injected via the `registerTools` `mediaStore` dep (never the production
`MEDIA_ROOT`); the `finally` restores the clock, closes client/server/pools,
and removes both the exports dir and the media scratch, and a
`process.on("exit")` hook removes them even on a setup-failure exit. No
listener is ever bound (in-memory transport only).

## Migration copy-paste proof (acceptance commands, verbatim)

```
$ dropdb --if-exists nutrition_mcp_smoke && createdb nutrition_mcp_smoke
NOTICE:  database "nutrition_mcp_smoke" does not exist, skipping
$ for f in db/migrations/00{1,2,3,4,5}_*.sql; do psql postgres://localhost:5432/nutrition_mcp_smoke -v ON_ERROR_STOP=1 -f "$f"; done
== 001_initial_schema.sql:      CREATE TABLE x10, CREATE INDEX x12, CREATE FUNCTION, COMMENT, INSERT 0 1
== 002_food_tracking.sql:       DROP FUNCTION, DO, CREATE TABLE x9, CREATE INDEX x4, CREATE FUNCTION, COMMENT
== 003_meal_captures.sql:       CREATE TABLE x3, CREATE INDEX x1
== 004_calculation_bundles.sql: NOTICE column "source_id" ... already exists, skipping; ALTER TABLE x7, UPDATE 0, CREATE INDEX
== 005_calculation_corrections.sql: ALTER TABLE x8, DO, CREATE INDEX
chain exit=0
```

Verification: `\dt` on the fresh DB listed 19 tables (profiles,
nutrition_goals, water_log, weight_log, food_cache, backup_manifests,
tool_analytics, meal_events, meal_event_versions, meal_event_items,
meal_event_inputs, meal_event_media, meal_event_nutrition_results,
meal_event_canonical_results, meal_event_sync_journal, meal_captures,
meal_capture_messages, meal_capture_answers, meal_capture_media), then
`dropdb nutrition_mcp_smoke` succeeded and
`SELECT count(*) FROM pg_database WHERE datname='nutrition_mcp_smoke'`
returned 0 — no database orphan.

## Gates

- Smoke (GREEN command above) — exit 0, 23 steps, every required tool named.
- `bun run typecheck` — src/ typechecks clean.
- `bun run test:unit` — 498 pass, 0 fail, 156 skip, 654 tests (unchanged).
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`
  — 140 pass, 0 fail, 0 skip across the 8 DB suites: 8, 41, 13, 20, 20, 7,
  23, 8 (`db.integration`, `meal-events`, `calculation-bundles.integration`,
  `meal-captures.integration`, `mcp-food-tracking`, `backup-policy`,
  `legacy-meal-tools.integration`, `calculation-acceptance.integration`) —
  unchanged per-suite counts.
- Migration chain proof — see above; exit 0 per file under ON_ERROR_STOP.
- Changed-file Prettier: `bunx prettier --check README.md scripts/mcp-smoke.ts .hermes/plans/2026-08-05-gap-remediation-s9-kimi-handoff.md`
  — pass.
- `git diff --check` — pass.
- Repository-wide `bun run format:check` — still RED, pre-existing and
  untouched by S9: 28 files, all historical markdown under `.hermes/plans/`
  (calculation-provenance-enforcement brief/plan/reviews x9,
  gap-remediation campaign brief/plan, gap-remediation terra reviews and the
  s8-kimi-handoff-3/s8 reviews x11, legacy-meal-tools-event-schema-fix
  brief/plan/fixes x5). Formatting those is S10 scope
  (campaign plan lines 639+); none were modified here.

## REFACTOR

No production code changed, so nothing to refactor in `src/`. Within the
smoke itself: `check()` now throws instead of calling `process.exit(1)` so
the `finally` cleanup (clock restore, pool close, scratch removal) runs on
failure too; the header comment now states the true coverage.

## Commits and push state

1. `6f237b6` — `docs: document the full 001-005 migration chain` — README
   only: the psql command block now lists 001..005, the order sentence lists
   all five files, and the destructive-`002` warning is retained verbatim.
2. This commit — `test: extend MCP smoke to all legacy reads and capture media`
   — `scripts/mcp-smoke.ts` plus this handoff.

Pushed after green; post-push `git status` clean and `HEAD` equals
`origin/main` (verified with `git rev-parse HEAD origin/main`).
