# Terra 8 final acceptance gate — calculation provenance enforcement

**Verdict: FAIL (blocking).**

The live tree passes the deterministic unit/DB runner and the new public calculation MCP happy-path test, but the final gate is not closed. Blocking source/coverage gaps remain around compatibility provenance synthesis, exact canonical audit round-trip, the complete public correction authorization matrix, and NULL-versus-zero widget behavior.

## Scope and tree evidence

- Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Baseline HEAD observed: `fdfa2e60b9a4f237c4ebdb64aa2fe1d95344a109`
- Full working-tree diff inspected, including production source, tests, `scripts/test-db-gate.ts`, and the public MCP integration test in `src/legacy-meal-tools.integration.test.ts`.
- Production code was not modified by Terra 8.
- Existing unrelated dirty paths were preserved. They include README/docs, prior plan artifacts, and unrelated source/test files in addition to the feature files; see `git status --short --branch` evidence below.
- `exports/` is absent after the runner: PASS.

## Commands actually run and exact results

1. `DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test DATABASE_URL=postgres://localhost/nutrition_mcp_test bun run test:acceptance`
    - **PASS**
    - Unit gate: **444 pass, 84 skip, 0 fail, 528 tests across 33 files**.
    - DB gate: **82 pass, 0 skip, 0 fail, 82 tests across 7 suites**.
    - DB suite counts: `db.integration` 5, `meal-events` 41, `calculation-bundles.integration` 7, `meal-captures` 4, `mcp-food-tracking` 8, `backup-policy` 7, `legacy-meal-tools.integration` 10.
    - The DB output is real PostgreSQL evidence against `postgres://localhost/nutrition_mcp_test`, not invented or inferred evidence.
2. `bun run typecheck`
    - **PASS**: `src/ typechecks clean`.
3. Targeted Prettier check over `scripts/test-db-gate.ts` and changed calculation/MCP/legacy files
    - **PASS**: all matched files use Prettier code style.
4. `git diff --check`
    - **PASS**.
5. Post-run `git status --short --branch`
    - **PASS for preservation/hygiene**: no `exports/` directory; unrelated dirty files were not cleaned or overwritten.

## Acceptance evaluation

### 1. Durable write seam and dedupe readback — PARTIAL, FAIL overall

Positive evidence:

- `src/meal-events.ts:60-153` defines transaction-client `readPersistedWriteStatus()` and fails if the persisted version or canonical row is absent.
- Normal create and correction paths, same-key dedupe paths, and concurrent-create recovery paths call that readback (`src/meal-events.ts:656-665`, `715-725`, `771-781`, `847-857`, `887-897`, `907-918`).
- The real DB gate proves create/correction/idempotency/rollback behavior.

Blocking findings:

- `readPersistedWriteStatus()` still substitutes `c.source_result_ids ?? []`, `c.audit_evidence ?? {}`, and `c.algorithm_version ?? null` (`src/meal-events.ts:108-114`) instead of rejecting absent required audit fields. This can turn incomplete persisted evidence into a synthetic aggregate and then classify it as pending/unavailable rather than failing the durable seam closed.
- `insertVersionChildren()` remains a separate compatibility persistence path (`src/meal-events.ts:409-589`) and synthesizes `LEGACY_COMPATIBILITY_SOURCE_ID`/compatibility provenance and canonical audit metadata. The calculation bundle seam likewise uses `COMPATIBILITY_SOURCE_ID` and `{ compatibility: true }` defaults (`src/calculation-bundles.ts:13`, `289-309`, `473-490`). This is not a synthetic _empty public response_, but it violates the requested exact provenance/audit contract for supplied evidence.

### 2. Exact provider/canonical provenance/audit round-trip — PARTIAL, FAIL overall

Positive evidence:

- Provider rows are durably selected and returned by public readback (`src/meal-events.ts:79-84`, `src/mcp.ts:4456-4472`).
- The public DB/MCP test supplies and checks a nested sentinel provider provenance object (`src/legacy-meal-tools.integration.test.ts:862-899`); the DB gate passes it.
- Canonical source IDs, audit evidence, and algorithm version are selected and exposed (`src/meal-events.ts:87-114`, `src/calculation-bundles.ts:198-231`).

Blocking findings:

- The public test does not assert exact raw payload, source ID, request fingerprint, algorithm version, basis/units, error fields, canonical `source_result_ids`, canonical `audit_evidence`, or canonical `algorithm_version` after the transport round-trip. It only asserts one provider provenance sentinel and recomputed calories.
- The bundle/correction writers construct canonical audit evidence themselves (`src/calculation-bundles.ts:338-343`, `516-525`) and use compatibility provenance defaults when fields are omitted. No exact canonical audit sentinel is supplied and compared byte-for-byte through public `tools/call`.

### 3. No fabricated public fallback — PASS for the old empty fallback, FAIL for contract closure

- Public commit/correction handlers perform user-scoped durable readback and throw when it is absent (`src/mcp.ts:4792-4808`, `4865-4879`). The focused unit test and real public DB test exercise successful readback/failure behavior.
- However, the underlying compatibility defaults and nullable/empty audit substitutions above remain fabricated evidence at the domain seam. The public handler therefore cannot claim the stronger “all successful output is exact durable evidence” guarantee requested by this gate.

### 4. Strict runtime `structuredContent` for provenance/bundle/correction — PASS

- Strict nested Zod schemas are declared in `src/calculation-bundles.ts:47-152`.
- Public tools declare output schemas (`src/mcp.ts:4434`, `4784`, `4840`) and parse actual output before returning it (`src/mcp.ts:4447-4473`, `140-170`, `4805-4808`, `4876-4879`).
- The real PostgreSQL/InMemoryTransport test parses provenance, bundle, and correction `structuredContent` with those schemas (`src/legacy-meal-tools.integration.test.ts:870-932`, `959-984`); DB evidence is green.

### 5. Public authorization/current-history/idempotency/deleted/cross-user/journal matrix — PARTIAL, FAIL overall

Covered by the real public test:

- Initial missing provenance and current read.
- Successful bundle commit with unavailable provider and strict output.
- Same-key bundle dedupe.
- Historical provenance read.
- Cross-user bundle mutation rejection with unchanged calculation counts.
- Confirmed correction with external authorization, `pending` sync output, correction replay dedupe, and exactly one journal row.
- Deleted-event provenance read rejection and deleted-event bundle mutation rejection.

Missing required public assertions:

- Cross-user `commit_calculation_correction` rejection with unchanged counts/current pointer.
- Deleted-event `commit_calculation_correction` rejection with unchanged counts/current pointer.
- Altered correction identity under the same correction idempotency key through public `tools/call` (repository-only coverage exists, but it is not public transport evidence).
- Exact public assertion of the correction history read after version 2, including `current_version`, `is_current: false` for version 1 and `is_current: true` for version 2.
- Public failed-provider output is partially represented by the unavailable provider in the bundle, but a public failed-provider case and its strict error fields are not separately asserted.

### 6. NULL versus explicit zero across legacy surfaces — FAIL

Positive evidence:

- Unit tests cover nullable averages/presence and explicit zero (`src/mcp.test.ts`).
- The real DB legacy test covers a pending/null event through list/date/range/summary/progress/trends/export and passes (`src/legacy-meal-tools.integration.test.ts:607-705`).
- The same file includes an explicit-zero fixture in the pending test and checks summary/progress values.

Blocking gap:

- The required end-to-end public matrix is not complete for widgets. `src/mcp.ts:711-714` explicitly documents that `totalsPayloadOf` uses `?? 0`, making an unrecorded nutrient indistinguishable from a true zero in the trends widget and causing averages to divide by every day instead of covered days. Existing unit/helper tests do not prove the rendered widget structured payload preserves NULL versus explicit zero.
- The source still contains numeric fallback paths in legacy output code (for example `src/mcp.ts:397-408`, `1368`, `1592`). Some are valid sums or display gates, but the final acceptance requirement is an end-to-end public assertion across log, update, import, list/date/range/search/export, summary, progress, trends, and widget payloads for both pending/null and explicit-zero events; that evidence is absent.

### 7. Deterministic acceptance runner — PASS

- `scripts/test-db-gate.ts:23-31` enumerates all seven destructive DB suites.
- It requires matching `DATABASE_URL` and `DATABASE_URL_TEST` (`:6-17`), resets the complete migration chain before each child (`:39-61`, `85-90`), awaits each child sequentially (`:85-110`), rejects zero-test/hidden-skip suites (`:129-133`), and cleans exports in a `finally` block (`:111-113`).
- The actual runner completed with 82/82 DB tests and 0 skips.

### 8. Feature scope and unrelated dirty files — PASS for Terra handling; repository remains intentionally dirty

- Terra did not alter unrelated dirty files.
- The full diff includes feature changes plus pre-existing unrelated docs/plans/source/tests. They were preserved as required; no cleanup or reset was performed.
- The final artifact itself is the only file created by this review.

## Focused coder plan (required because FAIL)

1. **Close the durable seam.** Make persisted canonical audit arrays/object and required algorithm metadata explicit invariants in `readPersistedWriteStatus()`; reject missing required rows/fields rather than applying `?? []`/`?? {}`. Ensure every normal, correction, bundle, capture-confirmation, compatibility, and dedupe/recovery path returns the same authoritative persisted aggregate result.
2. **Remove evidence fabrication for supplied contracts.** Preserve caller-supplied provider source ID, raw payload, provenance, basis, units, request fingerprint, algorithm version, errors, and canonical audit inputs exactly. If legacy compatibility data must be supported, mark it as an explicit compatibility result without pretending it is complete provenance; never overwrite or invent supplied fields.
3. **Strengthen the real public MCP test.** Add byte-for-byte sentinel assertions for every provider field and canonical `source_result_ids`, `audit_evidence`, and `algorithm_version` after `tools/call`. Add public altered-correction-key conflict, cross-user correction, deleted correction, and version-1 historical/version-2 current assertions; verify row counts and current pointer remain unchanged on every rejected mutation.
4. **Close NULL/zero at widget boundary.** Build a real DB/InMemoryTransport fixture with one pending/null event and one explicit-zero event, then assert list/date/range/search/export, summary, progress, trends, and widget `structuredContent` retain null versus 0. Remove or constrain `totalsPayloadOf`/other legacy fallbacks that collapse this distinction; keep valid SUM semantics separate from averages/presence semantics.
5. **Re-run the complete ladder.** Run `bun run test:acceptance` with the real disposable DB, targeted Prettier, typecheck, `git diff --check`, confirm no `exports/` residue, and report all unrelated dirty paths without modifying them.

**Final decision: FAIL.**
