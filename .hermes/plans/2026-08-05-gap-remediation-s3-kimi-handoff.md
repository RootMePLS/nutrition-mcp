# Slice S3 handoff — NULL-vs-zero presence contract in public aggregates

Date: 2026-08-05
Slice: S3 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` (decision D4)
Coder: coder-kimi
Base HEAD: `bf2ab1a665e08b9ba938f0189839abf7519acc3d` (clean tree, `main == origin/main` at start)

## Scope executed

Only S3. Storage, consensus, provider persistence, S4 provenance-status
fields, and migrations are untouched (`git diff` shows no `db/`,
`src/calculation-bundles.ts`, `src/meal-events.ts`, `src/meal-types.ts`,
`src/insights.ts`, or `src/export.ts` changes). S4 not started.

## What changed

- `src/mcp.ts`
    - `DailyTotals`: `calories`/`protein_g`/`carbs_g`/`fat_g` become
      `number | null`; adds `meals_total` / `meals_calculated` counts.
    - `TOTALS_ITEM`: four core macros `.nullable()`; adds
      `meals_total: z.number().int()`, `meals_calculated: z.number().int()`.
    - `sumMeals`: presence-aware per-macro sum via the shared `presenceSum`
      helper; counts calculated meals via `hasCalculatedCore`.
    - `presenceSum(meals, key)` (exported, REFACTOR extraction): `null` when no
      meal carries the nutrient; explicit `0` sums as a real zero.
    - `rangeAverages`: core macros keep the historical every-logged-day
      denominator; numerator skips null day-totals; average is `null` when no
      day in the range carries the nutrient (empty range keeps the legacy `0`).
      Presence counts summed over the range.
    - `totalsPayloadOf`: rounds null-safe, emits the two counts.
    - `trendsDayPayloadOf`: core macros presence-nulled via `presenceSum`;
      per-day counts.
    - `formatProgress`/`coreGoalLine`: null core total renders
      `Calories: no data yet [/ 2000 kcal target]` — never `0%`, never `NaN`.
    - CSV export path (`src/export.ts`) verified already null-correct
      (`csvEscape(null) -> ""`); pinned by integration assertions, no code
      change needed.
- `public/widgets/src/shared/macros.js`: `macroBits` gains a `noData` branch
  (null value -> `goalLine = "no data yet"`, ring centre `—`, aria label
  `no data yet`); explicit `0` still renders as `0` with a real percentage.
- `public/widgets/src/templates/{meal-logged,goal-progress,nutrition-summary,trends}.html`:
  `fmt(null|NaN)` now renders `—` instead of a fabricated `"0"`.
  (`component-gallery.html` is a dev-only preview and `weight-trends.html`
  renders body weight, not macro totals — intentionally untouched.)

## RED evidence (tests written first, failing for the right reason)

Command:

```bash
bun test src/mcp.test.ts src/widgets.test.ts
```

Output (baseline + new tests):

```
 103 pass
 18 fail
 411 expect() calls
Ran 121 tests across 2 files. [735.00ms]
```

Representative failure (right reason — coalesced zero, missing counts):

```
src/mcp.test.ts:
    test("fully pending selection yields null core macros", () => {
        const t = sumMeals([pendingMeal(), pendingMeal()]);
        expect(t.calories).toBeNull();
                                 ^
error: expect(received).toBeNull()

Received: 0
```

DB/MCP RED command:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts
```

RED output:

```
(fail) ... > pending event-scope nutrition retains nulls end to end and never fabricates zeros [92.07ms]
(fail) ... > mixed and explicit-zero days keep partial sums and real zeros distinct [103.21ms]
 9 pass
 2 fail
```

Representative failure (missing presence counts on the wire):

```
expect(days.find((d) => d.date === "2026-08-07")).toMatchObject(
                                                        ^
error: expect(received).toMatchObject(expected)
  {
    "calories": 300,
    "meal_count": 2,
-   "meals_calculated": 1,
-   "meals_total": 2,
    "protein_g": 12,
    ...
  }
```

Widget RED: 4 failures `... renders no-data rather than zero for null core
macros` (`expect(html).not.toContain('if (n == null || isNaN(n)) return "0";')`
failed — the templates laundered null into `"0"`).

## GREEN evidence

Commands and outputs after implementing `sumMeals`/`TOTALS_ITEM`/builders/
`formatProgress`/widget changes:

```bash
bun run typecheck
# src/ typechecks clean

bun run test:unit
# Unit gate totals: 467 pass, 0 fail, 104 skip, 571 tests (DB suites are run by test:db).

DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
# DB gate totals: 98 pass, 0 fail, 0 skip, 98 tests across 8 DB suites.

RUN_LEGACY_MEAL_DB_TESTS=1 (same env) bun test src/legacy-meal-tools.integration.test.ts
# 11 pass, 0 fail — including both previously-red tests.
```

## REFACTOR evidence

Extracted the shared `presenceSum(meals, key)` helper (plus `hasCalculatedCore`)
so the null-vs-zero rule exists exactly once; `sumMeals` and
`trendsDayPayloadOf` both use it. Added a direct `presenceSum` unit test.
Gates after refactor:

```
bun run typecheck  -> src/ typechecks clean
bun run test:unit  -> Unit gate totals: 468 pass, 0 fail, 104 skip, 572 tests
bun run test:db    -> DB gate totals: 98 pass, 0 fail, 0 skip, 98 tests across 8 DB suites
grep -n "calories ?? 0|protein_g ?? 0|carbs_g ?? 0|fat_g ?? 0" src/mcp.ts -> no matches (exit 1)
```

(Fiber/sugar/alcohol `?? 0` at the `sumMeals` day-sum remains intentionally —
documented in the code comment: it is a SUM, where a missing value adds
nothing; averages use `nutrientPresence`/`coveredDailyAverage`.)

## Deleted / rewritten old zero-for-pending assertions

`src/legacy-meal-tools.integration.test.ts`, test "pending event-scope
nutrition retains nulls end to end and never fabricates zeros":

1. REWRITTEN — the comment "Approved aggregation contract: a pending event
   still counts as a logged meal but adds nothing to the nutrient sums"
   replaced with the D4 presence-contract comment.
2. DELETED — pending-day assertions `calories: 0` and `protein_g: 0`
   (`days.find((d) => d.date === "2026-08-06")` toMatchObject), replaced with
   `calories: null`, `protein_g: null`, `meals_total: 1`,
   `meals_calculated: 0`.
3. REWRITTEN — the local `days` type annotation `calories: number;
protein_g: number;` -> `number | null` plus the two count fields.
4. REWRITTEN (test fixture, not a contract change) —
   `src/mcp.test.ts` "calories still divide by every day in both":
   `round1(summary.averages.calories)` -> `round1(summary.averages.calories!)`
   (type widened to `number | null`; value expectation unchanged).
5. REWRITTEN (test fixture) — `src/mcp.test.ts` trendsDayPayloadOf
   explicit-zero test now builds the bucket with zeroed core sums so the
   fixture is internally consistent.

No other zero-for-pending assertions existed; `git grep` found none in other
suites.

## Pending / mixed / explicit-zero matrix (real MCP transport + PostgreSQL)

All asserted through `InMemoryTransport` client calls against the disposable
PostgreSQL DB in `src/legacy-meal-tools.integration.test.ts`:

| Fixture       | Tool                  | Assertion                                                                                                         |
| ------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| pending day   | get_nutrition_summary | day cores null, counts 1/0; range averages 125 over 2 logged days with counts 2/1; text has "no data yet", no NaN |
| pending day   | get_goal_progress     | totals cores null, counts 1/0; text "no data yet", never "Calories: 0"/NaN                                        |
| pending day   | get_trends            | per-day cores null, counts 1/0; ready day keeps 250/20                                                            |
| pending day   | export_meals          | CSV nutrient cells empty for the pending meal                                                                     |
| mixed day     | get_nutrition_summary | calories 300 (partial sum), counts 2/1                                                                            |
| mixed day     | get_goal_progress     | totals calories 300, counts 2/1                                                                                   |
| mixed day     | get_trends            | per-day calories 300, counts 2/1                                                                                  |
| explicit zero | get_nutrition_summary | cores 0 (not null), counts 1/1                                                                                    |
| explicit zero | get_goal_progress     | totals 0; text "Calories: 0 kcal", no "no data yet"                                                               |
| explicit zero | get_trends            | per-day calories 0, counts 1/1                                                                                    |
| explicit zero | export_meals          | CSV keeps `"0"` cells for the zero meal                                                                           |

Unit matrices: `sumMeals presence contract` (5 tests), `presenceSum`,
`rangeAverages` presence cases (2 tests), `formatProgress renders pending core
macros as no-data` (3 tests), `totalsPayloadOf`/`TOTALS_ITEM` payload parses
(2 tests), `trendsDayPayloadOf` presence cases (3 tests), widget template
guards (4 tests, `src/widgets.test.ts` style of the existing trends null
test).

## Design decisions inside the slice (documented in code)

- `meals_calculated` counts meals carrying at least one non-null core macro
  (`hasCalculatedCore`); per-macro totals are independently presence-aware.
- Range averages keep the historical every-logged-day denominator for core
  macros (a pending day adds nothing to the numerator but stays in the
  denominator); the average is `null` only when no day in the range carries
  the nutrient. The per-day nulls and the presence counts — not the average —
  disclose partial coverage. Empty range keeps the legacy `0` (pinned by the
  pre-existing "an empty range divides nothing by zero" test).
- Widgets: shared `macros.js` no-data branch covers every macro-panel widget;
  `fmt` in the four totals-rendering templates renders `—` for null/NaN.

## Gate counts (reported separately, final)

- unit: 468 pass / 104 skip / 0 fail (572 tests). Baseline at slice start:
  448 pass / 103 skip / 0 fail (551). +20 pass; skip +1 is the new DB-gated
  integration test skipping in unit mode.
- db: 98 pass / 0 skip / 0 fail across 8 suites. Baseline at slice start:
  97 pass / 0 / 0 across 8 suites. +1 (the new mixed/explicit-zero test).
- typecheck: clean. `git diff --check`: silent.
- `bunx prettier --check <changed files>`: all matched files use Prettier
  code style (changed-files-only per campaign rule D5).

## Commits

1. `fix: preserve null core macros in public aggregates` — code + tests
   (`src/mcp.ts`, `src/mcp.test.ts`, `src/widgets.test.ts`,
   `src/legacy-meal-tools.integration.test.ts`,
   `public/widgets/src/shared/macros.js`, four widget templates).
2. `docs: document totals presence contract` — `README.md`,
   `docs/food-tracking-agent-driven.md`.
3. `docs: record S3 TDD evidence` — this handoff.

## Known limitations / risks

- Breaking declared-output-schema change for `get_nutrition_summary`,
  `get_goal_progress`, `get_trends`, `log_meal`, `update_meal` totals payloads
  (accepted per D4; single-user deployment).
- Unlogged days in the `get_trends` per-day series now report null core
  macros with counts 0/0 instead of 0; the shipped widget's `avgOf`/`dayHasData`
  already skip/handle nulls, but third-party consumers pinned to numbers will
  need the counts.
- Rollback: revert the three commits; no DDL, no storage change.
