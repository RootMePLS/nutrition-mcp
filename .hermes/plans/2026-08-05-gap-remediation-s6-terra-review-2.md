# S6 reviewer-terra re-review — FAIL

**Reviewed range:** `2d401219e72be9e99bf415f59f1c0ce1906abc1c..54c7cdae924d47c6a27e66be82f8c22ed55d04fd`

**Governing acceptance:** Slice S6, `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md:466-503`. This re-review also evaluated the immutable first review and its required fixes, plus `.hermes/plans/2026-08-05-gap-remediation-s6-kimi-handoff-2.md`.

**Immutable review SHA-256:** `03807f23362abd67640bbb51f1563560c28bf8409a58d7f4dd8403558806210b` — independently verified byte-identical.

**Verdict:** **FAIL — one bounded contract defect remains.** The runtime lifecycle flows, D7 correction behavior, tests, documentation, formatting, retained additive work, version sweep, and scope controls are otherwise materially successful. Do not revert the retained 13-tool sweep or version `1.23.3` work.

## Blocking finding

### 1. `confirm_meal_capture` has no exported strict schema and is not parsed through an exact exported schema

**Acceptance:** The request requires an audit of **exported strict capture schemas** and all nine lifecycle tools to be invoked through linked `InMemoryTransport`, with runtime `structuredContent` parsed by the **exact exported schemas** and extra-key rejection proven. S6 line 479 likewise requires exact runtime schema tests and `.strict()` rejection.

**Evidence:** `src/mcp.ts:1525-1554` exports:

```ts
export const CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA = {
    capture_id: z.string(),
    // ... fields ...
};
```

This is a raw Zod shape object, not a Zod schema. Unlike the other exported capture contracts it has neither `.parse()` nor its own `.strict()` boundary. The registration at `src/mcp.ts:5309` advertises that raw object.

The purported exact-schema test explicitly synthesizes a different schema at `src/mcp-food-tracking.test.ts:1029-1039`:

```ts
if (tool === "confirm_meal_capture")
    return z.object(CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA).strict();
```

Thus the confirm response does parse and reject extras under a reviewer/test-created wrapper, but **not through the exact exported schema**. The export itself cannot be directly parsed or demonstrated strict. This fails the stated strict exported-schema/exact-schema requirement for one of nine lifecycle tools.

**Required coder-kimi fix (bounded):**

1. In `src/mcp.ts`, replace the raw `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` shape with an exported strict Zod object:

    ```ts
    export const CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA = z
        .object({
            // Preserve the existing confirm fields and validators exactly.
        })
        .strict();
    ```

    Keep `confirm_meal_capture`'s `outputSchema` pointing directly to that exported schema. Do not alter confirm persistence, states, text payload, media handling, migrations, providers, or S7 work.

2. In `src/mcp-food-tracking.test.ts`, make `captureSchemaFor("confirm_meal_capture")` return `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` directly; remove `z.object(...).strict()`. Retain the linked-transport runtime parse and extra-key rejection assertion so it proves the exact exported contract.
3. Add/retain a focused direct strictness assertion for the exported confirm schema if needed, then rerun the full S6 review battery and report the results in a replacement handoff.

## Acceptance audit

| Governing criterion                                                         | Result   | Independent evidence                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Nine lifecycle registrations advertise `outputSchema`                       | PASS     | Linked `InMemoryTransport` `listTools()` test passed: 9/9. `src/mcp.ts` has nine capture registrations with `outputSchema`.                                                                                                                                                                      |
| Nine tools return runtime `structuredContent` through valid lifecycle flows | PASS     | DB-gated linked-transport execution passed: start → append → answer → draft → get → cancel, overdue expire, attach → draft → confirm; 18 `mcp-food-tracking` tests passed.                                                                                                                       |
| Exact **exported strict** schemas parse all nine and reject extra keys      | **FAIL** | Eight contracts satisfy this. Confirm requires the non-exported test wrapper described above.                                                                                                                                                                                                    |
| Shared `captureStateOutput`                                                 | PASS     | `src/mcp.ts:1467-1491` exports strict `CAPTURE_STATE_OUTPUT_SCHEMA` and the shared serializer. Start/append/answer/draft/cancel/expire use it; tests cover null normalization and strictness.                                                                                                    |
| GET null behavior                                                           | PASS     | Runtime valid missing-ID call returns and parses `{ capture: null }`; `GET_MEAL_CAPTURE_OUTPUT_SCHEMA` is strict and nullable.                                                                                                                                                                   |
| Post-mutation readback authorization/state                                  | PASS     | Append/answer/draft mutation handlers read back using the same `userId`; DB transport tests cover valid post-mutation states and existing cross-user mutation tests pass.                                                                                                                        |
| D7 correction schema distinct, strict, required metadata                    | PASS     | `src/calculation-bundles.ts:134-140` defines a `.extend(...).strict()` schema; focused test proves identity inequality, required fields, constraints, and extra-key rejection.                                                                                                                   |
| Fresh/replay correction semantics and conflicting replay metadata           | PASS     | Real linked transport correction test passes: fresh/replay parse actual `prior_version: 1`, `correction_reason: "portion corrected"`, `correction_author: "hermes"`; altered same-key reason returns MCP error and counts do not change (`src/legacy-meal-tools.integration.test.ts:1510-1567`). |
| Duplicate exact title count                                                 | PASS     | `git grep -c '"rejects cross-user capture message, answer, and draft mutations"' src/mcp-food-tracking.test.ts` returned `1`. Renamed title accurately states non-persistence.                                                                                                                   |
| README capture note                                                         | PASS     | `README.md:165` names all nine tools and promises declared `outputSchema` plus `structuredContent` alongside text.                                                                                                                                                                               |
| Retained additive 13-tool/version sweep                                     | PASS     | Commits `a26a058`/`2d40121` are retained; 13-tool DB legacy suite passed (23 tests); `outputSchema` inventory count is 33; package/server/McpServer versions all equal `1.23.3`.                                                                                                                 |
| S6 scope / no migrations/providers/media/S7 changes                         | PASS     | Remediation diff changes only listed S6 code/tests/docs; zero migration files; no provider, media-behavior, or S7 implementation changes.                                                                                                                                                        |

## Verification evidence

All DB commands used both required URLs exactly: `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test` and `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`.

| Gate                                                                                   | Result                                                                        |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `bun run typecheck`                                                                    | PASS — `src/ typechecks clean`                                                |
| `bun test src/mcp.test.ts src/calculation-bundles.test.ts`                             | PASS — 125 pass, 0 fail                                                       |
| Focused linked capture transport (`src/mcp-food-tracking.test.ts --max-concurrency 1`) | PASS — 18 pass, 0 fail; all nine invoked over valid flows                     |
| Full unit gate                                                                         | PASS — 484 pass, 0 fail, 153 skip, 637 tests / 34 files                       |
| Explicit eight-suite DB gate                                                           | PASS — 135 pass, 0 fail, 0 skip: 5 + 41 + 13 + 20 + 18 + 7 + 23 + 8           |
| Prettier on all remediation paths except immutable first review                        | PASS                                                                          |
| `git diff --check`                                                                     | PASS                                                                          |
| Original review SHA-256                                                                | PASS — exact required hash                                                    |
| OutputSchema inventory                                                                 | 33 occurrences in `src/mcp.ts`; capture inventory 9/9 advertised              |
| Version equality                                                                       | PASS — `package.json`, `server.json`, and production `McpServer` are `1.23.3` |
| Remote equality before reviewer artifact                                               | PASS — `HEAD == origin/main == 54c7cdae924d47c6a27e66be82f8c22ed55d04fd`      |

## Delivery state

Per requested FAIL handling, this review is intentionally **uncommitted** and not pushed. Reviewer-terra changed no implementation code. `.hermes/plans/2026-08-05-gap-remediation-s6-terra-review-2.md` is the only reviewer-created working-tree artifact.

**S6 RE-REVIEW COMPLETE — FAIL.**
