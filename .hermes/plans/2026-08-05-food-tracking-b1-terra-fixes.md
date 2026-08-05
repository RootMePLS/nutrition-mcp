# B1 Terra remediation

Repo: /Users/fishhead/.workspace/projects/nutrition-mcp
Rejected commit: 24d56e810e1b2434c3bb85f0a2f0f025718a2376

## Findings to fix

1. Migration 004 adds `meal_event_nutrition_results.source_id NOT NULL`, but the existing production INSERT in `src/meal-events.ts` does not provide it. Fix the existing persistence path and add a regression integration test that creates a normal meal event after migrations 001-004.
2. Wire the new CalculationBundleInput into a real backend persistence/recompute seam. The backend must validate the bundle, recompute canonical consensus from provider rows using the existing consensus implementation, and ignore/reject any caller-proposed canonical result rather than trusting it.
3. Persist all provider rows with source_id, raw payload, provenance/status/error/fingerprint and the recomputed canonical result atomically in the event/version tables or an explicit bundle repository. Preserve existing `createMealEvent` and `log_meal_event` behavior.
4. Define idempotency for repeated bundle commit using content-derived bundle fingerprint and event/version identity. Same input retries must converge; tampered fingerprint/content must reject.
5. Add a real MCP tool only if needed for the agent-facing seam, with honest schema and no provider/network callers. Transport remains external to the repo.
6. Add PostgreSQL integration tests with `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test` covering:
    - migrations 001-004;
    - normal meal event regression after 004;
    - bundle commit with own/nutrition-local/myfitnesspal rows;
    - backend recomputation overriding a forged canonical proposal;
    - raw/provenance persistence;
    - idempotent retry and tamper rejection;
    - transaction rollback with no partial bundle rows.

Run focused B1 DB tests, full suite with the explicit DATABASE_URL_TEST, typecheck, changed-file formatting, and diff check. Commit one focused remediation. Do not implement B2 corrections, external provider callers, Telegram/STT/OCR/vision, or edit plan artifacts.
