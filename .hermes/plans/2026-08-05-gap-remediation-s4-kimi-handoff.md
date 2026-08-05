# Slice S4 handoff — Honest provenance status on legacy writes

Date: 2026-08-05
Slice: S4 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md`
Coder: coder-kimi
Base HEAD: `ef97e1c` `docs: accept S3 aggregate-presence remediation` (clean tree at slice start)
Feature commit: `e2c33f1` `feat: disclose provenance status on legacy meal writes`

## Scope executed

Only S4. Legacy write tools (`log_meal`, `update_meal`, `bulk_import_meals`)
now disclose write provenance on their structured outputs. What legacy writes
persist is unchanged (compatibility provider row semantics stay, per the slice
non-goal). S5 not started.

Scope proof — `git show --stat e2c33f1` touches exactly these 10 files:

```
 README.md                                 |   4 +
 docs/food-tracking-agent-driven.md        |  14 ++
 src/csv.test.ts                           |   6 +
 src/db.ts                                 |  31 ++-
 src/import.test.ts                        |  90 ++++++++-
 src/import.ts                             |  29 ++-
 src/legacy-meal-tools.integration.test.ts | 308 ++++++++++++++++++++++++++++++
 src/mcp.test.ts                           | 108 ++++++++++-
 src/mcp.ts                                |  26 ++-
 src/meal-events.ts                        |  59 ++++++
```

No `db/` migrations, no DDL, no storage/persistence change; the diff is
output-layer code (`src/meal-events.ts`, `src/db.ts`, `src/import.ts`,
`src/mcp.ts`) plus tests and docs. No S5 symbols (`attach_meal_capture_media`,
MediaStore staging) anywhere in the diff.

## What changed

- `src/meal-events.ts`
    - `CreateMealEventResult` gains `compatibility: boolean` — true when the
      version carries no calculation bundle fingerprint; always populated by
      `readPersistedWriteStatus` (`compatibility: v.calculation_bundle_fingerprint == null`).
    - `WriteProvenanceStatus = "pending" | "compatibility" | "complete"` and
      `WriteProvenanceFields` (`provenance_status`, `event_version`,
      `has_calculation_bundle`, `provenance_note`).
    - `writeProvenanceFields(write)` (REFACTOR extraction): the single mapping
      from a persisted write readback onto the disclosure fields, shared by all
      three legacy write tools so they can never drift apart:
        - compatibility write (no bundle fingerprint) -> `compatibility`,
          `has_calculation_bundle: false`, note directing the caller to
          `commit_calculation_bundle` / `commit_calculation_correction`;
        - bundle-backed version whose evidence readback is `ready` ->
          `complete`, `has_calculation_bundle: true`;
        - bundle-backed version with anything less -> `pending`,
          `has_calculation_bundle: true` (bundle exists; evidence incomplete).
- `src/db.ts`
    - `MealInsertResult` gains `provenance: WriteProvenanceFields`, derived
      from the persisted write readback so an idempotent retry reports the
      event's current truth, not a stale `compatibility`.
    - New `MealUpdateResult { meal, provenance }`; `updateMeal` returns it
      (`correctMealEvent` readback through the same builder).
- `src/mcp.ts`
    - `MEAL_PROGRESS_OUTPUT_SCHEMA` (now exported so tests parse real tool
      payloads against the declared contract) gains the four non-null fields:
      `provenance_status: z.enum(["pending","compatibility","complete"])`,
      `event_version: z.number().int().min(1)`,
      `has_calculation_bundle: z.boolean()`, `provenance_note: z.string()`.
    - `buildMealProgress` takes the provenance fields and spreads them into
      the structured content of both `log_meal` and `update_meal`.
- `src/import.ts`
    - `ImportResultRow` and `BULK_IMPORT_OUTPUT_SCHEMA` gain the same four
      fields per row, **nullable rather than optional**: `null` means "no
      event was written for this row". `serializeImportResult` emits them on
      every path; `resultRow` defaults them to `null` unless a provenance
      payload is passed.
- Docs: `README.md` "Legacy write provenance disclosure" section;
  `docs/food-tracking-agent-driven.md` paragraph on the same contract.

## Per-tool output semantics

- `log_meal` / `update_meal`: the structured payload always carries all four
  fields (non-null). A plain legacy write discloses
  `provenance_status: "compatibility"`, `has_calculation_bundle: false`, and
  the actual `event_version` (1 for a fresh log, the new version number for an
  update — verified 2 in the update test).
- `bulk_import_meals`: per result row. Rows that reached the database
  (`created`, `deduplicated`) carry the written event's provenance fields.
  Rows that never reached the database report all four fields as explicit
  `null`s, because there is no event whose provenance could truthfully be
  reported:
    - dry-run rows (`would_create`, `would_deduplicate`) — dry run writes
      nothing, so the per-row fields are `null` (asserted:
      `expect(row.provenance_status).toBeNull()` for `would_create` rows);
    - validation-failed rows (`failed`);
    - rows skipped after an abort (`not_attempted`).
- Only `commit_calculation_bundle` / `commit_calculation_correction` can move
  a version's disclosed status to `complete`; legacy writes alone can never
  claim more than `compatibility`.

## Duplicate / idempotent behavior

- The disclosure fields come from the persisted write readback
  (`readPersistedWriteStatus` inside the write transaction), not from the
  request — so an idempotent retry of an event that later gained a
  calculation bundle reports `complete`, never a stale `compatibility`.
  Asserted in "log_meal discloses compatibility provenance, honestly on
  idempotent retry": the retry of the same meal reports the same event
  version and current provenance.
- `bulk_import_meals` replays: a `deduplicated` row reports the provenance of
  the event it deduplicated to (same `insertMeal` readback path), while a dry
  run predicts `would_deduplicate` with all four fields `null`.
- Cross-check: "a committed calculation bundle completes a legacy write's
  disclosed provenance" — after `commit_calculation_bundle` lands on a legacy
  event, the follow-up readback reports `complete`.

## RED evidence (tests written first, failing for the right reason)

Unit RED — new tests referenced the not-yet-existing `writeProvenanceFields`
export (feature missing, not a typo):

```
bun test v1.3.14 (d1632b29)

src/mcp.test.ts:

# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'writeProvenanceFields' not found in module '/Users/fishhead/.workspace/projects/nutrition-mcp/src/meal-events.ts'.
-------------------------------


src/import.test.ts:

# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'writeProvenanceFields' not found in module '/Users/fishhead/.workspace/projects/nutrition-mcp/src/meal-events.ts'.
-------------------------------


 0 pass
 2 fail
 2 errors
Ran 2 tests across 2 files. [106.00ms]
```

DB/MCP RED command:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts
```

RED output — the four new provenance integration tests fail because the
structured payloads lack the fields (`undefined`), everything else passes:

```
(pass) legacy meal MCP tools use the event projection > public calculation MCP round-trips strict provenance and authorization [205.09ms]
(pass) legacy meal MCP tools use the event projection > account cleanup removes every event child and preserves unrelated user data [163.18ms]
1731 |                 const logged = await call("log_meal", args);
1732 |                 expect(logged.isError).not.toBe(true);
1733 |                 const parsed = z
1734 |                     .object(MEAL_PROGRESS_OUTPUT_SCHEMA)
1735 |                     .parse(logged.structuredContent);
1736 |                 expect(parsed.provenance_status).toBe("compatibility");
                                                        ^
error: expect(received).toBe(expected)

Expected: "compatibility"
Received: undefined

(fail) legacy meal MCP tools use the event projection > log_meal discloses compatibility provenance, honestly on idempotent retry [87.13ms]
1784 |                 expect(parsed.action).toBe("updated");
1785 |                 expect(parsed.provenance_status).toBe("compatibility");
                                                        ^
error: expect(received).toBe(expected)

Expected: "compatibility"
Received: undefined

(fail) legacy meal MCP tools use the event projection > update_meal discloses compatibility provenance on the new version [125.20ms]
1827 |                 expect(before.provenance_status).toBe("compatibility");
                                                        ^
error: expect(received).toBe(expected)

Expected: "compatibility"
Received: undefined

(fail) legacy meal MCP tools use the event projection > a committed calculation bundle completes a legacy write's disclosed provenance [92.77ms]
1914 |                 for (const row of dryParsed.results) {
1915 |                     expect(row.status).toBe("would_create");
1916 |                     expect(row.provenance_status).toBeNull();
                                                         ^
error: expect(received).toBeNull()

Received: undefined

(fail) legacy meal MCP tools use the event projection > bulk_import_meals reports per-row provenance and nulls for unwritten rows [72.56ms]

 12 pass
 4 fail
 221 expect() calls
Ran 16 tests across 1 file. [1.95s]
```

(RED excerpts verified against the committed test file: the quoted assertions
sit at exactly lines 1736, 1785, 1827 and 1916 of
`src/legacy-meal-tools.integration.test.ts` at `e2c33f1`.)

## GREEN evidence

Targeted unit + legacy integration after implementing
`writeProvenanceFields` / schema / builder / serializer changes:

```
=== GREEN: unit (targeted) ===

 208 pass
 0 fail
 966 expect() calls
Ran 208 tests across 3 files. [365.00ms]

=== GREEN: legacy integration ===
(pass) legacy meal MCP tools use the event projection > public calculation MCP round-trips strict provenance and authorization [143.58ms]
(pass) legacy meal MCP tools use the event projection > log_meal discloses compatibility provenance, honestly on idempotent retry [91.16ms]
(pass) legacy meal MCP tools use the event projection > update_meal discloses compatibility provenance on the new version [100.23ms]
(pass) legacy meal MCP tools use the event projection > a committed calculation bundle completes a legacy write's disclosed provenance [104.59ms]
(pass) legacy meal MCP tools use the event projection > bulk_import_meals reports per-row provenance and nulls for unwritten rows [110.31ms]

 16 pass
 0 fail
 279 expect() calls
Ran 16 tests across 1 file. [1.81s]
```

## REFACTOR evidence — one shared `writeProvenanceFields`

The mapping from persisted write readback to disclosure fields exists exactly
once, exported from `src/meal-events.ts` and consumed by all three tools:
`insertMeal`/`updateMeal` (`src/db.ts`) feed it into `buildMealProgress`
(`src/mcp.ts`), and `runImport` (`src/import.ts`) threads the same
`MealInsertResult.provenance` into each written result row. The three tools
therefore cannot drift apart. Direct unit coverage in `src/mcp.test.ts`:

```
(pass) writeProvenanceFields > compatibility write discloses compatibility, no bundle
(pass) writeProvenanceFields > bundle-backed version with ready evidence reports complete
(pass) writeProvenanceFields > bundle-backed version with incomplete evidence reports pending
```

plus handler-level "legacy write provenance disclosure" tests for
`log_meal`/`update_meal` structuredContent, and
`src/import.test.ts` "written rows disclose compatibility provenance;
unwritten rows null it" for the per-row contract. Gates re-run after the
extraction — final counts below.

## Gate counts (final, at e2c33f1, re-run for this handoff)

- typecheck: `bun run typecheck` -> `src/ typechecks clean`.
- unit: `bun run test:unit` -> **479 pass, 0 fail, 109 skip, 588 tests**
  (DB suites run by test:db). Baseline at slice start (`ef97e1c`, measured in
  a throwaway worktree): 473 pass / 0 fail / 105 skip / 578 tests. Delta:
  +6 pass (3 `writeProvenanceFields` unit tests, 2 legacy-write disclosure
  handler tests, 1 import per-row provenance test), +4 skip (the 4 new
  DB-gated integration tests skipping in unit mode).
- db (explicit 8-suite gate): `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`
  -> **103 pass, 0 fail, 0 skip, 103 tests across 8 DB suites**:

```
src/db.integration.test.ts: 5 pass, 0 fail, 0 skip, 5 ran, exit 0
src/meal-events.test.ts: 41 pass, 0 fail, 0 skip, 41 ran, exit 0
src/calculation-bundles.integration.test.ts: 13 pass, 0 fail, 0 skip, 13 ran, exit 0
src/meal-captures.integration.test.ts: 4 pass, 0 fail, 0 skip, 4 ran, exit 0
src/mcp-food-tracking.test.ts: 9 pass, 0 fail, 0 skip, 9 ran, exit 0
src/backup-policy.test.ts: 7 pass, 0 fail, 0 skip, 7 ran, exit 0
src/legacy-meal-tools.integration.test.ts: 16 pass, 0 fail, 0 skip, 16 ran, exit 0
src/calculation-acceptance.integration.test.ts: 8 pass, 0 fail, 0 skip, 8 ran, exit 0
DB gate totals: 103 pass, 0 fail, 0 skip, 103 tests across 8 DB suites.
```

Baseline at slice start (`ef97e1c`): 99 pass / 0 / 0 across the same 8
suites (legacy suite 12 -> 16). Delta: +4 (the four S4 provenance
integration tests).

- formatting: `bunx prettier --check <the 10 changed files>` ->
  `All matched files use Prettier code style!` (changed-files-only per
  campaign rule D5).
- whitespace: `git diff --check ef97e1c e2c33f1` -> silent (exit 0).

## Commits

1. `e2c33f1` `feat: disclose provenance status on legacy meal writes` — code +
   tests + docs (the 10 files above), per the campaign plan's commit
   boundary.
2. `docs: record S4 TDD evidence` — this handoff.

## Known limitations / risks

- Declared-output-schema addition (four new required fields on
  `log_meal`/`update_meal` payloads; four new nullable fields on
  `bulk_import_meals` rows) — additive only, no field removed or retyped;
  single-user deployment per campaign decisions.
- The disclosed status is point-in-write truth: a later bundle commit does not
  retroactively change an earlier tool response, but any subsequent write
  readback (idempotent retry, deduplicated import row, update) reports the
  current status — this is intentional and pinned by tests.
- Rollback: revert the feature commit; no DDL, no storage change.
