# Terra remediation: food-tracking bounded slice

## Review verdict

Reviewer-terra returned FAIL. Existing commits 316d89b and 0d68596 contain schema, types, consensus, media foundations, and `src/meal-events.ts`, but the feature is not wired end-to-end.

## Critical gaps to fix

1. **Repository/service verification**
    - Read the actual `src/meal-events.ts` now present. Complete/fix transactional create and correction paths where tests or integration expose gaps.
    - Add integration tests against real PostgreSQL for create event with multiple ordered items, child-row atomicity, idempotent retry, concurrent retry, correction version append, and current-version pointer.
    - Use the existing transaction helper and never mutate historical version/item/input/media/result rows.

2. **Provider results and canonical persistence**
    - Add a transaction-safe repository/service path to persist provider results and canonical consensus for event/version/item scopes.
    - Preserve NULL as unavailable; do not turn missing values into zero.
    - Test all-agree, two-agree/outlier, no-consensus, and low-confidence persistence.

3. **Sync journal orchestration**
    - Add a durable journal writer and state transition service.
    - Explicit add authorization creates a pending journal entry before any injectable external writer call.
    - Add injectable external writer interface/fake only. No real MyFitnessPal network call.
    - Failed external write leaves local event/canonical rows intact and marks journal failed. Retry is idempotent.
    - Add tests.

4. **MCP wiring**
    - Register a new bounded tool, e.g. `log_meal_event`, using the existing MCP patterns and Zod boundary.
    - Tool must create one event with multiple positions, accept raw text/evidence metadata and prepared provider estimates, honor reported/consumed timestamps, idempotency, and explicit add authorization.
    - Tool response must expose event/version/canonical/journal state honestly. Do not claim external sync success in this slice.
    - Add MCP tests for validation, duplicate retry, no-add behavior, and journaled add behavior.

5. **Backup/delete policy contracts**
    - Add `src/backup-policy.ts` and tests for daily retention 30 days, monthly forever, separate postgres/media kinds, ordinary delete preserving backups, and permanent-delete selection of live rows/media/backup manifests.
    - This slice may implement policy and injectable storage/deletion adapters only; do not build unattended scheduler or cloud provider.

6. **Migration verification**
    - Run `src/db.integration.test.ts` with real `DATABASE_URL_TEST` against PostgreSQL. Do not leave these skipped.
    - Verify fresh 001→002, existing legacy meals removal while unrelated data survives, rerun safety, and public_landing_stats.
    - If migration runner/ledger is needed by the current repo contract, add the smallest deterministic runner and tests; otherwise document that SQL is applied by operator and do not claim runtime migrations.

7. **Repository hygiene**
    - Remove embedded NUL bytes from source files `src/meal-types.ts` and `src/media-store.ts` if present, preserving intended string content.
    - Run feature-file format check and `git diff --check`.
    - Do not reformat untouched pre-existing files unless required for touched code.

## Verification gate

- `bun test`: zero failures; integration tests included, not skipped.
- `bun run typecheck` passes.
- `bun run format:check`; if pre-existing failures remain, isolate them and report exact paths.
- `git diff --check` passes.
- Commit all remediation changes with a focused commit and report SHA.
