# Terra remediation 3: close final acceptance gate gaps

## Base

Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
HEAD: `a6e6ab3ff0168cf5017d8edf5ec35e4d674bfd45`
Previous functional findings are PASS. Preserve unrelated dirty files and historical plan artifacts. Implement only through coder-kimi.

## HIGH — acceptance gate omits destructive DB suites

`scripts/test-db-gate.ts` currently runs only four suites. Add all required destructive PostgreSQL suites, sequentially and visibly:

- `src/db.integration.test.ts`
- `src/meal-events.test.ts`
- `src/calculation-bundles.integration.test.ts`
- `src/meal-captures.integration.test.ts`
- `src/mcp-food-tracking.test.ts`
- `src/backup-policy.test.ts` DB portion
- `src/legacy-meal-tools.integration.test.ts`

Do not hide suites by removing DB env vars or setting skips. The gate must fail if any included suite fails. Preserve deterministic isolation/serialization. If analytics persistence in `mcp-food-tracking.test.ts` requires a schema or explicit test stub, fix/isolate it honestly so the gate has no schema-error noise.

## MEDIUM — complete nullable nutrition and timezone boundary acceptance matrix

In real PostgreSQL + MCP tests:

- seed an event with missing/pending event-scope canonical nutrition and assert structured output retains nulls, does not fabricate zero, and aggregation behavior matches the approved contract;
- assert both sides of a timezone day boundary (just before and just after local midnight), not only one exact timestamp;
- retain existing stale/current, deleted, item-vs-event canonical, and cross-user assertions.

## MEDIUM — export after active correction

Add real MCP/PostgreSQL coverage where:

1. an event is created with known totals;
2. `update_meal` creates an active correction with changed totals/root fields;
3. `export_meals` runs before deletion;
4. CSV contains one row for the active event with corrected current-version totals;
5. only after that, delete and assert exclusion.

## LOW — generated export artifact

The review generated an untracked `exports/` directory. Keep generated artifacts out of the commit and ensure the acceptance runner cleans temporary export files or uses a disposable location.

## Verification

- `bun run test:acceptance` must run unit gate then all seven DB suites and report exact pass/fail/skip.
- Full DB gate must be green with explicit matching `DATABASE_URL`/`DATABASE_URL_TEST`.
- `bun run typecheck`, targeted Prettier, `git diff --check`.
- local MCP SDK smoke for reads, log, bulk, update, delete, export.
- no production `meals` SQL except intentional migration fixtures.
- commit only intended files, push, report SHA and exact evidence.
