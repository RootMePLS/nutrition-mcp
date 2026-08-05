# S6 remediation handoff 2 — governing acceptance fixes after Terra FAIL review

Date: 2026-08-05
Coder: coder-kimi
Base HEAD: 2d401219e72be9e99bf415f59f1c0ce1906abc1c (`docs: record S6 structured-output evidence`)
Governing acceptance: Slice S6, `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md:466-503`,
plus the required fixes plan in the uncommitted Terra FAIL review
`.hermes/plans/2026-08-05-gap-remediation-s6-terra-review.md`
(SHA-256 `03807f23362abd67640bbb51f1563560c28bf8409a58d7f4dd8403558806210b`,
preserved byte-identically).

Scope executed: S6 remediation ONLY. The additive 13-tool water/weight/import/widget
sweep (commits a26a058/2d40121) and version 1.23.3 are retained untouched. No S7,
no persistence/migration/provider/media behavior changes.

## RED evidence (before implementation)

New tests were written first and run against the unmodified HEAD:

```
bun test src/mcp.test.ts
# 112 pass, 3 fail — capture lifecycle output contracts (S6):
#   "mcp.js exports no captureStateOutput serializer" /
#   CAPTURE_STATE_OUTPUT_SCHEMA / GET_MEAL_CAPTURE_OUTPUT_SCHEMA undefined

bun test src/calculation-bundles.test.ts
# 9 pass, 1 fail — correction contract identity:
#   CALCULATION_CORRECTION_OUTPUT_SCHEMA === CALCULATION_BUNDLE_OUTPUT_SCHEMA (alias)

DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/mcp-food-tracking.test.ts --max-concurrency 1
# 14 pass, 4 fail — S6 capture contract block:
#   inventory (7/9 tools advertise no outputSchema) +
#   "start_meal_capture returned no structuredContent" (flow, expire, confirm/attach tests)
```

The RED-phase tests read the new contracts through a namespace binding so the
failures showed the missing runtime contract instead of a module link error; the
REFACTOR step switched them to static imports once the exports existed.

## GREEN — what changed

### Capture lifecycle contracts (commit ba22210, feat)

- `src/mcp.ts` exports `CAPTURE_STATE_OUTPUT_SCHEMA` (strict:
  `capture_id`, `state` enum, `event_id`/`version` nullable, `deduplicated`
  boolean) and one shared `captureStateOutput(capture)` serializer — the only
  place capture-state literals are built; optional domain fields normalize to
  explicit nulls.
- `GET_MEAL_CAPTURE_OUTPUT_SCHEMA` wraps `CAPTURE_READ_OUTPUT_SCHEMA.nullable()`
  under `{ capture }`, so a missing capture is an explicit null, not an absent
  payload. The read schema composes the shared state fields via
  `captureStateOutput` plus `user_id`, `conversation_key`, `expires_at`,
  `prepared_draft`, `messages`, `answers`, `media`.
- All seven previously missing registrations (`start_meal_capture`,
  `append_meal_capture_message`, `answer_meal_capture`,
  `save_meal_capture_draft`, `get_meal_capture`, `cancel_meal_capture`,
  `expire_meal_capture`) now declare `outputSchema` and return
  `structuredContent`; existing human-readable text/JSON content is preserved
  verbatim (acknowledgement strings and `JSON.stringify` payloads unchanged).
  append/answer/draft read the capture back after the mutation and serialize
  through the same shared serializer; no persistence or state-transition
  behavior changed.
- `confirm_meal_capture`'s pre-existing contract was hoisted unchanged to the
  exported `CONFIRM_MEAL_CAPTURE_OUTPUT_SCHEMA` shape (same keys, same
  registration style as the S6 sweep exports) so the nine-tool inventory and
  transport tests parse the exact declared keys.
  `attach_meal_capture_media`'s strict contract is unchanged.
- README gains the required note: all nine capture lifecycle tools declare an
  `outputSchema` and return machine-checkable `structuredContent` alongside
  their human-readable text.

### D7 correction contract + test dedup (commit 1f771d6, fix)

- `src/calculation-bundles.ts`: the identity alias is replaced with exactly
  `CALCULATION_BUNDLE_OUTPUT_SCHEMA.extend({ prior_version: z.number().int().min(1), correction_reason: z.string().min(1), correction_author: z.string().min(1) }).strict()`.
- `src/mcp.ts`: new `buildCalculationCorrectionOutput` serializer composes the
  bundle output with the three correction fields, so fresh AND idempotent
  replay `commit_calculation_correction` responses carry the actual
  `prior_version` (the enforced append invariant `bundle.version ===
current_version + 1` plus replayed version-identity verification make
  `version - 1` the persisted prior version on both paths) and the accepted
  `correction_reason`/`correction_author` request values. Bundle fields and the
  text payload are preserved.
- Duplicate test dedup: the second occurrence at (former)
  `src/mcp-food-tracking.test.ts:601` is renamed to `"rejects cross-user
capture message, answer, and draft mutations without persisting rows"` —
  its body asserts both the rejections and that no message/answer/draft rows
  persist. The first occurrence keeps the mandated title.

## Test evidence

### Nine-tool outputSchema inventory (real McpServer + InMemoryTransport listTools)

```
start_meal_capture             registered=true outputSchema=true
append_meal_capture_message    registered=true outputSchema=true
answer_meal_capture            registered=true outputSchema=true
save_meal_capture_draft        registered=true outputSchema=true
get_meal_capture               registered=true outputSchema=true
cancel_meal_capture            registered=true outputSchema=true
expire_meal_capture            registered=true outputSchema=true
confirm_meal_capture           registered=true outputSchema=true
attach_meal_capture_media      registered=true outputSchema=true
capture-outputSchema-count=9/9
```

### Correction schema identity/field check (direct runtime probe)

```
identity_equal=false
correction_fields=prior_version,correction_reason,correction_author
```

Unit tests (`src/calculation-bundles.test.ts`) prove identity
(`!== CALCULATION_BUNDLE_OUTPUT_SCHEMA`), valid correction output parses, each
missing correction field fails, constraint violations fail
(`prior_version: 0`, empty reason), and strict extra-key rejection on both the
correction and bundle schemas. `src/mcp.test.ts` unit-tests
`captureStateOutput` null normalization and strict rejection for both capture
schemas.

### Real transport assertions

- `src/mcp-food-tracking.test.ts` — new DB-gated describe "capture lifecycle
  structured output contracts (S6)": 4 tests over real linked
  `InMemoryTransport`. Every one of the nine tools is called with valid
  fixture flows (start → append → answer → draft → get → cancel; expire with
  an overdue capture; attach → draft → confirm). Each successful
  `structuredContent` is parsed through its exact exported schema (the confirm
  shape wrapped in `z.object(...).strict()` like the S6 sweep tests) and each
  runtime payload is proven to reject an extra key under `.strict()`. Text
  compatibility is asserted (acknowledgement strings and JSON text payloads).
- `src/legacy-meal-tools.integration.test.ts` — the real correction transport
  test now asserts all three correction values end-to-end on fresh and
  idempotent replay responses: `prior_version: 1`,
  `correction_reason: "portion corrected"`, `correction_author: "hermes"`,
  parsed through `CALCULATION_CORRECTION_OUTPUT_SCHEMA`.

### Mandated grep

```
git grep -c '"rejects cross-user capture message, answer, and draft mutations"' src/mcp-food-tracking.test.ts
1
```

## Gate battery (final tree, both URLs postgres://localhost:5432/nutrition_mcp_test)

| Gate                                                                  | Result                                                                              |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `bun run typecheck`                                                   | PASS — `src/ typechecks clean`                                                      |
| `bun test src/mcp.test.ts src/calculation-bundles.test.ts`            | PASS — 125 pass, 0 fail                                                             |
| `bun test src/mcp-food-tracking.test.ts --max-concurrency 1` (DB)     | PASS — 18 pass, 0 fail (14 pre-existing + 4 new S6 contract tests)                  |
| `bun test src/calculation-acceptance.integration.test.ts` (DB)        | PASS — 8 pass, 0 fail (MCP correction round-trip parses the new schema)             |
| `bun run test:unit`                                                   | PASS — 484 pass, 0 fail, 153 skip, 637 tests / 34 files                             |
| `bun run test:db` (DB)                                                | PASS — 135 pass, 0 fail, 0 skip across 8 suites: 5 + 41 + 13 + 20 + 18 + 7 + 23 + 8 |
| Capture outputSchema inventory                                        | PASS — 9/9 declared                                                                 |
| Correction identity/field check                                       | PASS — identity unequal; all three fields present and asserted end-to-end           |
| Duplicate exact-name grep                                             | PASS — 1 occurrence                                                                 |
| Prettier (all remediation-changed paths incl. prior handoff)          | PASS                                                                                |
| `git diff --check`                                                    | PASS                                                                                |
| Version equality (package.json / server.json / McpServer constructor) | PASS — all 1.23.3 (VERSION-EQUALITY-OK)                                             |

`git grep -c 'outputSchema' src/mcp.ts`: 26 at base HEAD -> 33 (seven new
registrations; the hoisted confirm contract keeps its single occurrence).

## Scope audit

Changed files: `src/mcp.ts`, `src/calculation-bundles.ts`, `src/mcp.test.ts`,
`src/calculation-bundles.test.ts`, `src/mcp-food-tracking.test.ts`,
`src/legacy-meal-tools.integration.test.ts`, `README.md`, plus this handoff,
the formatted prior handoff, and the preserved Terra FAIL review. Zero changes
under `db/migrations/` or `supabase/migrations/`; no provider, media-behavior,
or S7 readiness work. Commits a26a058/2d40121 and version 1.23.3 retained.

## Commits

1. `ba22210` — `feat: declare structured outputs for capture lifecycle tools`
2. `1f771d6` — `fix: give corrections a dedicated output contract and dedupe cross-user test names`
3. docs (this handoff + formatted prior handoff + immutable Terra FAIL review) —
   `docs: record S6 governing acceptance remediation`

**S6 REMEDIATION COMPLETE.**
