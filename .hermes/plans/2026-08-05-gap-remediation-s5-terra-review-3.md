# S5 reviewer-terra final re-review — PASS

Date: 2026-08-05
Slice: S5 — public capture media path with real byte lifecycle
Reviewer: reviewer-terra
Original S5 range: `65d29c023bb2b3c7349f124c859bec7768226657..645f5778d5451462231e8c6ac23cf2645a66a0e6`
Prior remediation: `645f5778d5451462231e8c6ac23cf2645a66a0e6..a137af2d20f93c52ac79f24a250ef9aa5b857b7f`
Final remediation reviewed: `a137af2d20f93c52ac79f24a250ef9aa5b857b7f..0e34bb54a68959b47831f96c7717dc3d5e252b11`
Final code commit: `ed9e822` (`fix: reconcile capture media after ambiguous commits`)
Reviewed HEAD: `0e34bb54a68959b47831f96c7717dc3d5e252b11`

## Verdict

**PASS — S5 is accepted.** The final remediation resolves both review-2 blockers without changing the S5 public contract or expanding into DDL, S6, or provider/transport work.

## Immutable prior-review verification

The required immutable artifacts were read and verified byte-for-byte by SHA-256:

```text
44ac7006a880a0e6abb93e9c040ae70904eb52661d02f6639fd7fc6bd28d3f38  .hermes/plans/2026-08-05-gap-remediation-s5-terra-review.md
28cdde9a7322c1806e202c8476c97244be9c9260227e4f9d488e5590c791816b  .hermes/plans/2026-08-05-gap-remediation-s5-terra-review-2.md
```

Both match the required hashes.

## Final remediation audit

### Transaction phases and uncertain-client handling

- `src/db.ts:75-138` adds the narrowly scoped `UnknownCommitOutcomeError` and `withTransactionCommitPhases`; the pre-existing `withTransaction` remains unchanged for unrelated callers.
- Before `COMMIT` is sent, failures take ordinary rollback handling and preserve the original error. The attach path can remove only an invocation-owned staged key in this definite rollback case.
- Once `COMMIT` has been sent, any query error becomes `UnknownCommitOutcomeError`, preserving the original error as `cause` (`src/db.ts:76-82`). No false `ROLLBACK` certainty is claimed or issued for that phase.
- The uncertain client is released with an error (`client.release(new Error(...))` at `src/db.ts:133-137`), so pg discards it rather than returning an untrustworthy connection to the pool.

### Fresh-connection reconciliation and capture locking

- On an unknown outcome, `attachCaptureMediaBytes` does not delete immediately (`src/meal-captures.ts:622-644`). It calls `reconcileStagedKeyAfterUnknownCommit` using a fresh `pool.connect()` client.
- Reconciliation starts a new transaction and obtains `SELECT id FROM meal_captures WHERE id=$1 FOR UPDATE` (`:332-336`) before evaluating identity or cleanup, retaining the S5 capture-scoped cooperating-writer serialization boundary.
- When the `(capture_id, sha256)` row refers to the staged key, it retains bytes. When that row is absent or refers elsewhere, it performs exact-key reference scans over **both** `meal_capture_media` and `meal_event_media` (`:359-367`). A staged key is deleted only at zero references while the capture lock remains held (`:368-373`).
- Connection failure, query failure, unreadable capture row, filesystem deletion failure, or reconciliation-commit failure is caught as ambiguous and retains bytes (`:374-392`). This is the correct no-data-loss direction.

### ON CONFLICT and bounded orphan policy

- The non-cooperating different-key conflict branch now compares `row.storage_key` with the invocation's staged key exactly (`src/meal-captures.ts:567-591`). A different key is marked as redundant and removed only after an acknowledged commit (`:594-609`), or reconciled as an unknown commit outcome (`:622-636`).
- The conflict row's referenced key is never deleted. If a post-commit deletion cannot be proven or itself fails, the retained orphan is bounded and deterministic: at most the content-addressed `capture/<capture_id>/<kind>-<sha256>` key per capture/kind/content identity. This is accepted because it favors retention over destructive cleanup and cannot grow per retry.

## Independent adversarial reproduction

Ran against real PostgreSQL and real temporary filesystem roots through the committed test proxies. All four required paths passed:

1. Real `COMMIT` succeeds and acknowledgement is lost: attach rejects with the injected original error; one `meal_capture_media` row and its real bytes remain; on-disk SHA-256 equals the row hash; retry returns the original `media_id` and `storage_key` with `deduplicated: true`.
2. Real `COMMIT` succeeds, acknowledgement is lost, and a fresh reconnect is unavailable: row and bytes remain; safe retention occurs rather than deletion; retry resolves to the original identity.
3. `COMMIT` is rejected before it is sent: fresh reconciliation proves no media row and removes the staged key; zero row and zero file remain.
4. A non-cooperating conflicting row with a different storage key: the referenced conflict row and bytes survive; the redundant staged key is removed.

The focused execution also re-ran and passed prior S5 protections: wrong-user retry, post-cancel retry, post-confirm retry with `meal_event_media` reference, injected duplicate identity-check failure, coordinated concurrent outcomes, normal retry/deduplication, initial INSERT rollback, missing-file healing, and full public MCP attach -> draft -> confirm.

## Scope and test inventory

- Full S5-chain changed paths are confined to S5 implementation/tests/docs: `README.md`, `docs/food-tracking-agent-driven.md`, `src/db.ts`, `src/mcp.ts`, `src/media-store.ts`, `src/meal-captures.ts`, their relevant test files, and S5 handoff/review artifacts.
- `git diff --name-only 65d29c0..0e34bb5 -- db/migrations` produced zero paths. No migration/DDL change exists.
- No S6 sweep is present: the output-schema additions are the S5 attach tool's declared contract only. No Telegram/MyFitnessPal/provider/STT/OCR/vision behavior was added to the media path.
- No test file was deleted. The final remediation adds four database/filesystem adversarial tests; the S5 chain adds test coverage rather than removing it.

## Commands independently run

All DB commands used:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test
```

```text
bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts src/media-store.test.ts --max-concurrency 1
42 pass / 0 fail / 264 expect() calls

bun run typecheck
src/ typechecks clean

bun run test:unit
481 pass / 138 skip / 0 fail (619 tests)

bun run test:db
124 pass / 0 fail / 0 skip across 8 suites
5 + 41 + 13 + 20 + 14 + 7 + 16 + 8 = 124

bunx prettier --check src/db.ts src/meal-captures.ts src/meal-captures.integration.test.ts src/mcp.ts src/mcp-food-tracking.test.ts src/media-store.ts src/media-store.test.ts
All matched files use Prettier code style!

git diff --check 65d29c0..0e34bb5
silent / success
```

## Honest gate deltas

Immediate pre-final-remediation baseline at `a137af2` (review-2 evidence): **481 unit pass / 120 DB pass**.

- Unit: **481 pass** (`+0`), 138 DB-gated skips, 0 fail.
- DB: **124 pass** (`+4`), 0 skip, 0 fail. The four additions are the commit-outcome and different-key conflict cases above.

For the complete post-original-FAIL trajectory, the immutable review-2 baseline was **479 unit pass / 114 DB pass**; accepted S5 ends at **481 unit pass / 124 DB pass**. The immediate delta is stated above rather than conflating the two remediation rounds.

## Remote state before review commit

Immediately before writing this review, local HEAD and `origin/main` both resolved to `0e34bb54a68959b47831f96c7717dc3d5e252b11`; ahead/behind was `0 0`.

**S5 FINAL RE-REVIEW COMPLETE — PASS.**
