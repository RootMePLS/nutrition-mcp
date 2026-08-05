# B1 third Terra remediation

Current implementation: c629727f6ba74e0b042dfab062103f7922100e1d

Remaining Terra blockers:

1. Harden `validateCalculationBundle` fail-closed for untrusted runtime values. Inputs such as `results: [null]`, `results: [{}]`, and `results: [{scope: null}]` must return validation issues, never throw TypeError. Add RED tests for null/primitives/missing scope/provider/status and nested malformed values. Preserve valid bundle semantics and stable issue output.
2. Expose the production `commitCalculationBundle` seam through an honest additive MCP tool, likely `commit_calculation_bundle`, with a complete Zod schema for the transport-neutral bundle input and explicit event/version identity. The tool must call the real transaction-backed commit seam, return the recomputed canonical result, and never call external providers. Add MCP discovery/call tests with a real DB or the existing MCP harness where appropriate, including malformed input rejection and idempotent retry.
3. Preserve A1/A2/B1 behavior, explicit confirmation gate, no B2/provider/Telegram/STT/OCR/vision scope.
4. Run focused validator/MCP/PostgreSQL bundle tests, full suite with DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test, typecheck, changed-file Prettier, and diff check. Commit one focused remediation with exact SHA/results. Do not edit plans.
