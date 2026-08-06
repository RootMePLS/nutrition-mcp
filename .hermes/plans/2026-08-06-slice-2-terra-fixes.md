# Slice 2 reviewer-terra remediation brief: concurrent product create

## Governing scope

Fix only the Slice 2 idempotency concurrency FAIL in commit `127b733608059773753c3902b2bdbe0c06770fc5`. Do not add later-slice features.

## Confirmed failure

`createSupplementProduct` has an unlocked lookup then inserts a root/version. Terra reproduced two concurrent calls for the same `user_id` and idempotency key:

- same payload: both fulfilled `deduplicated:false`, producing two roots;
- different payload: both fulfilled, producing two roots rather than one root and a stable conflict.

This violates B2/B10. The comment documenting the race must disappear once fixed.

## Required behavior

For first-time product creation with a non-empty idempotency key:

1. Concurrent same-user/same-key/same-semantic-payload calls converge to one root and one version-1 label. One result may be original and the other deduplicated, but both must read back the same product ID.
2. Concurrent same-user/same-key/different-semantic-payload calls yield exactly one committed root. The losing request returns stable `idempotency_conflict`; it must not create a second root or child rows.
3. Different users may reuse the same idempotency key without colliding.
4. Empty/null idempotency key behavior remains explicitly supported and must not be accidentally forced unique.
5. Enforce this at PostgreSQL level with a forward-safe new migration if the already-pushed migration chain needs evolution. Do not edit published 006/007. Use an appropriate partial unique index or a dedicated idempotency table/constraint; prove it works under real concurrent connections.

## Tests and verification

- RED: add an integration test that uses separate PostgreSQL clients and `Promise.all` to demonstrate the original race. Preserve it as named regression coverage.
- GREEN: real PostgreSQL same-payload concurrency, different-payload concurrency, and cross-user same-key cases. Assert roots, versions, aliases and nutrient child counts exactly.
- Add public InMemoryTransport concurrency test if that harness can faithfully execute parallel operations, but direct real PG proof is mandatory.
- Run the full DB gate with real disposable `DATABASE_URL_TEST` equal to `DATABASE_URL`, along with unit/typecheck/format/diff checks.
- Commit, push, and report exact results.
