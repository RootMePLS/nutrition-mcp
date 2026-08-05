# Terra acceptance-gate review 4 — calculation provenance enforcement

**Verdict: FAIL (blocking).** The latest working-tree pass improves nullable meal breakdowns, adds a public provenance read tool and correction tool, and makes type/unit checks green. It still does not close the authoritative write-boundary, complete durable-readback, legacy-surface, or real PostgreSQL/MCP acceptance requirements. This review did not modify production code or unrelated files.

## Scope and evidence basis

Reviewed independently against the live working tree:

- approved plan: `.hermes/plans/2026-08-05-calculation-provenance-enforcement-plan.md`
- prior Terra gate: `.hermes/plans/2026-08-05-calculation-provenance-enforcement-terra-review-3.md`
- live source/diff in `src/meal-events.ts`, `src/calculation-bundles.ts`, `src/mcp.ts`, `src/meal-captures.ts`, `src/meal-event-projection.ts`, `src/db.ts`, and relevant tests
- final `git status --short`, typecheck, targeted Prettier, `git diff --check`, focused tests, and full tests

Feature-related dirty files currently include `README.md`, `docs/food-tracking-agent-driven.md`, `src/calculation-bundles.test.ts`, `src/calculation-bundles.ts`, `src/mcp.ts`, `src/meal-events.test.ts`, `src/meal-events.ts`, and `src/meal-types.ts`. Pre-existing/unrelated dirty files remain the two 2026-08-04 Supabase plans, `src/foods.ts`, `src/rate-limit.ts`, and numerous untracked historical plan artifacts. They were preserved.

## Verification results

### Hygiene: PASS

- `bun run typecheck`: **PASS** — `src/ typechecks clean`.
- `bunx prettier --check src/meal-events.ts src/calculation-bundles.ts src/mcp.ts src/meal-events.test.ts src/calculation-bundles.test.ts`: **PASS** — all matched files use Prettier style.
- `git diff --check`: **PASS**.
- Focused command:
  `bun test src/nutrition-bundle.test.ts src/calculation-bundles.test.ts src/meal-events.test.ts --max-concurrency 1`
  returned **30 pass, 35 skip, 0 fail; 65 tests**.
- Full command:
  `bun test --max-concurrency 1`
  returned **444 pass, 83 skip, 0 fail; 527 tests across 33 files**.

These are not sufficient acceptance evidence because the skipped tests include the required database, real MCP, capture, legacy, correction, tombstone, migration, and provenance-readback matrices.

### Database gate: BLOCKED, not PASS

`DATABASE_URL_TEST` is absent. The focused and full runs explicitly skipped DB suites. Examples from the actual output include:

- `src/meal-events.test.ts: repository tests SKIPPED — DATABASE_URL_TEST is not set`;
- `src/calculation-bundles.integration.test.ts: SKIPPED — DATABASE_URL_TEST is not set`;
- `src/mcp-food-tracking.test.ts: SKIPPED — DATABASE_URL_TEST is not set`;
- `src/legacy-meal-tools.integration.test.ts` skipped because matching `DATABASE_URL`/`DATABASE_URL_TEST` plus `RUN_LEGACY_MEAL_DB_TESTS=1` were not supplied;
- `src/meal-captures.integration.test.ts` skipped;
- `src/db.integration.test.ts` skipped;
- `src/backup-policy.test.ts` tombstone tests skipped.

Per the approved plan and acceptance-gate policy, skipped DB tests are not evidence. No real PostgreSQL persistence/readback, two-user scope, deleted-event, correction, migration, capture, legacy projection, or real MCP transport gate can be marked PASS in this environment.

## Blocking substantive findings

### 1. FAIL — provenance is still not authoritative at the common durable write boundary

`src/meal-events.ts:324-481` (`insertVersionChildren`) writes provider rows and canonical rows, but it does not persist or return an authoritative provenance/readiness state. It inserts compatibility-derived metadata (`source_id` as `${provider}:${request_fingerprint}` and a small synthetic provenance object) rather than preserving a complete provider evidence contract. It writes canonical rows without `audit_evidence`, `algorithm_version`, or a calculation fingerprint.

`createMealEvent()` (`src/meal-events.ts:588-620`) returns `deriveWriteProvenance(..., null)`, so all ordinary create writes are necessarily pending even when caller-supplied provider results look complete. That can be an approved compatibility policy only if the persisted/readback contract is common and explicit; here the write seam itself does not establish the state. The deduplicated create paths (`:555-562` and `:664-671`) return hardcoded pending/null data rather than the persisted scoped aggregate.

`confirmMealCapture()` (`src/meal-captures.ts:346-375`) still calls `createMealEvent()` inside its capture transaction and returns only the small capture result. The MCP handler performs a later `getMealEventProvenance()` query (`src/mcp.ts:4693-4716`). This is handler-side readback, not one authoritative write-boundary result, and the DB gate that would prove the locked transaction plus pending status is skipped.

`commitCalculationBundle()` persists the strongest bundle data, but its domain result remains only `{event_id, version, fingerprint, deduplicated, canonical}` (`src/calculation-bundles.ts:26-32`). It does not return the shared provenance/readback shape. `commitCalculationCorrection()` has the same result type (`:349-353`) and independently writes a second provenance/audit construction. The public handlers compensate with a post-commit read (`src/mcp.ts:4763-4774`, `:4843-4853`), but there is no common repository seam returning/enforcing the status for create/capture/bundle/correction/legacy.

`correctMealEvent()` (`src/meal-events.ts:682-779`) also uses the generic child inserter and returns a derived write result, while legacy `update_meal` routes through this compatibility correction path. The approved invariant requires every active version to be explicit and ready only after complete persisted evidence; this remains unclosed.

### 2. FAIL — durable bundle readback is incomplete/internally inconsistent

The bundle commit path does persist provider source IDs, raw payloads, request fingerprints, algorithm versions, basis, units, nutrients, errors, canonical source IDs, audit evidence, and algorithm version (`src/calculation-bundles.ts:275-337`). However:

- provider `provenance` is rebuilt from `{source_id, capture_id}` instead of preserving a caller-supplied provenance object (`:294-297`);
- `readCanonical()` (`:192-224`) does not select/read `audit_evidence`, `algorithm_version`, or `source_result_ids`, so the domain commit result cannot prove complete canonical readback;
- ordinary create/correction child persistence uses the older incomplete metadata shape and lacks the bundle audit fields;
- `getMealEventProvenance()` relies on `getMealEvent()` and `deriveAggregateProvenance()` (`src/meal-events.ts:979-1006`), so ready status is reconstructed from whichever rows happen to exist rather than being enforced by the shared write seam.

The unit test `calculation-bundles.test.ts:55-90` only parses a hand-built correction payload with an empty `provider_results` array; it does not verify persisted rows or strict runtime structuredContent from the correction path.

### 3. FAIL — ready output remains vulnerable to fallback fabrication and is not proven transport-valid

`buildCalculationBundleOutput()` (`src/mcp.ts:117-171`) now uses readback when available, which is an improvement over the previous input-derived path. But both public commit handlers still contain a fallback that fabricates a pending/empty output when the readback is null (`src/mcp.ts:4775-4786` and `:4855-4868`). A successful commit must not silently return an empty provider/canonical result after durable write; it should fail closed on missing readback.

The builder ends with `as unknown as CalculationBundleOutput` (`src/mcp.ts:171`), bypassing runtime validation. The public tests do not call a real PostgreSQL commit through MCP and then parse its returned structured content against the declared schema.

`CALCULATION_PROVENANCE_OUTPUT_SCHEMA` is present and registered (`src/calculation-bundles.ts:130-149`, `src/mcp.ts:4391-4408`), and provider/canonical schemas are strict. That is positive contract scaffolding, but it is not complete acceptance proof: no real persisted provider/canonical round-trip is executed, and the aggregate-to-output conversion is not explicitly parsed before return.

### 4. FAIL — NULL→0 closure is incomplete across legacy surfaces

`mealBreakdown()` and `formatMeal()` now preserve nulls (`src/mcp.ts:498-516`, `:1146-1165`), which closes one important display regression. The broader legacy surface is not closed:

- `sumMeals()` intentionally uses `m.<nutrient> ?? 0` (`src/mcp.ts:373-387`) and totals are numeric zero even when all meal nutrition is missing;
- `rangeAverages()` uses `fiber.avg ?? 0`, `sugar.avg ?? 0`, and `alcohol.avg ?? 0` (`src/mcp.ts:440-448`), conflating “no recorded nutrient” with zero in structured/narrative aggregate outputs;
- `totalsPayloadOf()` emits numeric zero for fiber/sugar and other aggregate totals (`src/mcp.ts:670-680`), and `trendsDayPayloadOf()` is built on that helper (`:692-709`); comments at `:683-691` acknowledge the missing-vs-zero drift rather than fixing it;
- `formatProgress()`/legacy progress paths can still present aggregate zeroes for pending/unavailable events even though `formatMeal()` suppresses null individual lines.

The full output shows the legacy integration suite skipped, including the named test `pending event-scope nutrition retains nulls end to end and never fabricates zeros`. There is no live evidence covering `log_meal`, bulk import, `update_meal`, list/date/range/search/progress/trends/export, and widget payloads with both missing/null and explicit stored zero cases. This criterion therefore remains FAIL, not partial PASS.

### 5. FAIL — current/historical/deleted/user-scope/correction semantics are unverified

The read seam has useful SQL filtering (`src/meal-events.ts:991-1005`: `user_id` and `status='active'`), and bundle commit checks active ownership when `options.user_id` is supplied (`src/calculation-bundles.ts:245-255`). Correction locks an active root and checks `metadata.user_id` (`:369-379`). These are promising static controls.

No real DB/MCP evidence exists for the required matrix because `DATABASE_URL_TEST` is absent:

- current-version default and explicit immutable historical read;
- deleted event hidden exactly like cross-user access, with no provider leakage;
- cross-user read and bundle/correction mutation rejected with unchanged versions/row counts;
- correction appends exactly `current_version + 1`, preserves all prior provider/canonical rows, and updates the root only after complete commit;
- same correction key exact dedupe versus altered identity conflict;
- failed/unavailable provider rows survive with errors and nullable nutrients;
- explicit external authorization creates only a pending journal state;
- capture confirmation remains one locked transaction and pending rather than ready when no bundle exists.

Static source inspection also shows `getMealEvent()` itself remains an unscoped repository function (`src/meal-events.ts`), with scoping supplied by the preceding `getMealEventProvenance()` lookup. This should be proven under concurrent/authorization tests before treating the public boundary as closed.

### 6. FAIL — complete acceptance evidence is absent

The new unit evidence proves only pure derivation/shape/discoverability. The actual required DB and MCP suites are skipped. The full run's **444 pass / 83 skip** summary must not be represented as a complete gate. In particular, no test currently proves a successful public `commit_calculation_bundle` or `commit_calculation_correction` returns all persisted provider fields and canonical audit evidence through real MCP transport after a real PostgreSQL commit.

## Non-blocking positives

- No flat `meals` table/view was restored in this feature diff.
- No provider worker, Telegram/STT/OCR/vision call, or external delivery worker was added.
- `get_calculation_provenance` and `commit_calculation_correction` are discoverable in the unit MCP test.
- The public provenance read is user-ID supplied by the server, not caller input, and uses current version by default in source.
- The latest formatter change preserves `null` for individual meal breakdown nutrients.
- TypeScript, targeted formatting, diff hygiene, focused unit tests, and the full non-DB test run are green.

## Focused coder plan if FAIL

1. **Unify the write seam.** Make one repository helper own persistence plus status/readback derivation. Use it from create, capture confirmation, bundle commit, bundle correction, and legacy compatibility correction. Return the same aggregate/status shape from every path. Preserve compatibility as explicit `pending`/`compatibility`; failed/unavailable evidence is `unavailable`; only a complete persisted bundle can be `ready`.
2. **Preserve authoritative evidence.** For bundle writes, persist the caller's validated `source_id`, raw payload, provenance, basis, units, errors, and all canonical audit/source-result/algorithm fields. Make the canonical read select every required field. Do not synthesize provider source IDs or provenance for compatibility rows beyond explicitly documented legacy metadata.
3. **Fail closed on missing readback.** Remove the successful-commit fallbacks that return empty provider/canonical arrays. Parse the actual output object against the declared strict schema before returning it. Remove `as unknown as CalculationBundleOutput` where it masks missing fields.
4. **Finish strict schemas and outputs.** Keep `get_calculation_provenance` and correction output schemas strict, complete, and identical to their real structuredContent. Add transport tests that call each public write/read tool and validate the returned structured content, including canonical `source_result_ids`, `audit_evidence`, and `algorithm_version`.
5. **Close every NULL display boundary.** Audit and test `sumMeals`, `rangeAverages`, totals/trends payloads, progress text, list/date/range/search/export, bulk import, and update correction. Pending/missing/unavailable must remain nullable or explicitly say pending/unavailable; a persisted provider nutrient of `0` must remain `0`.
6. **Add the real matrix.** With matching disposable `DATABASE_URL_TEST` and `DATABASE_URL`, run migrations and real MCP tests for two users, deleted hidden reads/mutations, current/historical versions, pending/missing/unavailable/zero, complete bundle recomputation against a `9999` proposal, capture transaction/lock behavior, correction append/history/idempotency/conflict, rollback, and pending-only journal authorization. Assert unchanged DB state after rejected operations.
7. **Re-run the complete gate.** Record exact per-suite DB totals, focused/full totals, typecheck, targeted Prettier, `bun run format:check`, `git diff --check`, and final status. Do not approve while `DATABASE_URL_TEST` is absent or DB tests are skipped.

## Final gate decision

**FAIL.** Hygiene is green, but the fourth acceptance gate remains blocked and substantive closure is not demonstrated. The remaining blockers are authoritative durable provenance across every write boundary, complete persisted readback, all legacy NULL semantics, strict runtime output evidence, and real current/historical/deleted/user-scope/correction integration coverage.
