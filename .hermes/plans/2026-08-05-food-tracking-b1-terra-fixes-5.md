# B1 fifth Terra remediation

Current commit: acb67c084e2471a21ed939b32b73269c1870aeb3

Terra finding:

- MCP `CALCULATION_BUNDLE_INPUT_SCHEMA` defines `scope` with `z.object({ ordinal: ... })` but does not use `.strict()`. Zod strips unknown scope keys before the domain validator sees them. An input such as `{ ordinal: 1, unexpected: true }` must be rejected, not silently normalized.

Required:

1. Add RED MCP test proving commit_calculation_bundle rejects scope objects with unknown keys.
2. Change only the transport schema as needed to enforce exact scope shape, preserving valid `{ ordinal: null }` and non-negative integer item scopes.
3. Run focused MCP/validator tests, explicit DATABASE_URL_TEST integration and full suite, typecheck, changed-file formatting, diff check.
4. Commit one focused fix. No B2/provider/Telegram/STT/OCR/vision or plan edits.
