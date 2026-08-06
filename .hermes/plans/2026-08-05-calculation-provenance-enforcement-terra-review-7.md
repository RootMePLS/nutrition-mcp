# Terra 7 acceptance review — calculation provenance enforcement

**Verdict: FAIL (blocking).** Terra 7 reviewed the live working tree and did not modify production code. The real PostgreSQL DB gate and type/format checks are green, but the required public calculation MCP matrix is still absent and the opt-in deterministic full suite still fails. Terra 6 blockers are therefore not closed.

## Review scope and tree state

- Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Current HEAD: `fdfa2e6 test: close acceptance gate gaps for meal event tooling`
- The relevant Terra 7 remediation remains in the working tree, not as a clean reviewable commit. Existing unrelated dirty files and untracked plan artifacts were preserved.
- Terra-created artifact: this file only.
- `git status --short` after verification still shows the pre-existing dirty source/docs/tests plus untracked plans; no `exports/` directory remains.
- `git diff --check`: PASS.

## Commands actually run and exact results

1. `DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test DATABASE_URL=postgres://localhost/nutrition_mcp_test bun run test:db`
    - **PASS: 81 pass, 0 fail, 0 skip, 81 tests across 7 DB suites.**
    - Suites and counts:
        - `src/db.integration.test.ts`: 5/0/0, exit 0
        - `src/meal-events.test.ts`: 41/0/0, exit 0
        - `src/calculation-bundles.integration.test.ts`: 7/0/0, exit 0
        - `src/meal-captures.integration.test.ts`: 4/0/0, exit 0
        - `src/mcp-food-tracking.test.ts`: 8/0/0, exit 0
        - `src/backup-policy.test.ts`: 7/0/0, exit 0
        - `src/legacy-meal-tools.integration.test.ts`: 9/0/0, exit 0
    - This is real PostgreSQL evidence for those suites, not evidence of the missing public calculation MCP matrix.
2. `bun run typecheck`
    - **PASS: `src/ typechecks clean`.**
3. `bunx prettier --check src/meal-events.ts src/calculation-bundles.ts src/mcp.ts src/nutrition-bundle-types.ts src/meal-types.ts src/calculation-bundles.test.ts src/mcp-food-tracking.test.ts src/legacy-meal-tools.integration.test.ts scripts/test-db-gate.ts scripts/mcp-smoke.ts`
    - **PASS: All matched files use Prettier code style.**
4. `bun test --max-concurrency 1`
    - **PASS: 496 pass, 11 skip, 0 fail, 507 tests across 33 files.**
    - The 11 skips are the opt-in destructive legacy DB regression suite; this ordinary run is not complete public legacy evidence.
5. `DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test DATABASE_URL=postgres://localhost/nutrition_mcp_test RUN_LEGACY_MEAL_DB_TESTS=1 bun test --max-concurrency 1`
    - **FAIL: 497 pass, 8 fail, 0 skip, 505 tests across 33 files.**
    - All 8 failures are in `src/legacy-meal-tools.integration.test.ts`. Observed failures include missing `u1` rows (`rows[0]` undefined), stale `m1` projection instead of the expected current event, duplicate import retry returning `created: 2` instead of `created: 0, deduplicated: 2`, pending/null read receiving the wrong shared `m1` row, timezone fixture receiving the wrong shared row, and active-correction lookup finding no row. This proves the required full opt-in run is not deterministic/green despite the isolated DB gate passing.
6. Post-run hygiene: `exports/` is absent; `git diff --check` passes.

## Terra 6 blocker evaluation against live source/tests

### 1. Shared durable write seam and dedupe recovery — **FAIL**

Positive: `src/meal-events.ts:60-153` now has `readPersistedWriteStatus()` and normal create/dedupe/concurrent recovery paths call it (`:662-672`, `:721-731`, `:777-787`, and correction readback around `:853-863`, `:893-907`). The DB tests prove normal create/retry/concurrency behavior.

Blocking gaps remain:

- `src/meal-events.ts:426-589` (`insertVersionChildren`) is a separate legacy create/correction persistence implementation. It synthesizes compatibility `source_id` values at `:501-503`, synthesized provenance at `:521-523`, and canonical audit metadata with `compatibility: true` and `algorithm_version: "legacy-compat"` at `:580-584`.
- `src/calculation-bundles.ts:232-368` and `:371-568` retain separate SQL implementations for bundle commit/correction rather than routing all durable writes through one aggregate/status result seam.
- Bundle results remain the narrow `CalculationBundleCommitResult` (`src/calculation-bundles.ts:27-33`) and are expanded by later MCP readback/build logic, rather than being one authoritative durable write result across create, capture confirmation, bundle, correction, and compatibility paths.
- The required public capture-confirmation-to-common-write-result proof is absent; DB capture tests cover lifecycle/rollback but not the full public calculation output contract.
- `readPersistedWriteStatus()` defaults selected arrays/objects with `?? []`/`?? {}` (`src/meal-events.ts:108-114`), which is acceptable only for a fully validated persisted schema but is not a substitute for explicit required audit completeness in every result path.

### 2. Exact provider/canonical provenance roundtrip and audit fields — **FAIL**

Positive: `src/calculation-bundles.ts:307-312` and `:492-499` preserve supplied provider provenance when present; bundle readback selects canonical `source_result_ids`, `audit_evidence`, and `algorithm_version` (`:198-228`); the 7 real DB bundle tests pass.

Blocking gaps:

- The shared normal-event path still fabricates compatibility source/provenance/audit fields (`src/meal-events.ts:501-523`, `:580-584`) rather than preserving a complete caller-supplied provenance contract byte-for-byte.
- Bundle/correction commit functions return only fingerprint/dedupe/canonical (`src/calculation-bundles.ts:27-33`); the public provider rows and full canonical audit are reconstructed by a separate read/build path.
- `src/calculation-bundles.test.ts` proves discovery, strict literals, malformed input, a mocked absent-readback failure, and mocked query flow, but does **not** perform a real PostgreSQL public `tools/call` with sentinel nested provider provenance and assert exact returned `structuredContent` fields after durable readback.

### 3. No fabricated fallback — **PARTIAL / FAIL overall**

Positive: `src/mcp.ts` builders parse final payloads, and the public commit handlers fail closed when scoped durable readback is absent rather than returning the old synthetic empty success object. The focused test `fails closed through MCP when scoped durable readback is absent` passes.

Remaining concern: the domain write paths still fabricate compatibility provenance/source IDs and audit metadata for legacy writes. That is not the old empty-result fallback, but it violates the Terra requirement that supplied provider/canonical provenance be exact and that incomplete evidence not be represented by guessed audit data. No real public DB transport test proves all successful outputs are built solely from scoped durable readback.

### 4. Runtime-strict public `structuredContent` — **PARTIAL / FAIL overall**

Positive: strict nested schemas are declared in `src/calculation-bundles.ts:45-150`; `buildCalculationBundleOutput()` and provenance output builders parse final payloads; malformed calculation scopes are rejected through MCP in `src/calculation-bundles.test.ts:156-190`.

Blocking evidence gap: no real PostgreSQL `InMemoryTransport` call covers successful `commit_calculation_bundle`, `commit_calculation_correction`, and `get_calculation_provenance` with actual returned `structuredContent` validated against the exact strict output schema. Current public calculation tests are discovery/malformed/mock-readback tests, not runtime durable transport proof.

### 5. Public bundle/correction authorization/history/idempotency/deleted/cross-user matrix — **FAIL**

The 7 DB bundle tests prove repository-level persistence, same-fingerprint idempotency, tamper/conflict rejection, rollback, correction audit/journal, altered same-key rejection, and exact same-key dedupe. They do not close the public MCP requirement.

`src/calculation-bundles.test.ts` has no real DB-backed public calculation commit/correction matrix for:

- authorized versus unauthorized bundle/correction writes and exactly one pending journal row;
- current and historical provenance readback;
- deleted-event read hiding and mutation rejection;
- cross-user commit/correction rejection with unchanged row counts and current-version pointer;
- exact same-key dedupe versus changed identity conflict at `tools/call`;
- failed/unavailable providers through the strict public schema.

The public test at `:123-155` only discovers provenance/correction tools and rejects an invalid UUID. The commit test at `:192-264` uses a mocked pool and expects readback failure, not a real persisted successful call.

### 6. NULL versus explicit zero across all legacy summary/progress/trends/widgets — **FAIL**

Positive: unit tests in `src/mcp.test.ts` cover nullable averages/presence and explicit-zero distinction; isolated DB legacy test `pending event-scope nutrition retains nulls end to end and never fabricates zeros` passes; `src/legacy-meal-tools.integration.test.ts` includes summary/progress/trends calls.

Blocking evidence:

- The complete named public matrix is not green as one deterministic run: the opt-in full suite fails 8 tests because shared `m1`/`u1` fixture state leaks/order-depends.
- `src/mcp.ts:394-408` still uses `?? 0` for sums and `:464-469` uses nullable averages; comments at `:710-714` explicitly acknowledge widget payload drift risk. The unit helper behavior is not equivalent to an end-to-end public assertion across log, bulk import, update, list/date/range/search/export, progress, summary, trends, and widget payloads for both pending/null and explicit-zero records.
- A focused coder pass must prove every public surface, not only the helper tests and one passing isolated pending test.

### 7. Deterministic full-suite hygiene — **FAIL**

The ordinary suite is green only with the legacy DB file skipped: **496 pass, 11 skip**. Enabling the required public regression produces **497 pass, 8 fail**. `--max-concurrency 1` did not make the shared destructive fixture deterministic. The isolated `test:db` script is correctly sequential and green, but cannot substitute for a deterministic full-run result.

### 8. Formatting/type/diff hygiene — **PASS**

Typecheck, targeted Prettier, and `git diff --check` pass. This does not override the functional acceptance failures above.

## Focused coder plan if FAIL

1. **Unify the durable write result.** Introduce one transaction-local aggregate persistence/readback helper and route normal create, concurrent/dedupe recovery, capture confirmation, calculation bundle commit, calculation correction, and legacy compatibility writes through it. The helper must fail closed when required persisted aggregate/canonical/audit data is absent; no synthetic pending/null status on recovery paths.
2. **Remove fabricated provenance for supplied evidence.** Preserve provider `source_id`, raw payload, full provenance, basis, units, request fingerprint, algorithm version, error fields, and canonical audit evidence exactly on the shared seam. Compatibility synthesis must be explicit and limited to omitted fields; supplied values must win byte-for-byte. Add sentinel nested JSON roundtrip assertions through PostgreSQL.
3. **Make public output authoritative.** Have commit/correction/provenance handlers use user-scoped durable readback after the transaction and validate the actual `structuredContent` with the exact strict schemas. Add real `InMemoryTransport + PostgreSQL` success tests for `tools/list` and `tools/call`, not mocked pool-only assertions.
4. **Add the complete public calculation matrix.** Cover authorization/no-authorization, pending-only journal semantics, current/history reads, deleted reads and mutations, cross-user reads/commit/correction with unchanged DB state, same-key exact dedupe, altered same-key conflict, version sequencing, failed/unavailable providers, and rollback through the public MCP boundary.
5. **Close NULL/zero end to end.** Build one real DB/MCP fixture containing a pending/null event and an explicit-zero event. Assert list/date/range/search/export, summary, progress, trends, and widget structured payloads preserve `null` versus `0`; constrain or remove any public numeric fallback that collapses the distinction.
6. **Make the full runner deterministic.** Isolate the destructive legacy suite from other DB-backed files using separate invocations/databases or a runner with clean reset boundaries. The required opt-in full environment run must finish with zero failures; keep intentional skips visible in the ordinary run.
7. **Final closeout.** Run targeted Prettier, typecheck, the new focused public DB/MCP suite, `bun run test:db`, ordinary full suite, opt-in full suite, `git diff --check`, verify no exports/temp artifacts, and report a clean explicit changed-file commit without touching unrelated dirty files.

## Non-blocking positives

- Real sequential PostgreSQL gate is green: 81/81, 0 skips.
- Typecheck, targeted Prettier, and diff check pass.
- Canonical audit columns are selected in the readback helper.
- Old empty synthetic public success fallback is removed; absent scoped readback fails closed.
- Repository create/correction authorization, idempotency, rollback, and sync journal tests are materially stronger than Terra 6.
- No production or unrelated files were modified by Terra.

**Final decision: FAIL.**
