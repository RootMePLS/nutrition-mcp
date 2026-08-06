# S8 third remediation — handoff 4 (clock-freeze test fix)

- Date: 2026-08-06
- Scope: third remediation only, per immutable review-3
  `.hermes/plans/2026-08-05-gap-remediation-s8-terra-review-3.md`
  (SHA-256 `fe1f0d2d62ec6411cc7eb2bc7da376b5bf8cb0bc23183c8711477aa5a8b3d3bc`,
  verified byte-for-byte before and after the work).
- Base: `a5a439c` (`docs: remove unproven client compatibility claims`).
- No S9 work started. All accepted S8 public and generated truth work retained
  untouched.

## Change

One implementation file changed: `src/legacy-meal-tools.integration.test.ts`.

1. Added `setSystemTime` to the existing `bun:test` import.
2. In the single serial test "log and all eight legacy reads work through the
   real MCP transport": derive the current real UTC date, construct a same-day
   noon UTC instant (`${...}T12:00:00.000Z`), `setSystemTime(frozenNow)` before
   `callTools`, and use `day = frozenNow.toISOString().slice(0, 10)` for every
   existing dynamic date argument (`logged_at`, by-date, range, summary,
   progress, trends, patterns).
3. The complete `callTools` plus the existing post-call DB assertions are
   wrapped in `try { ... } finally { setSystemTime(); }`, matching the reset
   pattern already used in `src/rate-limit.test.ts:16-24`.

No runtime, migration, schema, provider, public copy, generator, version, or
other test file was modified. Noon UTC is 12 hours from both adjacent UTC
midnights, so the sampled `day` and the server's live `todayInTz("UTC")`
(`src/tz.ts:12-18`, profile-less users resolve UTC via `src/db.ts:503-506`)
cannot diverge during the transport transaction.

## Eight legacy reads preserved

All eight read operations and their assertions are unchanged in content and
order; only their indentation moved inside the `try`:

1. `get_meals_by_date` — isError false, text contains "oatmeal",
   "Calories: 500".
2. `get_meals_today` — isError false, text contains "oatmeal".
3. `get_meals_by_date_range` — isError false, text contains `day`.
4. `get_nutrition_summary` — isError false, `logged_days` 1, meals length 1.
5. `get_goal_progress` — isError false, `meal_count` 1.
6. `get_trends` — isError false, days length 30.
7. `get_meal_patterns` — isError false, text contains "Patterns —".
8. `search_meals` — isError false, text contains "oatmeal".

Plus the preserved `log_meal` write and the two post-call DB assertions
(active `meal_events` count 1; `public.meals` absent).

## RED proof (clock-boundary regression)

Focused reproduction run against the real `todayInTz` from `src/tz.ts`
(scratch file `/tmp/red-clock-rollover.test.ts`, not committed): freeze at
`2026-08-06T23:59:59.500Z`, sample the pre-fix `day` (`2026-08-06`), roll the
clock to `2026-08-07T00:00:00.500Z` as the transport round-trips would allow,
then `todayInTz("UTC")` returns `2026-08-07`. Output:
`RED CONFIRMED: sampled day=2026-08-06 but server today=2026-08-07 ->
get_meals_today finds no meal` (1 pass, 0 fail — the divergence the pre-fix
test would hit once per UTC midnight window is real).

## Clock lifecycle verification

- Success path: focused suite
  `RUN_LEGACY_MEAL_DB_TESTS=1 DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun test src/legacy-meal-tools.integration.test.ts`
  — 23 pass, 0 fail. The frozen first serial test is followed by 22 tests in
  the same file, all passing, so the `finally` reset left no clock leakage.
- Forced-failure path: temporarily changed the post-call count assertion to
  `toBe(2)` (scratch edit, reverted byte-identically afterward). Result:
  exactly the frozen test failed (expected 2, got 1) and all 22 subsequent
  serial tests still passed — the `finally` resets the clock even when the
  `try` body throws. Reverted file then passed all gates below.

## Gates (post-fix, on the committed tree)

- `bun run typecheck` — src/ typechecks clean.
- `bun run test:unit` — 498 pass, 0 fail, 156 skip, 654 tests.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`
  — 140 pass, 0 fail, 0 skip across 8 suites: 8, 41, 13, 20, 20, 7, 23, 8
  (identical per-suite counts to review-3).
- Changed-file Prettier:
  `bunx prettier --check src/legacy-meal-tools.integration.test.ts` — pass.
- `git diff --check` — pass.

## Commits

- `test: freeze legacy today regression clock` — the one-file test fix.
- `docs: record S8 clock-freeze remediation` — immutable review-3 (preserved
  byte-identically) plus this handoff-4.

Pushed after green; `HEAD == origin/main` and the tree is clean.
