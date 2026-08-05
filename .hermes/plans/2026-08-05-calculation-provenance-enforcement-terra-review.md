# Terra acceptance-gate review — calculation provenance enforcement

**Verdict: FAIL (blocking).** Reviewed the current working tree against the approved plan and brief. No production code was changed by this review.

## Blocking findings

1. **No real PostgreSQL/MCP acceptance evidence exists.** `DATABASE_URL_TEST` is unset. The focused run passed **27, skipped 35, failed 0**; the full run passed **441, skipped 83, failed 0**. All new persistence, public MCP readback, correction, legacy, capture, deleted-event, cross-user, idempotency, immutable-history, and rollback assertions are therefore skipped. Per the approved acceptance criterion, this is unverified, not a pass.

2. **The core enforcement invariant is not implemented at the common write boundary.** `src/meal-events.ts` adds `deriveProvenanceStatus()` and computes status only in `getMealEventProvenance()`. `createMealEvent()`/`insertVersionChildren()` were not changed to persist or return an explicit pending/unavailable state, and `src/meal-captures.ts:346-375` still confirms a draft with `provider_results ?? []` and returns only the old capture result. `confirm_meal_capture` consequently does not expose `provenance_status`, nullable canonical nutrition, or bundle fingerprint as required by the plan.

3. **Public legacy compatibility paths still have a numeric-zero risk.** The changed feature code does not update `src/db.ts`, `src/meal-event-projection.ts`, or legacy tool output. `src/mcp.ts:445-451` still formats projection nutrition with `?? 0` (and the aggregation code uses null-to-zero sums). Existing unit tests cover generic legacy formatting, but there is no new real legacy integration assertion proving a pending compatibility event is not reported as ready/zero. The approved decision explicitly requires `log_meal`, bulk import, and `update_meal` to remain pending/compatibility with nullable nutrition.

4. **Public `commit_calculation_bundle` remains unscoped.** `src/mcp.ts` calls `commitCalculationBundle(mealEventsPool, bundle)` without `userId`; `src/calculation-bundles.ts:129-135` selects a version by event/version only, and the idempotent path also reads only those identifiers. A caller can submit a bundle for another user's event ID if it knows the UUID. The new correction function does pass `metadata.user_id`, but the approved acceptance requires user-scoped public mutation behavior for the bundle path too. No DB/MCP test proves rejection and unchanged state.

5. **The public correction/read contracts are only shallowly tested.** The added `src/calculation-bundles.test.ts:76-108` checks tool discovery and malformed read input only. There are no new real-MCP assertions for `commit_calculation_correction`, no output schema for that tool, no raw provider/canonical readback, same-key identity conflict, cross-user mutation, deleted-event hiding, historical read, or external-write pending journal. The correction handler returns `Promise<any>` and an ad-hoc payload rather than a declared strict output schema.

6. **Readback status derivation can overclaim `ready`.** `deriveProvenanceStatus()` returns `ready` for any non-null bundle fingerprint, present canonical row, and consensus other than `insufficient_data`; it does not verify that provider rows/raw/provenance fields and canonical evidence are internally complete/consistent, as required by the invariant. This is especially material because `commitCalculationBundle()` itself does not check ownership and the read helper delegates to the unscoped `getMealEvent()` after only scoping the root.

## What did pass

- `bun run typecheck`: passed (`src/ typechecks clean`).
- Targeted Prettier check for feature/test files: passed.
- `git diff --check`: passed (included in the verification command).
- Unit/schema tests exercised: provenance-status pure cases, tool discovery, malformed bundle/read validation, canonical recomputation seam, fingerprint validation. These are not DB or public end-to-end evidence.
- No flat `meals` table was added by the feature diff; no provider worker/Telegram/STT/OCR/vision code was introduced.
- `get_calculation_provenance` has the intended UUID/version input shape, user-scoped active-root query, current-version default, historical version selection, and deleted/cross-user null-to-error behavior in code, but these claims remain unverified without DB execution.

## Focused fixes plan for coder-kimi

1. **Enforce and expose status across every write path**
   - Files: `src/meal-events.ts`, `src/meal-captures.ts`, `src/mcp.ts`, `src/db.ts`, `src/meal-event-projection.ts`.
   - Add shared pending/unavailable derivation at version persistence/readback; keep compatibility writes pending/compatibility and preserve SQL NULL/JSON null. Confirm capture may create pending, but its public response must include status, fingerprint (nullable), and nullable canonical data. Ensure legacy `log_meal`, bulk import, and `update_meal` never render missing nutrition as numeric zero while preserving explicit zero.
   - Tests: add/update real MCP and legacy integration assertions for empty providers, failed/unavailable providers, missing canonical, compatibility writes, capture confirmation, and explicit zero vs NULL.

2. **Bind public bundle commit to the authenticated user**
   - Files: `src/calculation-bundles.ts`, `src/mcp.ts`.
   - Add a required user-scoped option/metadata to `commitCalculationBundle()` and include `user_id` in the locked version/root query (including dedupe path). Pass `userId` from the public handler. Reject cross-user/deleted events without mutation.
   - Tests: `src/mcp-food-tracking.test.ts` or `src/calculation-bundles.integration.test.ts`: two-user cross-user commit/read rejection and row-count/current-version unchanged.

3. **Finish the public correction contract**
   - Files: `src/mcp.ts`, `src/calculation-bundles.test.ts`, `src/mcp-food-tracking.test.ts`, `src/calculation-bundles.integration.test.ts`.
   - Declare a strict output schema (or the repository’s established equivalent), test valid/invalid inputs, real MCP call, backend recomputation against a hostile canonical proposal, immutable prior rows, `current_version + 1`, same-key exact dedupe, same-key identity conflict rejection, user scope, deleted hiding, and pending-only external journal intent.

4. **Harden provenance readback derivation**
   - Files: `src/meal-events.ts` plus integration tests.
   - Verify selected version belongs to the scoped active root and derive `ready` only from a complete consistent bundle/canonical/provider evidence set; distinguish missing evidence from persisted insufficient/failed/unavailable evidence. Assert every required provider field, raw payload, provenance, source ID, basis, units, errors, canonical audit evidence, algorithm version, fingerprint, current/historical selection, and deleted/cross-user behavior.

5. **Run the real gate before approval**
   - Do not invent a DSN. Set a real disposable `DATABASE_URL_TEST` and matching `DATABASE_URL` only when available; run the focused DB/MCP/legacy suites serially, then full suite, typecheck, targeted Prettier, and `git diff --check`. Record exact pass/skip/fail counts. If the DB remains unavailable, keep the gate FAIL.

## Working-tree scope / hygiene

At review time `git status --short` showed feature files `README.md`, `docs/food-tracking-agent-driven.md`, `src/mcp.ts`, `src/meal-events.ts`, and their tests, plus pre-existing tracked changes in `src/foods.ts`, `src/rate-limit.ts`, two 2026-08-04 plans, and many unrelated untracked `.hermes/plans/*` artifacts. The approved plan explicitly identifies those unrelated files as pre-existing; this review did not modify, reset, stash, or clean them. The only file created by this review is this review artifact.
