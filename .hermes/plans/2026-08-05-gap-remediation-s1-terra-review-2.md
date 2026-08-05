# S1 reviewer-terra remediation re-review — PASS

Reviewed original S1 range: `be94d985ec587f08a69809a2fd2c7dc039da7317..dbff058d99e6e17d0d2fd23844f6b645b46d7a34`

Reviewed remediation range: `dbff058d99e6e17d0d2fd23844f6b645b46d7a34..c851e453c376dd7790e77862f1b59af807d31c72`

Remediation commits:

1. `90088b0ba1e8e277a7750252bcb79ecef1e04a03` — `test: isolate per-scope MCP acceptance suite`
2. `c851e453c376dd7790e77862f1b59af807d31c72` — `docs: record S1 review and TDD handoff`

## Verdict

PASS — both blockers in the original Terra FAIL review are remediated, the accepted original S1 implementation remains in scope and substantiated, and all required independent gates pass. This document is the immutable re-review artifact.

## Original FAIL review and TDD evidence

- `.hermes/plans/2026-08-05-gap-remediation-s1-terra-review.md` is present in the remediation commit and hashes byte-identically to its committed blob (`PRESERVED_BYTE_IDENTICAL`). Its FAIL verdict and exact coder-kimi plan are preserved without alteration.
- The new coder handoff explicitly says the original historical RED was not persisted and does not present the later run as historical evidence. It consistently labels the evidence `REPRODUCED RED`.
- The claimed reproduction is independently reproducible. I created a new detached temporary worktree at `be94d985ec587f08a69809a2fd2c7dc039da7317`, symlinked only the main checkout's `node_modules`, and applied exactly `git diff be94d98..afad258 -- src/mcp-food-tracking.test.ts`. The temporary-worktree diff was exactly `M src/mcp-food-tracking.test.ts`, `115 insertions / 0 deletions`; no production file was patched.
- With both URLs set to `postgres://localhost:5432/nutrition_mcp_test`, the independent old-code run exited 1 with `8 pass / 1 fail / 9 tests`. The sole added per-scope test failed at the event canonical assertion: expected `505`, received `201`. This demonstrates the old single-event-row defect (an item-scoped value contaminating the event canonical) without falsely claiming a historical RED run. The temporary worktree was removed; `git worktree list` subsequently showed only the main checkout.
- The handoff separately records current GREEN unit and DB totals and names `persistCanonicalPerScope` as the shared bundle/correction REFACTOR path. Source inspection confirms the helper's scope-local `ordinal IS NOT DISTINCT FROM $3` and `status = 'succeeded'` source-ID query.

## MCP suite isolation and assertions

- The real MCP acceptance test is now in its own accurately named lifecycle: `calculation bundle MCP per-scope readback (requires DATABASE_URL_TEST)` in `src/mcp-food-tracking.test.ts:318-461`.
- It has an independent `Pool` (`beforeAll`/`afterAll`), analytics drain (`afterEach`), and schema/migration reset (`beforeEach`). `resetSchemaWithMigrations(pool, migrations)` is a test-only, explicitly named shared reset helper; it preserves the prior drop/replay migration behavior for all three DB describes.
- The moved test still uses real `InMemoryTransport` to call `commit_calculation_bundle` then `get_calculation_provenance`, Zod-parses both structured outputs, asserts the event plus item 0/item 1 canonical calories and ordinals, asserts scope-local item `source_result_ids`, and directly checks the three persisted scope keys (`event`, `item:0`, `item:1`). Remediation diff review found a relocation/lifecycle extraction only; the test declaration remains exactly one occurrence.
- No real test was lost. `src/mcp-food-tracking.test.ts` has 9 `test(...)` declarations at both `dbff058` and `c851e45`; the per-scope declaration appears exactly once at each revision. With database variables absent, Bun reports 15 skipped entries: 9 real tests plus two skipped-wrapper entries for each of the now three `describeDb` wrappers. At `dbff058`, the corresponding two-wrapper count was 13. The explained +2 skip count is therefore wrapper accounting, not added or removed real tests. The PostgreSQL gate runs all 9 file tests with 0 skips.

## Scope and original-S1 acceptance review

- The remediation range changes exactly three files: the preserved FAIL review, the coder handoff, and `src/mcp-food-tracking.test.ts`. It changes no production source file and no migration (`git diff --name-only <remediation-range> -- db/migrations` is empty). No S2 concurrency/acceptance-matrix file or behavior is present.
- The accepted original S1 implementation remains aligned with Slice S1: `persistCanonicalPerScope` persists event and item scopes with scope-local source IDs; the original DB suite still contains the required per-scope rows/source IDs, negative item-to-event isolation, mixed-status, retry, correction/prior-version immutability, and rollback tests. S1's real MCP round trip parses the public bundle and provenance schemas. No migration was introduced, as required by the S1 non-goal.

## Independent verification at `c851e453c376dd7790e77862f1b59af807d31c72`

```text
bun run typecheck
PASS: src/ typechecks clean

bun run test:unit
PASS: 448 pass / 93 skip / 0 fail; 541 tests across 33 files

DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
PASS: 89 pass / 0 skip / 0 fail; 89 tests across 7 DB suites
  src/db.integration.test.ts: 5
  src/meal-events.test.ts: 41
  src/calculation-bundles.integration.test.ts: 13
  src/meal-captures.integration.test.ts: 4
  src/mcp-food-tracking.test.ts: 9
  src/backup-policy.test.ts: 7
  src/legacy-meal-tools.integration.test.ts: 10

bunx prettier --check .hermes/plans/2026-08-05-gap-remediation-s1-kimi-handoff.md .hermes/plans/2026-08-05-gap-remediation-s1-terra-review.md src/mcp-food-tracking.test.ts
PASS: All matched files use Prettier code style.

git diff --check
PASS: silent
```

## Repository action

- Review document: `.hermes/plans/2026-08-05-gap-remediation-s1-terra-review-2.md`
- Verdict: PASS
- Commit/push: performed immediately after this immutable review is written; only this review document is included.

S1 RE-REVIEW COMPLETE
