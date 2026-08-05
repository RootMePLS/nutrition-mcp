# Final campaign Terra remediation: capture MCP user scoping

Terra final campaign gate FAIL on HEAD 7a302b75af7cf856b49da281d80010433895f65d.

Blocking authorization finding:

The MCP-reachable capture mutators `append_meal_capture`, `answer_meal_capture`, and `save_meal_capture` call repository functions without passing the authenticated/configured `userId`. Other capture operations are scoped, but these mutators can potentially mutate a capture by ID across users.

Required:

1. Add RED MCP tests proving a capture started for user A cannot be mutated by user B through each affected tool.
2. Thread `userId` through the MCP handlers and repository APIs, preserving backward-compatible internal call shape only where safe. Enforce ownership before mutation.
3. Verify start/get/cancel/expire/confirm and all mutators have consistent user scoping.
4. Run focused MCP + real PostgreSQL capture integration tests, full suite with explicit `DATABASE_URL_TEST`, typecheck, changed-file formatting, and diff check.
5. Commit one focused remediation. Do not change docs, add external providers, Telegram/STT/OCR/vision, or push.
