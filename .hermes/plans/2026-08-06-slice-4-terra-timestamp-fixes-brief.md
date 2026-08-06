# Slice 4 Terra remediation brief: strict ISO-8601 timestamps

## Authority

- Immutable initial review: reviewer-terra at `e12ae824cf512317b3a8c937820f34c74627c2b0` returned **FAIL** with one HIGH finding.
- Governing acceptance remains unchanged: `.hermes/plans/2026-08-06-slice-4-reuse-mutation-brief.md`, especially lock §1 strict runtime validation, and the Slice 4 implementation plan.

## Finding

`reuse_meal_calculation` currently validates `reported_at` and `consumed_at` using only `Date.parse()` in the public MCP schema and service boundary. This accepts parseable but non-ISO strings such as `"August 6, 2026 12:30 UTC"`, contrary to the public contract and plan’s strict ISO-8601 requirement. It was reproduced through real `McpServer` + `Client` + `InMemoryTransport`.

## Required remediation

1. Define/reuse a strict ISO-8601 timestamp validator suitable for the repo’s existing timestamp conventions. It must accept supported canonical ISO inputs, reject non-ISO strings even when `Date.parse()` accepts them, and reject invalid dates/times.
2. Apply it both at the MCP public input boundary and the direct `reuseMealCalculation` service boundary. Do not rely only on Zod; direct callers must fail closed too.
3. Add RED→GREEN tests, including public real-MCP transport tests for parseable non-ISO `reported_at` and `consumed_at`, asserting validation failure and unchanged domain row counts.
4. Preserve correct valid ISO behavior, idempotency, timestamps, output schema, and all Slice 4 scope boundaries.
5. Run focused tests, full unit/DB/typecheck/format/diff gates with the real disposable test DB setup; commit and push. Do not touch unrelated source, migrations, or docs unless required by an actual contract correction.

## Workflow

Planner-fable must inspect current code/test patterns and write the focused plan only to:

`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-06-slice-4-terra-timestamp-fixes-plan.md`

Do not implement code in planning.
