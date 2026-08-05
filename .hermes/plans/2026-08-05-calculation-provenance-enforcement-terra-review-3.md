# Terra acceptance-gate review 3 — calculation provenance enforcement

**Verdict: FAIL (blocking).** Hygiene is closed, but substantive acceptance is not. This review did not modify production code or unrelated files. The remaining fixes go to coder-kimi.

## Scope and baseline

Reviewed:

- approved plan: `.hermes/plans/2026-08-05-calculation-provenance-enforcement-plan.md`
- Terra review 2: `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-2.md`
- live working-tree diff and source/tests in `src/meal-events.ts`, `src/calculation-bundles.ts`, `src/mcp.ts`, `src/meal-event-projection.ts`, `src/db.ts`, and capture/correction tests
- current git status, typecheck, targeted tests, full tests, Prettier, and diff check

Feature-related changed files are `README.md`, `docs/food-tracking-agent-driven.md`, `src/calculation-bundles.test.ts`, `src/calculation-bundles.ts`, `src/mcp.ts`, `src/meal-events.test.ts`, `src/meal-events.ts`, and `src/meal-types.ts`. Pre-existing unrelated dirty files remain `src/foods.ts`, `src/rate-limit.ts`, two 2026-08-04 Supabase plans, and many untracked historical plan artifacts. They were preserved.

## Hygiene gate: PASS

- `bun run typecheck`: **PASS** — `src/ typechecks clean`.
- `bunx prettier --check src/calculation-bundles.ts src/mcp.ts src/calculation-bundles.test.ts src/meal-events.ts src/meal-events.test.ts src/meal-types.ts`: **PASS** — all matched files use Prettier style.
- `git diff --check`: **PASS**.
- Focused unit/schema command:
  `bun test src/nutrition-bundle.test.ts src/calculation-bundles.test.ts src/meal-events.test.ts --max-concurrency 1`
  returned **30 pass, 35 skip, 0 fail; 65 tests**.
- Full local command:
  `bun test --max-concurrency 1`
  returned **444 pass, 83 skip, 0 fail; 527 tests across 33 files**.
- No flat `meals` table/view or Telegram/STT/OCR/vision/provider worker was added in the feature diff.

These are hygiene/unit results only; they do not close the required PostgreSQL/MCP acceptance gate.

## Database gate: BLOCKED

`DATABASE_URL_TEST` is absent. DB-gated repository, correction, capture, legacy MCP, migration, bundle integration, and tombstone suites were skipped. No real PostgreSQL or real MCP persistence/readback evidence exists in this review. Per the approved plan, skipped tests cannot be converted into acceptance PASS.

## Substantive findings: FAIL

### 1. Common write-boundary provenance is still not authoritative

`src/meal-events.ts:84-125` defines `deriveWriteProvenance()`, and `createMealEvent()`/the compatibility correction return its result (`:553-562`, `:715-724`), but the shared persistence seam still only inserts canonical rows in `insertVersionChildren()` (`:377-423`). It does not persist or return a common explicit provenance state. In particular:

- create writes always pass `null` as the bundle fingerprint, so the write seam cannot establish a complete ready bundle;
- the ordinary legacy correction path returns derived pending data, but `commitCalculationCorrection()` returns only the old `CalculationBundleCommitResult` (`src/calculation-bundles.ts:498-504`), with no authoritative status;
- `confirmMealCapture()` still creates through `createMealEvent()` and the MCP handler performs a second `getMealEventProvenance()` read (`src/mcp.ts:4690-4725`). This is handler readback, not common-boundary enforcement;
- `commit_calculation_bundle` computes response status from the caller bundle and returned canonical (`src/mcp.ts:114-178`), rather than deriving it from the persisted provider/canonical rows;
- correction computes `readback` but does not use it (`src/mcp.ts:4828-4837`), then builds output from the input bundle/result.

The approved invariant requires every active version to receive an explicit pending/unavailable/ready determination at the write seam, with ready allowed only after complete persisted evidence. That is not demonstrated or implemented end-to-end.

### 2. Legacy projection/formatting still converts NULL to numeric zero

`src/meal-event-projection.ts:59-65` correctly preserves SQL NULL in the projection, but the public legacy path converts it back to zero:

- `src/mcp.ts:511-522` (`mealBreakdown`) uses `Math.round(m.calories ?? 0)` and the same pattern for all nutrients;
- `src/mcp.ts:1152+` `formatMeal()` is used by log/list/date/update output, while the update/log call sites still render compatibility meals through that path;
- `src/mcp.ts:380-394` intentionally sums NULL as zero for totals, but the feature requirement is not only aggregate summing: pending/unavailable meal nutrition must not be displayed as if calculated;
- the source itself documents the remaining problem for trends (`src/mcp.ts:689-697`), while the required legacy pending end-to-end integration tests are skipped.

No live evidence proves `log_meal`, bulk import, `update_meal`, list/date/range/search/export, and progress output preserve pending/missing NULL while preserving an explicit provider zero. The approved NULL→0 blocker therefore remains open.

### 3. Strict output contracts and ready derivation are incomplete

There are positive changes, but they do not satisfy the approved strict contract:

- `get_calculation_provenance` is registered without an `outputSchema` (`src/mcp.ts:4397-4458`), despite returning the largest nested contract;
- `CALCULATION_BUNDLE_OUTPUT_SCHEMA` (`src/calculation-bundles.ts:77-122`) is top-level strict and has a strict nested canonical, but provider entries omit required `ordinal`, `id`, `provenance`, `basis`, and `units`; canonical output is not the full persisted readback contract;
- `CALCULATION_CORRECTION_OUTPUT_SCHEMA` is merely an alias of the bundle schema (`:124-125`), while the correction handler remains `async (...): Promise<any>` (`src/mcp.ts:4805-4813`);
- `buildCalculationBundleOutput()` is input-derived (`src/mcp.ts:114-178`), hardcodes `compatibility: false` and `is_current: true`, derives source IDs from input rather than persisted IDs, and creates synthetic audit evidence. This can pass unit parsing without proving durable evidence;
- `deriveProvenanceStatus()` is used in `getMealEventProvenance()` but not as the authoritative output of bundle commit/correction. Its read completeness check also only requires `provider_results.length > 0` and does not explicitly prove the required complete event-scope three-provider set (`src/meal-events.ts:942-967`).

Thus handler/readback additions are hygiene/contract scaffolding, not closure of the ready-evidence invariant.

### 4. User scoping, current/historical/deleted/correction matrix is unverified

The source has useful predicates: `getMealEventProvenance()` filters by `user_id` and `status='active'` (`src/meal-events.ts:933-940`), bundle commit joins the active root and accepts `user_id` (`src/calculation-bundles.ts:221-231`), and correction locks an active owned root (`:344-353`). Deleted events are consequently hidden in these paths.

However, `DATABASE_URL_TEST` absence means there is no real two-user or deleted-event proof, and no proof of unchanged row/version state after rejected cross-user mutation. The required current-version default, historical immutable read, correction append/version+1, prior-row preservation, exact same-key dedupe, same-key identity conflict, failed/unavailable evidence, pending journal, and correction output round-trip cases remain skipped. The small in-memory unit test only proves discoverability and malformed UUID rejection, not authorization or persistence.

### 5. Feature-scope hygiene: PASS with dirty-tree caveat

The feature diff remains within the approved provenance/readback/correction scope. It does not introduce external provider calls, transport workers, or flat-meal restoration. Unrelated dirty files and historical plan artifacts were not touched. The requested review artifact is the only file created by this review.

## Focused coder-kimi fixes plan

1. **Make the repository write seam authoritative.** Introduce one shared persisted/readiness derivation used by `insertVersionChildren` plus create, capture confirmation, bundle commit, bundle correction, and legacy compatibility correction. Return the same status/fingerprint/canonical-nullable shape from each write path. Preserve approved compatibility writes as `pending`/`compatibility`; failed/unavailable provider evidence is `unavailable`; only a complete persisted bundle can be `ready`.
2. **Close the legacy NULL boundary.** Audit `mealBreakdown`, `formatMeal`, progress, list/date/range/search/export, bulk import, `update_meal`, and widgets. Pending/missing/unavailable nutrients must serialize/display as NULL or explicit pending/unavailable text; a stored provider zero must remain `0`. Add non-DB unit tests at each formatter and DB/MCP tests for the actual legacy surfaces.
3. **Finish strict public schemas.** Add a strict `outputSchema` for `get_calculation_provenance`; make nested provider/canonical contracts exact and complete, including IDs, ordinal, source, raw payload, provenance, basis, units, errors, source-result IDs, audit evidence, and algorithm version. Remove `Promise<any>` from correction and validate actual MCP structuredContent.
4. **Derive output from durable readback.** After commit/correction, build the public response from a user-scoped repository aggregate and shared status helper, not directly from the caller bundle. Do not hardcode `is_current`, compatibility, source IDs, or audit evidence. Require persisted event-scope canonical evidence, complete provider evidence, fingerprint consistency, and canonical audit fields before `ready`.
5. **Add the missing real matrix.** With a disposable matching `DATABASE_URL_TEST`/`DATABASE_URL`, run migrations and real MCP transport tests for two users, deleted hidden reads/mutations, current/historical selection, pending/missing/unavailable/explicit-zero, complete bundle recomputation, correction versioning/history, idempotency/conflict, rollback, and pending-only external journal behavior. Assert row counts/current version are unchanged on rejected operations.
6. **Re-run the full gate serially.** Record exact DB suite counts, focused and full counts, typecheck, targeted Prettier, `git diff --check`, and final status. Do not approve while the database gate is blocked.

## Final gate decision

**FAIL.** Hygiene closure is real (`typecheck`, Prettier, diff check, and unit/full non-DB runs pass), but substantive closure is not: common write-boundary semantics, legacy NULL preservation, strict complete schemas, durable ready derivation, and real scoping/history/deleted/correction evidence remain unproven or incomplete. No production code was changed by Terra.
