# Slice 1 reviewer-terra remediation brief

## Governing scope

Fix only reviewer-terra findings against commit `01cad231ae40b8a47b1d2991f1092257d4cdf7ed` for Release 1 Slice 1. This is a remediation of the already shipped Slice 1 commit. Do not implement any later-slice MCP tools, product repositories/services, search/reuse mutations, regimens/intakes, snack-event linkage, reports, flags, cron, provider calls, or UI.

## Terra verdict

FAIL. Full review record is in the process log for this session. These three findings are mandatory acceptance gaps.

## Finding 1: generic nutrient tuple identity collision

### Problem

`src/supplement-types.ts` currently creates the deduplication identity by direct concatenation of `nutrient_key` and `unit`. It rejects two valid distinct facts such as:

- `{ nutrient_key: "ab", unit: "c" }`
- `{ nutrient_key: "a", unit: "bc" }`

This disagrees with the SQL uniqueness tuple `(product_id, version, nutrient_key, unit)`.

### Required fix

Use a collision-free tuple representation, e.g. a nested map/set or unambiguous safe serialization. Do not rely on a character delimiter that user-supplied fields can contain unless the validator demonstrably excludes it. Preserve valid, distinct key/unit pairs; reject only exact duplicate tuple pairs.

### Tests

Start RED by adding the distinct-pair regression case above and show it fails under the old implementation. Add equivalent adversarial identity cases as appropriate. Then run the focused test file.

## Finding 2: user/lineage relational integrity

### Problem

Migration `006_meal_reuse_and_supplements.sql` currently has duplicate `user_id` and relationship fields without enough database constraints to prevent cross-user or mismatched lineage:

- `meal_event_reuse_sources` does not bind `user_id` to target/source event ownership.
- `meal_event_reuse_provider_sources` does not bind provider-result IDs to the declared target/source event/version pair.
- supplement child/label/intake/link tables can contain duplicate `user_id` or product/version references that do not belong together.

Direct persistence must not be able to create facts the eventual MCP handler would consider cross-user or provenance-invalid.

### Required fix

Harden the additive schema with composite candidate keys/FKs, CHECKs, triggers, or another robust PostgreSQL-native design that enforces ownership and correlation. The chosen approach must work for this existing schema/migration ordering and remain safe when migration 006 is rerun. Do not casually edit old migrations if it makes an already-applied deployment inconsistent. If the already-pushed `006` must be evolved, create a forward-safe `007` migration, update migration chain/docs/tests appropriately, and explain why. Enforce at least:

- reuse lineage user equals both source and target owner;
- reuse provider source IDs correspond to the declared target/source event+version pair;
- every product/version child has a matching same-user product/version;
- intake snapshots and meal links bind product/version data to their actual intake and same user.

### Tests

Add real PostgreSQL adversarial insert tests proving each representative invalid cross-user/mismatched relation is rejected, while valid same-user/correlated rows remain accepted. Preserve the populated 001–005 upgrade and rerun proof. Do not accept only application-level validation.

## Finding 3: README migration truth

### Problem

`README.md` still instructs local operators to apply `001–005`, so a clean setup misses the new tables. `docs/food-tracking-agent-driven.md` already lists 006.

### Required fix

Update the README migration order/commands and any related operator wording to include every actually required migration through the current head. Expand docs tests so this cannot drift again.

## Required gates

- Follow TDD: save a durable RED command/result for each new bug class, then minimal GREEN.
- Run focused unit tests and real PostgreSQL integration tests with a real disposable `DATABASE_URL_TEST` equal to `DATABASE_URL`.
- Run `bun run test:unit`, `bun run test:db`, `bun run typecheck`, `bun run format:check`, and `git diff --check`.
- Commit and push a focused remediation commit.
- Final report: changed files, RED proof, exact pass/fail/skip counts, migration strategy and reason for 006 vs 007, commit SHA, push status, any blocker.
