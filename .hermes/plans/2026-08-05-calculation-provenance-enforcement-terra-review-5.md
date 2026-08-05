# Terra acceptance-gate review 5 — calculation provenance enforcement

**Verdict: FAIL (blocking).** This is the fifth and final acceptance gate against the live working tree. Terra made no production-code changes. The real disposable PostgreSQL DB gate is green, but end-to-end substantive acceptance is not closed.

## Scope and evidence

Reviewed:

- approved plan: `.hermes/plans/2026-08-05-calculation-provenance-enforcement-plan.md`
- Terra reviews 3 and 4
- live diff and surrounding source/tests in `src/meal-events.ts`, `src/calculation-bundles.ts`, `src/mcp.ts`, `src/mcp-food-tracking.test.ts`, `src/calculation-bundles.test.ts`, `src/meal-events.test.ts`, legacy projection/formatter paths, and migrations
- live working-tree status and changed-file scope

### Verification actually run

- `DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test DATABASE_URL=postgres://localhost/nutrition_mcp_test bun run test:db`
  - **PASS: 81 pass, 0 fail, 0 skip, 81 tests across 7 DB suites.**
  - Suites executed: `db.integration.test.ts` 5, `meal-events.test.ts` 41, `calculation-bundles.integration.test.ts` 7, `meal-captures.integration.test.ts` 4, `mcp-food-tracking.test.ts` 8, `backup-policy.test.ts` 7, `legacy-meal-tools.integration.test.ts` 9.
- `bun run typecheck`: **PASS** (`src/ typechecks clean`).
- targeted Prettier on feature files: **PASS**.
- `git diff --check`: **PASS**.
- Full `DATABASE_URL_TEST=... DATABASE_URL=... RUN_LEGACY_MEAL_DB_TESTS=1 bun test --max-concurrency 1`: **FAIL: 497 pass, 8 fail, 0 skip, 505 tests across 33 files.** The failures are the legacy MCP integration file's shared-reset/order-sensitive cases (stale `m1`/`u1` rows and failed expected current projections), not evidence that the feature is accepted. The dedicated sequential DB gate above is the authoritative green DB-suite result.

## Acceptance findings

### 1. Authoritative provenance/readiness at the durable write boundary — FAIL

`src/meal-events.ts` adds `deriveAggregateProvenance`, but the common durable child seam is still not authoritative:

- `insertVersionChildren()` persists provider rows with `source_id` synthesized as `${provider}:${request_fingerprint}` and `provenance` synthesized as `{ compatibility, provider }`; it does not preserve the supplied provider `source_id`/`provenance` object or persist canonical `audit_evidence`/`algorithm_version`.
- `createMealEvent()` and `correctMealEvent()` always pass `null` for the bundle fingerprint and return a locally derived result. Their dedupe/error-recovery branches hardcode `pending`, null fingerprint, and null canonical rather than reading the persisted scoped aggregate.
- `confirmMealCapture()` still commits through `createMealEvent()` and the MCP handler performs a second read. This is not a common write-boundary result.
- `commitCalculationBundle()` and `commitCalculationCorrection()` use separate SQL/persistence implementations and return the old narrow `CalculationBundleCommitResult`, not the shared authoritative status/readback shape.
- `update_meal` remains on the generic compatibility correction path.

The code does prevent some overclaiming (`ready` requires three event-scope providers and canonical evidence in `deriveAggregateProvenance`), but the status is not owned and returned by one durable seam for create/capture/bundle/correction/legacy as required by the approved invariant.

### 2. Provider raw/provenance/canonical audit round-trip — FAIL

The bundle path persists raw payload, source ID, errors, basis, units, request fingerprint, algorithm version, canonical source-result IDs, audit evidence, and canonical algorithm version. However it does **not** round-trip all supplied provenance:

- `commitCalculationBundle()` stores `provenance` as `{ source_id, capture_id }`, discarding any caller-supplied provider provenance fields.
- `commitCalculationCorrection()` stores `{ source_id, correction_idempotency_key }`, likewise discarding supplied provenance.
- `readCanonical()` omits `source_result_ids`, `audit_evidence`, and `algorithm_version`; therefore the domain commit result cannot itself prove complete canonical readback (the later aggregate query happens to select those fields).
- Ordinary create/legacy correction rows use the older synthetic metadata and lack canonical audit fields.

The DB integration tests prove selected SQL columns, but do not prove the required public readback contract for the full caller-supplied provenance object.

### 3. NULL versus explicit zero across legacy formatter/progress/trends/summary — FAIL

Individual `mealBreakdown()`/`formatMeal()` handling was improved, and unit tests cover nullable trends payloads. The complete legacy path still has numeric fallback/conflation:

- `sumMeals()` uses `?? 0` for all nutrients; this is acceptable only as arithmetic accumulation, but aggregate payloads must preserve whether a nutrient was ever recorded.
- `rangeAverages()` still emits `fiber.avg ?? 0`, `sugar.avg ?? 0`, and `alcohol.avg ?? 0`.
- `totalsPayloadOf()`/`trendsDayPayloadOf()` are still documented and wired through fallback-based aggregate logic; the source comments explicitly acknowledge the remaining drift.
- The full suite's legacy cases did not pass when run as one full process, and no single complete public MCP call matrix validates missing/null and explicit-zero behavior across log, bulk import, update, list/date/range/search/export, progress, summary, and trends under one clean run.

Therefore this gate cannot claim closure merely from the isolated formatter unit tests.

### 4. Strict declared schemas and actual `structuredContent` — FAIL

Positive: strict schemas are declared for `get_calculation_provenance`, `commit_calculation_bundle`, and `commit_calculation_correction`; nested provider/canonical objects are `.strict()`.

Blocking gaps:

- `buildCalculationBundleOutput()` returns `as unknown as CalculationBundleOutput`, bypassing runtime validation.
- Both commit handlers retain a successful-write fallback that fabricates a pending response with empty `provider_results` and `canonical: null` when readback is absent. A successful durable commit must fail closed, not fabricate a substitute.
- `get_calculation_provenance` and commit handlers return payloads without explicitly parsing the actual object through the corresponding output schema.
- The public tests only discover tools/validate malformed input or hand-built schema literals. They do not make a real PostgreSQL commit/correction via MCP and validate the resulting `structuredContent` against the declared strict schemas.

### 5. Persisted user-scoped readback, no fabricated fallback — FAIL

`getMealEventProvenance()` correctly predicates the root on `user_id` and `status='active'`, and the public provenance read uses the authenticated server user. This is a good boundary. The two public commit handlers nevertheless retain the synthetic empty-output fallback described above. The public create/capture response paths also construct a reduced payload from handler-side follow-up reads rather than returning one common write-boundary aggregate. This does not meet the approved no-fabricated-fallback/readback requirement.

### 6. `ready` requires complete event-scope provider/canonical evidence — PARTIAL, overall FAIL

`deriveAggregateProvenance()` now checks exactly three event-scope rows, the three expected provider namespaces, succeeded status, IDs/source/request/algorithm/raw/provenance/basis/units, canonical ready status, three source-result IDs, audit evidence, algorithm version, and fingerprint consistency. This is a substantive improvement.

It is not acceptance-complete because:

- the check is a read-time reconstruction, not authoritative at all durable write boundaries;
- bundle/correction persistence can discard caller provenance before the check;
- ordinary create/correction writes never get a bundle fingerprint and cannot return the same durable status/readback object;
- no real public MCP bundle/correction transport test proves the ready result through the declared schema.

### 7. Current/historical/deleted/cross-user/correction/idempotency/journal semantics — PARTIAL, overall FAIL

The dedicated DB gate passes repository correction/idempotency/journal, capture, tombstone, and legacy suites (81/0/0). Static inspection also confirms active/user predicates for provenance read, bundle commit ownership, and correction ownership. The remaining acceptance gap is public end-to-end calculation-tool coverage:

- no real MCP call in the DB gate commits a calculation bundle and then reads all persisted provider/canonical evidence;
- no real MCP call exercises `commit_calculation_correction` current/historical readback, same-key exact dedupe versus altered identity conflict, or cross-user mutation with unchanged row/version counts;
- no public transport test proves deleted calculation events are hidden for both read and mutation;
- failed/unavailable rows are covered at repository level, but not through the public strict output/readback contract;
- the pending-only journal rule is covered for repository/create paths, not the public calculation correction response contract.

### 8. Scope hygiene — PASS

The feature diff remains within the approved provenance/readback/correction scope. No flat `meals` table/view was restored in production code, and no provider caller, Telegram/STT/OCR/vision pipeline, or transport worker was added. The `meals` references found are migration-regression fixtures only. Unrelated dirty files were preserved:

- `.hermes/plans/2026-08-04-supabase-to-pg-brief.md`
- `.hermes/plans/2026-08-04-supabase-to-pg-plan.md`
- `src/foods.ts`
- `src/rate-limit.ts`
- numerous pre-existing/untracked historical plan artifacts

Feature-related dirty files are `README.md`, `docs/food-tracking-agent-driven.md`, `src/calculation-bundles.test.ts`, `src/calculation-bundles.ts`, `src/mcp-food-tracking.test.ts`, `src/mcp.ts`, `src/meal-events.test.ts`, `src/meal-events.ts`, and `src/meal-types.ts`.

## Exact focused coder plan if FAIL

1. **Unify the durable write seam.** Create one transaction-local child persistence/readback helper that accepts the complete validated provider bundle plus optional compatibility mode, persists provider and canonical audit fields, derives status from the rows it just wrote, and returns the same aggregate/status shape. Use it for `createMealEvent`, capture confirmation, `commitCalculationBundle`, `commitCalculationCorrection`, and legacy compatibility correction. Keep compatibility writes `pending`/`compatibility`; failed/unavailable evidence is `unavailable`; only complete three-provider event-scope evidence can be `ready`.
2. **Preserve evidence exactly.** Store the validated caller `source_id`, complete `raw_payload`, complete `provenance`, basis, units, request fingerprint, algorithm version, errors, canonical `source_result_ids`, `audit_evidence`, and canonical `algorithm_version` in both bundle and correction paths. Extend `readCanonical()` to select and return every canonical audit field. Add a real DB assertion that a sentinel provenance object round-trips byte-for-byte.
3. **Eliminate fake successful-write outputs.** Remove the null-readback fallback objects from both public commit handlers. A commit that cannot perform user-scoped durable readback must return an error. Build output only from the persisted aggregate, and parse the final object with the exact strict output schema before returning `structuredContent`.
4. **Make public schemas honest and tested.** Keep separate explicit schemas for provenance, bundle commit, and correction (no alias that hides contract differences). Add real `InMemoryTransport` + PostgreSQL tests for `get_calculation_provenance`, `commit_calculation_bundle`, and `commit_calculation_correction`; validate actual returned `structuredContent` with the schema, including all nested provider/canonical fields and strict unknown-key rejection.
5. **Close the complete NULL/zero legacy matrix.** Audit every legacy formatter, progress, summary, trends, export, search, list/date/range, bulk-import, and `update_meal` path. Missing/pending/unavailable nutrients must remain null or explicit pending/unavailable text; a stored provider zero must remain zero. Add one clean DB/MCP test that exercises all named surfaces with both cases, including widget payloads.
6. **Add the missing public authorization/history matrix.** Through real MCP transport and a clean disposable DB, cover current default and historical version, deleted hidden reads/mutations, cross-user read/commit/correction rejection with unchanged counts/current version, correction version+1 and immutable prior rows, same-key exact dedupe/conflict, failed/unavailable provider evidence, and explicit-authorization pending journal only.
7. **Fix the full-run harness or document an isolated sequential gate.** The dedicated `test:db` gate is green, but the full env run is 497 pass/8 fail because legacy DB fixtures interfere across files. Make full verification deterministic (isolated/reset DB per destructive suite or an explicitly serialized runner) and rerun full tests, typecheck, targeted Prettier, `git diff --check`, and final status.

## Final gate decision

**FAIL.** The DB gate is genuinely green (81/0/0), but the implementation still fails the substantive end-to-end acceptance contract: the durable write boundary is split and non-authoritative, provider provenance is not faithfully round-tripped, successful public outputs can fabricate fallback data, actual strict `structuredContent` has not been proven for bundle/correction commits, and the full legacy/public calculation-tool matrix is incomplete. No production code was changed by Terra.

Non-blocking positives: the complete DB suite now runs without skips; typecheck/targeted formatting/diff hygiene pass; readiness derivation is materially stricter; user-scoped active-event filtering, tombstone hiding, correction/idempotency/journal repository behavior, and no-flat-meal/no-worker scope constraints are present.
