# Terra acceptance-gate review 2 — calculation provenance enforcement

**Verdict: FAIL (blocking).** This second acceptance pass reviewed the approved plan, the prior Terra FAIL/remediation list, the live working-tree diff, and the current source/test files. No production code was changed by this review. Fixes must go back to **coder-kimi**.

## Verification evidence

- Targeted unit/schema run:
  - `bun test src/nutrition-bundle.test.ts src/calculation-bundles.test.ts src/meal-events.test.ts --max-concurrency 1`
  - **30 pass, 35 skip, 0 fail; 65 tests**.
  - The 35 skipped tests are PostgreSQL repository/canonical/correction/journal tests gated by missing `DATABASE_URL_TEST`.
- Full local run without a DB:
  - `bun test --max-concurrency 1`
  - **444 pass, 83 skip, 0 fail; 527 tests across 33 files**.
  - This is not a DB/MCP acceptance pass; all DB-gated suites remain skipped.
- `bun run typecheck`: **PASS** (`src/ typechecks clean`).
- Targeted Prettier check from the approved plan: **FAIL** for:
  - `src/calculation-bundles.ts`
  - `src/mcp.ts`
  - `src/calculation-bundles.test.ts`
- `git diff --check`: **PASS**.
- `DATABASE_URL_TEST`: **unset**. No DSN was fabricated. `test:db` would refuse to run before executing suites because it requires `DATABASE_URL_TEST` and matching `DATABASE_URL`.

## Blocking findings

### 1. Real PostgreSQL/MCP acceptance evidence is still absent

The required DB/MCP/legacy integration matrix cannot be accepted from skipped tests. Missing evidence includes real persistence/readback of provider fields, raw payload/provenance, canonical audit evidence, NULL-vs-explicit-zero, capture confirmation, public MCP write/read behavior, correction idempotency/conflicts, deleted/cross-user behavior, immutable history, journal pending semantics, and legacy compatibility paths. Per the approved plan, this remains an automatic blocking gate.

### 2. Common write-boundary pending/unavailable semantics are still not implemented

`src/meal-events.ts` still persists canonical rows directly in `insertVersionChildren()` for every create/correction, including empty or incomplete provider input, but `createMealEvent()` still returns only `{ event_id, version, deduplicated }`. `deriveProvenanceStatus()` is used only by `getMealEventProvenance()`; it is not applied at the common persistence/return boundary as required.

`confirmMealCapture()` in `src/meal-captures.ts` still passes `draft.provider_results ?? []` through unchanged and returns the old capture result. The MCP wrapper adds a post-commit read, but this is not common-boundary enforcement and is not backed by a real integration assertion. The implementation must preserve the approved pending capture policy while making the result authoritative and atomic.

The legacy paths are also not updated: `src/db.ts:compatibilityCommand()` still creates the synthetic one-provider `own`/`legacy-compat` row, and `updateMeal()` still routes through `correctMealEvent()` with that compatibility result. They are not changed to expose an authoritative pending/compatibility status at their write boundary.

### 3. NULL-to-zero risk remains in legacy/projection behavior

The compatibility projection keeps SQL NULL nullable, but the legacy write/formatting and aggregate paths were not comprehensively changed in this slice. `src/mcp.ts` and existing progress/aggregation code still contain null-to-zero behavior in paths outside the newly added provenance readback. The approved contract requires pending/unavailable nutrition never be presented as numeric zero while preserving a genuine provider-supplied zero. The only evidence for this matrix is skipped legacy integration coverage, so the requirement is not closed.

### 4. `commit_calculation_bundle` user scope was added in code but is unverified and incomplete as a public output contract

The handler now passes `{ user_id: userId }`, and the repository query joins `meal_events` with an active/user predicate. However, no real two-user MCP/DB test proves cross-user rejection and unchanged row/version state. The idempotent and deleted-event behavior likewise remains unverified.

The public `commit_calculation_bundle` registration still has no declared output schema and returns an ad-hoc `Promise<any>` payload. It reports status from only `canonical.consensus_status`, rather than deriving complete ready evidence from the persisted provider/canonical bundle. It also does not expose the complete required persisted readback bundle (provider raw/provenance/source/error and canonical audit evidence).

### 5. Correction output schema is not strict enough and the public correction matrix is unverified

`CALCULATION_CORRECTION_OUTPUT_SCHEMA` is strict only at the top level. Its nested `canonical` object is not `.strict()`, and `status`/`consensus_status` are unconstrained `z.string()` values rather than the approved enumerations. The schema also omits required canonical fields such as `source_result_ids`, `audit_evidence`, and `algorithm_version`. The handler is still typed as `Promise<any>`.

The added unit test only proves that one sample parses and `{}` fails. There is no real MCP/DB evidence for valid correction commit, hostile canonical proposal recomputation, `current_version + 1`, immutable prior rows, exact same-key dedupe, same-key identity conflict, deleted/cross-user rejection, or pending-only external journal intent.

### 6. Ready-evidence derivation can still overclaim

`deriveProvenanceStatus()` defaults optional `providerEvidenceComplete` and `canonicalEvidenceComplete` to permissive `undefined`, and returns `ready` once a fingerprint/canonical/non-insufficient consensus exists unless the caller supplies explicit false flags. The read helper does calculate completeness flags, but the invariant is not enforced at persistence and the commit MCP response bypasses the helper entirely.

The read helper also uses `provider_results.length` rather than explicitly requiring the event-scope provider/canonical evidence set required by the plan. Missing/legacy, persisted insufficient, failed/unavailable, and complete-ready states need real DB assertions. Current/historical selection is present in code, but not acceptance-proven.

### 7. Scope hygiene has unrelated dirty files that must be preserved

The feature-related tracked changes include `README.md`, `docs/food-tracking-agent-driven.md`, `src/calculation-bundles.test.ts`, `src/calculation-bundles.ts`, `src/mcp.ts`, `src/meal-events.test.ts`, `src/meal-events.ts`, and `src/meal-types.ts`. Pre-existing unrelated tracked changes remain in:

- `.hermes/plans/2026-08-04-supabase-to-pg-brief.md`
- `.hermes/plans/2026-08-04-supabase-to-pg-plan.md`
- `src/foods.ts`
- `src/rate-limit.ts`

There are also many pre-existing untracked `.hermes/plans/*` artifacts, including the prior plan/review. This review did not reset, stash, clean, or format unrelated files. The three feature files failing targeted Prettier must be fixed by coder-kimi without rewriting unrelated plans or dirty files.

## Focused fixes plan for coder-kimi

1. **Enforce one shared provenance/readiness policy at all writes.** Apply the common derivation to `createMealEvent()`/`insertVersionChildren()`, capture confirmation, bundle commit, bundle correction, and legacy compatibility correction. Preserve compatibility writes as explicit `pending`/`compatibility`; mark failed/unavailable evidence `unavailable`; never claim ready without the complete persisted bundle. Return authoritative status/fingerprint/nullable canonical data from the write seam.
2. **Close the NULL/zero boundary.** Audit every legacy formatter, progress/summary path, projection consumer, `log_meal`, bulk import, and `update_meal`; retain SQL/JSON null for missing values and retain explicit numeric zero. Add assertions for pending, unavailable, missing canonical, and explicit zero through the actual MCP/legacy surfaces.
3. **Finish user-scoped bundle/correction behavior.** Keep authenticated user predicates in locked root/version and dedupe queries; add real two-user and deleted-event mutation tests with row-count/current-version unchanged assertions. Preserve append-only correction and external-write journal as pending only.
4. **Make every public output contract strict and complete.** Add declared output schemas for bundle commit and correction. Use strict nested objects and exact enum domains; include the approved provider/canonical evidence fields, nullable nutrients, fingerprint, status, current/historical marker, audit evidence, and source IDs. Remove `Promise<any>` from these handlers where practical and validate actual MCP `structuredContent`.
5. **Harden ready derivation.** Require explicit complete provider evidence, event-scope canonical evidence, fingerprint consistency, canonical source IDs/audit evidence/algorithm version, and active user-scoped version selection. Add real DB tests for current, historical, missing/legacy, insufficient, failed/unavailable, deleted, and cross-user cases.
6. **Run the real gate before approval.** With a real disposable DSN only (never a placeholder), run `bun run test:acceptance`/the DB suites serially, then full suite, typecheck, targeted Prettier, and `git diff --check`. Record exact per-suite counts and confirm exports/temp artifacts are cleaned. Without `DATABASE_URL_TEST`, keep the verdict FAIL.

## Non-blocking positives

- TypeScript typecheck passed.
- Unit/schema tests passed and cover several pure status, schema, proxy, fingerprint, and recomputation cases.
- `git diff --check` passed.
- The feature diff does not restore a flat `meals` table or add provider/Telegram/STT/OCR/vision workers.
- The new provenance read tool and public correction tool are discoverable in the in-memory MCP unit test, and malformed provenance input returns an MCP error in that unit test.

**Final verdict: FAIL. Fixes must return to coder-kimi; do not approve until the common-boundary behavior, strict complete outputs, real DB/MCP integration matrix, and formatting gate are all closed.**
