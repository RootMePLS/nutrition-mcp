# Slice 2 migration 008 forward-safe remediation brief

## Finding

Terra reproduced a real upgrade failure: a database at migrations 001–007 containing duplicate version-1 `(user_id, revision_idempotency_key)` rows from the pre-008 race cannot create `uniq_spv_user_create_idem`. Therefore `008` is not forward-safe.

## Required reconciliation policy

Do not delete product roots, versions, aliases, nutrients, or label data. Preserve historical truth.

Before adding the partial unique index, migration 008 must deterministically reconcile every duplicate non-null `(user_id, version=1, revision_idempotency_key)` group:

1. Choose the winner deterministically by oldest version `created_at`, then stable UUID/product ID tie-breaker.
2. Keep the winner's key unchanged, so future same-key retries converge on it.
3. Set only every losing version-1 row's `revision_idempotency_key` to NULL. Its product and all child label facts remain fully readable. Null means it no longer claims the shared retry identity.
4. Write an append-only audit record for every reconciliation: migration/version, user ID, original key, winner product/version, loser product/version, decision/reason, and timestamp. The table/constraints must be idempotent and must not log duplicate audit entries on migration rerun.
5. Create the unique partial index only after reconciliation.

This preserves all accidental duplicate data, makes the retry identity deterministic, and gives operators an audit trail. Do not silently soft-delete or merge nutrition data.

## Tests

Start with a real PostgreSQL upgrade regression:

- apply 001–007;
- insert at least two valid same-user version-1 roots with the same key plus aliases/nutrients, and an independent non-duplicate control;
- apply 008 successfully;
- assert winner is deterministic and retains key, loser product/version/children remain, loser key is NULL, exactly one complete audit row exists, index exists, and fresh subsequent same-key create converges on winner;
- rerun 008 and prove no duplicate audit rows or data loss;
- include a stable timestamp/UUID tie-break test if practical.

Retain existing clean-schema concurrency tests. Update migration chain docs/tests/gates if the reconciliation audit table changes documented schema.

## Scope

Fix migration 008, its real-PG tests, and necessary docs/test-gate truth only. No later release slices or product API behavior beyond safe retry convergence.

## Gates

Real disposable PostgreSQL with matching `DATABASE_URL_TEST`/`DATABASE_URL`, full `bun run test:db`, unit/typecheck/format/diff, commit and push.
