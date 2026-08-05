# Slice S3 remediation handoff 2 — per-nutrient aggregate coverage + null empty-range averages

Date: 2026-08-05
Slice: S3 remediation of `.hermes/plans/2026-08-05-gap-remediation-s3-terra-review.md` (FAIL: F1, F2)
Coder: coder-kimi
Base HEAD: `45be11d9ddd74639c5bf3168396ee3a694618183` (tree clean except the preserved uncommitted FAIL review)

## Review preservation

`.hermes/plans/2026-08-05-gap-remediation-s3-terra-review.md` was preserved
byte-identically throughout the work (never opened for write).

- SHA-256 before remediation: `3f438a88843b88e758cf0d19088ca9cf204015378c7a6842be266731d81c2646`
- SHA-256 after all gates, pre-commit: `3f438a88843b88e758cf0d19088ca9cf204015378c7a6842be266731d81c2646`

## Scope executed

Only the exact coder-kimi fixes plan in the FAIL review. Storage, migrations,
consensus, provider persistence, calculation bundles, meal-events, and
provenance-status fields untouched (`git diff --stat` shows only `src/mcp.ts`,
`src/mcp.test.ts`, `src/legacy-meal-tools.integration.test.ts`, `README.md`,
`docs/food-tracking-agent-driven.md`). S4 not started. No S4 behavior was
required: the per-nutrient coverage object is additive within the existing S3
schemas.

## What changed

- `src/mcp.ts`
    - `MealsCalculated` (new exported interface): per-core-macro integer
      counts `{ calories, protein_g, carbs_g, fat_g }` — how many meals carry
      each specific nutrient.
    - `DailyTotals.meals_calculated`: scalar `number` -> `MealsCalculated`
      (F2). `DailyAverages` inherits it.
    - `emptyTotals`: zero-filled per-macro object.
    - `coreMacroCounts(meals)` (new exported helper, REFACTOR extraction):
      per-macro presence counting shared by `sumMeals` and
      `trendsDayPayloadOf`; an explicit stored 0 counts as coverage for its
      own macro. Replaces the now-deleted any-macro `hasCalculatedCore`.
    - `sumMeals`: assigns `coreMacroCounts(meals)`; sums unchanged.
    - `rangeAverages`: sums the per-macro counts over the range; `coreAverage`
      now returns `null` for an EMPTY range too (F1) — the
      `perDay.length || 1` exception is removed for core macros. Water alone
      keeps the legacy `water / (perDay.length || 1)` average. The accepted
      every-logged-day denominator is unchanged for non-empty ranges.
    - `MEALS_CALCULATED_ITEM` (new exported Zod object, four
      `z.number().int()`); `TOTALS_ITEM.meals_calculated` uses it;
      `TRENDS_DAY_ITEM` extends `TOTALS_ITEM`, so summary, goal progress,
      trends, and log/update-meal progress outputs all expose the
      per-nutrient counts.
    - `totalsPayloadOf` passes the object through; `trendsDayPayloadOf` builds
      it via `coreMacroCounts(bucket.meals)`.
- `src/mcp.test.ts` — RED-first unit tests (see RED below): distinct-presence
  matrices where calories coverage differs from protein/carbs/fat, explicit
  zero counting as coverage for its own macro only, empty `rangeAverages`
  (null cores + zero counts), unlogged trend day with zero per-macro coverage,
  and a calorie-only trends day. Every payload assertion parses with
  `TOTALS_ITEM` / `TRENDS_DAY_ITEM`.
- `src/legacy-meal-tools.integration.test.ts` — real PostgreSQL +
  `InMemoryTransport`: the pending/mixed/explicit-zero fixtures now parse
  every structured payload with its declared schema (`SUMMARY_DAYS` =
  `TOTALS_ITEM.extend({date, meal_count})`, `TOTALS_ITEM`, `TREND_DAYS`) and
  assert per-macro counts. New test "distinct per-nutrient presence, unlogged
  days and empty ranges disclose per-macro coverage" seeds a calorie-only meal
  beside a full meal and proves `{calories:2, protein_g:1, carbs_g:1, fat_g:1}`
  across summary, goal progress and trends, an unlogged trend day with null
  cores and zero per-macro counts, an empty summary range with null core
  averages, and CSV columns `400,,,,,,,` vs `200,10,20,5,,,,`.
- `README.md` + `docs/food-tracking-agent-driven.md` — the totals presence
  contract now states the per-nutrient `meals_calculated` object semantics and
  the null empty-range core averages (water's legacy 0 called out).

## RED (watched fail, focused)

- `bun test src/mcp.test.ts -t "presence"` -> 2 pass / 9 fail. Failures are
  the intended reason, e.g.
  `expect(t.meals_calculated).toEqual({calories:2, protein_g:1, carbs_g:1, fat_g:1})`
  received `2` (the reviewer-terra counterexample: a scalar 2/2 falsely
  implies complete protein coverage).
- `bun test src/mcp.test.ts -t "range"` -> 5 pass / 4 fail (per-macro object
  expected, scalar received).
- `bun test src/mcp.test.ts -t "an empty range has null core averages"` ->
  0 pass / 1 fail: `expect(averages.calories).toBeNull()` — **Received: 0**
  (F1's fabricated empty-range numeric 0).
- `bun test src/mcp.test.ts -t "calorie-only day discloses"` -> 0 pass /
  1 fail (scalar `1` vs expected `{calories:1, protein_g:0, carbs_g:0, fat_g:0}`).
- Real PostgreSQL RED:
  `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts`
  -> 9 pass / 3 fail. The new distinct-presence test failed at the first
  summary assertion with `"meals_calculated": 2` received where
  `{calories:2, protein_g:1, carbs_g:1, fat_g:1}` was expected — the exact
  public-payload form of F2; the pending and mixed fixtures failed the same
  way on the parsed schema payloads.

## GREEN

- `bun test src/mcp.test.ts` -> **107 pass / 0 fail** (342 expect calls).
- `bun test src/widgets.test.ts` -> **20 pass / 0 fail**.
- Real PostgreSQL + MCP:
  `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts`
  -> **12 pass / 0 fail** (210 expect calls; 12 tests = 11 prior + 1 new).

## REFACTOR

Real extraction, done while green: `coreMacroCounts` is the single per-macro
counting rule shared by `sumMeals` and `trendsDayPayloadOf`; the any-macro
`hasCalculatedCore` was deleted (no remaining callers); `rangeAverages` now
loops the shared `CORE_MACRO_KEYS` instead of a second hardcoded key list and
folds count-aggregation into the same pass. `MEALS_CALCULATED_ITEM` is one
declared schema reused by `TOTALS_ITEM` (and through it `TRENDS_DAY_ITEM` and
every dependent output schema). Tests re-run after the extraction: 107 pass /
0 fail.

## Gates (all executed, all green)

- `bun run typecheck` -> "src/ typechecks clean".
- `bun run test:unit` -> **473 pass / 0 fail / 105 skip (578 tests, 34 files)**.
- Explicit DB gate, both URLs equal
  (`DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`)
  -> **99 pass / 0 fail / 0 skip across 8 suites**:
  db.integration 5, meal-events 41, calculation-bundles.integration 13,
  meal-captures.integration 4, mcp-food-tracking 9, backup-policy 7,
  legacy-meal-tools.integration 12, calculation-acceptance.integration 8.
- Changed-file Prettier:
  `bunx prettier --check src/mcp.ts src/mcp.test.ts src/legacy-meal-tools.integration.test.ts README.md docs/food-tracking-agent-driven.md`
  -> "All matched files use Prettier code style!" (one initial warn on
  `src/mcp.test.ts` fixed with `--write`, then `bun test src/mcp.test.ts`
  re-run: 107 pass / 0 fail).
- `git diff --check` -> silent (clean).

## Behavior summary

- Fully pending selections and empty ranges emit null core macros/averages
  with zero per-macro counts; explicit stored zeros stay real zeros and count
  as coverage for their own macro.
- Non-empty ranges keep the accepted every-logged-day denominator (250
  calculated calories plus one pending logged day still averages 125); the
  per-nutrient counts now expose that partiality honestly, per nutrient.
- Water's range average keeps its documented legacy 0 on an empty range.
- CSV keeps empty cells for missing values; widgets were not touched (no
  widget consumes `meals_calculated`).

## Known limitations

- The old scalar `meals_calculated` is replaced, not retained under a
  compatibility alias (the review's preferred additive form was followed;
  no consumer of the scalar remains in this repo).
- `meals_total` stays a single integer; per-nutrient denominators beyond
  meals (e.g. per-day coverage inside a range) remain disclosed by the
  per-day null values plus the summed per-nutrient meal counts.
