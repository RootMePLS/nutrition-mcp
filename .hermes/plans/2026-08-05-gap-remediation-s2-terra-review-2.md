# S2 reviewer-terra re-review — acceptance-matrix fixture remediation

Date: 2026-08-05
Reviewer: reviewer-terra
Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
Original S2 handoff/base: `f9d9b7f6adb3fb31127f5896c58e40f799a29c9e`
Reviewed remediation commit: `44921c7167c7ccfd89edee4b8b8d185dada50a64` (`test: extract S2 calculation acceptance fixtures`)
Preserved FAIL review: `.hermes/plans/2026-08-05-gap-remediation-s2-terra-review.md`

## Verdict: PASS — S2 acceptance-matrix remediation accepted

The remediation satisfies the sole prior blocking criterion without weakening or removing any S2 acceptance coverage. The previously 748-line acceptance suite is now 563 lines after Prettier, below the Slice S2 `~600`-line refactor threshold. Its 205-line extracted module is explicitly labelled as S2 test-only acceptance fixtures and is imported only by `src/calculation-acceptance.integration.test.ts`; no production module imports it.

## Independent scope and integrity evidence

- The preserved FAIL review SHA-256 is exactly `26f5dddcc5b243997078244495b0fcf83242f06772f5130c0cded79d6afc991c`, byte-identical to the required value.
- `git diff --name-status f9d9b7f..44921c7` contains exactly two paths:
  - `A src/calculation-acceptance.fixtures.ts`
  - `M src/calculation-acceptance.integration.test.ts`
- No production `src/*.ts` file, migration, DB-gate file, S3 path, or S3 behavior changed. The remediation range's migration and `scripts/test-db-gate.ts` path queries are empty.
- The fixture module's header states it contains shared S2 acceptance fixtures and that nothing in it is imported by production code. Repository grep finds its sole import in the acceptance integration test.
- Main acceptance-suite line count: base 748; remediation 563. Extracted test fixture module: 205. Combined test-only source: 768 lines.
- The eight required literal names each occur exactly once in both the pre-remediation and remediation acceptance suite. The remediation suite still declares eight `test(...)` cases.
- No assertion line was added, removed, or changed in the acceptance-test diff outside the mechanically moved helper definitions. Static `expect(` count remains 48 in the suite; executed focused runs and the DB gate each report the required 56 `expect()` calls.
- The real test mechanisms remain: two `Promise.all` commit races, real migration `005` file bytes executed against populated PostgreSQL data, deterministic rollback trigger followed by row-count checks, stale-version and cross-user no-write checks, real SQL checks, schema-parsed real MCP transport calls, and failed-provider nutrient `NULL` checks. The remediation suite has zero `sleep`/`setTimeout` occurrences.

## Required independent execution

All focused runs used exactly:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/calculation-acceptance.integration.test.ts
```

| Check | Independent result |
| --- | --- |
| Focused run 1 | 8 pass, 0 fail, 56 `expect()` calls |
| Focused run 2 | 8 pass, 0 fail, 56 `expect()` calls |
| Focused run 3 | 8 pass, 0 fail, 56 `expect()` calls |
| Focused run 4 | 8 pass, 0 fail, 56 `expect()` calls |
| `bun run typecheck` | `src/ typechecks clean` |
| `bun run test:unit` | 448 pass, 103 skip, 0 fail, 551 tests |
| Explicit `bun run test:db` with both URLs above | 97 pass, 0 fail, 0 skip, 97 tests across 8 DB suites; S2 suite: 8 pass, 0 fail, 0 skip, 56 `expect()` calls |
| `bunx prettier --check src/calculation-acceptance.integration.test.ts src/calculation-acceptance.fixtures.ts` | All matched files use Prettier code style |
| `git diff --check f9d9b7f..44921c7` | clean (silent; explicit confirmation emitted) |

## Acceptance checklist

- [x] Preserved FAIL review hash is required byte-identical SHA-256.
- [x] Main S2 suite is below 600 lines after Prettier.
- [x] Extracted fixtures are clearly scoped as test-only and are not used by production.
- [x] All eight exact test names, all test cases, and all runtime assertions remain.
- [x] Genuine race, migration rerun, rollback, SQL, MCP, and `NULL` provenance checks remain.
- [x] No production, migration, gate, or S3 scope changed.
- [x] Four focused PostgreSQL runs and every requested gate pass.

This verdict and the preserved FAIL review are the only review artifacts to commit for acceptance.
