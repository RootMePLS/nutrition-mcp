# B1 second Terra remediation

Current commit: c09677d8a3953c85492f6f51763ec70cce3700cc
Terra verdict: FAIL.

Blocking findings:

1. `src/calculation-bundles.test.ts` has only mocked-client/unit tests. Add a real PostgreSQL integration suite using `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test` that applies migrations 001-004 and calls the production `commitCalculationBundle` seam with a real Pool.
2. Prove on PostgreSQL:
    - provider rows for nutrition-local, own, myfitnesspal persist with source_id, raw_payload, provenance, status/error, basis/units and fingerprint;
    - canonical result is recomputed from supplied provider rows and a forged caller canonical proposal is ignored;
    - same event/version/content fingerprint retry is idempotent and does not duplicate rows;
    - conflicting/tampered content is rejected without mutation;
    - injected failure inside the bundle transaction rolls back provider and canonical rows completely.
3. If the existing calculation-bundle API does not accept event/version identity required for a real event, adapt the production seam honestly, preserving existing createMealEvent/log_meal_event APIs. Do not replace DB tests with mocks.
4. Terra also noted no MCP/runtime bundle tool. Add an additive MCP commit/validate tool only if required to make the agent-facing production seam reachable; if the repository intentionally exposes the seam only to the capture orchestrator, document/test that boundary instead. No provider/network callers.
5. Run focused DB bundle tests and full suite explicitly with `DATABASE_URL_TEST`, typecheck, changed-file formatting, and diff check. Commit one focused remediation. No B2, external providers, Telegram/STT/OCR/vision, or plan edits.
