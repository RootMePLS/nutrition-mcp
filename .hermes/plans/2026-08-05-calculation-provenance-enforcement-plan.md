# Calculation Provenance Enforcement Implementation Plan

> **For Hermes:** execute this plan through planner-fable → coder-kimi → reviewer-terra. This artifact is an audit and bounded implementation plan only; do not add production code before the RED tests.

**Goal:** make every MCP-reachable meal write honest about calculation provenance, preserve provider evidence and backend-derived canonical results, and provide a user-scoped readback of the complete persisted bundle without fabricating historical data.

**Architecture:** `nutrition-mcp` remains a transport-neutral persistence/validation/recomputation/read layer. Hermes owns the independent estimate and all external provider calls; the server accepts prepared provider results, stores them transactionally, recomputes canonical consensus with `computeConsensus`, and exposes the persisted evidence. The narrowest common write boundary is the event-version persistence seam (`createMealEvent`/its shared child inserter plus the existing `commitCalculationBundle` and correction seam), not a Telegram/provider worker or a new ingestion pipeline.

**Tech stack:** Bun, TypeScript, `bun:test`, PostgreSQL via `pg`, MCP SDK `McpServer` + `Client` + `InMemoryTransport`, Zod, migrations `001`–`005`.

---

## 1. Current-reality gap report (live HEAD)

Audit basis: HEAD `fdfa2e6` (`test: close acceptance gate gaps for meal event tooling`), with the pre-existing dirty tree preserved. Existing unrelated modifications are `src/foods.ts`, `src/rate-limit.ts`, two modified old plans, and many untracked plans; none are part of this slice.

### Present and reusable

- `db/migrations/002_food_tracking.sql` is the authoritative append-only event model and deliberately drops the flat `meals` table. Do not restore it.
- `db/migrations/003_meal_captures.sql` provides durable capture/draft state.
- `db/migrations/004_calculation_bundles.sql` adds `source_id`, `basis`, `units`, `provenance`, and version `calculation_bundle_fingerprint`; its data update backfills `source_id` as `provider:id` for old rows, but does not invent provider results or canonical rows.
- `db/migrations/005_calculation_corrections.sql` adds immutable correction/audit columns and canonical `audit_evidence`/`algorithm_version`.
- `src/nutrition-bundle-types.ts` validates provider identity/status/scope, raw payload, errors, nullable nutrients, and content fingerprints.
- `src/calculation-bundles.ts` already has transactional `commitCalculationBundle()` and `commitCalculationCorrection()`. It recomputes canonical values, persists raw/provider fields and canonical rows, supports same-fingerprint idempotency, rejects conflicting content, preserves corrections, and writes pending sync intent only when explicitly authorized.
- `src/calculation-bundles.integration.test.ts` proves those low-level PostgreSQL properties, but not public provenance readback or every create/correction MCP path.
- `src/mcp.ts` exposes `validate_calculation_bundle` and `commit_calculation_bundle`, but no verified MCP tool reads the persisted provider rows/raw payloads/canonical audit evidence.
- `src/meal-events.ts:getMealEvent()` already queries all provider and canonical rows, but its returned `provider_results` omit `source_id`, `raw_payload`, `provenance`, `basis`, and `units`; its canonical object omits `audit_evidence` and `algorithm_version`; the function is not user-scoped and is not registered as an MCP read tool.
- `src/meal-event-projection.ts` intentionally reads only the current version/event-scope canonical row for legacy meal outputs, but converts missing values to nullable internally and `src/mcp.ts` formatters commonly render `null` with `?? 0`.

### Write paths that can currently create incomplete/synthetic provenance

1. **`log_meal` → `src/db.ts:compatibilityCommand()` → `createMealEvent()`**
    - Creates a one-item compatibility event and synthesizes one `own`/`legacy-compat` provider row from optional legacy nutrient fields.
    - It can therefore create a meal with one provider, null nutrients, and no three-provider bundle. `buildMealProgress()` and legacy formatters can display missing canonical values as zero because they use `?? 0`.
    - This is a compatibility write, not evidence of a complete Hermes calculation bundle.

2. **`bulk_import_meals` → `runImport()` → `insertMeal()`**
    - Uses the same compatibility command and therefore has the same incomplete/synthetic one-provider semantics for every imported row.
    - It must not be silently upgraded into a provider caller or a fabricated three-provider bundle.

3. **`log_meal_event` → `src/mcp.ts` → `createMealEvent()`**
    - `provider_results` is optional and defaults to `[]`.
    - `src/meal-events.ts:insertVersionChildren()` still creates an event-scope canonical row for an empty set (`insufficient_data` with nullable nutrients), so persistence itself is atomic but the public command does not make the distinction between pending/incomplete and nutrition-ready explicit enough.
    - Public output only exposes provider status summaries and a reduced canonical object; it does not expose raw/provenance evidence or a durable bundle-read status.

4. **`confirm_meal_capture` → `src/meal-captures.ts:confirmMealCapture()` → `createMealEvent()`**
    - `draft.provider_results ?? []` is passed through unchanged. A ready capture can therefore become a confirmed event with no provider rows and only an `insufficient_data` canonical result.
    - Confirmation is correctly user-scoped, row-locked, atomic with event creation, and explicit-add authorized; the provenance gap is the missing bundle/readiness guard, not the transaction boundary.

5. **Legacy `update_meal` → `src/db.ts:updateMeal()` → `correctMealEvent()`**
    - Reads the current projection, merges fields, and appends a correction containing the synthetic one-provider compatibility result. It does not use `commitCalculationCorrection()` and therefore has no calculation fingerprint/audit/canonical-bundle identity.
    - It is still append-only and user-scoped, but it can make a current version appear nutritionally complete when it is only a compatibility correction.

6. **`commit_calculation_bundle` → `commitCalculationBundle()`**
    - This is the strongest path: complete validated bundle input, backend recomputation, raw/provider/canonical atomic persistence, fingerprint idempotency, and no external calls.
    - It is not currently linked to the public create/capture flow by an enforced invariant, so a caller can create an event first and never commit its bundle.

7. **`commit_calculation_correction` is not a public MCP tool on HEAD**
    - The repository correction function exists and is covered directly by integration tests, but the public MCP surface exposes no explicit correction-bundle command. Do not infer that the low-level function is reachable over MCP; either add an explicit public tool in this slice only if Dmitrii approves, or keep it as the internal seam used by a future correction boundary.

### Read paths

- `get_meals_today`, `get_meals_by_date`, `get_meals_by_date_range`, summary/progress/trends/patterns/search/export all consume the compatibility projection in `src/meal-event-projection.ts` and therefore read only current-version event-scope canonical totals.
- `getMealEvent()` is the only existing aggregate read that queries raw provider/canonical rows, but it is not exposed and drops the exact provenance fields required by the brief.
- No public MCP read returns event/version selection, bundle fingerprint, provider source IDs/raw payloads/provenance/basis/units/request fingerprints/algorithm versions/errors plus canonical audit evidence.

### Migrations/docs/tests

- The complete chain in the live integration harnesses is `001_initial_schema.sql` through `005_calculation_corrections.sql`.
- No migration is needed for readback: all required columns already exist in `004`/`005`, and nullable nutrients are already the correct representation for missing values.
- `README.md` and `docs/food-tracking-agent-driven.md` document provider bundles and nullable/missing semantics, but do not document a public readback tool or the fact that legacy compatibility writes are pending/incomplete rather than three-provider-ready.
- Focused baseline run without `DATABASE_URL_TEST`: 14 unit tests passed, 12 PostgreSQL/MCP tests skipped, 0 failed. This is not database evidence; the plan requires rerunning with a real disposable `DATABASE_URL_TEST`.

## 2. Architecture stance and invariant

### Authoritative invariant

For every active event version:

1. The persisted event version has exactly one explicit provenance state derived from its stored provider rows and canonical row:
    - `ready`: a complete calculation bundle was accepted through the bundle contract and canonical evidence is persisted;
    - `pending`: the event is a legacy/compatibility or incomplete provider submission; provider rows and/or canonical row may be incomplete, but the state is explicit and readable;
    - `unavailable`: the bundle evidence is present but no usable provider consensus exists, with failed/unavailable rows and errors retained.
2. A response may never present `pending`/`unavailable` nutrition as a numeric zero or claim it is `ready`.
3. A `ready` response is allowed only when provider result rows, their raw/provenance fields, the version fingerprint, and the event-scope canonical row are all present and internally consistent. Canonical values are always recomputed by the backend, never copied from `canonical_proposal`.
4. Missing nutrient values remain JSON `null`/SQL `NULL`; zero is a real stored value only when a provider explicitly supplied zero.
5. Corrections append an immutable version and re-evaluate this invariant for the new version; prior provider/canonical rows never change.

### Narrowest enforcement point

Add one shared server-side provenance/readiness derivation and apply it at the common version persistence/readback boundary, not in MCP handlers:

- `createMealEvent()` / `insertVersionChildren()` must persist an explicit pending/unavailable canonical state for incomplete compatibility/provider input and return/read it as such; it must not silently manufacture a complete bundle.
- `commitCalculationBundle()` remains the only path that can mark a version `ready` because it validates the full `CalculationBundleInput`, fingerprints it, recomputes consensus, and atomically persists all bundle fields.
- `commitCalculationCorrection()` must retain the same rule for corrected versions.
- Legacy `correctMealEvent()` must either be routed through the same derived pending compatibility policy or be forbidden from claiming ready; it must not bypass the shared readiness/readback semantics.

Recommended bounded policy: preserve compatibility writes, but label them `pending`/`compatibility` and expose nullable nutrition. Do not make `log_meal` or `bulk_import_meals` pretend to have `nutrition-local`/MFP/own independent calculations. The stricter alternative—rejecting all non-bundle create/capture writes—is a product decision, not something coder-kimi should invent.

## 3. Public MCP contract to add/clarify

### New read tool (recommended): `get_calculation_provenance`

Register in `src/mcp.ts` with a strict input schema:

```ts
{
  event_id: z.string().uuid(),
  version: z.number().int().min(1).optional(),
}
```

The server supplies the authenticated/configured `userId`; callers never supply a user ID. Default `version` is `meal_events.current_version`. An explicit historical version is allowed for audit, but must belong to the same user and event. Deleted events should not be returned by the normal public read (return the same not-found/hidden result as cross-user access unless Dmitrii explicitly chooses an audit-only deleted read).

Structured output should include:

```ts
{
  event_id: string,
  version: number,
  current_version: number,
  is_current: boolean,
  provenance_status: "ready" | "pending" | "unavailable" | "missing",
  compatibility: boolean,
  bundle_fingerprint: string | null,
  providers: Array<{
    id: string,
    ordinal: number | null,
    provider: "nutrition-local" | "own" | "myfitnesspal",
    status: "succeeded" | "failed" | "unavailable",
    source_id: string | null,
    request_fingerprint: string,
    algorithm_version: string,
    raw_payload: Record<string, unknown>,
    provenance: Record<string, unknown>,
    nutrients: Record< NutrientField, number | null >,
    basis: "per_item" | "per_meal" | "per_100g" | "serving" | null,
    units: "g_and_kcal" | null,
    error_code: string | null,
    error_message: string | null,
  }>,
  canonical: {
    status: "pending" | "ready" | "low_confidence",
    consensus_status: "two_agree_one_outlier" | "all_agree" | "no_consensus" | "insufficient_data",
    nutrients: Record< NutrientField, number | null >,
    eligible_providers: string[],
    outlier_providers: string[],
    threshold_percent: number,
    policy_version: string,
    source_result_ids: string[],
    audit_evidence: Record<string, unknown>,
    algorithm_version: string | null,
  } | null,
}
```

`provenance_status: "missing"` is for an event/version with neither provider rows nor canonical evidence (including legacy rows created before bundle persistence); it is not a reason to synthesize empty provider objects. `canonical: null` is allowed only for genuinely absent legacy evidence. For a persisted `insufficient_data` canonical row, return that row and `provenance_status: "unavailable"` or `"pending"` according to the approved policy; do not collapse it to missing.

Text output should be concise and model-readable: identify event/version/status, say whether the version is current, list each provider status/source/error, show canonical policy/consensus and nullable nutrients, and explicitly say “missing/pending/unavailable — no provider result was fabricated” where applicable.

Errors:

- malformed event/version: MCP input validation error (`isError: true`); no DB write/read;
- unknown, deleted, or cross-user event/version: stable not-found/hidden domain error (`isError: true`), with no leakage of existence or provider data;
- valid owned event with missing bundle: successful read (`isError: false`) with `provenance_status: "missing"` and an explicit remediation hint, not an exception and not invented data;
- DB failure: normal tool error (`isError: true`) with no partial response.

Also extend `log_meal_event`, `confirm_meal_capture`, and `commit_calculation_bundle` outputs/descriptions so a successful write response includes the same `provenance_status`, `bundle_fingerprint` (when present), and canonical nullable values—or clearly says that the create is pending and requires a subsequent bundle commit. A meal row existing must not be the only success signal.

## 4. Legacy and correction decisions

- **No flat meal restoration:** no `meals` table/view/compatibility table, no backfill of fabricated provider rows, and no provider calls.
- Existing events without bundle rows must be read as `missing`, with a follow-on correction/backfill command that requires Hermes to submit real evidence. The correction may persist a new version through `commitCalculationCorrection()` only when the caller supplies a valid bundle; it must never infer raw payload/source IDs from canonical totals.
- Existing compatibility events with the current synthetic `own` result should be reported as `pending`/`compatibility`, not as a complete three-provider result. Their stored single result is historical evidence of the legacy command, not evidence that the other providers were called.
- The legacy correction adapter (`update_meal`) should remain append-only and user-scoped. Recommended near-term behavior is to keep it explicitly compatibility/pending; do not expand this slice into a full legacy-to-bundle provider workflow. If Dmitrii wants every correction to require a complete bundle, retire/change `update_meal` or make its public contract accept a bundle; coder-kimi must not silently choose that breaking behavior.
- `current_version` is the default read. Historical version is opt-in, immutable, and must be user-scoped. A correction advances the root only after the entire new version/provider/canonical write commits.
- Idempotent create remains `(user_id, idempotency_key)`. Bundle commit remains `(event_id, version, fingerprint)` with same fingerprint deduplicated and conflicting fingerprint rejected without mutation. Correction retry first looks up the persisted correction idempotency key and compares all identity fields before returning deduplicated; a same-key changed payload is rejected.
- Failed/unavailable providers remain rows with raw payload and error code/message; they are never converted to zero and do not authorize an external write. Explicit add/correction authorization still creates only a `pending` sync journal entry; provider availability and journal pending are not delivery success.

## 5. Migration decision

**Recommended: no new migration.** `004`/`005` already contain every persistence column required for the readback contract. Add no denormalized `provenance_status` column in this bounded slice; derive it from the authoritative version fingerprint, provider rows, and canonical row in one repository helper. This avoids a second status source and avoids rewriting historical data.

The implementer must still add migration-chain regression assertions:

- fresh `001 → 005` contains all required columns/indexes;
- rerunning `005` is safe;
- old event rows with no bundle remain readable as `missing`;
- `004`'s `source_id` compatibility backfill is reported as stored legacy metadata only, not as reconstructed provider provenance.

A forward migration is justified only if review proves a required public contract cannot be derived without a new immutable audit field. If so, stop and return a revised plan before coding; do not edit `001`–`005` in place.

## 6. Exact file/function targets

### Production targets

- `src/meal-events.ts`
    - Extend `MealEventAggregate` provider/canonical types with all persisted provenance fields.
    - Update `insertVersionChildren()` and the shared provenance derivation so incomplete compatibility/provider writes are explicit pending/unavailable, not ready.
    - Update `getMealEvent()` to preserve SQL `NULL`, return raw payload/provenance/source/basis/units, canonical source IDs/audit evidence/algorithm version, and support a user-scoped read seam (or add a separate user-scoped provenance repository function rather than exposing the current unscoped helper).
- `src/calculation-bundles.ts`
    - Reuse the shared read/derivation helper; ensure commit and correction results expose the same provenance status/readback shape.
    - Keep backend `computeConsensus`, fingerprint/idempotency, immutable correction, and pending journal semantics unchanged.
- `src/db.ts`
    - Mark `compatibilityCommand()`'s generated provider result as explicitly legacy compatibility/pending through the agreed domain seam; do not add fake nutrition-local/MFP rows.
    - Ensure `updateMeal()` correction continues to be user-scoped/append-only and cannot claim bundle-ready status.
- `src/meal-captures.ts`
    - Keep the single transaction/row lock and explicit confirmation. Pass the draft through the common provenance policy; define whether a missing bundle is accepted as pending or rejected based on Dmitrii's decision.
- `src/mcp.ts`
    - Add strict public `get_calculation_provenance` schema/handler and output schema.
    - Add provenance status/readback fields to public create/confirm/commit responses and tool descriptions.
    - Ensure legacy progress/list formatters do not render `NULL` nutrient values as numeric zero when the meal is pending/missing/unavailable; retain real provider-supplied zero.
- `src/meal-event-projection.ts`
    - Preserve nullable canonical values and, if required by the approved public contract, carry a small provenance-status marker into compatibility `Meal` projections without duplicating provider SQL in MCP handlers.

### Tests to add/modify

- `src/calculation-bundles.test.ts`: public MCP schema/output tests for the new read tool, unknown/cross-user event behavior, historical/current version selection, and strict nested bundle readback shape.
- `src/calculation-bundles.integration.test.ts`: real PostgreSQL readback of every provider field/raw payload/provenance/basis/units/error, canonical audit/source IDs/fingerprint, `NULL` versus explicit zero, missing legacy event, current-version default, historical immutable version, same-key idempotency/conflicting fingerprint, correction preservation, and rollback.
- `src/mcp-food-tracking.test.ts`: real MCP `tools/list`/`tools/call` tests for `log_meal_event`, `confirm_meal_capture`, `commit_calculation_bundle`, and `get_calculation_provenance`; seed two users and prove cross-user read/mutation rejection.
- `src/legacy-meal-tools.integration.test.ts`: compatibility `log_meal`/bulk import/update tests must assert `pending`/compatibility status and nullable nutrition rather than fabricated ready/zero output; assert prior versions remain unchanged after update.
- `src/meal-events.test.ts` and/or a new focused repository test: RED tests for empty provider results, failed/unavailable rows, explicit zero, missing canonical, and legacy status derivation.
- `src/food-tracking-docs.test.ts`: update migration/tool-description assertions if the tool list or documented migration/readback contract changes.

### Docs

- `README.md` and `docs/food-tracking-agent-driven.md`: document the new read tool, current/historical version semantics, pending/missing/unavailable distinction, legacy compatibility status, nullable nutrition, and the strict Hermes/provider boundary. Do not document provider workers or flat-meal restoration.

## 7. TDD-first bounded slice order

### Slice 1 — RED: readiness and null/zero contract

1. Add pure tests showing explicit provider nutrient `0` remains `0`, missing nutrient remains `null`, and empty/failed/unavailable provider input cannot produce a `ready` status.
2. Add a failing legacy MCP regression showing `log_meal` with omitted nutrients must not return/display `Calories: 0` as if calculated; it must return pending/missing and nullable values.
3. Add a failing create/capture test for an empty `provider_results` path: either the approved policy rejects it before event creation or returns explicit pending state. No silent ready response.
4. Implement only the shared derivation/output changes needed to turn these tests green.

### Slice 2 — RED: repository provenance readback

1. Add a repository test for `getMealEventProvenance(pool, userId, eventId, version?)` (name may follow existing conventions) proving all required columns round-trip from PostgreSQL.
2. Add missing/legacy, current-version default, historical-version, deleted, and cross-user red tests.
3. Implement the user-scoped repository read and extend aggregate types; keep SQL out of MCP handlers.

### Slice 3 — RED: real MCP public readback

1. Through `InMemoryTransport`, assert `tools/list` contains `get_calculation_provenance` with strict UUID/version schema.
2. Call it after a real PostgreSQL bundle commit and assert provider raw/provenance/source/error fields, canonical audit evidence, fingerprint, and nullable nutrients are present.
3. Call it for a missing legacy event and assert successful explicit `missing` status with no fabricated provider results; call as another user and assert `isError: true` with no data leakage.
4. Implement the handler/output schema and stable error semantics.

### Slice 4 — RED: public writes cannot overclaim

1. Add real MCP tests for `log_meal_event` and `confirm_meal_capture` with no bundle, incomplete providers, failed/unavailable providers, and a complete bundle flow.
2. Assert every successful response says pending/unavailable until the bundle/canonical evidence is present; assert complete `commit_calculation_bundle` returns ready and backend-derived canonical values rather than the caller proposal.
3. Add compatibility `update_meal` tests proving correction remains append-only and pending/compatibility, while a real bundle correction remains immutable and auditable.
4. Implement the smallest common enforcement/response change; do not redesign capture or add provider calls.

### Slice 5 — migration/docs and full regression

1. Add fresh/rerun `001 → 005` assertions and missing-legacy fixture coverage.
2. Update README/tool descriptions/docs to match the actual contract.
3. Run targeted DB/MCP suites, then full suite/typecheck/format/diff gates.

## 8. Acceptance criteria

- No MCP meal write reports a nutrition-ready result when provider bundle/canonical evidence is absent; it either fails closed per the approved strict policy or returns explicit pending/missing/unavailable status.
- No missing nutrient is rendered or serialized as zero. An explicit stored zero remains zero.
- A complete bundle persists and reads back all three prepared provider calculations when supplied, including provider, scope, source ID, status, raw payload, provenance, nutrients, basis, units, request fingerprint, algorithm version, and errors.
- Canonical values are backend-recomputed; a caller proposal such as `9999` never becomes canonical.
- `get_calculation_provenance` is discoverable and callable through real MCP transport, user-scoped, current-version by default, and supports immutable historical reads.
- Missing/legacy event versions return an explicit `missing`/compatibility state and no invented provider result or canonical value.
- Failed/unavailable provider rows and error evidence survive round-trip and are not treated as zero or external success.
- Same bundle retry is deduplicated; changed fingerprint/content is rejected without mutation.
- Corrections append exactly `current_version + 1`, preserve all prior rows, enforce user scope, compare same-key identity before deduplication, and preserve explicit external-write authorization as pending journal state only.
- `confirm_meal_capture` remains one transaction with the capture lock and event creation; no Telegram/STT/OCR/vision/provider worker is introduced.
- No flat `meals` table/view/compatibility table is restored, and no historical provider data is fabricated.
- Full migration chain and rerun behavior are tested; no new migration is added unless a documented contract gap proves it necessary.
- Real PostgreSQL and real MCP evidence is reported only when `DATABASE_URL_TEST` is explicitly set; skipped DB tests do not count.

## 9. Executable verification commands

Run from `/Users/fishhead/.workspace/projects/nutrition-mcp` with a real disposable PostgreSQL URL. Do not replace the DSN in the executed command with a redacted placeholder.

```bash
# Focused unit/schema tests (no DB claim)
bun test src/nutrition-bundle.test.ts src/calculation-bundles.test.ts src/meal-events.test.ts --max-concurrency 1

# Focused real PostgreSQL + real MCP tests; DATABASE_URL_TEST must be a real scratch DB.
DATABASE_URL_TEST="$REAL_SCRATCH_POSTGRES_URL" \
DATABASE_URL="$REAL_SCRATCH_POSTGRES_URL" \
RUN_LEGACY_MEAL_DB_TESTS=1 \
bun test src/calculation-bundles.integration.test.ts src/mcp-food-tracking.test.ts src/legacy-meal-tools.integration.test.ts --max-concurrency 1

# Full suite against the same disposable test database.
DATABASE_URL_TEST="$REAL_SCRATCH_POSTGRES_URL" \
DATABASE_URL="$REAL_SCRATCH_POSTGRES_URL" \
bun test --max-concurrency 1

bun run typecheck
bunx prettier --check src/meal-events.ts src/calculation-bundles.ts src/db.ts src/meal-captures.ts src/meal-event-projection.ts src/mcp.ts src/nutrition-bundle-types.ts src/*calculation*test.ts src/*food-tracking*.test.ts src/legacy-meal-tools.integration.test.ts
bun run format:check
git diff --check
git status --short
git diff --stat -- .hermes/plans/2026-08-05-calculation-provenance-enforcement-plan.md
```

The coder/reviewer must record exact pass/skip/fail output. If the test database is unavailable, report the blocker; never claim the DB gate passed.

## 10. Risks, open decisions, and follow-ons

### Risks

- Tightening `createMealEvent` globally could break the deliberately compatibility-shaped `log_meal`/bulk-import contract. Keep compatibility status explicit or obtain approval to reject those writes.
- Existing formatters use `?? 0`; fixing this may change user-visible text/widgets and must be covered in MCP contract tests.
- `getMealEvent()` currently has no user predicate; exposing it directly would be an authorization leak. Use a user-scoped repository seam and test cross-user access before registering a tool.
- `004` backfills `source_id` for old rows. Treat that as a storage migration compatibility value, not proof of a historical provider call.
- Destructive DB integration files reset `public`; run them serially and with a disposable DSN matching the required environment gate.

### Approved decisions for coder-kimi

Dmitrii approved the following contract before implementation:

1. **Compatibility policy:** keep `log_meal`, bulk import, and legacy `update_meal` as explicit `pending/compatibility` writes. They may persist a compatibility event, but must not claim a complete three-provider calculation or render fabricated numeric zeroes.
2. **Capture confirmation policy:** `confirm_meal_capture` may commit a pending event. A subsequent full bundle commit moves the version to `ready`; capture confirmation must remain explicit-add-authorized, user-scoped, locked, and transactional.
3. **Public correction surface:** add a public `commit_calculation_correction` MCP tool in this slice. It accepts a complete validated bundle plus correction metadata, appends an immutable version, recomputes canonical values server-side, enforces user scope and correction idempotency, and creates only a pending external-sync journal intent when explicitly authorized.
4. **Deleted-event read policy:** hide deleted events as `not found`, with the same non-leaking behavior for cross-user access.
5. **Pending display policy:** expose `nutrition pending/unavailable` text and nullable structured nutrition. Pending/unavailable is never treated as ready; a real provider-supplied zero remains zero.

The implementation must not broaden these decisions into provider calls, Telegram/STT/OCR/vision work, flat-meal restoration, or fabricated historical bundles.

### Follow-ons (not this slice)

- Hermes-side orchestration that calls `own`, `nutrition-local`, and MyFitnessPal and submits a complete bundle.
- A dedicated bundle commit after capture confirmation if the approved pending flow is retained.
- Honest backfill/correction of existing missing bundles using real evidence supplied by Hermes; never infer or fabricate raw provider results.
- Actual external sync workers and Telegram/STT/OCR/vision remain outside `nutrition-mcp`.
