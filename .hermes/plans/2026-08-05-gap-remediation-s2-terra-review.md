# S2 reviewer-terra acceptance-matrix review

Date: 2026-08-05
Reviewer: reviewer-terra
Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
Reviewed range: `9868a96b80c848358557822d43ddee28a57050c4..f9d9b7f6adb3fb31127f5896c58e40f799a29c9e`
Implementation commit: `cdd5bfb2dc6282b7ff2e47fce35920719019c32a` (`test: add calculation concurrency and correction acceptance matrix`)
Handoff commit: `f9d9b7f6adb3fb31127f5896c58e40f799a29c9e` (`docs: record S2 acceptance evidence`)

## Verdict: FAIL — required S2 REFACTOR was not completed

The functional S2 acceptance matrix is strong and all independently executed gates passed. However, the only new acceptance suite is **748 lines**, above S2's explicit `~600`-line threshold, and its shared fixture/builder/transport helpers remain embedded in that file. The S2 plan says: "**REFACTOR: extract shared bundle-builder fixtures if the file exceeds ~600 lines**". This is an explicit acceptance criterion, not a non-blocking style suggestion. The test-only slice therefore is not accepted yet.

The review document is intentionally left uncommitted, as required for a FAIL verdict.

## Scope and history checked

- `git show --stat cdd5bfb` contains exactly:
    - `src/calculation-acceptance.integration.test.ts` (new, 748 lines)
    - `scripts/test-db-gate.ts` (+1 suite entry)
- The full reviewed range also adds only the coder handoff document. No production source, migration, S3 work, or public documentation was changed.
- `git diff --name-only 9868a96b..cdd5bfb` confirms only the two intended test/gate files.
- S3/S5 symbols are absent from the implementation diff (`sumMeals`, `TOTALS_ITEM`, `provenance_status`, `attach_meal_capture_media`: 0 matches).
- At review start/end before this review artifact, `main...origin/main` was `0/0`; the working tree was clean.

## Acceptance matrix evidence

| Required S2 promise                             | Independent evidence                                                                                                                                                                                                                                                                                                                                                                 | Result   |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| Eight exact named cases                         | Each exact name occurs once in `src/calculation-acceptance.integration.test.ts`; focused runs execute all eight.                                                                                                                                                                                                                                                                     | PASS     |
| Genuine concurrent identical bundle convergence | Lines 269–337 launch two `commitCalculationBundle(pool, bundle)` calls in one `Promise.all`; the pool is `max: 4`; assertions require one winner/one deduplicated result, one version fingerprint, six provider+scope rows each with `n=1`, and three canonical scopes. Production uses `FOR UPDATE OF v` at `src/calculation-bundles.ts:341–374`, making convergence deterministic. | PASS     |
| Genuine concurrent correction convergence       | Lines 339–396 race two `commitCalculationCorrection` calls in `Promise.all` with the same idempotency key; assertions require only versions `[1,2]`, six provider rows and three canonical rows for each version, and one winner/one deduplicated result.                                                                                                                            | PASS     |
| No sleep-based luck / deterministic convergence | The acceptance suite has 0 `sleep`/`setTimeout` matches and four `Promise.all` calls. Focused suite passed four consecutive independent executions (8 pass / 0 fail / 56 expects each).                                                                                                                                                                                              | PASS     |
| Migration 005 rerun with populated data         | Lines 398–472 apply migrations `001..005`, commit v1 and correction v2, read the actual `db/migrations/005_calculation_corrections.sql` with `Bun.file(...).text()`, and execute those real bytes. Row counts are unchanged and correction data remains asserted.                                                                                                                    | PASS     |
| Migration constraint/index survive rerun        | Same case queries `pg_constraint` for `meal_event_versions_prior_fk` and `pg_indexes` for `uniq_correction_bundle_fingerprint`, requiring exactly one of each.                                                                                                                                                                                                                       | PASS     |
| Rollback after rows are written                 | Lines 474–556 install a deterministic `BEFORE UPDATE ON meal_events` failure trigger. The correction path writes version/provider/canonical records before updating the root event; the test requires the injected rejection, `current_version === 1`, zero version-2 rows in all three tables, and intact v1 counts (1/6/3).                                                        | PASS     |
| Stale-version no-write guarantee                | Lines 558–603 use current version 2 with fresh keys while resubmitting target version 2, require `correction must append the current version` / `CalculationBundleValidationError`, unchanged table counts, and `current_version === 2`.                                                                                                                                             | PASS     |
| Cross-user no-write guarantee                   | Lines 605–632 use an owner event and `intruder-user`, require the ownership error, unchanged counts, and `current_version === 1`.                                                                                                                                                                                                                                                    | PASS     |
| Real MCP correction schema + SQL                | Lines 634–688 use real `McpServer`, linked `InMemoryTransport`, and `Client`; `structuredContent` parses with `CALCULATION_CORRECTION_OUTPUT_SCHEMA`, while SQL independently confirms version 2 and its three canonical scopes.                                                                                                                                                     | PASS     |
| Failed-provider public provenance honesty       | Lines 690–747 persist a failed `own` provider with verbatim code/message and raw payload, retrieve it through `get_calculation_provenance` over the real MCP transport, parse `CALCULATION_PROVENANCE_OUTPUT_SCHEMA`, and require every failed-provider nutrient value to be `NULL` (with no fabricated zero).                                                                       | PASS     |
| DB gate wiring/count                            | `scripts/test-db-gate.ts:31` adds this suite. Explicit DB gate with both URLs set to `postgres://localhost:5432/nutrition_mcp_test` reports `97 pass, 0 fail, 0 skip, 97 tests across 8 DB suites`. The new suite contributes 8 pass / 0 fail / 0 skip.                                                                                                                              | PASS     |
| Unit skip accounting                            | `bun run test:unit` independently reports `448 pass / 103 skip / 0 fail / 551 tests`: exactly +10 skips over the 93-skip handoff baseline, consisting of the eight DB-gated named tests plus Bun's two skipped lifecycle-hook entries. Pass count is unchanged.                                                                                                                      | PASS     |
| Typecheck, formatting, whitespace               | `bun run typecheck`: clean. `bunx prettier --check` over all three changed range files: pass. `git diff --check 9868a96b..f9d9b7f`: silent.                                                                                                                                                                                                                                          | PASS     |
| Required refactor / maintainability decision    | The acceptance file is 748 lines. Its reusable `EVENT`, `seedEvent`, `scopedProvider`, `makeScopedBundle`, `makeScopedCorrection`, `correctionMetadata`, `eventTableCounts`, and `withTools` helpers remain in the same file. No shared fixture module exists. This violates S2's mandatory refactor rule once the suite exceeds about 600 lines.                                    | **FAIL** |

## Commands independently executed

```bash
export DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
export DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test

# Four independent focused executions
bun test src/calculation-acceptance.integration.test.ts
# each run: 8 pass, 0 fail, 56 expect() calls

bun run typecheck
# src/ typechecks clean

bun run test:unit
# 448 pass, 103 skip, 0 fail, 551 tests

bun run test:db
# DB gate totals: 97 pass, 0 fail, 0 skip, 97 tests across 8 DB suites.

bunx prettier --check \
  .hermes/plans/2026-08-05-gap-remediation-s2-kimi-handoff.md \
  scripts/test-db-gate.ts \
  src/calculation-acceptance.integration.test.ts
# All matched files use Prettier code style!

git diff --check 9868a96b80c848358557822d43ddee28a57050c4..f9d9b7f6adb3fb31127f5896c58e40f799a29c9e
# silent
```

## Exact coder-kimi fixes plan

1. Add a **test-only** fixture module, for example `src/calculation-acceptance.fixtures.ts`. Move the reusable acceptance fixtures from the 748-line suite into it:
    - `EVENT`
    - `seedEvent`
    - `scopedProvider`
    - `makeScopedBundle`
    - `makeScopedCorrection`
    - `correctionMetadata`
    - `eventTableCounts`
    - the real-transport `withTools` helper and its local `ToolResult` type, if needed to bring the suite below the threshold.
2. Import those helpers into `src/calculation-acceptance.integration.test.ts`. Keep all eight literal test names, real `Promise.all` races, real migration-file execution, SQL assertions, MCP parsing, and failure-trigger behavior unchanged. The main acceptance suite must be **below 600 lines** after Prettier.
3. Do not modify production `src/*.ts` implementation files, migrations, S3 configuration, or any S3+ behavior. The only expected changed paths are the new fixture module and `src/calculation-acceptance.integration.test.ts`; do not alter the DB-gate suite list unless strictly necessary.
4. Re-run four focused PostgreSQL executions using both URLs exactly equal to `postgres://localhost:5432/nutrition_mcp_test`; each must report 8 pass / 0 fail. Then run typecheck, unit gate, explicit DB gate, Prettier on every changed file, and `git diff --check`. Report the unit count and the exact 8-suite DB total separately.
5. Commit the test-only refactor as a focused follow-up commit (do not rewrite already-pushed `main` history), e.g. `test: extract S2 calculation acceptance fixtures`, push `origin main`, and return a new handoff for re-review. Do not commit this reviewer document.
