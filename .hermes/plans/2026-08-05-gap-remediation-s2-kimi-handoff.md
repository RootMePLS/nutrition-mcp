# S2 handoff — concurrency acceptance + correction/migration acceptance matrix

Date: 2026-08-05
Author: coder-kimi
Slice: S2 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md` (only S2 executed; S3+ untouched)
Base HEAD at slice start: `9868a96b80c848358557822d43ddee28a57050c4` (clean tree, verified)

## Scope executed

Test-only slice. Two files changed, nothing else:

1. `src/calculation-acceptance.integration.test.ts` — NEW destructive DB suite (migrate-all in `beforeAll`, following the `src/meal-captures.integration.test.ts:19` pattern).
2. `scripts/test-db-gate.ts` — one-line append of the new suite to `suites` (line 31).

No production files, no migrations, no docs touched. `git show --stat` of the test commit contains exactly these two files.

## Test inventory (all eight named cases, grep-able)

File: `src/calculation-acceptance.integration.test.ts`

1. `"concurrent identical calculation bundles converge"` — two `commitCalculationBundle` calls raced via `Promise.all`, launched synchronously on a pool with `max: 4` (two real clients); deterministic serialization comes from the production `FOR UPDATE OF v` lock on the version row, not from sleeps or sequencing. Asserts: exactly one `deduplicated=false`, one fingerprint on the version row, exactly one provider row per provider+scope (6 `GROUP BY provider, scope_key` rows, each `n=1`), exactly one canonical row per scope (`event`, `item:0`, `item:1`).
2. `"concurrent identical corrections yield one new version"` — two `commitCalculationCorrection` calls raced via `Promise.all` with the same `correction_idempotency_key`. Asserts: both return version 2, exactly one `deduplicated=false`, versions are exactly `[1, 2]` (no N+2), per-version provider counts 6/6 and canonical counts 3/3 (no orphans).
3. `"migration 005 reruns safely"` — populates correction-era data (bundle v1 + correction v2, so correction columns and the partial unique index hold real rows), snapshots row counts of all four calculation tables, then re-applies the **real file bytes** of `db/migrations/005_calculation_corrections.sql` via `client.query(await Bun.file(...).text())`. Asserts: no error, counts before == after, correction row fields byte-identical (`prior_version`, `correction_reason`, `correction_author`, `confirmation_received`), `pg_constraint` still has `meal_event_versions_prior_fk`, `pg_indexes` still has `uniq_correction_bundle_fingerprint`.
4. `"correction rollback leaves prior state intact"` — deterministic failure injection via a temporary `BEFORE UPDATE ON meal_events` trigger (created and dropped inside the test; the `UPDATE meal_events` is the last mutation before readback, so the abort happens after version/provider/canonical rows are written). Asserts: rejection with the injected message, `current_version` unchanged, zero version-2 rows in all three tables, prior-version table counts intact. Trigger is dropped in `finally`.
5. `"stale-version correction with fresh idempotency key is rejected"` — current version 2, correction bundle targets version 2 again under a **fresh** idempotency key. Asserts: `"correction must append the current version"` error (also verified as `CalculationBundleValidationError` on a second fresh key), zero new writes (table-count snapshot equality), `current_version` still 2.
6. `"direct cross-user correction is rejected"` — repository-level `commitCalculationCorrection` with `metadata.user_id = "intruder-user"` against an event owned by `"owner-user"`. Asserts: `"event is not owned by user"` ownership error, zero writes, `current_version` unchanged.
7. `"MCP correction round-trip"` — real `InMemoryTransport` client: `commit_calculation_bundle` (v1) then `commit_calculation_correction` (v2). Asserts: `structuredContent` parses with the real `CALCULATION_CORRECTION_OUTPUT_SCHEMA`, version 2, event canonical 600, `item_canonicals` ordinals `[0, 1]`, `external_sync: "not_authorized"`; SQL cross-check in the same test (`current_version = 2`, three per-scope canonical rows at version 2).
8. `"failed provider is readable through public provenance"` — bundle with an event-scope `own` provider in `status: "failed"` carrying `error_code: "provider_timeout"` / `error_message: "timed out after 30s"`; read back via `get_calculation_provenance` over real MCP transport. Asserts: `CALCULATION_PROVENANCE_OUTPUT_SCHEMA` parse, error code/message verbatim, raw payload verbatim, every nutrient NULL (no fabricated zeros), event canonical computed from the succeeded provider alone (500).

## First-run evidence (RED-phase equivalent)

Per the plan, RED for this slice means "the suite runs and any genuinely-unmet promise fails loudly"; cases passing immediately against correct S1 code is explicitly allowed.

First run, focused suite, exact command and output:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/calculation-acceptance.integration.test.ts
```

```
(pass) calculation concurrency and correction acceptance matrix > concurrent identical calculation bundles converge [17.56ms]
(pass) calculation concurrency and correction acceptance matrix > concurrent identical corrections yield one new version [13.64ms]
(pass) calculation concurrency and correction acceptance matrix > migration 005 reruns safely [13.39ms]
(pass) calculation concurrency and correction acceptance matrix > correction rollback leaves prior state intact [14.74ms]
(pass) calculation concurrency and correction acceptance matrix > stale-version correction with fresh idempotency key is rejected [11.93ms]
(pass) calculation concurrency and correction acceptance matrix > direct cross-user correction is rejected [4.93ms]
(pass) calculation concurrency and correction acceptance matrix > MCP correction round-trip [40.21ms]
(pass) calculation concurrency and correction acceptance matrix > failed provider is readable through public provenance [10.84ms]
 8 pass
 0 fail
 56 expect() calls
Ran 8 tests across 1 file. [525.00ms]
```

**Born green: all 8 cases.** No case exposed a production defect, so the slice's stop-and-escalate escape hatch was not triggered; there is no micro-slice recommendation for reviewer-terra. Production behavior pinned by the suite (FOR UPDATE convergence, idempotency-key dedup, append-only version guard, ownership guard, per-scope materialization, schema-parsed MCP outputs) already matched the plan promises at HEAD.

Race-stability evidence: the focused suite was run 3 additional times after the gate run — `0 fail, 56 expect() calls` every time.

## Gate results (exact commands, counts reported separately)

Baseline at slice start (clean HEAD `9868a96b`): unit 448 pass / 93 skip / 0 fail; db 89 pass / 0 fail / 0 skip across 7 suites; typecheck clean.

Final gates after the change:

```bash
bun run typecheck
# src/ typechecks clean

bun run test:unit
# unit: 448 pass / 103 skip / 0 fail (551 tests)
#   (skip +10 vs baseline, verified: `env -u DATABASE_URL -u DATABASE_URL_TEST
#    bun test src/calculation-acceptance.integration.test.ts` reports exactly
#    10 skip = the suite's 8 named tests + 2 unnamed lifecycle-hook entries bun
#    counts for a skipped describe's beforeAll/afterAll; pass count unchanged, 0 fail)

DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
# src/calculation-acceptance.integration.test.ts: 8 pass, 0 fail, 0 skip, 8 ran, exit 0
# db: 97 pass / 0 skip / 0 fail across 8 DB suites
#   ("DB gate totals: 97 pass, 0 fail, 0 skip, 97 tests across 8 DB suites.")

git diff --check
# (silence)

bunx prettier --check src/calculation-acceptance.integration.test.ts scripts/test-db-gate.ts
# All matched files use Prettier code style!
```

Counts vs baseline: unit 448 -> 448 pass (0 fail), db 89 -> 97 pass across 7 -> 8 suites. Growth-only, 0 fail, 0 db-skip.

## No-scope-widening proof

- `git diff --stat 9868a96b80c848358557822d43ddee28a57050c4` shows exactly two files: `src/calculation-acceptance.integration.test.ts` (new) and `scripts/test-db-gate.ts` (+1 line).
- Zero production-file diffs (`src/*.ts` other than the new test: untouched; `db/migrations/`: untouched — case 3 re-applies the real 005 file read-only inside the disposable test DB).
- No S3+ work started: no `sumMeals`/`TOTALS_ITEM` presence changes, no provenance-status output fields, no capture media tool, no schema alias replacement.
- The temporary failure-injection trigger in case 4 lives only inside the disposable test database and is dropped in `finally`; it is not a migration and never touches the repo.

## Known limitations

- The concurrency cases pin convergence (winner persists, loser deduplicates), not a specific interleaving; the production `FOR UPDATE` ordering makes the asserted outcome deterministic, and 4 consecutive runs showed no flakiness.
- Case 4's injection point is the `UPDATE meal_events` trigger because `commitCalculationCorrection` exposes no `beforeCommit` seam (production files were forbidden); the trigger fires after all version-scoped rows are written, which is exactly the rollback surface the plan asks to prove.
- Unit-mode skip count grew by exactly 10 (8 new DB-gated tests + 2 unnamed hook entries bun registers for a skipped suite's beforeAll/afterAll, verified with env unset); this is the standard describeDb pattern and the DB gate runs all 8 for real.
