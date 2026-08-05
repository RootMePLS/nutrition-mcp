# Terra 9 final acceptance gate — calculation provenance enforcement

**Verdict: PASS.**

Terra 9 re-read the approved implementation plan and Terra 8, inspected the live tree and current feature/test diff, and reran the deterministic acceptance ladder against real PostgreSQL. Terra 8's blocking findings are closed by the current source/tests. No production code or unrelated file was modified by this review.

## Scope and tree evidence

- Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
- HEAD observed: `fdfa2e6` (`test: close acceptance gate gaps for meal event tooling`), with the feature remediation present in the working tree.
- The working tree is intentionally dirty. Existing source/docs/test changes and untracked plan artifacts were preserved; Terra 9 added only this artifact.
- `exports/` is absent after the acceptance runner.

## Commands actually run

1. `DATABASE_URL_TEST=postgres://localhost/nutrition_mcp_test DATABASE_URL=postgres://localhost/nutrition_mcp_test bun run test:acceptance`
   - **PASS**
   - Unit gate: **445 pass, 84 skip, 0 fail, 529 tests across 33 files**. The 84 skips are DB-gated tests intentionally excluded from the unit child; they are not counted as DB evidence.
   - Deterministic DB gate: **82 pass, 0 skip, 0 fail, 82 tests across 7 suites**.
   - Per-suite DB totals: `db.integration` 5, `meal-events` 41, `calculation-bundles.integration` 7, `meal-captures.integration` 4, `mcp-food-tracking` 8, `backup-policy` 7, `legacy-meal-tools.integration` 10.
   - This is real PostgreSQL evidence against `postgres://localhost/nutrition_mcp_test`.
2. `bun run typecheck`
   - **PASS**: `src/ typechecks clean`.
3. Targeted `bunx prettier --check` over the acceptance runner and changed calculation/MCP/legacy/widget files
   - **PASS**: all matched files use Prettier code style.
4. `git diff --check`
   - **PASS**.
5. `bun run format:check`
   - **Non-feature warning only / not a Terra blocker**: repository-wide check exits 1 because 13 `.hermes/plans/*.md` artifacts (the approved plan and prior Terra/legacy plan artifacts) have existing Markdown formatting warnings. No production source, test, runner, or widget file was reported by this command. Those unrelated plan artifacts were not rewritten.

## Acceptance evaluation

### 1. Compatibility contract and durable write seam — PASS

- `src/meal-events.ts` uses the shared persisted write readback for normal create, dedupe/retry, concurrent recovery, and correction paths.
- Compatibility writes remain explicitly compatibility/pending rather than being promoted to a fabricated three-provider-ready result. Legacy rows use explicit compatibility markers and nullable nutrients.
- `src/calculation-bundles.ts` preserves caller-supplied provider source IDs, raw payloads, provenance, basis, units, request fingerprints, algorithm versions, and errors; omitted legacy-compatible provenance is explicitly marked rather than presented as external evidence.
- Backend consensus is recomputed and the caller's `canonical_proposal` is not trusted.

### 2. `readPersistedWriteStatus` no-fallback masking — PASS

- The live implementation reads the persisted version, provider rows, and canonical row on the transaction client and fails when the version or canonical row is absent.
- It no longer masks absent canonical audit fields with `c.source_result_ids ?? []`, `c.audit_evidence ?? {}`, or equivalent fallback objects. Completeness is derived from actual persisted evidence and explicit compatibility/unavailable conditions.
- Unit and DB acceptance tests cover incomplete evidence, unavailable providers, rollback, and durable readback.

### 3. Exact public MCP round-trip and strict structured output — PASS

- `get_calculation_provenance` and `commit_calculation_correction` are discoverable through MCP and use strict nested output schemas.
- The real PostgreSQL + `InMemoryTransport` test in `src/legacy-meal-tools.integration.test.ts` calls the public tools, parses actual `structuredContent`, and checks provider source ID, request fingerprint, algorithm version, basis, units, raw payload, nested provenance, and error fields for every prepared result.
- It also checks canonical source-result IDs, audit evidence, algorithm version, and recomputed calories (caller proposal `9999` does not become canonical).
- Missing legacy evidence returns explicit `missing` with `canonical: null`; no provider object is fabricated.

### 4. Correction authorization, conflict, cross-user, deleted, and count invariants — PASS

The real public MCP test covers and asserts unchanged durable counts/current state on rejection for:

- cross-user bundle commit;
- cross-user correction;
- same-key correction replay deduplication;
- altered correction identity under the same idempotency key;
- deleted-event provenance read;
- deleted-event bundle commit;
- deleted-event correction.

It also verifies correction version `2`, historical version `1` (`is_current: false`), current version `2` (`is_current: true`), and exactly one pending external-sync journal row after authorized correction. Repository integration tests additionally cover immutable prior rows, append-only versioning, rollback, bundle conflict, and exact same-key idempotency.

### 5. NULL versus explicit zero and trends widget — PASS

- Legacy PostgreSQL/MCP coverage proves pending canonical nutrients remain SQL/JSON `NULL` through date reads, summaries, progress/trends payloads, and CSV export; pending events do not render fabricated `Calories: 0`/`Protein: 0` lines.
- `trendsDayPayloadOf` preserves the distinction at the public daily-series boundary: uncovered fiber/sugar/alcohol are `null`, while an explicitly recorded `0` remains `0`.
- `public/widgets/src/templates/trends.html` averages only non-null values and returns `null` when a metric has no covered days; the widget regression test verifies the emitted assembled code does not use the old `sum += d[key] || 0` collapse.
- Existing numeric `?? 0` uses are limited to valid sum/display-gating semantics and are not used to serialize the trends covered-day signal as zero.

### 6. Deterministic acceptance runner — PASS

- `scripts/test-db-gate.ts` enumerates all seven required DB suites, requires matching `DATABASE_URL`/`DATABASE_URL_TEST`, resets the complete `001`–`005` migration chain before every child, awaits suites sequentially, rejects zero-test/hidden-skip suites, and cleans `exports/` in `finally`.
- The observed run completed all 82 DB tests with zero skips/failures.

## Non-blocking caveats

- The repository remains intentionally dirty with pre-existing unrelated source/docs/test changes and many plan artifacts; Terra 9 did not clean, reset, or rewrite them.
- `bun run format:check` remains red only because of the pre-existing Markdown formatting warnings in plan artifacts listed above. Targeted formatting for the feature/runner files is green.
- The unit gate's 84 DB-gated skips are expected and separately closed by the real deterministic DB gate; they must not be read as missing acceptance evidence.

**Final decision: PASS.**
