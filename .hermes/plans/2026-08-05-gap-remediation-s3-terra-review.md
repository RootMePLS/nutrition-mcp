# S3 reviewer-terra review — FAIL

Date: 2026-08-05
Reviewer: reviewer-terra
Range reviewed: `bf2ab1a665e08b9ba938f0189839abf7519acc3d..45be11d9ddd74639c5bf3168396ee3a694618183`
Handoff reviewed: `.hermes/plans/2026-08-05-gap-remediation-s3-kimi-handoff.md`

## Verdict

**FAIL — two D4 correctness blockers. Do not accept S3 or begin S4.**

The implementation has good RED/GREEN/REFACTOR evidence and the independently
executed gates are green, but it does not satisfy the literal nullable-total
contract for an empty range, and its single aggregate coverage count is not
truthful when individual macros have different presence. Both defects can make
public data appear more complete than it is.

## Blocking findings

### F1 — Empty range emits fabricated numeric core averages

**Evidence**

- Decision D4 in the governing plan says a core total is `null` when **no meal
  in the selection** has a calculated value for that nutrient.
- `src/mcp.ts:525-527` deliberately preserves an empty-range special case:
  `const n = perDay.length || 1`; `coreAverage` returns `sums[key] / n` when
  `perDay.length === 0`. Because every sum begins at zero, an empty selection
  emits `0` for calories, protein, carbs, and fat.
- The existing unit test `rangeAverages > an empty range divides nothing by
  zero` passes by pinning that behavior. The handoff explicitly calls it
  "legacy 0" (lines 206-211).
- The changed README and agent-driven documentation instead say range averages
  are `null` when no day in the window carries the nutrient. An empty range has
  no such day, so the code and the new documentation disagree.

**Why this blocks**

The user-directed semantic question has an unambiguous answer: **yes, the
retained empty-range numeric `0` violates D4's literal contract**. It is not an
explicit stored zero and there is no calculated meal/day to support it. This is
also a public schema/value defect in `get_nutrition_summary` averages.

### F2 — `meals_calculated` is aggregate-any-core coverage and can falsely imply complete per-macro coverage

**Evidence**

- `src/mcp.ts:429-433` defines `hasCalculatedCore` as any non-null value among
  the four macros. `sumMeals` then increments one `meals_calculated` counter
  for that condition at `:442-443`.
- `TOTALS_ITEM` exposes only `meals_total` and that one
  `meals_calculated` integer (`src/mcp.ts:629-640`); `TRENDS_DAY_ITEM` extends
  the same shape. `rangeAverages` merely sums the same aggregate counts
  (`:517-519`). These shapes feed summary, goal progress, trends, and the
  log/update progress payload.
- The newly added unit test itself proves macro presence is independent
  (`sumMeals presence contract > presence is per-macro: a calorie-only meal
  still has null protein`), but it does not require coverage disclosure for
  that difference.

**Counterexample**

For two meals, A `{ calories: 300, protein_g: null, carbs_g: null, fat_g:
null }` and B `{ calories: 200, protein_g: 10, carbs_g: 20, fat_g: 5 }`, the
public totals would report `calories: 500`, `protein_g: 10`,
`meals_total: 2`, and `meals_calculated: 2`. A client can reasonably read `2/2`
as coverage for protein even though protein is based on only one meal. The same
false disclosure reaches range averages and trends.

**Why this blocks**

D4 requires counts such that a partial sum is never mistaken for a complete
one. A count based on *any* macro cannot honestly make that guarantee when the
four nutrients have different presence. **Per-nutrient coverage/count semantics
are required** (or an equivalently unambiguous per-nutrient coverage object),
not a single `meals_calculated` field. The handoff's stated interpretation is
therefore insufficient even though its pending/mixed/explicit-zero fixtures
pass.

## Non-blocking verified evidence

### Scope and history

- Range contains exactly the expected 12 files / 944 insertions / 49 deletions:
  S3 implementation/tests/widgets/docs plus the handoff.
- Commits are focused: `aef1947 fix: preserve null core macros in public
  aggregates`, `89c9758 docs: document totals presence contract`, and
  `45be11d docs: record S3 TDD evidence`.
- No changed `db/` file, migration, storage, consensus, provider, or S4
  provenance-status file/field was found. `git diff --check <range>` was clean.
- No core-macro `?? 0` fallback remains in `src/mcp.ts`; retained fallbacks are
  only fiber/sugar/alcohol with their documented day-sum rationale.

### RED/GREEN/REFACTOR evidence

- The handoff records focused RED failures that fail for the intended reason:
  pending total received `0`, and MCP payloads lacked the count fields; it also
  records widget null-to-`"0"` failures.
- It documents GREEN and a real helper extraction (`presenceSum` plus
  `hasCalculatedCore`). This is visible refactoring, not a green-only claim.

### Independently executed tests and gates

- `bun test src/mcp.test.ts src/widgets.test.ts` — **122 pass / 0 fail**.
- Real PostgreSQL + `InMemoryTransport` matrix:
  `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
  DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test
  RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts`
  — **11 pass / 0 fail**. It exercises summary, goal progress, trends, and CSV
  for pending/mixed/explicit-zero fixtures.
- `bun run typecheck` — clean.
- `bun run test:unit` — **468 pass / 104 skip / 0 fail (572 tests)**.
- Full DB gate with both required PostgreSQL URLs equal — **98 pass / 0 fail /
  0 skip across 8 suites**.
- Changed-file `bunx prettier --check ...` — all matched files formatted.
- `git diff --check <range>` — silent.

### Behavior that is correct and should be retained

- Fully pending non-empty selections become null for all four cores; explicit
  stored zero remains numeric zero through the real MCP paths and CSV keeps
  missing fields empty.
- `TOTALS_ITEM` makes the four core macro fields nullable and dependent output
  schemas reuse it for summary, goal progress, trends, and log/update progress.
- Unlogged trend days now become null core values with 0/0 counts; widgets
  render `—` / `no data yet`; progress text avoids `0%` and `NaN`.
- The range denominator choice itself is coherent with the documented
  historical rule for a **non-empty range**: every logged day remains in the
  denominator while a pending day contributes no numerator. For example, 250
  calculated calories plus one pending logged day produces 125. This is
  acceptable only once per-nutrient coverage exposes that partiality.

## Exact coder-kimi fixes plan

1. In `src/mcp.ts`, replace scalar aggregate coverage with a precise,
   schema-visible per-core-macro representation. Preferred additive form:
   `meals_calculated: { calories, protein_g, carbs_g, fat_g }`, each an integer
   count of meals carrying that specific macro, alongside `meals_total`. If
   retaining the old scalar for compatibility, rename/document it as
   `meals_with_any_core_calculated` and do not present it as sufficient coverage.
   Update `DailyTotals`, `DailyAverages`, `emptyTotals`, `sumMeals`,
   `rangeAverages`, `totalsPayloadOf`, and `trendsDayPayloadOf` consistently.
2. Update `TOTALS_ITEM`, `TRENDS_DAY_ITEM`, and every affected declared output
   schema/builder so summary, goal progress, trends, log-meal, and update-meal
   structured output expose the per-nutrient counts. Update README and
   `docs/food-tracking-agent-driven.md` to state their exact semantics.
3. Make empty core range averages null. Remove the `perDay.length || 1`
   exception for core averages (water may retain its independently documented
   legacy behavior if needed); `coreAverage` must return null when the range is
   empty or when that nutrient has no coverage. Replace the test that expects
   empty core `0` with assertions for null cores and zero counts.
4. Add RED-first unit tests for: empty `rangeAverages`; two meals with distinct
   per-nutrient presence; mixed day/range where calories are 2/2 but protein is
   1/2; explicit zero counting as coverage for its own macro; and unlogged
   trend day with zero per-macro coverage.
5. Extend the existing real PostgreSQL + MCP fixture matrix in
   `src/legacy-meal-tools.integration.test.ts`. For summary, goal progress,
   trends, and CSV prove per-nutrient counts and null/zero values for pending,
   mixed/different-presence, explicit-zero, and empty-range behavior. Parse
   each returned structured payload with its declared output schema rather than
   only using `toMatchObject`.
6. Re-run and record RED, GREEN, REFACTOR; then run typecheck, full unit, the
   explicit 8-suite DB gate with both URLs equal, changed-file Prettier, and
   `git diff --check`. Keep the repair strictly in S3 output/tests/docs; do not
   touch migrations, storage, consensus, provider paths, or S4 fields.

## Commit/push state

No review commit was made and no push was attempted because the verdict is
FAIL. The required review document is intentionally left uncommitted.
