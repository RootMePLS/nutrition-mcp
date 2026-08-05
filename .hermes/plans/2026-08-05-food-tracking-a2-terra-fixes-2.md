# A2 second Terra remediation

Current commit: 996531801a0ed14b02e5c947cd38554d14d25d0d
Terra remediation review: media provenance and MCP tools are now acceptable, but A2 remains blocked by rollback proof and verification completeness.

Fix only A2:

1. Add a real PostgreSQL failure-injection integration test for `confirmMealCapture`:
    - stage capture + draft + matching media;
    - inject a deterministic failure after event root/version/items/media work but before capture state update, using an explicit repository/transaction seam;
    - assert transaction rollback leaves zero meal_event root/version/items/media rows for the derived event key;
    - assert capture remains `ready_to_confirm`;
    - remove injection and retry confirmation successfully;
    - assert exactly one final event and capture becomes `confirmed`.
2. Ensure the injection seam is test-only injectable dependency, not a production bypass or swallowed error.
3. Add MCP tests with `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test` for discovery and calls of `get_meal_capture`, `cancel_meal_capture`, and `expire_meal_capture`, including user scoping and state semantics.
4. Run explicitly:
    - `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts`
    - full suite with same env;
    - typecheck;
    - changed-file Prettier and diff check.
5. Commit one focused remediation. Do not touch B/provider/Telegram/STT/OCR/vision or plan artifacts.
