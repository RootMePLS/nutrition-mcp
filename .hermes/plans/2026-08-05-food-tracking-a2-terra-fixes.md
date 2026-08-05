# A2 Terra remediation

Repo: /Users/fishhead/.workspace/projects/nutrition-mcp
Rejected commit: 8ec23203704345b7c831feca131960205970e7c9

Fix only A2 findings:

## 1. Enforce media provenance at confirmation, critical

- Remove `enforce_media_identity: false` from confirmation path.
- Capture media must be bound to the eventual event_id, version, kind, storage_key, SHA-256, MIME, byte size and provenance.
- When a prepared draft contains media, verify it matches media staged for the same capture and reject unrelated/cross-event/cross-version/cross-kind/SHA records.
- Ensure capture media is actually attached to the created meal event version, not merely stored in `meal_capture_media`.
- Add real PostgreSQL integration tests with draft media, mismatch rejection, and successful binding.

## 2. Expose durable lifecycle via MCP

Add honest additive tools for:

- `get_meal_capture`;
- `cancel_meal_capture`;
- `expire_meal_capture`.

Keep existing tool names and schemas stable. Test tool discovery and calls.

## 3. Rollback proof

Add PostgreSQL failure-injection integration test that forces event creation or capture update to fail after partial work, then verifies:

- no partial meal_event/event version/items/media rows;
- capture state remains pre-confirmation;
- retry can succeed.

Use injected transaction/repository seam, not production-only test hacks.

## 4. Verification

Run with explicitly set:
`DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`

Run A2 integration tests, full suite with that env, typecheck, changed-file formatting, diff check, and MCP schema tests. Commit one focused remediation. Do not touch B bundle, provider callers, Telegram/STT/OCR/vision, or plan artifacts.
