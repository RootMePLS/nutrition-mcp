# S5 reviewer-terra re-review 2 — FAIL

Date: 2026-08-05
Slice: S5 — public capture media path with real byte lifecycle
Reviewer: reviewer-terra
Original accepted S5 range: `65d29c023bb2b3c7349f124c859bec7768226657..645f5778d5451462231e8c6ac23cf2645a66a0e6`
Remediation reviewed: `645f5778d5451462231e8c6ac23cf2645a66a0e6..a137af2d20f93c52ac79f24a250ef9aa5b857b7f`
Remediation code commit: `4fd213f`
Reviewed HEAD: `a137af2d20f93c52ac79f24a250ef9aa5b857b7f`

## Verdict

**FAIL — commit-acknowledgement ambiguity can still delete a now-referenced capture-media file. Do not accept S5, do not commit this review, and do not advance to S6.**

The F1 fix is materially correct for normal rejected/duplicate paths: it validates ownership/state and resolves existing media under `SELECT ... FOR UPDATE` before filesystem I/O; it holds the capture-row lock over the bounded local write; existing-row retry verifies/heals without deletion; and the added adversarial cases pass. However, the cleanup invariant is not true when the server commits but the client loses the COMMIT acknowledgement.

## Immutable prior FAIL verification

SHA-256 of `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review.md`:

```text
44ac7006a880a0e6abb93e9c040ae70904eb52661d02f6639fd7fc6bd28d3f38
```

This exactly matches the required immutable hash.

## Blocking findings

### F1 — post-COMMIT acknowledgement failure deletes committed, referenced bytes

**Severity:** blocking / durability data loss

**Files:**

- `src/db.ts:50-65`
- `src/meal-captures.ts:362-481`, specifically `stagedByThisInvocation` remains non-null until `withTransaction` resolves at `:463`, then catch deletes it at `:476-480`.

`withTransaction` executes the callback, sends `COMMIT`, and returns only after the COMMIT query promise resolves. Its catch treats every COMMIT-query error as a rollback condition. A transport failure can occur after PostgreSQL has durably committed the transaction but before the client receives the acknowledgement. The subsequent `ROLLBACK` does not undo that already committed transaction. `attachCaptureMediaBytes` nevertheless still believes it owns the staged key and deletes it.

### Independent adversarial reproduction

I used a real PostgreSQL database and real temporary filesystem root. The test pool proxy ran the real `COMMIT` successfully, then rejected only the acknowledgement returned to `withTransaction`:

```json
{
    "rejection": "Error: injected lost COMMIT acknowledgement after server commit",
    "dbRows": 1,
    "storageKey": "capture/1f813801-a72b-42c0-be83-bd0cbac61d14/photo-4353a1de7e0dcc4e87350e22d5c9ee9f3e70e8ce9c31533ec991bee8870c4814",
    "dbSha": "4353a1de7e0dcc4e87350e22d5c9ee9f3e70e8ce9c31533ec991bee8870c4814",
    "exists": false,
    "recomputedSha": null
}
```

Thus the durable `meal_capture_media` reference survived while its bytes did not. This is the same class of data loss as the original F1, now reachable on an ambiguous commit outcome rather than a rejected duplicate.

### F2 — ON CONFLICT defense branch chooses an unbounded orphan over a provably unreferenced staged copy

**Severity:** blocking against the stated rollback/orphan acceptance constraint

**File:** `src/meal-captures.ts:444-459`

The claimed defense-in-depth branch clears `stagedByThisInvocation` before querying the conflicting row. If a future/direct writer creates the same `(capture_id, sha256)` identity with a different `storage_key`, this invocation's deterministic staged key is newly created and unreferenced, but is retained forever. The code assumes it coincides with a referenced key without checking `row.storage_key === staged.storage_key`.

The branch is unreachable for current cooperating writers because both public/internal writers lock the capture row. That reduces operational likelihood, but does not establish the claimed invariant or meet the requested ON CONFLICT/orphan audit. The old S5 behavior explicitly removed the redundant staged copy when the conflict row used another key.

## Exact fixes required from coder-kimi

Keep this strictly S5 remediation; do not change migrations, do not start S6, do not alter providers/Telegram/MFP/STT/OCR/vision behavior, and do not weaken/remove tests.

1. Make transaction completion phase-aware for this filesystem/DB boundary. A COMMIT error is an **unknown outcome**, not proof of rollback. Do not run ordinary staged-byte deletion solely because `withTransaction` rejected after beginning COMMIT.
2. Keep the current rollback cleanup for failures definitively before COMMIT (e.g. stage/INSERT failure): it must still remove the newly staged file and leave no media row.
3. For an unknown COMMIT outcome, never delete immediately. Reconcile on a fresh usable connection: lock the capture row and query `(capture_id, sha256)` while that lock is held. If the committed row exists, retain the file. Only if the fresh locked reconciliation definitively proves the media row absent may it delete the newly staged key; if reconciliation itself is unavailable/ambiguous, retain the possible orphan rather than delete potentially referenced data. Do not issue `ROLLBACK` as if it proves a post-COMMIT failure was rolled back; discard/release the uncertain connection appropriately.
4. Add real PostgreSQL + filesystem tests for both commit outcomes:
    - proxy runs real COMMIT then loses its acknowledgement: attach rejects, but the one capture-media row and real file remain; recomputed on-disk SHA equals the row SHA;
    - proxy rejects COMMIT before sending it: no row and no file remain;
    - include a retry/reconciliation assertion so the retained committed file returns the original media identity.
5. Correct the `ON CONFLICT` branch. After reading the conflict row, retain the staged key only when it is exactly the row's referenced key. If storage keys differ, delete only the invocation-owned, newly staged, still-unreferenced key, under a capture lock/reconciliation that excludes a racing attach. Add a test with an injected/non-cooperating conflicting row with a different key, asserting the conflict row/file survives and the redundant staged key is removed. If the implementation instead intentionally retains this orphan, document the bounded orphan policy and demonstrate that it cannot grow unbounded; the current unconditional retention is not acceptable.
6. Preserve and rerun all current F1 adversarial tests: wrong-user same-bytes, post-cancel, post-confirm with `meal_event_media` reference, injected duplicate failure, coordinated concurrent successes with rejected/failing participants, normal dedup, initial INSERT rollback, missing and corrupt existing-file healing. Every pre-existing-row case must assert capture row, event reference where applicable, actual file bytes, and recomputed SHA-256.

## What independently passed

- Original wrong-user same-bytes defect was independently reproduced at old S5 HEAD `645f577`: before `true`, rejected `capture not found`, after `false`, and `dbRows: 1`.
- Normal remediation focused suite passed: `38 pass / 0 fail` across `src/meal-captures.integration.test.ts`, `src/mcp-food-tracking.test.ts`, and `src/media-store.test.ts`.
- Added F1 tests passed for wrong-user, cancelled, confirmed with `meal_event_media` reference, duplicate identity-check failure, and coordinated two successful + rejected + failing callers. Their helper asserts the original DB row, real bytes, and recomputed SHA.
- Independent corrupt-file healing passed: a deliberately overwritten committed file was restored by a deduplicated attach; one row retained its original id, the byte sequence matched the original, and the recomputed SHA was `4353a1de7e0dcc4e87350e22d5c9ee9f3e70e8ce9c31533ec991bee8870c4814`.
- Lock-first ordering is present: user/state validation and `(capture_id, sha256)` lookup occur before `putCapture`; rejected callers do not execute filesystem I/O. The bounded capture-row lock remains held across local write/verify, which is the correct S5 serialization choice.
- Existing-row behavior is correctly non-destructive in ordinary execution: `read(key, sha)` verifies disk bytes; missing/corrupt reads use `MediaStore.restore`, never `delete`.
- `MediaStore.restore` uses the same `assertSafeKey` and root containment flow as all other storage access, writes then verifies actual bytes, and has unsafe-key coverage.
- Public S5 behavior remains intact: strict canonical base64, decoded 8 MiB cap, exact kind/MIME allow-list, server SHA computation and caller-hash check, backend-generated capture key, strict MCP input/output schemas, `structuredContent`, annotations, and full MCP attach -> draft -> confirm path.
- `metadata` storage uses PostgreSQL `jsonb`, whose canonical stored representation makes the persisted draft/media provenance comparison deterministic; no new user-controlled storage-key or custom serialization path was added.
- No migrations, S6 output sweep, provider changes, or test deletion occurred. Remediation source test/code delta is `383 additions / 26 deletions`; the only production deletion is the replaced unsafe attach cleanup implementation.

## Commands independently run

With both variables set to `postgres://localhost:5432/nutrition_mcp_test` for every DB command:

```text
DATABASE_URL=... DATABASE_URL_TEST=... bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts src/media-store.test.ts --max-concurrency 1
38 pass / 0 fail / 233 expect() calls

bun run typecheck
src/ typechecks clean

bun run test:unit
481 pass / 132 skip / 0 fail (613 tests)

DATABASE_URL=... DATABASE_URL_TEST=... bun run test:db
120 pass / 0 fail / 0 skip across 8 suites
5 + 41 + 13 + 16 + 14 + 7 + 16 + 8 = 120

bunx prettier --check src/meal-captures.ts src/meal-captures.integration.test.ts src/media-store.ts src/media-store.test.ts
pass

git diff --check 645f5778d5451462231e8c6ac23cf2645a66a0e6..a137af2d20f93c52ac79f24a250ef9aa5b857b7f
silent / pass
```

Literal Prettier across every changed pathname in the remediation range returned non-zero solely because the immutable historical FAIL review `.hermes/plans/2026-08-05-gap-remediation-s5-terra-review.md` is not Prettier-formatted. It must not be modified because its required SHA is verified above. All changed executable source/test files pass Prettier.

## Honest immediate-baseline delta

The immediate pre-remediation baseline from the immutable FAIL review was `479 unit pass / 114 DB pass`.

- Unit: `481 pass` (`+2`), `132 skip`, `0 fail`.
- DB: `120 pass` (`+6`), `0 skip`, `0 fail`.
- The unit skip increase from `124` to `132` is the eight DB-gated F1 entries, all executed by the explicit DB gate.

## Remote and artifact state

Before writing this uncommitted review, `HEAD` and `origin/main` both resolved to `a137af2d20f93c52ac79f24a250ef9aa5b857b7f`. No review commit or push was performed due to this FAIL. The sole intended working-tree change is this immutable review-2 artifact.

**S5 RE-REVIEW COMPLETE — FAIL (F1 post-COMMIT data loss and F2 ON CONFLICT orphan handling).**
