# Terra 6 acceptance review — calculation provenance enforcement

**Verdict: FAIL (blocking).** Terra reviewed the live working tree after the latest coder pass. No production code was changed by Terra. The 81/81 repository DB gate is real evidence for the seven suites it runs, but it does not close the required public MCP and deterministic full-run contract.

## Scope and independent evidence

Reviewed the live diff and surrounding source/tests in:

- `src/meal-events.ts`
- `src/calculation-bundles.ts`
- `src/mcp.ts`
- `src/nutrition-bundle-types.ts`
- `src/meal-types.ts`
- `src/calculation-bundles.test.ts`
- `src/meal-events.test.ts`
- `src/mcp-food-tracking.test.ts`
- `src/legacy-meal-tools.integration.test.ts`
- Terra 5 artifact and the current dirty-tree scope

Current HEAD: `fdfa2e6 test: close acceptance gate gaps for meal event tooling`.

Commands actually run:

- `DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test DATABASE_URL=postgres://localhost/nutrition_mcp_test bun run test:db`
    - **PASS: 81 pass, 0 fail, 0 skip, 81 tests across 7 DB suites.**
    - Includes calculation bundle persistence/correction tests, event repository tests, capture tests, public legacy regression tests, and MCP food-tracking tests.
- `bun run typecheck`
    - **PASS: `src/ typechecks clean`.**
- Targeted Prettier over changed feature/test files
    - **FAIL: `src/mcp.ts` is not formatted.** Other checked files were clean.
- `git diff --check`
    - **PASS.**
- `bun test --max-concurrency 1`
    - **496 pass, 11 skip, 0 fail, 507 tests across 33 files.** The 11 skips are the opt-in legacy DB regression suite; this is not complete public coverage.
- `DATABASE_URL_TEST=... DATABASE_URL=... RUN_LEGACY_MEAL_DB_TESTS=1 bun test --max-concurrency 1`
    - **497 pass, 8 fail, 0 skip, 505 tests across 33 files.** All eight failures are in `src/legacy-meal-tools.integration.test.ts`; shared `m1`/`u1` state/order-sensitive fixture failures cause missing rows, stale descriptions, failed current-projection assertions, and duplicate import expectations. Therefore the full run is not deterministic/green.

The working tree contains many unrelated pre-existing dirty and untracked plan/source files. They were preserved. The requested review artifact is the only file Terra created.

## Terra 5 blocker evaluation

### 1. Unified durable write seam — **FAIL**

The latest pass still has separate persistence implementations:

- `src/meal-events.ts:324-484` uses `insertVersionChildren()` for normal create/correction, but it synthesizes a fallback `source_id` (`${provider}:${request_fingerprint}`), writes compatibility audit metadata, uses `legacy-compat`, and does not accept/persist the complete bundle fingerprint/canonical audit contract.
- `src/meal-events.ts:490-677` (`createMealEvent`) and `:684-806` (`correctMealEvent`) still return `deriveWriteProvenance(...)` locally. Their dedupe/error-recovery paths return hardcoded `pending`, `fingerprint: null`, `canonical: null` (`:557-564`, `:666-673`, `:738-745`, `:793-801`) rather than a transaction-local authoritative aggregate readback.
- `src/calculation-bundles.ts:231-353` and `:355-540` retain independent SQL implementations for bundle commit and correction.
- `confirm_meal_capture` still calls the create path and then performs a second read in `src/mcp.ts:4696-4734`; it is not the common durable write result seam.

The code has useful shared readiness logic (`deriveAggregateProvenance`), but the required authoritative status/fingerprint/canonical result returned by one durable write boundary is not present across create, capture, bundle, correction, and legacy compatibility paths.

### 2. Exact provider/canonical provenance roundtrip — **FAIL**

Positive: bundle SQL now inserts supplied `result.provenance` when present (`src/calculation-bundles.ts:295-303`, `:470-477`), and canonical readback selects `source_result_ids`, `audit_evidence`, and `algorithm_version` (`:197-228`). The DB bundle tests prove selected persistence fields.

Blocking gaps remain:

- The shared normal-event seam still substitutes `source_id` and compatibility audit data (`src/meal-events.ts:412-418`, `:475-480`) instead of preserving the exact supplied provider/canonical provenance contract.
- Bundle/correction commit results still return the narrow `CalculationBundleCommitResult` and locally recomputed canonical object (`src/calculation-bundles.ts:26-32`, `:345-351`, `:532-538`), not a complete authoritative aggregate readback.
- No real public MCP commit/correction test sends sentinel provider provenance and asserts the returned `structuredContent` contains the exact durable provider and canonical audit fields after PostgreSQL readback.

### 3. Complete canonical audit readback — **PARTIAL, overall FAIL**

`readCanonical()` now selects and returns `source_result_ids`, `audit_evidence`, and `algorithm_version`, and `getMealEvent()` maps those fields (`src/meal-events.ts:957-965`). This closes the narrow omission identified by Terra 5 for the aggregate read path.

It does not close the acceptance item because canonical audit is not returned from a single shared write seam for all write paths, and no public DB-backed MCP call proves the complete canonical readback contract end to end.

### 4. No fabricated fallback — **PASS for the latest changed commit handlers; public proof still missing**

The old synthetic empty-result fallback is gone. Both commit handlers now throw when user-scoped durable readback is absent (`src/mcp.ts:4787-4789`, `:4855-4857`) and `buildCalculationBundleOutput()` parses the final object with `CALCULATION_BUNDLE_OUTPUT_SCHEMA` (`src/mcp.ts:139-184`). `get_calculation_provenance` also parses its payload (`:4421-4459`).

This is a substantive closure of the specific fabricated-fallback code defect. However, the required real public PostgreSQL transport test is still absent, so acceptance of the public contract remains blocked below.

### 5. Strict runtime parsing of public MCP `structuredContent` — **PARTIAL, overall FAIL**

Positive: declared strict nested schemas exist, and bundle/provenance builders call `.parse()` (`src/calculation-bundles.ts:44-149`, `src/mcp.ts:156-184`, `:4421-4459`). Unknown calculation-scope keys are tested through MCP in `src/calculation-bundles.test.ts`.

Blocking evidence gap: `src/calculation-bundles.test.ts` only exercises discovery, malformed input, builder/unit behavior, and a mocked/readback-absent path. It does not make a real PostgreSQL `tools/call` for `commit_calculation_bundle`, `commit_calculation_correction`, or `get_calculation_provenance` and validate the actual returned `structuredContent` against the declared strict schemas. The acceptance requirement is runtime transport proof, not schema declarations and unit literals.

### 6. Public bundle/correction authorization/history/idempotency/deleted/cross-user matrix — **FAIL**

The repository calculation integration suite proves seven DB cases (persistence, same-fingerprint idempotency, conflict/tamper rejection, rollback, correction audit/journal, altered same-key rejection, exact same-key dedupe). That is valuable but not public MCP evidence.

`src/calculation-bundles.test.ts` has no real DB-backed public calculation commit/correction matrix. The public tests call malformed inputs and a mocked readback-absent seam; they do not prove through `InMemoryTransport + PostgreSQL`:

- authorized versus unauthorized bundle/correction writes and pending-only journal behavior;
- current versus historical provenance readback;
- deleted-event read and mutation rejection;
- cross-user bundle commit/correction rejection with unchanged row counts/current-version pointer;
- same-key exact dedupe versus changed identity conflict at the public boundary;
- failed/unavailable provider output through the strict public schema.

The 81/81 gate cannot substitute for these missing public assertions.

### 7. Full NULL-vs-explicit-zero legacy matrix — **FAIL**

Some unit coverage is good: `src/mcp.test.ts` tests nullable trends/summary helpers and explicit zero distinction. The legacy DB test contains a pending/null end-to-end case (`legacy-meal-tools.integration.test.ts`), and the isolated DB gate passes it.

The complete required public matrix is still not executable/green as one clean run across log, bulk import, update, list/date/range/search/export, progress, summary, trends, and widget payloads for both missing and explicit zero. The production path still contains fallback-based aggregate fields at `src/mcp.ts:456-460` (`fiber.avg ?? 0`, `sugar.avg ?? 0`, `alcohol.avg ?? 0`), with comments at `:696-700` explicitly acknowledging widget drift. The source also retains display fallbacks such as `:1353-1354` and `:2720-2721`. Even if some are intentional arithmetic/display gating, the requested end-to-end matrix and invariant are not proven.

### 8. Deterministic full-run hygiene — **FAIL**

The ordinary run is green only because the legacy DB file is skipped: **496 pass, 11 skip**. Enabling the required public regression gives **497 pass, 8 fail**. `--max-concurrency 1` does not isolate the destructive/shared-reset legacy file from the rest of the process; failures show stale `m1`/`u1` state and order-sensitive expectations.

The isolated `test:db` script is a useful green evidence gate, but it is not a deterministic full-run solution and cannot be used to accept a failing opt-in public suite.

### 9. Formatting/diff hygiene — **FAIL (blocking closeout)**

`git diff --check` and typecheck pass, but targeted Prettier still fails on `src/mcp.ts`. The formatter issue must be fixed by the coder before a final acceptance rerun. Terra did not format or otherwise edit production code.

## Focused coder plan if FAIL

1. **Finish the shared durable seam.** Refactor create, capture confirmation, bundle commit, correction, and legacy compatibility correction to one transaction-local persistence/readback helper. It must preserve caller provider fields, persist canonical audit fields, derive status from committed rows, and return one aggregate/status/fingerprint shape. Dedupe and concurrent-recovery branches must lock/read the persisted aggregate rather than return hardcoded pending/null values.
2. **Complete exact roundtrip.** Add a DB assertion with sentinel nested provider provenance/raw payload and canonical audit fields, then assert exact values through the production aggregate readback. Do not use synthesized compatibility values for a supplied bundle.
3. **Add real public transport coverage.** Through `InMemoryTransport` against a disposable PostgreSQL schema, call `tools/list` and `tools/call` for provenance read, bundle commit, and correction. Validate the actual `structuredContent` with the exact strict output schemas, including unknown-key rejection and all provider/canonical audit fields.
4. **Add the complete public authorization/history matrix.** Cover current/historical reads, deleted hidden reads/mutations, cross-user reads/commit/correction with unchanged counts/current pointer, exact same-key dedupe, altered same-key conflict, version sequencing, failed/unavailable providers, and explicit authorization creating only one pending journal row.
5. **Close NULL/zero across every named legacy surface.** Run a clean DB/MCP fixture through log, bulk import, update, list/date/range/search/export, progress, summary, trends, and widget payloads with one pending/null event and one explicit-zero event. Remove or constrain numeric fallbacks that turn missing values into public zeroes, including the trends/summary/widget path.
6. **Make the full runner deterministic.** Isolate/reset the destructive public legacy DB suite per invocation or add a runner that serializes/reset-cleans every DB file without shared stale fixtures. The required full env run must finish with zero failures; keep skipped counts explicit for intentionally opt-in suites.
7. **Run final closeout.** Format every changed source/test file (including `src/mcp.ts`), run typecheck, focused public DB MCP suite, `bun run test:db`, ordinary full suite, opt-in full suite, `git diff --check`, and verify status while preserving unrelated dirty files.

## Non-blocking positives

- Real repository DB gate is green at 81/81 with no skips.
- Typecheck and `git diff --check` pass.
- Canonical audit columns are now selected in the narrow bundle read helper and mapped by aggregate readback.
- Commit handlers no longer fabricate an empty pending success response; missing durable readback fails closed.
- User-scoped active-event provenance read and repository correction/idempotency/journal semantics are present.
- No unrelated production code was edited by Terra.

**Final decision: FAIL.**
