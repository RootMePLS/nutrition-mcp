# S5 remediation handoff 2 — F1 durability fix (coder-kimi)

Date: 2026-08-05
Slice: S5 — public capture media path with real byte lifecycle
Remediation for: `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review.md` (FAIL, finding F1)
Remediation commit: `4fd213f` — `fix: preserve committed capture media during rejected retries`
Previous HEAD: `645f5778d5451462231e8c6ac23cf2645a66a0e6`
New commit range: `645f577..4fd213f` (code+tests), plus docs commit for this handoff and the immutable review.

## Scope statement

S5 remediation only. No migrations changed (`git diff --name-only 645f577..4fd213f -- db/migrations` is empty), no S6 work started, no existing tests deleted or weakened. The full MCP path (`attach_meal_capture_media`) is unchanged at the call site and covered by the DB gate.

## F1 root cause (recap)

`attachCaptureMediaBytes` staged bytes via `mediaStore.putCapture` BEFORE the ownership/state transaction, and its catch block unconditionally deleted `staged.storage_key`. Because the key is deterministic (`capture/<capture_id>/<kind>-<sha256>`), any rejected, failed, or racing duplicate attach of already-committed bytes deleted the committed file while its `meal_capture_media` row (and any `meal_event_media` copy) survived.

## Fix design — cleanup ownership invariant

`src/meal-captures.ts` (`attachCaptureMediaBytes`) now:

1. Opens the per-capture `SELECT ... FOR UPDATE` transaction FIRST and validates ownership/editable state before ANY filesystem I/O — rejected requests (wrong user, cancelled/confirmed/expired) never touch disk.
2. Establishes existing `(capture_id, sha256)` identity under the same lock before staging. The lock is held across the local filesystem write, so concurrent same-capture attaches serialize and later attempts always observe the committed row.
3. Tracks cleanup ownership explicitly in `stagedByThisInvocation`: set ONLY when a file is staged for a NEW, still-uncommitted row; cleared on commit, and cleared (never deleted) if a conflicting row ever appears. Ownership is NEVER inferred from the deterministic `storage_key`.
4. Existing-row retries own nothing for cleanup: they verify the referenced file via `mediaStore.read(key, sha256)` and, only if it is missing or corrupt, safely heal it via the new `MediaStore.restore` seam with the identical content-addressed bytes (healing can only restore, never destroy). No deletion occurs on this path under any outcome.
5. Rollback cleanup deletes only `stagedByThisInvocation` — a file proven newly created by this invocation and never referenced by a committed row. Initial stage/insert rollback (no row, no file) and normal dedup identity (one row, one file, same media_id/storage_key) are preserved.

`src/media-store.ts`: added `restore({storage_key, bytes, mime_type})` to the `MediaStore` interface/implementation — writes and verifies bytes at an already-referenced, server-generated key with the same unsafe-key/containment checks as every other entry point.

## RED evidence (adversarial, BEFORE the fix)

Six new real PostgreSQL + real temp-filesystem tests were added to `src/meal-captures.integration.test.ts` (describe: "capture media durability under rejected and duplicate retries (S5 F1)"). Each first attaches valid PNG bytes and commits the row, then proves the original row, file bytes, and recomputed committed SHA-256 survive. New failure-injection seam: `poolFailingMediaIdentityCheck` (rejects the media identity SELECT once armed).

Command (unfixed HEAD `645f577` + new tests only):

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/meal-captures.integration.test.ts --max-concurrency 1
```

Result: **11 pass / 5 fail** — every failure is `expect(await Bun.file(path).exists()).toBe(true)` → `Received: false` at `expectCommittedMediaIntact`, i.e. the committed file was deleted:

```text
(fail) wrong-user retry of committed bytes preserves the original row and file
(fail) same-owner retry after cancel preserves the original row and file
(fail) same-owner retry after confirmation preserves the original row, file, and event reference
(fail) injected transactional failure on a duplicate attempt preserves the original row and file
(fail) coordinated concurrent duplicate success and rejected/failing attempts preserve the original row and file
(pass) dedup retry heals a missing committed file with identical bytes   # behavior guard: old code re-staged, so it passed pre-fix
 11 pass / 5 fail / 88 expect() calls / Ran 16 tests
```

The DB rows survived in all RED cases (`dbRows = 1`); only the file bytes were destroyed — exactly reviewer-terra's F1 reproduction.

## GREEN evidence (AFTER the fix, commit `4fd213f`)

Same command, focused suites including the full MCP path:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts src/media-store.test.ts --max-concurrency 1
```

```text
38 pass / 0 fail / 233 expect() calls / Ran 38 tests across 3 files
```

- All 6 F1 adversarial tests pass: wrong-user rejection, post-cancel rejection, post-confirmation rejection (with `meal_event_media` reference verified), injected transactional failure on a duplicate attempt, and the coordinated concurrent case (2 fulfilled dedups returning the original media_id/storage_key + intruder rejection + injected failure — original row, bytes, and recomputed SHA intact).
- The heal test proves a dedup retry restores a deleted committed file with byte-identical content.
- Concurrency evidence: same-capture attaches serialize on the capture row lock; duplicate successes both return `deduplicated: true` with the original identity; the rejected/failing participants perform no deletion.
- All pre-existing S5 lifecycle tests (happy path, injected-INSERT rollback removing the new unreferenced file, retry-safe dedup, tampered hash, state guard, cross-user) still pass unchanged.

Post-Prettier re-run of the touched suite: `16 pass / 0 fail` in `src/meal-captures.integration.test.ts`.

## REFACTOR evidence

No behavior-changing refactor followed GREEN. The fix itself is the restructure (lock-first ordering + explicit ownership + restore seam); comment blocks in `src/meal-captures.ts` and `src/media-store.ts` document the durability contract. Two `restore` unit tests added to `src/media-store.test.ts` (verified rewrite at a referenced key; unsafe-key rejection). No production code was touched after the green run.

## Gate battery (both URLs = postgres://localhost:5432/nutrition_mcp_test)

```text
bun run typecheck
src/ typechecks clean

bun run test:unit
481 pass / 132 skip / 0 fail (613 tests)
Unit gate totals: 481 pass, 0 fail, 132 skip, 613 tests (DB suites are run by test:db).

DATABASE_URL=... DATABASE_URL_TEST=... bun run test:db
src/db.integration.test.ts: 5 pass, 0 fail, 0 skip, exit 0
src/meal-events.test.ts: 41 pass, 0 fail, 0 skip, exit 0
src/calculation-bundles.integration.test.ts: 13 pass, 0 fail, 0 skip, exit 0
src/meal-captures.integration.test.ts: 16 pass, 0 fail, 0 skip, exit 0
src/mcp-food-tracking.test.ts: 14 pass, 0 fail, 0 skip, exit 0
src/backup-policy.test.ts: 7 pass, 0 fail, 0 skip, exit 0
src/legacy-meal-tools.integration.test.ts: 16 pass, 0 fail, 0 skip, exit 0
src/calculation-acceptance.integration.test.ts: 8 pass, 0 fail, 0 skip, exit 0
DB gate totals: 120 pass, 0 fail, 0 skip, 120 tests across 8 DB suites.

bunx prettier --check src/meal-captures.ts src/meal-captures.integration.test.ts src/media-store.ts src/media-store.test.ts
All matched files use Prettier code style!

git diff --check
silent / success
```

Exact DB-gate suite counts: `5 + 41 + 13 + 16 + 14 + 7 + 16 + 8 = 120` across eight suites, zero skips, zero failures.

## Gate-delta reconciliation vs immediate S5 baseline

Immediate S5 baseline (from the FAIL review): **479 unit pass / 114 DB pass**.

After remediation:

- Unit: **481 pass** (+2: `restore` write/verify and unsafe-key tests in `src/media-store.test.ts`), 0 fail. The 132 skips are the same DB-gated tests delegated to `test:db` (124 baseline + 8 newly counted DB-gated skips from the F1 describe block running without DB env in the unit gate).
- DB: **120 pass** (+6 F1 adversarial tests), 0 fail, 0 skip; `src/meal-captures.integration.test.ts` grew 10 → 16.
- No test files deleted; test inventory only grew.

## Changed files (commit `4fd213f`)

- `src/meal-captures.ts` — lock-first attach, explicit cleanup ownership, heal-on-dedup, defense-in-depth conflict branch.
- `src/media-store.ts` — `MediaStore.restore` interface + implementation.
- `src/media-store.test.ts` — +2 `restore` unit tests.
- `src/meal-captures.integration.test.ts` — +6 F1 adversarial DB tests + `poolFailingMediaIdentityCheck` injection seam.

Docs commit (this handoff + the immutable reviewer-terra FAIL review, preserved byte-identical, SHA-256 `44ac7006a880a0e6abb93e9c040ae70904eb52661d02f6639fd7fc6bd28d3f38`): `docs: record S5 durability remediation`.

## Known limitations

- Holding the per-capture row lock across the local filesystem write bounds critical-section length to one local disk write/read per attach; this is the bounded design sanctioned for S5. Cross-capture attaches are unaffected (capture-scoped keys, per-capture locks).
- The defense-in-depth `ON CONFLICT` branch is unreachable while all writers of `(capture_id, sha256)` hold the capture lock (both `attachCaptureMediaBytes` and `saveCaptureMedia` do); it exists only to guarantee no future writer regression can turn cleanup into referenced-byte deletion.

**S5 REMEDIATION COMPLETE — ready for re-review.**
