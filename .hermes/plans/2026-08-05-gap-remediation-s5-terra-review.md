# S5 reviewer-terra review — FAIL

Date: 2026-08-05
Slice: S5 — public capture media path with real byte lifecycle
Reviewed range: `65d29c023bb2b3c7349f124c859bec7768226657..645f5778d5451462231e8c6ac23cf2645a66a0e6`
Reviewed HEAD: `645f5778d5451462231e8c6ac23cf2645a66a0e6`
Reviewer: reviewer-terra

## Verdict

**FAIL — blocking durability/security data-loss defect. Do not accept, commit this review, or advance to S6.**

The normal lifecycle and all requested gates are green, but a rejected identical attachment deletes an existing, committed capture-media file. This violates S5’s staged-file rollback guarantee, idempotency durability, and user/state guard safety.

## Blocking finding

### F1 — rejected same-bytes attach deletes an existing committed file

**Severity:** blocking / durability and authorization failure

**Files:**
- `src/meal-captures.ts:347-425`
- specifically staging before ownership/state validation at `:349-354`, and unconditional cleanup at `:421-425`

`attachCaptureMediaBytes` calls `mediaStore.putCapture` before entering the transaction that locks and verifies `meal_captures` ownership/state. The generated key is deterministic: `capture/<capture_id>/<kind>-<sha256>`. Thus an attempted attach of the same bytes re-writes the exact path already referenced by a committed `meal_capture_media` row.

If the later ownership or editable-state guard rejects, the catch block always calls `mediaStore.delete(staged.storage_key)`. That is the already-committed file’s key, so the rejected request removes the valid attachment while its DB row remains.

### Independent adversarial reproduction

I ran a real PostgreSQL + real temporary filesystem repro, independently of the committed tests:

1. Reset the disposable DB through migrations `001..005`.
2. Created a capture owned by `owner`.
3. Attached valid PNG bytes as `owner`; this persisted one `meal_capture_media` row and created `capture/<capture-id>/photo-<sha256>`.
4. Retried exactly the same bytes against the same capture as `intruder`.
5. The request correctly rejected with `Error: invalid meal capture: capture not found` — but the previously existing file no longer existed.

Actual result:

```json
{
  "before": true,
  "rejected": "Error: invalid meal capture: capture not found",
  "after": false,
  "dbRows": 1,
  "storageKey": "capture/9ffc3df0-4a29-4fb3-8e77-fdfbbcd8d554/photo-ae23791219e59390237eb38ab667d0e9590eaa4c343eda697b24a186eadfdcc3"
}
```

This is not merely an empty-root rollback issue. A cross-user rejected request can delete bytes owned by another user while the committed metadata row survives and later reads/confirmation reference a missing file. The same defect is reachable when the capture leaves the editable state after a successful attachment, and in races where an otherwise failing identical attach reaches cleanup after another transaction has committed the same content-addressed key.

Existing tests prove only that rejected attaches leave an initially empty media root unchanged. They do not retain a valid existing attachment before attempting the rejected/failing same-bytes request, so they do not cover file ownership during cleanup.

## Required coder-kimi remediation plan

Keep the repair strictly in S5 scope; do not modify migrations or begin S6.

1. Establish ownership/state and existing media identity before any destructive cleanup decision. A transaction/lock can validate the capture and detect an existing `(capture_id, sha256)` row before staging, but avoid holding a DB transaction across slow filesystem I/O if that is not acceptable.
2. Track whether this invocation exclusively created a previously absent file. Never infer ownership from `staged.storage_key`: a content-addressed key can pre-exist and be referenced by committed rows.
3. On any failure, delete only a file proven to have been newly created by this invocation and still unreferenced. For the deterministic same-key case, a safer strategy is to avoid deleting it if an existing DB row/reference is present; where a separate temporary staging key is introduced, clean up that private staging key only.
4. Preserve correct behavior for: initial stage/insert rollback (no row and no file), dedup retry (one row and one file), cross-user rejection, non-editable-state rejection, and concurrent identical success/failure.
5. Add real PostgreSQL + filesystem tests that first attach valid bytes, then verify all of the following leave the original row and file intact:
   - same capture and bytes from the wrong user;
   - same owner and bytes after cancelling or confirming the capture;
   - injected transaction failure on a second identical attach after the first has committed;
   - if practical, a coordinated concurrent identical successful attach plus a failing/rejected attach.
   Each case must assert the original file still exists and recomputes to its committed SHA-256, not just that the root file set is empty/non-empty.
6. Rerun the exact S5 focused suites and full gate battery, report RED/GREEN/REFACTOR evidence, and hand off a new commit range. The fix must not delete or weaken existing normal lifecycle tests.

## Acceptance evidence that passed

The following implementation portions were independently inspected and/or exercised successfully, but cannot overcome F1:

- Strict canonical base64 check is present (`STRICT_BASE64` plus re-encode equality) and applies the decoded 8 MiB cap (`CAPTURE_MEDIA_MAX_BYTES = 8 * 1024 * 1024`).
- Kind-compatible MIME allow-list is exact: photos allow JPEG/PNG/WebP; audio allows OGG/MPEG/MP4.
- SHA-256 is recomputed server-side; optional caller hash must match before staging.
- Capture key generation is backend-only and capture-scoped: `capture/<capture_id>/<kind>-<sha256>`.
- `MediaStore` checks root containment, unsafe keys, on-disk byte hash after writing, and read checksum.
- MCP input does not expose `storage_key`; the tool uses `userId`, has the requested mutation/idempotency annotations, declared strict `ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA`, and returns `structuredContent`.
- The injected `mediaStore` dependency seam plus lazy process-wide default store are present.
- Real MCP happy path passed: start -> attach -> draft that echoes returned media identity -> confirm; the `meal_event_media` row retains the capture-scoped key and bytes survive confirmation.
- Normal same-bytes retry passes with one row and one file; however, its safety is invalidated by F1 under rejected/failing later attempts.
- No S5 DDL was changed and no Telegram/MyFitnessPal/provider/STT/OCR/vision import was added to the new media path.
- README and agent-driven documentation describe the public byte path and `MEDIA_ROOT`.

## TDD evidence review

The handoff provides credible RED evidence for missing exports/tool schema, then focused GREEN results and a stated refactor. The reported RED failures are for the expected absent-function/absent-schema reasons. However, the test matrix omitted the adversarial pre-existing-file condition that exposes F1; therefore RED/GREEN/REFACTOR evidence is insufficient for the required rollback durability claim.

## Commands independently run

Environment for every DB/MCP command:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test
```

Results:

```text
bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts
24 pass / 0 fail

bun run typecheck
src/ typechecks clean

bun run test:unit
479 pass / 124 skip / 0 fail (603 tests)

bun run test:db
114 pass / 0 skip / 0 fail across 8 DB suites

bunx prettier --check $(git diff --name-only <S5 range>)
All matched files use Prettier code style!

git diff --check <S5 range>
silent / success
```

The exact DB-gate suite counts were: `5 + 41 + 13 + 10 + 14 + 7 + 16 + 8 = 114` across eight suites.

## Gate-delta reconciliation and scope review

The immediate S4 baseline supplied for this review is **479 pass / 109 DB pass** (not the stale campaign baseline). S5 retains the unit result at **479 pass** and grows the DB result to **114 pass**, a net **+5 DB tests**, with zero failures and zero DB skips. The 124 unit-gate skips are DB-gated tests intentionally delegated to `test:db`; the full DB gate executed all 114.

No real test files were deleted in the S5 range. The only test-line removals are the replaced `registerTools` import/call lines needed to inject the test media store; test inventory grew by the S5 lifecycle cases. This supports that the gate-count result did not hide a deleted test, but it does not compensate for the missing adversarial coverage above.

Commit partition is otherwise S5-shaped:

- `01f8b96` production code plus S5 tests only;
- `badb848` S5 documentation only;
- `645f577` S5 handoff only.

`git diff --name-only <S5 range> -- db/migrations` is empty. No S6 structured-output sweep is included beyond S5’s required attach tool output.

## Remote and review artifact state

Before this review artifact was written, local `main` and `origin/main` both resolved to `645f5778d5451462231e8c6ac23cf2645a66a0e6` (`## main...origin/main`).

Per FAIL instructions, this review is deliberately left uncommitted and no push was performed. The only intended working-tree change is this review file.

**S5 REVIEW COMPLETE — FAIL (blocked pending F1 remediation).**
