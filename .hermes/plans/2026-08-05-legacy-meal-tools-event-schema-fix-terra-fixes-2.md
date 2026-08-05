# Terra remediation 2: complete acceptance coverage and deterministic DB gate

## Repository
`/Users/fishhead/.workspace/projects/nutrition-mcp`

## Base
HEAD `f19db930301698ae9ad6b87f09d86f67478d0e80`. Previous Terra findings for update_meal, null notes, append-only correction, and user-scoped correction lock are now PASS. Do not regress them. Preserve unrelated dirty files and historical plan artifacts. No production code changes by the orchestrator.

## Finding A — MEDIUM: deterministic full DB test gate

The full suite with `RUN_LEGACY_MEAL_DB_TESTS=1` and matching `DATABASE_URL`/`DATABASE_URL_TEST` reports 491 pass / 4 fail because destructive DB resets from multiple DB-backed test files interfere with `legacy-meal-tools.integration.test.ts`. Bun `--max-concurrency 1` did not serialize files. Excluding the legacy suite passes 491/491, confirming interference.

Implement a reliable project-supported gate, preferably one of:
- isolate every DB-backed file with a unique disposable test database/schema and explicit DSN, or
- add a test runner script that runs destructive DB suites in separate sequential invocations and then runs the non-destructive suite, with clear documented commands and no false all-green claim.

The final verification must run the complete required DB coverage deterministically and report exact pass/skip/fail. Do not merely set `RUN_LEGACY_MEAL_DB_TESTS=0` to hide failures.

## Finding B — MEDIUM: complete real PostgreSQL/MCP projection edge-case matrix

Extend the real integration fixture and public tool assertions to seed and verify:
- stale version plus current version: reads use only current version;
- deleted event excluded from date reads, summaries, trends/patterns, search, and export;
- item-scope canonical row alongside event-scope canonical row: event-scope total selected once, no double counting;
- pending/missing nullable nutrition remains null and is not fabricated as zero;
- two users with cross-user read/search/export/correction/delete attempts returning no data/no mutation;
- timestamp exactly around configured timezone day boundary, with correct local date/range behavior.

Use the actual public MCP transport for tools, with direct repository setup only for deterministic fixtures. Assert structured output and database state where relevant.

## Finding C — MEDIUM: complete public mutator/export/cleanup acceptance coverage

Extend real PostgreSQL + MCP tests for:
- `bulk_import_meals`: multi-row import, duplicate retry/idempotency, control-total rejection, and expected response;
- `export_meals`: one row per active event, current-version totals after correction, deleted-event exclusion, and no cross-user leakage;
- account cleanup: every event child table and roots removed for requested user, unrelated user event data and unrelated profiles/goals/water/weight/analytics preserved.

Do not weaken assertions or replace real DB paths with mocks.

## Final gate

- Full deterministic DB-enabled test command, with exact counts.
- Full `bun test` or documented split command with all required DB suites included.
- `bun run typecheck`.
- Targeted Prettier on changed files and `git diff --check`; global format failure from unrelated historical plans may remain documented.
- Local MCP SDK smoke for all eight reads plus log/bulk/update/delete/export.
- No production SQL references to deleted `meals`, except intentional migration regression fixture.
- Commit only intended files and push. Report SHA and exact verification evidence.
