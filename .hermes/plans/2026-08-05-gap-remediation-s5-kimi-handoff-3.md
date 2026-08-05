# S5 remediation handoff 3 — commit-outcome reconciliation (coder-kimi)

Date: 2026-08-05
Slice: S5 — public capture media path with real byte lifecycle
Remediation for: `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review-2.md` (FAIL, findings F1 post-COMMIT data loss, F2 ON CONFLICT orphan handling)
Remediation code commit: `ed9e822` — `fix: reconcile capture media after ambiguous commits`
Previous HEAD: `a137af2d20f93c52ac79f24a250ef9aa5b857b7f`
New commit range: `a137af2..ed9e822` (code+tests), plus a docs commit for this handoff and the immutable review-2.

## Scope statement

S5 second remediation only. No migrations changed (`git diff --name-only a137af2..ed9e822 -- db/migrations` is empty), no S6 work started, no provider/Telegram/MFP/STT/OCR/vision behavior touched, no existing test deleted or weakened. Unrelated transactions keep the original `withTransaction`; the phase-aware helper is a new, separate export used only by `attachCaptureMediaBytes`.

Immutable artifacts preserved byte-identically (verified by SHA-256 before commit and after push):

- `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review-2.md`: `28cdde9a7322c1806e202c8476c97244be9c9260227e4f9d488e5590c791816b`
- `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review.md`: `44ac7006a880a0e6abb93e9c040ae70904eb52661d02f6639fd7fc6bd28d3f38`

## Root causes (recap of review-2)

- **F1:** `withTransaction` treated every COMMIT-query error as a rollback condition. When PostgreSQL durably commits but the COMMIT acknowledgement is lost, the subsequent ROLLBACK does not undo the committed transaction, yet the attach catch still deleted the staged file — leaving a durable `meal_capture_media` row referencing destroyed bytes.
- **F2:** the defense-in-depth `ON CONFLICT` branch cleared cleanup ownership unconditionally before reading the conflicting row, so a non-cooperating conflicting row with a DIFFERENT `storage_key` left this invocation's newly staged, unreferenced deterministic key on disk forever.

## Fix design

### Phase-aware transaction completion (`src/db.ts`, new exports)

`withTransactionCommitPhases(pool, fn)` + `UnknownCommitOutcomeError`:

- Failure BEFORE COMMIT (BEGIN/callback): ordinary semantics — ROLLBACK, original error rethrown. The transaction definitively did not commit.
- Failure AT/AFTER COMMIT: UNKNOWN outcome. No ROLLBACK is issued (it cannot prove anything about an already-committed transaction); the uncertain client is DISCARDED from the pool (`client.release(err)` destroys the connection, which also rolls the server side back if COMMIT truly never landed); an `UnknownCommitOutcomeError` wrapping the original error (`cause`) is thrown.

`withTransaction` is unchanged; no other caller uses the new helper.

### Attach cleanup (`src/meal-captures.ts`)

- Pre-COMMIT failures keep the existing ordinary rollback cleanup: the invocation-owned staged file is deleted and no row exists.
- UNKNOWN commit outcome: no immediate deletion. `reconcileStagedKeyAfterUnknownCommit` runs on a FRESH connection under a FRESH capture-row `FOR UPDATE` lock and applies the reconciliation invariant below. The original error is still returned to the caller.
- ON CONFLICT branch: after reading the conflicting row under the lock, the staged bytes are retained only when `row.storage_key === staged.storage_key` (ownership transfers to the committed row; never deleted on any outcome). When keys differ, the invocation-owned, provably unreferenced staged key is deleted AFTER a safe, acknowledged commit (or by reconciliation after an unknown outcome). A delete failure retains a bounded orphan (one deterministic key per capture/sha256) and never fails a committed attach.

### Reconciliation invariant

Under the fresh capture-row lock (which serializes against every cooperating attach/confirm of the capture):

1. If the `(capture_id, sha256)` row exists and references exactly the staged key → commit landed; RETAIN the bytes.
2. If the row is absent, or exists with a different key → delete the staged key ONLY when a locked reference scan proves ZERO references to that exact key in both `meal_capture_media` and `meal_event_media`; the delete happens while the lock is still held (before the reconciliation COMMIT), so no racing cooperating attach can interleave a new reference between the absence proof and the delete.
3. If reconciliation is unavailable or ambiguous (no fresh connection, query failure, unreadable capture row, failed reconciliation COMMIT) → RETAIN the possible orphan. The function never throws; retention is always the safe failure mode.

No DDL was required to build safe reconciliation.

## RED evidence (adversarial, BEFORE the fix)

Four new real PostgreSQL + real temp-filesystem tests added to `src/meal-captures.integration.test.ts` (describe: "capture media commit-outcome reconciliation (S5 remediation 2)"). Injection seams are one-shot pool proxies — no production code touched:

- `poolLosingCommitAcknowledgement`: runs the REAL COMMIT on the server, then rejects only the acknowledgement returned to the caller.
- `poolLosingCommitAckAndFailingReconnect`: additionally refuses every later connection, making reconciliation unavailable.
- `poolRejectingCommitBeforeSend`: rejects COMMIT without sending it.
- `poolHidingFirstMediaIdentityCheck`: masks the first identity SELECT, simulating a non-cooperating conflicting row (committed beforehand via raw SQL WITHOUT the capture lock, DIFFERENT storage_key) arriving between the identity check and the INSERT.

Command (unfixed HEAD `a137af2` + new tests only):

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/meal-captures.integration.test.ts --max-concurrency 1
```

Result: **17 pass / 3 fail** —

```text
(fail) real COMMIT succeeds then acknowledgement is lost: attach rejects but row and file survive, retry returns the original identity
       expect(await Bun.file(path).exists()).toBe(true) -> Received: false   (committed file deleted; dbRows = 1)
(fail) real COMMIT succeeds then acknowledgement is lost AND reconciliation is unavailable: possible orphan is retained, never deleted
       expect(await Bun.file(path).exists()).toBe(true) -> Received: false   (committed file deleted; dbRows = 1)
(pass) COMMIT rejected before being sent: reconciliation proves no row and removes the staged file
       behavior guard — pre-fix code already deleted the staged file after a pre-send COMMIT failure; pins the required post-fix outcome
(fail) non-cooperating conflicting row with a different key: conflict row and file survive, redundant staged key is removed
       expect(await Bun.file(join(mediaRoot, stagedKey)).exists()).toBe(false) -> Received: true   (unreferenced staged key retained forever)
 17 pass / 3 fail / 118 expect() calls / Ran 20 tests
```

All 16 pre-existing S5 tests passed during RED; only the three new adversarial assertions failed, exactly reproducing review-2's F1 (file destroyed while its committed row survived) and F2 (unbounded different-key orphan).

## GREEN evidence (AFTER the fix, commit `ed9e822`)

Focused suites including the full MCP path:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test \
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts src/media-store.test.ts --max-concurrency 1
```

```text
42 pass / 0 fail / 264 expect() calls / Ran 42 tests across 3 files
```

- Ack-lost-after-real-commit: attach rejects, but the one `meal_capture_media` row and the real file survive; recomputed on-disk SHA-256 equals the row SHA; a clean retry returns `deduplicated: true` with the ORIGINAL `media_id`/`storage_key`.
- Ack-lost + reconciliation unavailable: possible orphan retained, row/file intact, retry returns original identity.
- COMMIT rejected before send: reconciliation proves no row under a fresh lock and removes the staged file; zero rows, zero files.
- Non-cooperating conflicting row with a different key: attach resolves to the conflicting row's identity (`media_id`, `storage_key`), the conflict row and its file survive byte-identically, and the redundant invocation-owned staged key is removed.
- All prior S5 adversarial/public MCP tests preserved and passing: wrong-user same-bytes, post-cancel, post-confirm with `meal_event_media` reference, injected duplicate identity-check failure, coordinated concurrent successes with rejected/failing participants, normal dedup, initial INSERT rollback, missing/corrupt healing, and the full `attach_meal_capture_media` MCP suite.

Post-Prettier re-run of the touched suite: `20 pass / 0 fail` in `src/meal-captures.integration.test.ts`.

## REFACTOR evidence

No behavior-changing refactor followed GREEN. The fix itself is the restructure (phase-aware helper + reconciliation + exact-key conflict resolution); comment blocks document the contract. No production code was touched after the green run except Prettier formatting, which was re-verified by the focused-suite re-run above.

## Gate battery (both URLs = postgres://localhost:5432/nutrition_mcp_test)

```text
bun run typecheck
src/ typechecks clean

bun run test:unit
Unit gate totals: 481 pass, 0 fail, 138 skip, 619 tests (DB suites are run by test:db).

DATABASE_URL=... DATABASE_URL_TEST=... bun run test:db
src/db.integration.test.ts: 5 pass, 0 fail, 0 skip, exit 0
src/meal-events.test.ts: 41 pass, 0 fail, 0 skip, exit 0
src/calculation-bundles.integration.test.ts: 13 pass, 0 fail, 0 skip, exit 0
src/meal-captures.integration.test.ts: 20 pass, 0 fail, 0 skip, exit 0
src/mcp-food-tracking.test.ts: 14 pass, 0 fail, 0 skip, exit 0
src/backup-policy.test.ts: 7 pass, 0 fail, 0 skip, exit 0
src/legacy-meal-tools.integration.test.ts: 16 pass, 0 fail, 0 skip, exit 0
src/calculation-acceptance.integration.test.ts: 8 pass, 0 fail, 0 skip, exit 0
DB gate totals: 124 pass, 0 fail, 0 skip, 124 tests across 8 DB suites.

bunx prettier --check src/db.ts src/meal-captures.ts src/meal-captures.integration.test.ts
All matched files use Prettier code style!

git diff --check
silent / success
```

Exact DB-gate suite counts: `5 + 41 + 13 + 20 + 14 + 7 + 16 + 8 = 124` across eight suites, zero skips, zero failures.

## Gate-delta reconciliation vs immediate S5 baseline

Immediate pre-remediation baseline (immutable FAIL review): **479 unit pass / 114 DB pass**; previous remediation HEAD `a137af2`: **481 unit pass / 120 DB pass**.

After this remediation:

- Unit: **481 pass** (unchanged), 0 fail, 619 tests (+6). The 138 skips (+6 vs `a137af2`) are DB-gated entries delegated to `test:db`: the 4 new tests plus bun's per-skipped-describe counting for the one new describe block (verified: this file alone contributes 22 skips at `a137af2` vs 28 now when run without DB env).
- DB: **124 pass** (+4 new commit-outcome/conflict tests), 0 fail, 0 skip; `src/meal-captures.integration.test.ts` grew 16 → 20.
- No test files deleted; test inventory only grew.

## Changed files (commit `ed9e822`)

- `src/db.ts` — `UnknownCommitOutcomeError` + `withTransactionCommitPhases` (phase-aware completion; `withTransaction` untouched).
- `src/meal-captures.ts` — attach uses the phased helper; `reconcileStagedKeyAfterUnknownCommit` (fresh-connection, fresh-lock reconciliation); exact-key ON CONFLICT resolution with post-commit redundant-key removal.
- `src/meal-captures.integration.test.ts` — +4 real PostgreSQL/filesystem tests + 4 one-shot injection pool proxies.

Commit delta: `668 insertions / 92 deletions` across the three files. Docs commit: this handoff plus the immutable reviewer-terra FAIL review-2 (byte-identical, SHA-256 `28cdde9a7322c1806e202c8476c97244be9c9260227e4f9d488e5590c791816b`) as `docs: record S5 commit-outcome remediation`.

## Known limitations

- The unknown-outcome path can retain a bounded orphan only in the already-safe direction (file retained while unreferenced); the key is deterministic (`capture/<capture_id>/<kind>-<sha256>`), so retention cannot grow unbounded per capture/sha256 pair.
- Reconciliation runs synchronously before the original error is returned; if no fresh connection is available the orphan is retained for a later retry's heal/dedup path (a retry returns the original committed identity when the commit landed).
- The ON CONFLICT different-key branch remains unreachable for cooperating writers (both public attach and internal `saveCaptureMedia` hold the capture lock); it is now correctly handled and pinned by the non-cooperating-writer test rather than assumed away.

**S5 SECOND REMEDIATION COMPLETE — ready for re-review.**
