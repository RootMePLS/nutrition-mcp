# Terra fixes: legacy meal tools event-schema migration

## Repository and reviewed commit
- `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Reviewed commit: `b71aab740914af1b1b9338217beb3357` (pushed origin/main; verify exact SHA in git)
- Do not reset, stash, discard, or overwrite unrelated dirty files and historical plan artifacts.
- Fixes must be implemented by coder-kimi, not the orchestrator.

## Finding 1 — HIGH: update_meal loses root fields and cannot clear notes

Files: `src/db.ts`, `src/meal-events.ts`, public `update_meal` path.

The adapter merges `meal_type` and `logged_at`, but `correctMealEvent()` only persists new version items/inputs/media/provider rows. Root `meal_events.meal_type` and `meal_events.consumed_at` remain unchanged. `fields.notes ?? current.notes` also prevents `notes: null` from clearing notes.

Required fix:
- Preserve root-level correction fields through the append-only correction transaction, or explicitly reject them. Approved behavior is to preserve and apply them.
- Lock and update the root in the same transaction while advancing the version.
- Implement null-aware patch merge so explicit `notes: null` clears current notes.
- Add real PostgreSQL + MCP regression assertions for every supported update field, including meal_type change, logged_at/date movement, and note clearing.
- Prove version 1 remains immutable and current version contains the corrected values.

## Finding 2 — HIGH: missing real acceptance coverage for required public paths

File: `src/legacy-meal-tools.integration.test.ts` and any needed focused test files.

The current real MCP/PostgreSQL test covers log_meal and the eight read/search tools, but not:
- `bulk_import_meals`: event creation, duplicate retries, control totals, multi-row behavior;
- `update_meal`: append-only/version and field semantics;
- `delete_meal`: user-scoped/idempotent soft delete;
- `export_meals`: one row per event, current-version totals, no cross-user leakage;
- account cleanup (`deleteAllUserData`): all event children/roots removed only for requested user, unrelated user data preserved.

Add executable tests through the public MCP transport where applicable, and direct DB cleanup only where the cleanup function is not exposed as MCP. Use at least two users and real PostgreSQL with explicit `DATABASE_URL` and `DATABASE_URL_TEST`.

## Finding 3 — MEDIUM: correction transaction lacks explicit user authorization

File: `src/meal-events.ts` around the correction lock query.

The correction lock uses event ID only. The legacy adapter pre-reads with user scoping, but event ID alone must never be authorization.

Required fix:
- Add `user_id` to the correction command/seam and lock with `WHERE id = $1 AND user_id = $2`, or provide an equivalent transaction-aware user-scoped correction boundary.
- Add cross-user correction regression through the public MCP path or repository boundary. It must reject/no-op without mutation.

## Finding 4 — MEDIUM: projection edge cases lack real PostgreSQL coverage

Extend the real DB/MCP regression fixtures to include:
- stale version plus current version, proving only current is read;
- deleted event excluded from normal reads/aggregates/search/export;
- item-scope canonical plus event-scope canonical, proving event-scope totals are used once;
- nullable/pending nutrition preserved as null and not fabricated as zero;
- two users with cross-user ID attempts rejected/no data;
- timestamp at timezone day boundary.

## Finding 5 — MEDIUM: full test command is unreliable with shared destructive DB

Terra saw full suite with matching DB variables report `491 pass, 1 fail, 0 skip` because concurrent/destructive integration suites reset shared schema/data while the legacy test was running. Fix the harness/test isolation or document and enforce a reliable serial/full integration command. The final gate must produce a reproducible green result, not rely on timing.

## Verification gate

After fixes:
- run focused real PostgreSQL/MCP tests with explicit matching `DATABASE_URL` and `DATABASE_URL_TEST`;
- run full `bun test` with a reliable isolated/serial DB strategy and report exact pass/skip/fail;
- run `bun run typecheck`;
- targeted Prettier check for changed implementation/tests and `git diff --check`;
- run local MCP SDK smoke path for all previously failing reads plus required mutators;
- verify no production SQL references `meals` except intentional migration regression fixture;
- commit only intended implementation/test/harness files, push, and report SHA.

Do not modify unrelated historical plan markdown artifacts solely to satisfy global formatting unless required by the project gate and explicitly recorded.
