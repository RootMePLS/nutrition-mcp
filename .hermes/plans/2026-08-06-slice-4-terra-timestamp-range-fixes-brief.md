# Slice 4 Terra remediation brief 2: strict timestamp range validation

## Authority

- Initial immutable Slice 4 Terra review at `e12ae82`: FAIL, HIGH, timestamp validation too permissive.
- First remediation at `4063174`: re-review still FAIL, HIGH continuation.
- Governing Slice 4 strict ISO-8601 runtime validation requirement remains unchanged.

## Remaining HIGH finding

The shared `isStrictIsoTimestamp` correctly rejects broad non-ISO formats but still accepts invalid shape-valid timestamp values because the JavaScript parser normalizes them:

- `2026-08-06T24:00:00Z`
- invalid offset ranges such as `2026-08-06T12:00:00+14:01` and `2026-08-06T12:00:00+15:00`

These must fail at both MCP and direct-service boundaries and make zero domain writes.

## Required remediation

1. Harden the shared validator to enforce ISO calendar/time and UTC-offset numeric ranges, including `24:00` rejection, invalid offset-hour/minute rejection, and the maximum legal offset rule.
2. Add RED→GREEN unit cases plus public real-MCP and direct-service integration regressions for the forms above. Tests must assert the candidates are parser-accepted if relevant, yet strict validation rejects them with zero domain row delta.
3. Preserve valid canonical `Z`, valid offsets including legal edge cases, and valid fractional second forms.
4. Run full real PostgreSQL and public transport gates with explicit disposable matching `DATABASE_URL_TEST`/`DATABASE_URL`. Locate or create only the approved disposable DB through project-supported configuration; do not assume `DATABASE_URL` is safe because `.env` lacks `DATABASE_URL_TEST`.
5. Keep scope limited to the strict timestamp remediation. No migrations, docs, Slice 3, or unrelated timestamp paths.

## Output

Planner-fable must inspect the current validator and test conventions, then write the minimal RED→GREEN plan only to:

`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-06-slice-4-terra-timestamp-range-fixes-plan.md`

No production code during planning.
