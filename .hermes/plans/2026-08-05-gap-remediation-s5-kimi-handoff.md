# S5 handoff — Public capture media path with real byte lifecycle

Date: 2026-08-05
Slice: S5 of `.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md`
Base HEAD: `65d29c023bb2b3c7349f124c859bec7768226657` (clean tree, verified)
Coder: coder-kimi

Scope executed: S5 only. No S6 structured-output sweep, no STT/OCR/Telegram/provider
imports, no migration edits (`git diff HEAD -- db/migrations` empty — the existing
`meal_capture_media` table with `UNIQUE (capture_id, sha256)` supported the path
without DDL, so no stop-and-report was needed).

## RED (failing first, right reasons)

Tests written first; both target suites failed before any implementation:

```
$ DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun test src/meal-captures.integration.test.ts
SyntaxError: Export named 'attachCaptureMediaBytes' not found in module '.../src/meal-captures.ts'.
 0 pass / 1 fail

$ DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun test src/mcp-food-tracking.test.ts
SyntaxError: Export named 'ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA' not found in module '.../src/mcp.ts'.
 0 pass / 1 fail
```

Both failures are the plan's expected RED: repository function absent, MCP tool/schema
not registered.

## GREEN (implementation)

- `src/media-store.ts`: `generateCaptureStorageKey` /
  `isGeneratedCaptureStorageKey` (`capture/<capture_id>/<kind>-<sha256>`),
  `mediaSha256Hex` export, `MediaStore.putCapture(...)`.
- `src/meal-captures.ts`: `attachCaptureMediaBytes(pool, mediaStore, captureId,
userId, input)` — strict canonical base64 decode, 8 MiB decoded cap
  (`CAPTURE_MEDIA_MAX_BYTES`), exact MIME allow-list
  (`image/jpeg|image/png|image/webp|audio/ogg|audio/mpeg|audio/mp4`,
  kind-compatible), server-side SHA-256 (optional caller `sha256` must match or
  the call fails before staging), stage-then-transact with `ON CONFLICT
(capture_id, sha256) DO NOTHING` retry dedup, state guard (`capture is no
longer editable`), user scoping (`capture not found`), staged-file delete on
  any transactional rollback, redundant-copy delete when a dedup hit stores a
  different key.
- `src/mcp.ts`: `ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA` (exported, `.strict()`),
  `registerTools` deps seam gains `mediaStore?: MediaStore`, process-wide default
  via lazy `getProcessMediaStore()` reading `MEDIA_ROOT ?? "var/media"`, and the
  `attach_meal_capture_media` registration (annotations readOnlyHint:false,
  destructiveHint:false, idempotentHint:true; declared outputSchema +
  structuredContent).

Exact MCP schema (declared outputSchema):

```
capture_id: string, media_id: string, kind: "photo"|"audio",
storage_key: string (backend-generated only), mime_type: string,
byte_size: int>=0, sha256: string (server-computed),
duration_ms/width/height: int|null, metadata: record,
capture_state: "receiving"|"ready_to_confirm"|"confirmed"|"cancelled"|"expired",
deduplicated: boolean
```

Input: `capture_id`, `kind`, `mime_type`, `bytes_base64`, optional `sha256`
(64 lowercase hex, must match server hash), `duration_ms`, `width`, `height`,
`metadata`, `idempotency_key`. No `storage_key` input exists.

Deviation note: the plan listed `src/index.ts` for "pass a process-wide media
store into server construction". `handleMcp`/`buildMcpServer` live in `mcp.ts`;
the process-wide store is the lazy singleton `getProcessMediaStore()` in
`mcp.ts`, reached by `buildMcpServer` via the `registerTools` deps default, so
`src/index.ts` needed no edit. `MEDIA_ROOT` documented in README.

GREEN evidence (first passing runs):

```
$ ... bun test src/meal-captures.integration.test.ts   -> 10 pass / 0 fail
$ ... bun test src/mcp-food-tracking.test.ts           -> 14 pass / 0 fail
```

(Intermediate red runs during GREEN were test-isolation fixes only: shared tmp
media root across tests — switched to per-test fresh tmp root / before-after
file-set snapshots. No production behavior changed.)

## REFACTOR (after GREEN, gates re-run)

- Folded shared record validation: the new path validates the assembled media
  record through the existing `validateCaptureMedia` (metadata JSON shape, hash
  format, byte-size sanity) instead of duplicating checks.
- `media-store.ts`: `put`/`putCapture` share one `writeAndVerify` helper.
- `meal-captures.ts`: candidate key built via `generateCaptureStorageKey`, not a
  string literal.

Post-refactor gates:

```
$ bun run typecheck                                          -> src/ typechecks clean
$ bunx prettier --check <5 changed src files>                -> all matched files clean
$ ... bun test src/meal-captures.integration.test.ts src/mcp-food-tracking.test.ts
                                                             -> 24 pass / 0 fail
```

## Byte/storage evidence (asserted in tests, not just DB metadata)

- Happy path (repo + MCP): `Bun.file(join(root, storage_key)).exists()` true;
  on-disk bytes equal the sent bytes; recomputed
  `Bun.CryptoHasher("sha256")` of on-disk bytes equals returned `sha256`;
  storage_key is exactly `capture/<capture_id>/photo-<sha256>`.
- Rollback (repo): pool wrapper rejects `INSERT INTO meal_capture_media` after
  staging -> row count 0 AND staged file absent.
- Retry (repo + MCP): second attach returns `deduplicated: true`, same
  `media_id`/`storage_key`; exactly 1 DB row and exactly 1 file on disk.
- Tampered hash / malformed base64 / disallowed MIME / kind mismatch /
  8 MiB+1 payload / state guard / cross-user: structured error, 0 rows, media
  root file set unchanged.

## Test matrix (all real PostgreSQL; MCP via real InMemoryTransport)

Repository (`src/meal-captures.integration.test.ts`, tmp filesystem root):

1. happy path — file + row + recomputed hash
2. rollback — injected INSERT failure removes row AND file
3. retry-safe — one row, one file, same identity
4. tampered caller sha256 — rejected before staging
5. state guard — cancelled capture, "capture is no longer editable"
6. cross-user — "capture not found", nothing staged

MCP (`src/mcp-food-tracking.test.ts`, InMemoryTransport + tmp root): 7. full public path — start -> attach -> draft referencing returned media ->
confirm; `meal_event_media` row carries the capture-scoped key; staged bytes
survive confirmation; structuredContent parses with
`ATTACH_MEAL_CAPTURE_MEDIA_OUTPUT_SCHEMA` 8. retry through MCP — same identity, no duplicate row/file 9. cross-user attach rejected 10. malformed matrix — invalid base64, disallowed MIME (`image/gif`),
kind/MIME mismatch, oversized (8 MiB + 1), wrong caller sha256 11. attach on confirmed capture rejected, stages nothing

## Gate counts (baselines from plan: unit 445/84/0, db 82/0/0/7)

```
$ bun run typecheck                  -> src/ typechecks clean
$ bun run test:unit                  -> unit: 479 pass / 124 skip / 0 fail (603 tests)
$ bun run test:db (both URLs set)    -> db: 114 pass / 0 skip / 0 fail across 8 DB suites
    src/db.integration.test.ts: 5 pass
    src/meal-events.test.ts: 41 pass
    src/calculation-bundles.integration.test.ts: 13 pass
    src/meal-captures.integration.test.ts: 10 pass
    src/mcp-food-tracking.test.ts: 14 pass
    src/backup-policy.test.ts: 7 pass
    src/legacy-meal-tools.integration.test.ts: 16 pass
    src/calculation-acceptance.integration.test.ts: 8 pass
$ git diff --check                   -> clean
$ bunx prettier --check <changed files> -> all matched files clean
```

Counts grew vs baseline (unit 445->479 includes S1-S4 growth; this slice adds 0
unit-runnable tests — all new tests are DB-gated; db 82->114, suites 7->8 from
S2, unchanged here). DB-skip count for unit gate rose 84->124 because the two
extended DB suites now carry more tests; no unit test was removed.

## Safety checks

- `git grep -iE 'telegram|myfitnesspal' -- src/meal-captures.ts src/media-store.ts`
  -> no matches.
- `git diff -- db/migrations` -> empty; migrations untouched.
- `saveCaptureMedia` retained as the internal seam; the MCP tool goes through
  the byte-verified path exclusively; no caller-controlled `storage_key`.

## Commits

- `01f8b96` feat: attach meal capture media through MCP with staged byte lifecycle
  (src/media-store.ts, src/meal-captures.ts, src/mcp.ts,
  src/meal-captures.integration.test.ts, src/mcp-food-tracking.test.ts)
- `badb848` docs: document capture media byte lifecycle
  (README.md, docs/food-tracking-agent-driven.md)
- handoff commit: docs: record S5 TDD evidence (this file)

## Known limitations

- No event/version media promotion at confirm time (S5 non-goal): confirmed
  event media rows keep the capture-scoped storage key and the staged bytes stay
  under `capture/...`.
- `idempotency_key` input is accepted for caller symmetry; the actual retry
  dedup mechanism is the content-addressed `UNIQUE (capture_id, sha256)`.
- A crash between staging and commit can orphan a staged file; keys are
  content-addressed and re-derivable, and a later attach of the same bytes
  overwrites identical content.
