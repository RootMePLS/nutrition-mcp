# S1 coder handoff — TDD evidence and remediation record (coder-kimi)

Date: 2026-08-05
Scope: S1 gap remediation only. No production files, no migrations, and no S2 or
later-slice work were touched by this remediation.
Companion artifact: `.hermes/plans/2026-08-05-gap-remediation-s1-terra-review.md`
(Terra FAIL review, preserved byte-identical as an immutable review artifact).

## 1. Historical RED status (explicit)

The historical RED output from the original S1 TDD cycle was **not persisted**.
`git notes list` was empty and no ref or commit in
`be94d985ec587f08a69809a2fd2c7dc039da7317..dbff058d99e6e17d0d2fd23844f6b645b46d7a34`
carries the original failing run. This handoff does **not** claim otherwise.

Instead, an honest **REPRODUCED RED** was produced on 2026-08-05 in an isolated
temporary git worktree (method below). It is labeled REPRODUCED RED everywhere and
must not be cited as the original historical run.

## 2. REPRODUCED RED (2026-08-05, not the original historical run)

Method:

- Temporary worktree created at the pre-S1 base
  `be94d985ec587f08a69809a2fd2c7dc039da7317`
  (`git worktree add --detach /tmp/nutrition-mcp-s1-red be94d98...`), with
  `node_modules` symlinked from the main checkout. The main checkout was never
  modified by this step.
- Only the new per-scope tests were applied, as a test-only patch. The patch is
  exactly the test-file portion of the S1 implementation commit, verified purely
  additive (115 insertions, 0 deletions, `src/mcp-food-tracking.test.ts` only):
  `git diff be94d985ec587f08a69809a2fd2c7dc039da7317 afad258052976376fa86877a56a7634f602eddcd -- src/mcp-food-tracking.test.ts`
- No production code at the base was altered; the run exercised the old
  single-event-row implementation.

Exact command (run inside the worktree):

```text
cd /tmp/nutrition-mcp-s1-red && \
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/mcp-food-tracking.test.ts
```

Exit code: 1. Result: 8 pass / 1 fail — the only failure is the new per-scope
test; every pre-existing test at the base still passed. Complete unedited output
(relevant failure output included in full; this is the entire captured run):

```text
bun test v1.3.14 (d1632b29)

src/mcp-food-tracking.test.ts:
[analytics] log_meal_event success 18ms user=u1
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > accepts a multi-item event and returns the full structured payload [171.45ms]
[analytics] log_meal_event success 8ms user=u1
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > explicit add authorization returns pending, never synced [83.14ms]
[analytics] log_meal_event success 14ms user=u1
[analytics] log_meal_event success 7ms user=u1
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > duplicate retry returns the original event and never duplicates the journal [114.80ms]
[analytics] log_meal_event error=rate_limited 3ms user=u1
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > rejects safe but unrelated media storage keys [88.27ms]
(pass) log_meal_event MCP tool (requires DATABASE_URL_TEST) > validation rejects malformed input before any write [73.37ms]
374 |             });
375 |             expect(committed.isError).not.toBe(true);
376 |             const bundleOutput = CALCULATION_BUNDLE_OUTPUT_SCHEMA.parse(
377 |                 committed.structuredContent,
378 |             );
379 |             expect(bundleOutput.canonical?.nutrients.calories).toBe(505);
                                                                     ^
error: expect(received).toBe(expected)

Expected: 505
Received: 201

      at <anonymous> (/private/tmp/nutrition-mcp-s1-red/src/mcp-food-tracking.test.ts:379:64)
      at async withTools (/private/tmp/nutrition-mcp-s1-red/src/mcp-food-tracking.test.ts:69:15)
      at async <anonymous> (/private/tmp/nutrition-mcp-s1-red/src/mcp-food-tracking.test.ts:371:15)
(fail) log_meal_event MCP tool (requires DATABASE_URL_TEST) > commits an event+item bundle and reads item canonicals back through public provenance [87.03ms]
(pass) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations [96.48ms]
(pass) meal capture MCP lifecycle tools > discovers and calls get/cancel/expire with user scoping and states [177.47ms]
(pass) meal capture MCP lifecycle tools > rejects cross-user capture message, answer, and draft mutations [84.24ms]

 8 pass
 1 fail
 55 expect() calls
Ran 9 tests across 1 file. [1075.00ms]
```

Why this RED proves the pre-S1 defect: against the old implementation, the
committed bundle's event canonical reports calories `201` (an item-scope value)
instead of the event-scope consensus `505`. The old single-event-row path had no
per-scope separation, so item-scope provider results polluted the single
canonical. This is exactly the "old single-event-row implementation / missing
per-scope shape" failure the S1 tests were written to expose. The test appears
under the `log_meal_event` describe in this output because the reproduced patch
is the original S1 test placement, pre-relocation; the relocation remediation is
test-only and does not change what the test asserts.

Worktree disposal: after evidence capture the temporary worktree was removed with
`git worktree remove --force /tmp/nutrition-mcp-s1-red`; the main checkout was
untouched by the reproduction (verified: only the intended remediation changes
were present afterwards). This committed handoff is the durable evidence location
for the REPRODUCED RED; the raw capture itself lived at `/tmp/s1-red-output.txt`
during the run and is reproduced verbatim above.

## 3. GREEN (current, post-S1 implementation at the remediation commit)

All commands run in `/Users/fishhead/.workspace/projects/nutrition-mcp` on
2026-08-05 with the remediation applied.

```text
bun run typecheck
# src/ typechecks clean

bun run test:unit
# 448 pass
#  93 skip
#   0 fail
# Ran 541 tests across 33 files.
# Unit gate totals: 448 pass, 0 fail, 93 skip, 541 tests (DB suites are run by test:db).

DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
# src/db.integration.test.ts: 5 pass, 0 fail, 0 skip, 5 ran, exit 0
# src/meal-events.test.ts: 41 pass, 0 fail, 0 skip, 41 ran, exit 0
# src/calculation-bundles.integration.test.ts: 13 pass, 0 fail, 0 skip, 13 ran, exit 0
# src/meal-captures.integration.test.ts: 4 pass, 0 fail, 0 skip, 4 ran, exit 0
# src/mcp-food-tracking.test.ts: 9 pass, 0 fail, 0 skip, 9 ran, exit 0
# src/backup-policy.test.ts: 7 pass, 0 fail, 0 skip, 7 ran, exit 0
# src/legacy-meal-tools.integration.test.ts: 10 pass, 0 fail, 0 skip, 10 ran, exit 0
# DB gate totals: 89 pass, 0 fail, 0 skip, 89 tests across 7 DB suites.

bunx prettier --check <changed files>
# All matched files use Prettier code style.

git diff --check
# silent (pass)
```

### Totals, reported separately as required

- Unit gate: **448 pass / 0 fail / 93 skip, 541 tests** (DATABASE_URL and
  DATABASE_URL_TEST deleted by the unit gate; DB suites skip).
- DB gate: **89 pass / 0 fail / 0 skip, 89 tests across 7 DB suites** (both URLs
  explicitly `postgres://localhost:5432/nutrition_mcp_test`).

Unit-gate count note for the re-reviewer: the review recorded 539 tests / 91 skip
at `dbff058`. The remediation reports 541 / 93 skip. The delta is +2 skipped
entries with **zero tests added or removed** (the file holds 9 real tests before
and after, verified by count). Bun's skip accounting counts each `describe.skip`
wrapper as two additional skipped entries beyond its tests (measured directly:
13 skipped for the two-`describeDb` file at the base vs 15 for the
three-`describeDb` file after relocation). The DB gate totals are unchanged at
89/0/0, confirming no real test was added, lost, or altered.

## 4. REFACTOR identification

`persistCanonicalPerScope` (`src/calculation-bundles.ts:193-283` region) is the
REFACTOR: the shared per-scope canonical persistence path. Both the
`commit_calculation_bundle` flow and the correction repository flow persist one
canonical row per scope (event + each item ordinal) through this single helper,
and the correction MCP handler reuses the same `buildCalculationBundleOutput`
path (`src/mcp.ts:4885-4895`). Consensus is computed independently per scope and
the canonical source-ID query is scope-local via
`ordinal IS NOT DISTINCT FROM $3` with `status = 'succeeded'`.

## 5. Remediation change summary (test-only)

- `src/mcp-food-tracking.test.ts`: the real per-scope MCP acceptance test was
  moved out of `describeDb("log_meal_event MCP tool (requires DATABASE_URL_TEST)")`
  into its own honestly named
  `describeDb("calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST)")`
  with its own `Pool` lifecycle (`beforeAll`/`afterAll`), `flushAnalytics`
  `afterEach`, and migration reset `beforeEach`.
- The migration reset was extracted into the clearly named shared helper
  `resetSchemaWithMigrations(pool, migrations)`, now used by all three DB
  describes in the file (behavior-identical: same `DROP SCHEMA public CASCADE`
  plus the same per-suite migration lists).
- All real assertions are preserved unweakened: real `InMemoryTransport`
  round-trip through `commit_calculation_bundle` and `get_calculation_provenance`,
  Zod parsing of both structured outputs, three scope rows
  (`event`, `item:0`, `item:1`), scope-local `source_result_ids`, and the direct
  SQL cross-check on `meal_event_canonical_results`. The moved body was verified
  token-identical to the original modulo Prettier rewrapping (whitespace and
  trailing-comma placement only).
- No production files, no migrations, no S2 or later-slice scope changed.
