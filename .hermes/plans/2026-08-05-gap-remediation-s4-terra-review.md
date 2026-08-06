# S4 reviewer-terra acceptance review — Honest provenance status on legacy writes

Date: 2026-08-05
Reviewer: reviewer-terra
Scope reviewed: `ef97e1ce2e878cce4d07cb8882a2d35f108026d3..63a0e3ee09aa7eb84bf882922bbbb47ad015963f`
Feature commit: `e2c33f15392acb8e47ec64e96290941497ddf2a5`
Handoff commit: `63a0e3ee09aa7eb84bf882922bbbb47ad015963f`

## Verdict: PASS

S4 satisfies the global and Slice S4 acceptance criteria. The implementation is output/readback plumbing only: it adds no migration/DDL, storage/media/S3 work, consensus change, S3 aggregate change, or S5 symbol. Existing compatibility persistence stays intact; the public disclosures are computed only from the persisted write readback.

## Scope and boundary review

The reviewed range contains exactly two commits:

1. `e2c33f1 feat: disclose provenance status on legacy meal writes`
2. `63a0e3e docs: record S4 TDD evidence`

Changed production paths are confined to `src/meal-events.ts`, `src/db.ts`, `src/import.ts`, and `src/mcp.ts`; the remaining changes are tests and S4 documentation. The helper return-type additions in `src/db.ts` and provenance fields threaded through `src/import.ts` are necessary output-layer adapters, not changed persisted compatibility semantics.

Independent forbidden-path diff check was clean for `db/migrations`, calculation bundles/consensus/types, media/capture paths, widgets, and scripts. No S5 `attach_meal_capture_media` or media-store staging work is present. No migration file changed.

## Semantic review

### One mapping, persisted truth

`src/meal-events.ts:87` defines the sole `writeProvenanceFields` mapping. Both legacy single-write paths consume it through `insertMeal` and `updateMeal` in `src/db.ts`; bulk import receives the same `MealInsertResult.provenance` in `src/import.ts:1245-1257`. There is no per-tool request-derived status mapping.

The statuses are exact and truthful:

- Compatibility (`calculation_bundle_fingerprint == null`) maps to `provenance_status: "compatibility"`, `has_calculation_bundle: false`, current persisted `event_version`, and a note that says values were stored as given without a multi-provider bundle.
- A bundle-backed version is `complete` only when its persisted evidence readback is `ready`; it then reports `has_calculation_bundle: true`.
- A bundle-backed version with `pending`, `unavailable`, or `missing` provenance is disclosed as `pending`, still with `has_calculation_bundle: true`; its note explicitly states that evidence is incomplete/pending and points to `get_calculation_provenance`.

This is correctly based on `readPersistedWriteStatus`, which reads the version fingerprint, event-scope provider evidence, and canonical evidence inside the transaction. It prevents a compatibility write from claiming a complete bundle, and prevents a bundle-backed event with incomplete evidence from claiming complete.

### Current-readback / retries

`createMealEvent`’s idempotent and concurrent-race paths lock/read the event’s `current_version` and call `readPersistedWriteStatus`; `insertMeal` maps that returned record rather than the incoming request. `correctMealEvent` does the same for updates. Therefore an idempotent `log_meal` retry after a calculation correction reports the current complete version, not stale compatibility. Real PostgreSQL/InMemoryTransport coverage passed for that case.

Bulk import receives the current readback from `insertMeal`. Created and deduplicated rows carry the actual event provenance. `resultRow` in `src/import.ts:1043-1081` defaults each of all four provenance fields to explicit `null`; each dry-run, validation-failed, aborted/not-attempted, and insert-failed call site passes no provenance. Serialization emits every field unconditionally, so `undefined` cannot drift into runtime structured content.

### Declared schema versus runtime content

- `MEAL_PROGRESS_OUTPUT_SCHEMA` in `src/mcp.ts:704-731` requires all four fields and is the declared `outputSchema` for both `log_meal` and `update_meal`.
- `BULK_IMPORT_OUTPUT_SCHEMA` in `src/import.ts:206-252` requires the same four fields per result row as nullable fields, matching its no-event semantics.
- `buildMealProgress` spreads the required provenance object into actual `structuredContent`; `serializeImportResult` explicitly serializes every nullable field.

Real MCP tests use `McpServer` + `Client` over `InMemoryTransport`, parse returned `structuredContent` against the declared Zod contracts, and run against PostgreSQL. They cover `log_meal`, `update_meal`, and `bulk_import_meals`; bundle completion is cross-checked through public `get_calculation_provenance` before the retry demonstrates `complete`.

## Durable TDD evidence

The handoff records a relevant RED state: missing `writeProvenanceFields` export caused direct unit imports to fail, while the real legacy MCP assertions failed with `Received: undefined` for absent output fields. This is a behavior-relevant failure, not a contrived assertion.

The final code has direct mapping tests for compatibility, ready/complete, and incomplete/pending; runtime schema tests; import serialization tests; and real PostgreSQL/MCP regressions. The refactor is durable: `writeProvenanceFields` has one production definition and `git grep` found only its two production consumers (`src/db.ts`) feeding the three tools.

## Independent verification run

All commands were run by reviewer-terra at the reviewed HEAD.

- `bun test src/mcp.test.ts src/import.test.ts src/csv.test.ts`
    - PASS: 208 pass, 0 fail, 966 assertions.
- `bun run typecheck`
    - PASS: `src/ typechecks clean`.
- `bun run test:unit`
    - PASS: 479 pass, 109 DB-gated skips, 0 fail, 588 tests.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts`
    - PASS: 16 pass, 0 fail, 279 assertions. This is the real PostgreSQL + InMemoryTransport legacy MCP suite, including all four S4-specific cases.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`
    - PASS: 103 pass, 0 fail, 0 skip across 8 suites.
    - Suite counts: db 5; meal-events 41; calculation-bundles 13; meal-captures 4; mcp-food-tracking 9; backup-policy 7; legacy-meal-tools 16; calculation-acceptance 8.
- `bunx prettier --check README.md docs/food-tracking-agent-driven.md src/csv.test.ts src/db.ts src/import.test.ts src/import.ts src/legacy-meal-tools.integration.test.ts src/mcp.test.ts src/mcp.ts src/meal-events.ts .hermes/plans/2026-08-05-gap-remediation-s4-kimi-handoff.md`
    - PASS: all matched files use Prettier style.
- `git diff --check ef97e1c..63a0e3e`
    - PASS: silent / exit 0.

## Review decision

PASS. No coder-kimi changes requested. The slice is accepted as the S4 gate.
