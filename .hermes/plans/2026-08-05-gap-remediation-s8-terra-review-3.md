# S8 reviewer-terra final re-review 3 — FAIL

- Review date: 2026-08-06
- Required remediation range: `c3a3e0ec5428714f9cd1a7c933378f1904382627..a5a439c29ba135adb80ac0fbbc2c0fd9d3a94159`
- Full S8 chain reviewed: `3972a5fc9f7a95880e997b89eac174c133ef70f8..a5a439c29ba135adb80ac0fbbc2c0fd9d3a94159`
- Reviewed HEAD: `a5a439c29ba135adb80ac0fbbc2c0fd9d3a94159` (`origin/main` was identical before this review artifact was written).
- Immutable review-2 SHA-256: `1c0ce5698584556a1686e30f5d83922657a12666d07a4d33677449dee57c4b3b` — verified byte-for-byte.
- Verdict: **FAIL — request one bounded test-only correction.** This artifact is intentionally uncommitted; no acceptance commit or push was made.

## Blocking finding: `4f1fc68` retains a UTC-midnight TOCTOU flake

`4f1fc68` correctly identifies and removes the pre-existing hardcoded-date defect. The bad literal was introduced in `a26a058fe7e5e01de62b52f7343a49d88c3b8a40` (the original `logged_at`, by-date, range, summary, progress, trends, and patterns values all used `2026-08-05`). The repair changes those date arguments to one UTC-derived `day`, and all eight legacy read calls/assertion paths remain present: `get_meals_by_date`, `get_meals_today`, `get_meals_by_date_range`, `get_nutrition_summary`, `get_goal_progress`, `get_trends`, `get_meal_patterns`, and `search_meals`.

The UTC semantic is otherwise correct: profile-less users resolve `getUserTimezone()` to `UTC` in `src/db.ts:503-506`, and `todayInTz()` evaluates the live `new Date()` in that zone (`src/tz.ts:12-18`). However, `src/legacy-meal-tools.integration.test.ts:251` samples `new Date().toISOString().slice(0, 10)` once, then later invokes `get_meals_today` at `:273`. If UTC midnight occurs after the sample/log and before that read, `get_meals_today` queries the next UTC day while the logged meal remains on the previous day. The test can fail once per day despite the dynamic-date repair.

### Exact bounded Kimi fix

Change only `src/legacy-meal-tools.integration.test.ts`; do not modify runtime code, migrations, schemas, providers, or S9 files.

1. Add `setSystemTime` to the existing `bun:test` import.
2. At the beginning of this one serial test, derive a UTC date from the real clock, construct a same-day noon UTC instant, and freeze Bun's clock before `callTools`, for example:

   ```ts
   const frozenNow = new Date(
       `${new Date().toISOString().slice(0, 10)}T12:00:00.000Z`,
   );
   setSystemTime(frozenNow);
   const day = frozenNow.toISOString().slice(0, 10);
   try {
       await callTools(/* existing callback, unchanged assertions */);
       // existing post-call assertions
   } finally {
       setSystemTime();
   }
   ```

3. Preserve the current eight read operations/assertions and their dynamic `day` arguments exactly; merely move them inside the `try`. The repository already demonstrates the correct `setSystemTime()` reset pattern in `src/rate-limit.test.ts:16-24`.
4. Run the explicit DB gate with both URLs, plus the existing focused and full unit gates. This freezes both the test's stored date and profile-less `get_meals_today`'s UTC "today" for the complete transport transaction, eliminating the rollover window and avoiding clock leakage into subsequent serial tests.

## Public/repository-truth audit — PASS

- `public/index.html` is client-neutral in its affirmative product copy. It has no definite Claude, ChatGPT, named-client, any-client compatibility, plan-support, or account-sufficiency promise. Its remaining client names are only protocol examples, tab labels, conditional documentation referrals, or the conditional ChatGPT FAQ answer. The latter explicitly says that whether ChatGPT connects depends on support for unauthenticated remote MCP servers.
- All 15 JSON-LD blocks across `public/index.html` and the seven generated alternatives outputs parsed. `public/index.html` has 10 FAQ JSON-LD entries and all 10 normalized answer texts exactly match their visible `<details>` copies.
- The auth matrix has four README historical/negative survivors plus semantically negative public/source wording. No current Supabase, OAuth, Google/email/password account, token, authorization-code, or registration capability claim survives. `public/privacy.html` and `public/terms.html` truthfully describe the lack of an account/authentication layer.
- Every named-client survivor was audited line-by-line. They are limited to: MCP protocol examples; competitor facts that the competitor has no MCP connector/server; quoted search-query text; and conditional documentation referrals. None asserts compatibility of this endpoint.
- `scripts/gen-alternatives.ts` is the sole source for all seven alternatives outputs. Two real generator-plus-Prettier runs produced identical SHA-256 lists and zero worktree drift before this review artifact:
  - cronometer `3b2dd23410baeaab88416f3804377a65b9cbccbc6e7ebcf148627b159156e247`
  - index `ae26fc7d5b570733e456ea965d2724925f1e6aa4e2adba49e2b3ef41960be720`
  - lifesum `e892688248deec7a4802b04a0577244d0386ed825daf6c92bca7e49f59c3e62f`
  - lose-it `8afcf0705bfa7f629a6b59a67c761086bac0304936f5b327dff0e479979b2274`
  - macrofactor `1cee872d69c6d35ec59462624ecb0abeb8f339fbf56301bb325e5d5991e13d2f`
  - myfitnesspal `c3c515014483c4c965b058d6cd04227e21e1da4171ffee37fa30956a86295c26`
  - yazio `d334be633e76b1c4b5843e153ea132b81ac8f652673df2d456e8db95f04437e8`
- New public prose is concrete, conditional where compatibility is not proved, and free of the former invented client/account promises. Humanizer quality is acceptable.

## Prior S8 acceptance rechecks — PASS

- All 12 `supabase/migrations/*.sql` files, `docs/google-auth-setup.md`, and `src/supabase.test.ts` are absent. `src/db-helpers.test.ts` is the 98%-similarity rename and its describe blocks accurately cover idempotency, profile defaults, and `fetchAllPages` helpers.
- `CLAUDE.md` correctly identifies local PostgreSQL `tool_analytics`; `src/analytics.ts` executes `INSERT INTO tool_analytics`.
- Legal no-auth/deletion wording is supported by the static runtime inventory. The widget harness still imports DB types from `src/db.js` and supplies compatibility provenance.
- The 21 findings in first review are closed. No database migration, runtime/schema/provider/version/S9 drift was found beyond the disclosed test-only `4f1fc68` change. The test change is not accepted only because of the bounded rollover flake above.

## Independent commands and outcomes

- Generated sync proof — pass; two generator-plus-format runs, equal seven-file SHA-256 lists, and zero generated-file/source diff.
- Grep matrices — pass semantically: no positive auth or compatibility/account-sufficiency survivor; named-client survivors are all allowed categories above.
- JSON-LD parse — 15/15 blocks pass. HTML/public source Prettier parse/check — pass.
- Focused affected suites — **235 pass, 0 fail**.
- `bun run typecheck` and strict standalone widget-harness compilation — pass.
- Harness — strict compile, `GET /`, and `GET /host?widget=import-meals` pass; valid `POST /tool/bulk_import_meals` returned success with `created=1`, `provenance_status=compatibility`, `event_version=1`, and `has_calculation_bundle=false`. The harness was killed and port 8788 has no listener.
- `bun run test:unit` — **498 pass, 156 skip, 0 fail; 654 total**.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db` — **140 pass, 0 fail, 0 skip across 8 suites**: 8, 41, 13, 20, 20, 7, 23, 8.
- Changed-file Prettier — pass. `git diff --check HEAD` and `git diff --check 3972a5f..HEAD` — pass.
- Before writing this required FAIL artifact, `HEAD` and `origin/main` were both `a5a439c29ba135adb80ac0fbbc2c0fd9d3a94159`; remote equality was verified after fetch.

## Disposition

Client-neutral decision: **PASS**. Generation proof: **PASS**. Test-repair decision: **FAIL** due to the exact UTC-midnight TOCTOU described above. Resolve only the bounded test clock freeze, re-run the listed gates, and request another final review. This review file remains uncommitted, so the tree is intentionally not clean.
