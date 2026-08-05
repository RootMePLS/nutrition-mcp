# S6 second remediation handoff — coder-kimi (handoff 3)

**Scope executed:** the single bounded FAIL finding from the immutable
second review `.hermes/plans/2026-08-05-gap-remediation-s6-terra-review-2.md`
(SHA-256 `71bad98ac967d09a7bbd404d05b638b43210216754628ca62456ae4e0523d46d`,
verified byte-identical before and after this remediation; the file is
committed unchanged in the docs commit). Nothing else was touched: no
persistence, migration, capture-behavior, media, provider, version, or S7
changes, and no other accepted S6 contract was modified.

## RED — exact defect demonstrated

The review finding: `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` was exported as a raw
Zod shape object (`src/mcp.ts:1525`), not a Zod schema — it had no `.parse()`
and no `.strict()` boundary of its own, so the confirm contract could only be
parsed through a test-synthesized `z.object(...).strict()` wrapper in
`captureSchemaFor` (`src/mcp-food-tracking.test.ts:1036`).

RED was executed test-first, before any production change:

1. `captureSchemaFor("confirm_meal_capture")` changed to return
   `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` directly (wrapper removed).
2. A focused non-DB describe block
   `"confirm_meal_capture exported output schema (S6)"` was added with two
   direct tests against the export: parse a valid confirm payload, and reject
   an extra key under the export's own `.strict()` boundary.

RED run (exact output):

```
(fail) confirm_meal_capture exported output schema (S6) > parses a valid confirm payload through the exact export
TypeError: CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA.parse is not a function.
    at src/mcp-food-tracking.test.ts:1088:48
 1 pass, 28 skip, 1 fail
```

The failure is exactly the reviewed defect: the exported contract is a raw
shape, so `.parse` is `undefined` on it. (The extra-key test passed trivially
in RED because the same TypeError is a throw; after GREEN it asserts a real
strict-mode rejection.)

## GREEN — minimal bounded fix

1. `src/mcp.ts`: `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` is now an exported
   `z.object({ ... }).strict()`. Every pre-existing field and validator is
   preserved exactly, in the same order: `capture_id: z.string()`,
   `state: z.literal("confirmed")`, `event_id: z.string()`,
   `version: z.number()`, `deduplicated: z.boolean()`,
   `provenance_status: z.enum(["ready", "pending", "unavailable", "missing"])`,
   `compatibility: z.boolean()`, `bundle_fingerprint: z.string().nullable()`,
   and the nullable `canonical` object with the seven nullable nutrient
   numbers. Only the surrounding wrapper changed (raw shape →
   `z.object(...).strict()`). The `confirm_meal_capture` registration
   (`outputSchema: CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA`) already pointed
   directly at the export and was not edited; the handler's text payload and
   `structuredContent` construction are byte-for-byte unchanged, and
   `confirmMealCapture` in `src/meal-captures.ts` is untouched. Two nearby
   comments were reworded to stop describing the export as a raw "shape" —
   comment text only.
2. `src/mcp-food-tracking.test.ts`: `captureSchemaFor` now returns
   `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` directly; the synthesized
   `z.object(...).strict()` wrapper is gone. The linked-transport runtime
   parsing in `parseCaptureStructured` and its extra-key rejection assertion
   are retained unchanged, so the DB-gated lifecycle tests now prove the
   exact exported contract. The two new focused direct tests provide
   non-DB parse/strictness coverage of the export itself.

GREEN run (exact output, both required DB URLs set):

```
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/mcp-food-tracking.test.ts --max-concurrency 1
 20 pass
 0 fail
 212 expect() calls
Ran 20 tests across 1 file. [2.53s]
```

This includes the direct exact-schema evidence:

- `(pass) confirm_meal_capture exported output schema (S6) > parses a valid confirm payload through the exact export`
- `(pass) confirm_meal_capture exported output schema (S6) > rejects extra keys under its own .strict() boundary`
- `(pass) capture lifecycle structured output contracts ... > confirm and attach parse through their exact exported contracts` — runtime `structuredContent` from the real linked `InMemoryTransport` flow now parses through the exported schema itself, and the extra-key rejection fires on that same export.

## Regression battery (all re-run after GREEN)

All DB commands used both required URLs exactly:
`DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test` and
`DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`.

| Gate                                                                   | Result                                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Focused linked capture transport (`src/mcp-food-tracking.test.ts`, DB) | PASS — 20 pass, 0 fail (18 pre-existing lifecycle + 2 new direct export tests); 9/9 inventory                                         |
| `bun test src/mcp.test.ts src/calculation-bundles.test.ts`             | PASS — 125 pass, 0 fail                                                                                                               |
| Duplicate exact title grep                                             | PASS — `git grep -c '"rejects cross-user capture message, answer, and draft mutations"'` = 1                                          |
| `bun run typecheck`                                                    | PASS — `src/ typechecks clean`                                                                                                        |
| Full unit gate (`bun run test:unit`)                                   | PASS — 486 pass, 0 fail, 153 skip, 639 tests / 34 files (484+2 new direct tests)                                                      |
| Explicit 8-suite DB gate (`bun run test:db`, both URLs)                | PASS — 137 pass, 0 fail, 0 skip: 5 + 41 + 13 + 20 + 20 + 7 + 23 + 8                                                                   |
| Correction/replay checks                                               | PASS — within the above: fresh/replay correction with real linked transport parses                                                    |
|                                                                        | `prior_version: 1`, `correction_reason`, `correction_author`; altered same-key replay returns                                         |
|                                                                        | MCP error with unchanged counts (`src/legacy-meal-tools.integration.test.ts`, 23 tests);                                              |
|                                                                        | MCP correction round-trip (`src/calculation-acceptance.integration.test.ts`, 8 tests)                                                 |
| Prettier on remediation files (not the immutable review)               | PASS — `bunx prettier --check src/mcp.ts src/mcp-food-tracking.test.ts .hermes/plans/2026-08-05-gap-remediation-s6-kimi-handoff-3.md` |
| `git diff --check`                                                     | PASS                                                                                                                                  |
| `outputSchema` inventory count                                         | 33 occurrences in `src/mcp.ts` (unchanged); capture inventory 9/9 advertised                                                          |
| Version equality                                                       | PASS — `package.json`, `server.json`, and production `McpServer` all `1.23.3` (unchanged)                                             |
| Immutable review-2 SHA-256                                             | PASS — `71bad98ac967d09a7bbd404d05b638b43210216754628ca62456ae4e0523d46d`, byte-identical                                             |

Note on DB-gate arithmetic: the `src/mcp-food-tracking.test.ts` suite grew
from 18 to 20 tests (the two new direct export tests also run in the DB gate),
so the gate total is 137 pass vs. the review's 135, with the per-suite
breakdown shifting 18 → 20 in that one suite only.

## Scope control

`git diff` for the code/test commit touches exactly two files:
`src/mcp.ts` (the strict export plus two comment rewordings) and
`src/mcp-food-tracking.test.ts` (direct `captureSchemaFor` return plus the
focused direct tests). Zero migration files, zero provider/media-behavior
changes, zero version changes, zero S7 changes. The immutable review file was
never edited.

**S6 SECOND REMEDIATION COMPLETE.**
