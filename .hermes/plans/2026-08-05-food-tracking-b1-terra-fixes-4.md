# B1 fourth Terra remediation

Current commit: 57ae697fb7c5df425cdd46b80d41cde768c178cc

Terra blockers:

1. Focused MCP commit/idempotency test currently fails before handler because its fixture uses `event_id: "00000000-0000-0000-0000-000000000001"`, which is not a valid UUID under the MCP Zod schema. Fix the test fixture to use a valid UUID (or, if the transport contract intentionally accepts opaque IDs, make schema and contract consistent). Keep production schema strict and honest.
2. Harden `validateCalculationBundle` further: malformed `scope` values (null, primitive, missing ordinal, non-integer ordinal, unexpected object shape) must return deterministic validation issues and never throw or be accepted. Add RED tests for scope contents and valid null/item scopes.
3. Run focused unit/MCP tests, explicit DB-backed bundle integration and full suite with `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`, typecheck, changed-file formatting, diff check. Commit one focused remediation. Do not edit plans, add B2/provider callers, or touch Telegram/STT/OCR/vision.
