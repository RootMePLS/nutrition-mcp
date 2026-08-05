# S6 reviewer-terra verdict — FAIL

**Reviewed range:** `98fc0b892c7cdaeab969122b3cb6e77511f9f9da..2d401219e72be9e99bf415f59f1c0ce1906abc1c`

**Governing acceptance:** Slice S6, `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md:466-503`. The narrower coder dispatch does not supersede that checklist.

**Verdict:** **FAIL — changes requested.** The 13-tool water/weight/import/widget structured-output sweep is real, additive, and should be retained. It does not satisfy the governing S6 slice because the required capture lifecycle sweep, dedicated correction schema/D7, duplicate test-name fix, and README note are absent. The handoff accurately discloses those omissions.

## Blocking findings

### 1. Capture lifecycle contract is incomplete — 7/9 tools missing

**Acceptance:** S6 lines 468, 476, 479, and reviewer checklist line 498 require all nine capture lifecycle tools to declare `outputSchema` and return `structuredContent`, proven by real `InMemoryTransport` calls that parse the exact exported schemas and reject extra keys.

**Evidence:** A real `McpServer` + `registerTools` + linked `InMemoryTransport` `client.listTools()` inventory reported:

```
start_meal_capture                 registered=true  outputSchema=false
append_meal_capture_message        registered=true  outputSchema=false
answer_meal_capture                registered=true  outputSchema=false
save_meal_capture_draft            registered=true  outputSchema=false
get_meal_capture                   registered=true  outputSchema=false
cancel_meal_capture                registered=true  outputSchema=false
expire_meal_capture                registered=true  outputSchema=false
confirm_meal_capture               registered=true  outputSchema=true
attach_meal_capture_media          registered=true  outputSchema=true
capture-outputSchema-count=2/9
```

`src/mcp.ts:4894-5069` confirms the seven missing registrations have neither `outputSchema` nor `structuredContent`; they either serialize a capture into text only or return text-only acknowledgements. `confirm_meal_capture` and `attach_meal_capture_media` are the only two advertised contracts.

The existing DB-gated capture MCP test ran and passed (`14 pass`), but it does not prove the missing output contracts; it retains the duplicate test title and does not add exact-schema transport parsing for every lifecycle tool.

### 2. D7 correction schema is still an identity alias and cannot carry correction metadata

**Acceptance:** S6 line 477 and checklist line 499 require a distinct, explicit strict `CALCULATION_CORRECTION_OUTPUT_SCHEMA`, extended from the bundle schema with `prior_version`, `correction_reason`, and `correction_author`; the correction handler must populate them end-to-end. A unit identity test must prove it is not the bundle schema.

**Evidence:** `src/calculation-bundles.ts:134-135` remains:

```ts
export const CALCULATION_CORRECTION_OUTPUT_SCHEMA =
    CALCULATION_BUNDLE_OUTPUT_SCHEMA;
```

The direct runtime check returned:

```
identity_equal=true
correction_fields=NONE
```

`src/mcp.ts` continues to build `commit_calculation_correction` output with `buildCalculationBundleOutput(...)`, which returns the bundle contract (`src/mcp.ts:150-195`), so the required fields are not emitted. This is not merely missing test evidence: the production contract is wrong for S6.

### 3. Duplicate cross-user capture test name remains twice

**Acceptance:** S6 line 478 and checklist line 500 require exactly one occurrence of `"rejects cross-user capture message, answer, and draft mutations"`.

**Evidence:**

```text
git grep -c '"rejects cross-user capture message, answer, and draft mutations"' src/mcp-food-tracking.test.ts
2
```

The occurrences are `src/mcp-food-tracking.test.ts:490` and `:601`. The focused MCP DB run prints two passing tests with that identical name. One must be renamed according to its actual scenario.

### 4. README omits the required capture structured-output note

**Acceptance:** S6 line 492 requires the README tool table/documentation to state that all capture tools return structured content.

**Evidence:** `README.md:153-165` documents only `attach_meal_capture_media`'s structured output. It describes the capture flow but provides no statement that all capture lifecycle tools return structured content. This is absent because seven tools do not yet do so.

### 5. Full changed-file Prettier check is not green

The source-only changed-file check is clean, as is `git diff --check`. However, the full changed-file check requested for this review fails on the newly added handoff:

```text
bunx prettier --check src/mcp.ts src/db.ts src/legacy-meal-tools.integration.test.ts package.json server.json .hermes/plans/2026-08-05-gap-remediation-s6-kimi-handoff.md
[warn] .hermes/plans/2026-08-05-gap-remediation-s6-kimi-handoff.md
[warn] Code style issues found in the above file.
```

This is secondary to the acceptance failures but must be corrected before a green S6 handoff.

## Accepted additive work — retain, do not revert

The following implementation is useful S6-adjacent additive work and is not harmful scope creep:

1. **13-tool water/weight/import/widget sweep is real.** `src/legacy-meal-tools.integration.test.ts` adds seven real `InMemoryTransport` DB-gated tests. The DB gate executed them successfully, including every named tool, and parses runtime `structuredContent` using exact exported schemas wrapped in strict objects. The 13-name inventory is locked and passed.
2. **Schemas and runtime payloads line up for the sweep.** `src/mcp.ts` exports water/weight/widget schemas, hoists `WEIGHT_TRENDS_OUTPUT_SCHEMA`, declares the registrations, and supplies matching structured payloads. The final `outputSchema` token count is **26** (base handoff inventory reported 15; this range adds 11 registrations/occurrences as expected for 11 previously missing contracts).
3. **`delete_water` semantics are more honest.** `src/db.ts:841-854` changes the delete to `DELETE ... RETURNING id` and returns `boolean`. `src/mcp.ts:3263-3298` now returns `{ id, deleted }`; text correctly says `No water entry found...` when false. The DB transport test covers both found and missing paths and passed.
4. **Version bump is truthful.** Robust extraction confirms `package.json=1.23.3`, `server.json=1.23.3`, and the production `McpServer` constructor in `src/mcp.ts` is `1.23.3` (`VERSION-EQUALITY-OK`).
5. **No migrations, provider work, or S7 implementation changed.** The six changed files are the handoff, `package.json`, `server.json`, `src/db.ts`, `src/legacy-meal-tools.integration.test.ts`, and `src/mcp.ts`. The range changes zero files under `db/migrations/` or `supabase/migrations/`; provider/S7 mentions occur only in the handoff’s scope disclosures.

Retain this exact additive work and extend it with the bounded governing S6 goal. Do not revert the 13-tool sweep or the version bump. Do not add migrations, provider integrations, media behavior changes, or S7 readiness work.

## Required coder-kimi fixes plan

1. In `src/mcp.ts`, define one exported explicit strict capture-state schema (or a deliberately composed set of exported strict schemas if the operations genuinely differ) covering the capture payload returned by the lifecycle APIs. Add a shared `captureStateOutput(capture)` serializer as the plan’s refactor boundary specifies. Do not alter capture persistence or state-transition behavior.
2. Wire all seven currently missing registrations — `start_meal_capture`, `append_meal_capture_message`, `answer_meal_capture`, `save_meal_capture_draft`, `get_meal_capture`, `cancel_meal_capture`, and `expire_meal_capture` — with their declared `outputSchema` and `structuredContent`. Preserve current human-readable/text-JSON content for compatibility. Confirm the pre-existing `confirm_meal_capture` and `attach_meal_capture_media` contracts are included in a nine-tool inventory rather than changed unnecessarily.
3. Add transport-level tests in `src/mcp.test.ts` for non-DB-safe cases and `src/mcp-food-tracking.test.ts` for DB-backed lifecycle cases. Each of the nine tools must be called over actual linked `InMemoryTransport`, its successful `structuredContent` parsed through its exact exported schema, and an extra-key payload rejected by `.strict()`. Cover start → append → answer → draft → get → cancel/expire and confirmation/attach paths with valid fixture data. Do not settle for direct handler/unit invocation or presence-only assertions.
4. Replace the alias in `src/calculation-bundles.ts` with exactly the required distinct strict schema:

    ```ts
    export const CALCULATION_CORRECTION_OUTPUT_SCHEMA =
        CALCULATION_BUNDLE_OUTPUT_SCHEMA.extend({
            prior_version: z.number().int().min(1),
            correction_reason: z.string().min(1),
            correction_author: z.string().min(1),
        }).strict();
    ```

    Create/build a correction-specific output serializer in `src/mcp.ts` so `commit_calculation_correction` emits all three fields on fresh and idempotent replay responses. `prior_version` must be the actual pre-correction version; reason/author must be the accepted correction request values. Preserve the existing bundle fields and text compatibility.

5. Add a focused unit test proving `CALCULATION_CORRECTION_OUTPUT_SCHEMA !== CALCULATION_BUNDLE_OUTPUT_SCHEMA`, valid correction output parses, missing correction fields fail, and unexpected keys fail. Add/extend the real correction `InMemoryTransport` test to parse the runtime output with that correction schema and assert all three values.
6. Rename exactly one duplicate test in `src/mcp-food-tracking.test.ts:490/:601` to accurately describe its distinct scenario. Ensure the mandated exact grep returns one.
7. Add a concise README capture documentation note stating that all nine capture lifecycle tools return declared structured content alongside their human-readable text.
8. Run Prettier on the S6 handoff as well as changed source files, then rerun the complete battery below and report its counts/outputs in a replacement handoff.

## Verification evidence

Commands were run against the reviewed final commit with the DB gate’s required matching URLs (`DATABASE_URL=DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`).

| Gate                                                                                                | Result                                                                              |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bun run typecheck`                                                                                 | PASS — `src/ typechecks clean`                                                      |
| `bun test src/mcp.test.ts`                                                                          | PASS — 112 pass, 0 fail                                                             |
| `DATABASE_URL=... DATABASE_URL_TEST=... bun test src/mcp-food-tracking.test.ts --max-concurrency 1` | PASS — 14 pass, 0 fail; also evidences duplicate title twice                        |
| `bun run test:unit`                                                                                 | PASS — 481 pass, 0 fail, 147 skip, 628 tests / 34 files                             |
| `DATABASE_URL=... DATABASE_URL_TEST=... bun run test:db`                                            | PASS — 131 pass, 0 fail, 0 skip across 8 suites: 5 + 41 + 13 + 20 + 14 + 7 + 23 + 8 |
| S6 13-tool DB transport block                                                                       | PASS — 7 tests, included within the 23-pass legacy suite                            |
| Source changed-file Prettier + `git diff --check`                                                   | PASS                                                                                |
| Full changed-file Prettier including added handoff                                                  | FAIL — handoff Markdown requires formatting                                         |
| Capture transport outputSchema inventory                                                            | FAIL — 2/9 declared (`confirm`, `attach`); 7 missing                                |
| Correction schema identity/field check                                                              | FAIL — identity equal; all three required fields absent                             |
| Duplicate exact-name grep                                                                           | FAIL — 2 occurrences; required 1                                                    |
| Version equality                                                                                    | PASS — all three values are 1.23.3                                                  |
| Migration/provider/S7 scope audit                                                                   | PASS — zero migration edits; no provider/S7 implementation                          |

## Git / delivery state

Per the requested FAIL handling, this review is intentionally **uncommitted** and was **not pushed**. No source code was modified by reviewer-terra; this file is the only reviewer-created working-tree artifact. The implementation commits in the reviewed range remain untouched. A commit/push must wait for the bounded fixes and a passing re-review.

**S6 REVIEW COMPLETE — FAIL.**
