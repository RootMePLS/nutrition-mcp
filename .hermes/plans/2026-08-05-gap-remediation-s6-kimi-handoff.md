# S6 handoff — structured-output contract sweep (remaining public tools)

Date: 2026-08-05
Coder: coder-kimi
Base HEAD: 98fc0b892c7cdaeab969122b3cb6e77511f9f9da (`docs: accept S5 capture-media commit reconciliation`)
Scope executed: S6 structured-output contract sweep ONLY, for exactly the 13
named remaining tools. No S7 (readiness), no capture/correction work from the
plan's S6 text (already landed in earlier slices), no persistence, migration,
media, or provider changes.

## RED inventory (measured at base HEAD)

`git grep -c 'outputSchema' src/mcp.ts` at HEAD: **15** (plan said 14 at audit
time; S5 added the attach tool's). After this slice: **26**.

Per-tool state at base HEAD (inspected registrations in `src/mcp.ts`):

| Tool                     | outputSchema at HEAD                   | structuredContent at HEAD |
| ------------------------ | -------------------------------------- | ------------------------- |
| get_water_by_date        | missing                                | missing                   |
| log_water                | missing                                | missing                   |
| delete_water             | missing                                | missing                   |
| get_weight_today         | missing                                | missing                   |
| get_weight_by_date       | missing                                | missing                   |
| get_weight_by_date_range | missing                                | missing                   |
| log_weight               | missing                                | missing                   |
| update_weight            | missing                                | missing                   |
| delete_weight            | missing                                | missing                   |
| get_weight_trends        | present (inline, not exported)         | present (widget contract) |
| start_meal_import        | present (`START_IMPORT_OUTPUT_SCHEMA`) | present                   |
| get_widget_display       | missing                                | missing                   |
| set_widget_display       | missing                                | missing                   |

So 11 tools needed the full contract; get_weight_trends needed its inline
schema hoisted to an exported declaration; start_meal_import already satisfied
the contract and is pinned by a new acceptance test.

## RED evidence (before implementation)

```
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts --max-concurrency 1
```

Result: **17 pass, 6 fail, 23 tests**. All six failures were the new S6
describe block failing for the right reason — e.g.:

```
error: log_water returned no structuredContent
error: get_weight_trends exports no declared output schema
error: set_widget_display returned no structuredContent
```

(inventory, water, weight-log/date-reads, weight-today/update/delete,
get_weight_trends, widget-display tests failing; start_meal_import already
passing). The RED tests read the declared schemas through a namespace binding
so the failures showed the missing runtime contract instead of a module link
error; the REFACTOR step switched them to static imports once the exports
existed.

## Exact tool list and declared schemas (all exported from `src/mcp.ts`)

Shared building blocks (single source, no copy/paste):

- `WATER_ENTRY_OUTPUT_SCHEMA` — strict object `{ id, amount_ml, logged_at, notes(nullable) }`; built only by `waterEntryPayload()`.
- `WEIGHT_ENTRY_OUTPUT_SCHEMA` — strict object `{ id, weight_g, logged_at, notes(nullable) }`; built only by `weightEntryPayload()`.
- `WEIGHT_UNIT_FIELD` — `z.enum(["kg", "lb"])`.

Per-tool contracts:

- log_water -> `LOG_WATER_OUTPUT_SCHEMA` `{ deduplicated, entry: WATER_ENTRY }`
- get_water_by_date -> `WATER_DAY_OUTPUT_SCHEMA` `{ date, total_ml, entries: WATER_ENTRY[] }` (empty day returns `total_ml: 0, entries: []`)
- delete_water -> `DELETE_WATER_OUTPUT_SCHEMA` `{ id, deleted }`
- log_weight -> `LOG_WEIGHT_OUTPUT_SCHEMA` `{ deduplicated, unit, entry: WEIGHT_ENTRY }`
- get_weight_today -> `WEIGHT_DAY_OUTPUT_SCHEMA` `{ date, unit, entries: WEIGHT_ENTRY[] }`
- get_weight_by_date -> `WEIGHT_DAY_OUTPUT_SCHEMA` (shared with get_weight_today)
- get_weight_by_date_range -> `WEIGHT_RANGE_OUTPUT_SCHEMA` `{ start_date, end_date, unit, days: [{ date, average_weight_g, entries: WEIGHT_ENTRY[] }] }`
- update_weight -> `UPDATE_WEIGHT_OUTPUT_SCHEMA` `{ unit, entry: WEIGHT_ENTRY }`
- delete_weight -> `DELETE_WEIGHT_OUTPUT_SCHEMA` `{ id, deleted }`
- get_weight_trends -> `WEIGHT_TRENDS_OUTPUT_SCHEMA` `{ end_date, unit, target(nullable), default_range, days: [{ date, weight }] }` — hoisted verbatim from the inline declaration; the weight-trends widget consumes exactly this shape, unchanged.
- start_meal_import -> `START_IMPORT_OUTPUT_SCHEMA` (pre-existing, unchanged)
- set_widget_display -> `WIDGET_DISPLAY_OUTPUT_SCHEMA` `{ widgets_enabled }`
- get_widget_display -> `WIDGET_DISPLAY_OUTPUT_SCHEMA` (shared with set_widget_display)

Model-facing text content is unchanged on every path (structuredContent is
purely additive), with ONE documented exception below.

## Acceptance tests (InMemoryTransport, DB-gated)

New describe block "S6 sweep tools declare and return structured outputs" in
`src/legacy-meal-tools.integration.test.ts` (the existing DB-gated legacy
transport suite — kept the DB gate at exactly 8 suites). 7 new tests invoke
all 13 named tools over a real `InMemoryTransport` client and parse
`structuredContent` with `z.object(EXPORTED_SCHEMA).strict().parse(...)`:

1. inventory: `client.listTools()` — every one of the 13 sweep tools is registered AND advertises `outputSchema`; the sweep set is locked at exactly 13 names.
2. water lifecycle: log (fresh + idempotent replay), by-date (populated + empty-day success path), delete (found + not-found).
3. weight log + date reads: log, by-date (populated + empty), range (two days incl. a two-entry day with `average_weight_g` 81000, + empty-range success path).
4. weight today/update/delete: today read, update (80000 -> 81000 g), delete found + not-found.
5. get_weight_trends: parsed against the exported hoisted schema (`target` null without goals, `default_range` 30).
6. widget display set/get round trip (`false` -> readback -> `true`).
7. start_meal_import: parsed against `START_IMPORT_OUTPUT_SCHEMA`.

## Additive-schema / honesty notes (required disclosures)

- `delete_water`: `deleteWater()` (`src/db.ts`) returned `void`, so an honest
  `deleted` flag was not representable. It now uses `DELETE ... RETURNING id`
  and returns `boolean`, mirroring the existing `deleteWeight`. The not-found
  path (previously reported as "Water entry <id> deleted.") now answers "No
  water entry found with id <id>.", mirroring delete_weight's existing text.
  This is the only model-facing text change in the slice; it fixes a false
  success claim rather than breaking a real contract. No other text changed.
- All other success responses were representable additively; no schema had to
  be widened and no S7 (or later) behavior was touched. `get_water_today`,
  `set_weight_unit`, `get_weight_unit` are intentionally NOT in the sweep
  (not among the 13 named tools) and remain unchanged.

## Version bump

Inspected current value first: 1.23.2 in all three places. One honest patch
bump: **1.23.2 -> 1.23.3** in `package.json`, `server.json`, and the
`McpServer` constructor in `src/mcp.ts`. Direct three-file equality check:

```
package.json=1.23.3 server.json=1.23.3 mcp.ts(McpServer)=1.23.3
VERSION-EQUALITY-OK
```

## Gates (final tree, after Prettier)

Canonical env: `DATABASE_URL=DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`.

- `bun run typecheck` — src/ typechecks clean.
- `bun run test:unit` — **unit: 481 pass / 147 skip / 0 fail** (628 tests, 34 files). Baseline was 481/138/0 (619 tests). Delta +9 tests, all skips in unit mode: the 7 new DB-gated S6 acceptance tests plus 2 `(unnamed)` per-describe entries bun counts for the new describe block (verified with `--reporter=junit` against a HEAD worktree: legacy suite 18 -> 27 standalone; every other file unchanged).
- `bun run test:db` — **db: 131 pass / 0 skip / 0 fail across 8 suites** (5 + 41 + 13 + 20 + 14 + 7 + 23 + 8). Baseline at campaign start was 82/7 suites; S1-S5 grew it to 124; this slice adds the 7 S6 tests in the legacy suite (16 -> 23 there).
- `bunx prettier --check src/mcp.ts src/db.ts src/legacy-meal-tools.integration.test.ts package.json server.json` — all matched files use Prettier code style (changed-files-only per D5).
- `git diff --check` — silent.
- Three-file version equality — VERSION-EQUALITY-OK (above).

## Files changed

- `src/mcp.ts` — 13 schema exports + 2 shared serializers; outputSchema + structuredContent wired on 11 tools; get_weight_trends schema hoisted; version bump.
- `src/db.ts` — `deleteWater` returns `boolean` via `RETURNING id` (mirrors `deleteWeight`).
- `src/legacy-meal-tools.integration.test.ts` — `callTools` now also hands the test the `Client`; new S6 describe block (7 tests).
- `package.json`, `server.json` — version 1.23.3.

## Deviations from the plan's S6 text

The campaign plan's S6 text couples three things: capture-tool output
schemas, a dedicated correction output schema (D7), and a cross-user test-name
dedup. This invocation's dispatch re-scoped S6 to the structured-output
contract sweep of exactly the 13 remaining named tools, and only that was
executed. State of the plan-S6 items at this HEAD:

- Capture lifecycle tools (`start/append/answer/draft/get/cancel/expire/
confirm_meal_capture`, `attach_meal_capture_media`): NOT given outputSchema
  in this slice — the dispatch limited the sweep to the 13 named tools. Of the
  capture family, `confirm_meal_capture` and `attach_meal_capture_media`
  already declare outputSchema + structuredContent from S5/S0 work; the other
  seven capture tools still lack the contract and remain available for a
  follow-up dispatch.
- D7: `CALCULATION_CORRECTION_OUTPUT_SCHEMA` (`src/calculation-bundles.ts:134`)
  is STILL an alias of `CALCULATION_BUNDLE_OUTPUT_SCHEMA` — deliberately not
  touched here (outside the dispatched tool list).
- The duplicated cross-user test name in `src/mcp-food-tracking.test.ts` was
  not touched (outside dispatch).

Nothing beyond the 13 named tools was modified.

## README/docs

No README or docs change was required for contract/version truth: the README
tool table carries no per-tool output-contract claims and no version string,
and no docs file references these tools' output shapes.

## Out of scope confirmed

No persistence/migration changes (no `db/migrations` edits), no media,
provider, Telegram, STT/OCR/vision, or S7 readiness work. S7+ not started.
