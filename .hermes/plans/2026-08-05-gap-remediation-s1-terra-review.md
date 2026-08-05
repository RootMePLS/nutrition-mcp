# S1 reviewer-terra acceptance review — FAIL

Reviewed range: `be94d985ec587f08a69809a2fd2c7dc039da7317..dbff058d99e6e17d0d2fd23844f6b645b46d7a34`

Reviewed commits:

1. `afad258052976376fa86877a56a7634f602eddcd` — `fix: materialize calculation canonicals per scope`
2. `dbff058d99e6e17d0d2fd23844f6b645b46d7a34` — `docs: describe per-scope canonical readback`

## Verdict

FAIL — the implementation and independently rerun gates are green, but the mandatory visible TDD evidence / reviewer handoff is absent, and the required real MCP acceptance test is misrepresented by placement in the `log_meal_event` describe block. This review file is intentionally uncommitted; no push was made.

## Blocking findings

### 1. Missing mandatory RED → GREEN → REFACTOR evidence / handoff metadata

Global rule 2 requires visible TDD evidence: the new test must have been run red with its command and relevant failure output before implementation, then green, then refactored with gates green. No S1 coder handoff metadata, RED command output, GREEN output, or REFACTOR record exists in the reviewed commits, git notes, or repository refs. `git notes list` was empty and no ref matched `s1`, `kimi`, `handoff`, or `review`.

The final green tests cannot retroactively demonstrate that the S1 tests initially failed for the intended pre-S1 defect. This is a missing acceptance artifact, not a request to alter production code.

Required evidence must state at minimum:

- RED command and its failure that proves the old single-event-row implementation / missing per-scope shape;
- GREEN commands and output;
- REFACTOR statement identifying `persistCanonicalPerScope` as the shared bundle/correction path;
- the separately reported unit and DB totals.

### 2. The real MCP per-scope test is not honestly or logically isolated

`src/mcp-food-tracking.test.ts:319-428` calls `commit_calculation_bundle` and `get_calculation_provenance` over real `InMemoryTransport`, but it is placed inside `describeDb("log_meal_event MCP tool (requires DATABASE_URL_TEST)", ...)` at line 118.

That test neither calls `log_meal_event` nor exercises its contract. It directly seeds `meal_events` / `meal_event_versions` and exercises the calculation-bundle/provenance public contract. It shares the first describe's setup solely by incidental placement. The test is technically database-reset isolated (`beforeEach` at lines 135-163) and passed in the independent DB gate, but its describe name is false and the scope is not isolated from the unrelated log-meal-event suite. This fails the requested honesty/isolation inspection and makes future triage misleading.

## Accepted implementation evidence (non-blocking)

The following acceptance points are satisfied by code inspection and independent gates:

- `src/calculation-bundles.ts:193-283` computes consensus independently for event (`ordinal NULL`) and every item ordinal, then persists one canonical row per scope through the shared `persistCanonicalPerScope` helper.
- The canonical source-ID query uses `ordinal IS NOT DISTINCT FROM $3` and `status = 'succeeded'`, so `source_result_ids` are scope-local. The former bare event-only predicate is removed.
- `src/calculation-bundles.integration.test.ts:410-485` proves rows for `event`, `item:0`, and `item:1`; uses SQL joins to prove no cross-scope source ID; and checks all expected in-scope references.
- `src/calculation-bundles.integration.test.ts:487-528` proves an extreme item-0 value does not affect the event canonical.
- `src/calculation-bundles.integration.test.ts:530-555` proves same-fingerprint retry is deduplicated with exactly one canonical per scope.
- `src/calculation-bundles.integration.test.ts:557-619` exercises the correction repository path and asserts new-version per-scope rows plus prior-version row/value immutability.
- `src/calculation-bundles.integration.test.ts:621-639` injects a pre-commit failure and proves zero provider and canonical rows remain.
- `src/calculation-bundles.integration.test.ts:503-528` proves failed item-only providers yield a pending / insufficient-data canonical with null nutrients and no source IDs while event and sibling item scope remain correct.
- `src/meal-events.ts:86-186` now reads all canonical rows, retains the event canonical for backward compatibility, returns sorted `item_canonicals`, and fails closed if the event canonical is absent or an ordinal with a succeeded provider lacks a canonical row.
- `src/calculation-bundles.ts:113-157`, `src/mcp.ts:140-193`, and `src/mcp.ts:4455-4495` expose `item_canonicals` in bundle and provenance schemas/structured outputs. The correction handler uses the same `buildCalculationBundleOutput` path at `src/mcp.ts:4885-4895`; S1 still correctly keeps the correction schema alias, because the dedicated correction schema is explicitly S6 work.
- The real MCP test Zod-parses the bundle and provenance `structuredContent`, and checks item ordinals/calories and source IDs. It passed in the DB gate. It must be relocated, not deleted.
- No migration file changed: `git diff --name-only <range> -- db/migrations` was empty.
- The range contains only S1 implementation/tests and S1 documentation. No S2 concurrency suite, migration work, NULL-total work, capture-media work, readiness, Supabase cleanup, or other later-slice implementation appeared.

## Independent verification

Commands executed at `dbff058d99e6e17d0d2fd23844f6b645b46d7a34`:

```text
bun run typecheck
# PASS: src/ typechecks clean

bun run test:unit
# PASS: unit 448 pass / 91 skip / 0 fail; 539 tests

DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
# PASS: DB 89 pass / 0 skip / 0 fail across 7 DB suites

bunx prettier --check README.md docs/food-tracking-agent-driven.md src/calculation-bundles.integration.test.ts src/calculation-bundles.test.ts src/calculation-bundles.ts src/mcp-food-tracking.test.ts src/mcp.test.ts src/mcp.ts src/meal-events.ts
# PASS: All matched files use Prettier code style.

git diff --check
# PASS: silent
```

The DB gate explicitly verified the two required URLs are equal and ran suites sequentially. Counts increased from the S0 baseline: unit `445/84/0` to `448/91/0`; DB `82/0/0` to `89/0/0` across the unchanged seven-suite S1 gate.

## Exact coder-kimi fixes plan (do not alter production code)

1. Create a durable S1 coder handoff artifact (or append a clearly headed S1 TDD evidence section to the prescribed handoff location) containing the exact RED, GREEN, and REFACTOR commands and unedited relevant output. The RED record must show the new per-scope test failing against the pre-S1 behavior for the stated reason; do not manufacture a retrospective RED claim. Include unit and DB pass/skip/fail counts separately.
2. In `src/mcp-food-tracking.test.ts`, move lines 319-428 into a new, accurately named `describeDb`, e.g. `"calculation bundle MCP per-scope readback"`. Give it its own `Pool` lifecycle and migration reset hook (or an extracted explicitly named shared reset helper) so it remains independently runnable and does not borrow the unrelated `log_meal_event` describe's identity.
3. Preserve the existing real transport assertions: submit the event+item bundle through `commit_calculation_bundle`, Zod-parse structured output, read it through `get_calculation_provenance`, Zod-parse it, and assert the three scope rows / scope-local IDs. Do not weaken the direct SQL cross-check.
4. Do not modify production files, migrations, S2 concurrency tests, or later-slice scope for these remediation items.
5. Run and record: `bun run typecheck`; `bun run test:unit`; the exact DB command above; changed-file Prettier; and `git diff --check`. Leave the remediation handoff and commit metadata ready for Terra re-review.

## Repository action

- Review document: `.hermes/plans/2026-08-05-gap-remediation-s1-terra-review.md`
- Commit: none (required FAIL behavior)
- Push: not attempted
- Tree status after this review: the review document is intentionally untracked; all pre-existing project files remain untouched.

S1 REVIEW COMPLETE
