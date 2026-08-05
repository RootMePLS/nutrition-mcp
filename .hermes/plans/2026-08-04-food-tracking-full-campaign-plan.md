# Full agent-driven food-tracking campaign plan

> **Для Hermes:** это только repo-grounded план. Production-код во время planner-фазы не менять. Исполнять строго через `planner-fable → coder-kimi → reviewer-terra`; каждый slice — RED → GREEN → PostgreSQL integration gate → focused commit → Terra review.

**Цель:** довести agent-driven food tracking до рабочего, проверяемого вертикального пути: Hermes в чате принимает text/photo/voice, уточняет, считает сам и вызывает внешние MCP; `nutrition-mcp` принимает уже подготовленные данные, валидирует, персистит и возвращает честное состояние.

**Repo:** `/Users/fishhead/.workspace/projects/nutrition-mcp`  
**Baseline:** `b931c0b2804655beadc475a2a58b060301c54cb4` (`main`, ahead of `origin/main` by one commit)  
**Runtime:** Bun + TypeScript + `pg` + PostgreSQL + MCP SDK

---

## 1. Архитектурная граница (не нарушать)

### Hermes owns

- Telegram transport and receipt of text/photo/voice.
- Downloading/staging bytes through its own available capabilities.
- Parsing, clarification questions, one-question-at-a-time interview, and evidence precedence decisions.
- Hermes `own` estimate and calls to `nutrition-local` and MyFitnessPal MCP tools.
- Explaining uncertainty and presenting a proposal to the user.
- Interpreting explicit user confirmation (`добавь` or equivalent) and deciding when to retry/ask correction.

### `nutrition-mcp` owns

- Durable PostgreSQL capture/event/version state.
- Transport-neutral raw message, answer, evidence and media metadata storage.
- Runtime validation of prepared drafts and calculation bundles.
- Server-derived identity/idempotency, atomic confirmation, append-only corrections.
- Backend recomputation with existing `computeConsensus` / `consensus-10pct-v1`.
- Honest provider statuses and raw provenance.
- MyFitnessPal authorization/write journal only; never the external MFP call or a claim of `synced` without an external result.
- MCP schemas and deterministic responses.

### Explicitly out of scope

No Telegram bot/webhook/polling, STT, OCR/vision, LLM/parser, direct import/call of another MCP server, autonomous worker/cron, or production provider credentials. No parallel flat meal model: retain `meal_events` + immutable versions/items/results/journal.

---

## 2. Repo truth at baseline

Existing and reusable:

- `db/migrations/002_food_tracking.sql`: event aggregate, immutable versions/items, evidence/media metadata, provider rows, canonical rows, sync journal.
- `db/migrations/003_meal_captures.sql`: capture/message/answer/media tables, but current implementation does not yet provide a complete safe lifecycle.
- `src/meal-types.ts`: provider/status/nutrient/evidence/media contracts and existing event validation.
- `src/meal-events.ts`: transactional event creation/corrections/provider/canonical/journal primitives; it already uses `withTransaction`, but capture confirmation currently calls it outside the capture transaction.
- `src/meal-captures.ts` and `src/meal-capture-types.ts`: partial start/append/answer/draft/confirm surface. Terra gap: missing read/cancel/expire, unsafe confirmation race, caller-controlled alternate event idempotency, and non-atomic event/capture update.
- `src/media-store.ts`: generated event/version media keys, hash verification, containment, read/delete. Capture-specific staging/attach/read/cleanup still needs a bounded seam.
- `src/nutrition-bundle-types.ts`: partial validation and fingerprint helper. Terra gap: fingerprint is not verified, does not include the full resolved input/provenance contract, and is not persisted through a real bundle service.
- `src/mcp.ts`: already exposes prepared food-tracking helpers and a pure `recomputeCanonical` helper; add tools only after domain tests, keeping descriptions honest.
- Tests: `src/meal-captures.test.ts`, `src/meal-events.test.ts`, `src/media-store.test.ts`, `src/nutrition-bundle.test.ts`, `src/mcp-food-tracking.test.ts`, `src/db.integration.test.ts`.
- `db.integration.test.ts` already applies `001 → 002 → 003` when `DATABASE_URL_TEST` is present, but new capture/bundle integration files and positive assertions are required. Skipped tests are not an integration gate.

Do not reset or discard the current tree. The untracked historical plan artifacts are existing workspace state; this campaign creates only this file during planning.

---

## 3. Global execution contract for every slice

1. Planner reads current HEAD and the exact files again immediately before dispatch.
2. Coder writes the failing focused test first.
3. Coder runs the RED command and records the expected failure; no production implementation before RED.
4. Coder implements the smallest bounded change, then runs the focused GREEN tests and typecheck.
5. For any persistence slice, run the real PostgreSQL gate against a disposable DB. A skipped suite is failure, not success.
6. Run `git diff --check`; inspect only approved files; do not reformat unrelated pre-existing files.
7. Commit exactly one bounded slice. Do not squash unrelated slices.
8. Terra reviews current HEAD against the slice criteria. If rejected, planner writes a remediation slice; coder adds a regression RED test; Terra re-reviews.

### Common commands

```bash
cd /Users/fishhead/.workspace/projects/nutrition-mcp
git status --short
git diff --check
bun test <focused-files> --reporter dots
bun run typecheck
bunx prettier --check <changed-files>
```

### Required PostgreSQL gate

```bash
export DATABASE_URL_TEST='postgres://localhost:5432/nutrition_mcp_test'
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun test \
  src/db.integration.test.ts \
  src/meal-captures.integration.test.ts \
  src/nutrition-bundle.integration.test.ts \
  src/mcp-food-tracking.test.ts --reporter dots
```

The suite must apply migrations in order `001_initial_schema.sql`, `002_food_tracking.sql`, `003_meal_captures.sql`, reset the disposable public schema safely, and show passing DB tests rather than skips. Final campaign gate additionally runs `bun test --reporter dots`, `bun run typecheck`, `bun run format:check`, and `git diff --check`; known unrelated formatter failures must be recorded, not hidden by unrelated edits.

---

## 4. Ordered bounded campaign

### Slice 0 — Planner handoff and contract freeze

**Purpose:** freeze decisions before implementation and prevent another ambiguous Stage A/B attempt.

**Files:** read-only `src/meal-captures.ts`, `src/meal-capture-types.ts`, `src/meal-events.ts`, `src/nutrition-bundle-types.ts`, `src/mcp.ts`, `db/migrations/002_food_tracking.sql`, `db/migrations/003_meal_captures.sql`, existing food-tracking plans. No production edit.

**RED/GREEN:** no code RED. Planner must produce a handoff checklist confirming: exact additive MCP names (recommended `start_meal_capture`, `append_meal_capture_message`, `save_meal_capture_answer`, `save_meal_capture_draft`, `read_meal_capture`, `confirm_meal_capture`, `cancel_meal_capture`, `commit_meal_calculation_bundle`); backend recomputation is authoritative; `003` remains forward-only unless an inspected schema defect requires a new migration.

**PostgreSQL gate:** run baseline migration suite with `DATABASE_URL_TEST`; record current failures/skips as baseline, not as success.

**Acceptance:** Terra findings are mapped to slices below; no coder starts until the atomic transaction boundary and result contract are explicit.

**Dependencies:** none. **Commit boundary:** no commit (planner artifact is already this file). **Recovery:** if planner/coder crashes, inspect `git status`, preserve all files, and restart from this slice using current HEAD; never reset.

---

### Slice A1 — Runtime capture/evidence contract validation

**Files:** modify `src/meal-capture-types.ts`; test `src/meal-captures.test.ts`; only if shared mapping requires it, narrow `src/meal-types.ts`.

**RED:** add tests that reject missing IDs, invalid dates, unsupported message/media kinds, negative/non-finite byte sizes, malformed SHA-256, invalid MIME/metadata, invalid evidence source kinds, content/hash mismatch, duplicate ordinals, empty draft items; accept all retained evidence with deterministic precedence `user_text > audio_transcript > photo_ocr > photo_vision > model_assumption`.

**GREEN:** implement pure validators/normalizers only. Do not infer food, select questions, call providers, or import Telegram types.

**PostgreSQL gate:** no new DB behavior; run `src/db.integration.test.ts` to ensure no migration regression.

**Acceptance:** Hermes can send a transport-neutral prepared payload and gets stable fail-closed validation; lower-precedence evidence is retained rather than discarded.

**Dependencies:** Slice 0. **Commit:** `test/feat: validate agent meal capture contracts`. **Recovery:** if timeout occurs after tests, run `git diff`, keep the partial test, finish RED/GREEN or revert only the uncommitted slice edits after documenting the exact failure; do not reset prior commits.

---

### Slice A2 — Durable capture lifecycle: read/cancel/expire

**Files:** modify `src/meal-captures.ts`; test `src/meal-captures.test.ts`; create `src/meal-captures.integration.test.ts`; inspect/modify `db/migrations/003_meal_captures.sql` only if needed.

**RED:** test `start` replay, `read` after process boundary, idempotent append/answer, valid transitions `receiving → ready_to_confirm → confirmed|cancelled|expired`, invalid transitions, explicit cancel, expiry based on stored `expires_at`, and row locking for every mutator. Test missing capture/user isolation.

**GREEN:** add `readMealCapture`, `cancelMealCapture`, `expireMealCapture` and explicit transition validation. Every mutating operation uses `SELECT ... FOR UPDATE` in one transaction; replay returns the existing state without duplicate rows. The backend stores agent-supplied questions/answers but never generates questions.

**PostgreSQL gate:** `meal-captures.integration.test.ts` proves migration `001→002→003`, restart/read, rollback, state transitions and duplicate keys against real PostgreSQL.

**Acceptance:** pending multi-turn state survives process restart; cancel/expire are durable and idempotent; no unconfirmed capture can be committed.

**Dependencies:** A1. **Commit:** `feat: complete durable meal capture lifecycle`. **Recovery:** on crash, locate the last committed SHA with `git log`; run integration tests from that SHA/current tree; preserve uncommitted changes and continue only the unfinished test/implementation step.

---

### Slice A3 — Capture media persistence and provenance

**Files:** modify `src/meal-captures.ts`, `src/meal-capture-types.ts` if required, `src/media-store.ts` only for a minimal staging seam; tests `src/meal-captures.test.ts`, `src/media-store.test.ts`, `src/meal-captures.integration.test.ts`; migration `003` only if a constraint/index is demonstrably missing.

**RED:** host-staged bytes are hash-verified and assigned a generated capture-safe identity; metadata attach/read is idempotent; unsafe unrelated/final-event keys are rejected; size/MIME limits fail before DB commit; DB failure invokes cleanup and leaves no orphan staged file; read verifies checksum.

**GREEN:** implement `stage → verify → attach metadata → commit` ordering. PostgreSQL stores key/hash/MIME/size/dimensions/duration/provenance only; bytes remain under `MEDIA_ROOT`. Do not download or inspect media content.

**PostgreSQL gate:** attach/read/duplicate/rollback tests query `meal_capture_media` and verify no partial rows. File-store tests use an isolated temporary root.

**Acceptance:** raw photo/audio can be audited and retried without claiming OCR/STT/vision; final `enforce_media_identity` behavior in `meal-events.ts` is not weakened.

**Dependencies:** A2. **Commit:** `feat: persist capture media provenance safely`. **Recovery:** if media bytes were staged by a crashed agent, use the test temp root/cleanup helper only; do not delete user media or alter production roots. Continue from the last commit and rerun both media and DB tests.

---

### Slice A4 — Atomic confirmation and one-capture/one-event vertical path

**Files:** modify `src/meal-captures.ts`, narrowly `src/meal-events.ts`, `src/mcp.ts`; tests `src/meal-captures.integration.test.ts`, `src/mcp-food-tracking.test.ts`, and focused `src/meal-events.test.ts`.

**RED:** concurrent confirmations create exactly one event root/version; alternate caller event idempotency keys cannot create another root; event creation, child rows, capture `confirmed` state, and journal intent roll back together on any failure; duplicate confirmation returns the original IDs; two-item draft yields one root with ordered items.

**GREEN:** lock capture row with `FOR UPDATE` before state/draft checks; derive `event_idempotency_key` server-side from capture identity (`capture:<capture_id>`); do not accept a caller override. Add a transaction-aware event insertion path so event children, capture update, and authorization journal are one transaction. If an existing `createMealEvent` API cannot accept a client, refactor minimally to share its insert helper rather than nesting independent transactions.

**PostgreSQL gate:** real concurrent-confirm test (two clients/barriers), rollback injection, one-root count, ordered children, capture/event foreign keys, and journal state.

**Acceptance:** explicit `добавь` is the only commit gate; one confirmed capture maps to one event root; no partial event survives failed confirmation; retry is safe.

**Dependencies:** A2, A3. **Commit:** `feat: make meal capture confirmation atomic`. **Recovery:** never manually repair test DB rows in production. On timeout, inspect transaction locks and test DB only, terminate the disposable test session if needed, then resume from the last commit. Preserve failed regression tests.

---

### Slice B1 — Calculation bundle schema, full canonical fingerprint, runtime validation

**Files:** modify `src/nutrition-bundle-types.ts`; tests `src/nutrition-bundle.test.ts`; optional shared nutrient type changes only in `src/meal-types.ts`.

**RED:** reject fingerprint mismatch; require/validate event/version/capture context, scope, provider/status, basis/units, algorithm/model version, raw JSON payload, request fingerprint and finite nullable nutrients; reject unknown providers, invalid scopes, duplicate provider+scope, NaN/Infinity, malformed status; prove changed portion/evidence/provider input changes fingerprint and provider order does not.

**GREEN:** define a stable canonical serialization that includes resolved draft/evidence snapshot and all provider inputs needed for replay. Separate request fingerprints from the bundle fingerprint. Keep `failed`/`unavailable` nutrients null; do not coerce to zero. No network/MCP calls.

**PostgreSQL gate:** run existing migration suite; no persistence implementation yet.

**Acceptance:** a submitted Hermes bundle is auditable and tamper-evident; server can distinguish unavailable calculation from missing numeric data.

**Dependencies:** A4. **Commit:** `feat: harden calculation bundle contract and fingerprints`. **Recovery:** if fingerprint design changes during review, keep the test as the contract and amend only this slice; do not duplicate consensus logic in another module.

---

### Slice B2 — Backend-authoritative canonical recomputation

**Files:** create `src/nutrition-bundle.ts`; modify narrowly `src/meal-consensus.ts` only if a real exposed defect is found; tests `src/nutrition-bundle.test.ts` and `src/meal-consensus.test.ts`.

**RED:** exact 10% inclusive boundary, all-agree, two-agree/one-outlier, no-consensus, insufficient-data, near-zero, null nutrient, failed/unavailable and provider-order invariance must match `computeConsensus`. A mismatching Hermes proposal must never become canonical.

**GREEN:** validate bundle, normalize stable scope/provider ordering, call existing `computeConsensus` as the sole policy, and retain Hermes proposal only as non-authoritative audit input. Persist policy version, threshold, eligible/outlier providers and source-result placeholders in the persistence mapping.

**PostgreSQL gate:** migration suite plus a DB-independent canonical fixture run; no claim of persistence yet.

**Acceptance:** backend canonical result is deterministic and cannot be changed by an agent proposal; `own` remains Hermes’s estimate, not a backend calculator.

**Dependencies:** B1. **Commit:** `feat: recompute canonical nutrition from submitted providers`. **Recovery:** if Terra finds a policy discrepancy, add a regression test against `meal-consensus.ts`; do not fork or silently change `consensus-10pct-v1`.

---

### Slice B3 — Atomic bundle persistence, source IDs, retry and correction identity

**Files:** modify `src/meal-events.ts`, `src/nutrition-bundle.ts`; create `src/nutrition-bundle.integration.test.ts`; extend `src/nutrition-bundle.test.ts`, `src/meal-events.test.ts`.

**RED:** confirmed event/version accepts event- and item-scoped rows; all raw provider rows and one canonical row per scope persist atomically; canonical `source_result_ids` equal inserted IDs; repeat verified fingerprint returns existing result without duplicates; concurrent identical submissions converge; DB failure rolls back all rows; changed portion/evidence/provider input creates a new fingerprint and append-only correction/version path; provider failure does not roll back local event.

**GREEN:** implement transaction-aware persistence using existing `meal_event_nutrition_results` and `meal_event_canonical_results`, unique constraints, and append-only version rules. The calculation bundle must be tied to confirmed capture/event context; never mutate historical rows.

**PostgreSQL gate:** `nutrition-bundle.integration.test.ts` applies all migrations and proves read-back, rollback, unique idempotency, concurrent retry, event/item scopes, source IDs, and correction identity with real PostgreSQL.

**Acceptance:** there is a real durable calculation-bundle seam, not just a pure helper; same input is idempotent and changed input is correction-safe.

**Dependencies:** A4, B1, B2. **Commit:** `feat: persist calculation bundles atomically and idempotently`. **Recovery:** if an agent crashes during a migration/test, inspect `pg_stat_activity` only on the disposable DB, rerun schema reset, and continue from the last commit. Never edit applied migrations backward; add a forward migration if needed.

---

### Slice B4 — MFP availability vs authorization journal

**Files:** modify `src/meal-events.ts`, `src/mcp.ts`; tests `src/mcp-food-tracking.test.ts`, `src/nutrition-bundle.integration.test.ts`; inspect `db/migrations/002_food_tracking.sql` and add a forward migration only if the existing unique journal contract cannot represent the required state.

**RED:** unavailable/failed `myfitnesspal` result is distinct from write authorization; no explicit confirmation creates no journal row; confirmed `добавь` creates exactly one `pending` intent; duplicate intent is idempotent; pending is never reported as synced; retry transitions and external failure remain honest.

**GREEN:** use the existing `external_write_authorized` and `meal_event_sync_journal` state machine. Separate provider calculation status from journal authorization source/state in the return contract. No MFP import or call.

**PostgreSQL gate:** real DB tests for no authorization, authorized pending intent, retries, failed/dead-letter semantics, and no false `synced`.

**Acceptance:** the user’s confirmation authorizes a possible external write, but only an external adapter result can establish success.

**Dependencies:** A4, B3. **Commit:** `feat: separate MFP calculation and write authorization`. **Recovery:** if journal state is ambiguous, stop and report; do not mark rows succeeded to make tests pass.

---

### Slice B5 — Agent-facing MCP vertical contracts

**Files:** modify `src/mcp.ts`; tests `src/mcp-food-tracking.test.ts`; optionally narrow `src/meal-capture-types.ts`/`src/nutrition-bundle-types.ts` schema exports; no external integration files.

**RED:** tool schemas reject unconfirmed commits, malformed evidence/media/bundles and fingerprint mismatch; routes return stable errors; responses expose capture/event/version IDs, provider statuses, canonical state and journal state; duplicate calls converge; descriptions explicitly say Hermes supplies prepared data and external calls are not made here.

**GREEN:** register the additive capture lifecycle and `commit_meal_calculation_bundle` surface around tested repository functions. Keep low-level prepared `log_meal_event` compatibility unless a contract test proves a safe additive alias is necessary. Use injected pool/media dependencies and no direct MCP/network calls.

**PostgreSQL gate:** invoke the MCP handlers against the disposable PostgreSQL DB and re-read persisted rows; do not rely only on pure handler tests.

**Acceptance:** an agent can execute the complete path: start → append/answer/media/draft → confirm → submit bundle → receive canonical/journal truth.

**Dependencies:** A4, B3, B4. **Commit:** `feat: expose agent-facing food tracking MCP contracts`. **Recovery:** if a tool schema change breaks existing tests, preserve existing tools and add a new additive surface; do not rewrite unrelated nutrition tools.

---

### Slice C1 — Corrections, reads and idempotency audit

**Files:** modify `src/meal-events.ts`, `src/meal-captures.ts`, `src/mcp.ts`; tests `src/meal-events.test.ts`, `src/meal-captures.test.ts`, `src/nutrition-bundle.test.ts`, both integration files.

**RED:** read capture/event/history after restart; correction with changed portion/evidence creates exactly one new immutable version; replayed correction key does not duplicate; stale version cannot overwrite current pointer; same capture/bundle/correction keys converge; user isolation holds across all reads/writes.

**GREEN:** close any remaining identity/read gaps using existing append-only model and server-derived keys. Never delete or mutate historical provider/canonical evidence as a shortcut.

**PostgreSQL gate:** concurrent correction/retry/read tests on real PostgreSQL and current-version aggregate checks.

**Acceptance:** normal chat correction flow is safe: Hermes can ask again, submit a changed prepared result, and preserve history.

**Dependencies:** A4, B3, B5. **Commit:** `test/fix: harden correction and idempotency semantics`. **Recovery:** retain any new regression tests even if implementation is incomplete; restart from their failing command.

---

### Slice C2 — Docs, operator contract and final truth pass

**Files:** modify `README.md`, `.env.example`, narrowly `CLAUDE.md` only if it contradicts the shipped contract; update `src/mcp.ts` tool descriptions and `src/mcp-food-tracking.test.ts`; do not modify prior plan artifacts.

**RED:** documentation/description assertions fail if they claim Telegram/STT/OCR/vision/provider calls in this repo, claim MFP sync from a pending row, omit `DATABASE_URL_TEST`/`MEDIA_ROOT`, or omit migration order and confirmation boundary.

**GREEN:** document the actual agent/backend split, prepared inputs, media metadata and local root, bundle provenance, canonical policy, unavailable-vs-pending semantics, correction/idempotency, local Postgres setup and explicit limits. Ensure `.env.example` contains no bot/provider secrets.

**PostgreSQL gate:** full integration gate after docs/tool description changes; MCP tests inspect live registered descriptions.

**Acceptance:** a new coder can run the repo and understand what Hermes does versus what nutrition-mcp persists; docs do not promise unverified external integrations.

**Dependencies:** B5, C1. **Commit:** `docs: document agent-driven food tracking boundary`. **Recovery:** if formatter reports pre-existing failures, isolate changed files with `bunx prettier --check <changed-files>`, record the baseline failure, and do not reformat unrelated files.

---

### Slice C3 — Campaign closeout and release gate

**Files:** no production changes expected; inspect all changed files, migrations, docs, tests, `package.json`, `.env.example`, `CLAUDE.md`.

**RED/GREEN:** run the complete test/type/format/integration commands; treat skipped PostgreSQL tests, failing focused tests, dirty diff checks, undocumented schema changes, direct provider imports, or missing source IDs as RED. GREEN is only the complete set passing with exceptions explicitly recorded.

**PostgreSQL gate:**

```bash
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun test --reporter dots
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun run typecheck
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun run format:check
DATABASE_URL_TEST="$DATABASE_URL_TEST" git diff --check
```

Run a boundary scan over `src/meal-captures.ts`, `src/nutrition-bundle.ts`, `src/nutrition-bundle-types.ts`, `src/meal-events.ts`, and `src/mcp.ts`; forbidden direct Telegram/provider/MCP imports are a release blocker.

**Acceptance:** all Stage A/B criteria below are demonstrably true; Terra signs off on current HEAD; final push is explicitly approved by the parent workflow. Do not claim Telegram/provider end-to-end verification when only contract tests exist.

**Dependencies:** all previous slices. **Commit boundary:** no new implementation commit; release/merge only after reviewer approval, then push the bounded campaign commits. **Recovery:** if final gate fails, create a focused remediation slice from the failing command; never “fix” by weakening tests or resetting history.

---

## 5. Campaign acceptance checklist

### Stage A

- [ ] Capture state, messages, answers and media metadata survive restart and are read-able by user/capture ID.
- [ ] Runtime validation checks identifiers, timestamps, media hash/size/MIME, evidence source/precedence and retains all evidence.
- [ ] Read/cancel/expire and all mutators have explicit idempotent state transitions and row locks.
- [ ] Only explicit user confirmation permits final commit.
- [ ] Confirmation derives event identity server-side and is atomic with event/version/items/journal.
- [ ] Concurrent confirmation yields one root, one version and one capture result.
- [ ] Capture media uses safe generated identity, hash verification and cleanup on transaction failure; bytes are not JSONB.
- [ ] One confirmed N-item draft becomes one ordered `meal_event` root; no backend parsing or provider call exists.

### Stage B

- [ ] Bundle fingerprint is recomputed and mismatch rejected; resolved draft/evidence/provider input is included.
- [ ] Every provider result has honest status, scope, basis/units, raw payload, request fingerprint and algorithm/model provenance.
- [ ] Backend recomputes canonical through existing `computeConsensus` and stores `consensus-10pct-v1` metadata/source IDs.
- [ ] Null/missing/unavailable values never become numeric zero; Hermes proposal is audit-only.
- [ ] Bundle rows/canonical rows persist atomically and are idempotent under retry/concurrency.
- [ ] Changed inputs create a distinguishable append-only correction/version path.
- [ ] MFP availability is separate from explicit write authorization; pending is never synced.
- [ ] Real PostgreSQL tests prove migrations, rollback, locking, idempotency, correction and re-read behavior.
- [ ] MCP descriptions and README state that Hermes owns parsing, clarification, own calculation and external MCP calls.

---

## 6. Timeout / crash / handoff protocol

Every agent must leave the tree usable:

1. Do not reset, `git clean`, discard another agent’s work, or rewrite prior commits.
2. First run `git status --short`, `git log -8 --oneline`, and `git diff --check`.
3. Record the exact slice, last RED/GREEN command, PostgreSQL command, and whether the process died before/after commit.
4. If no commit exists, preserve uncommitted work and hand off the failing test plus changed paths; the next coder decides whether to continue or clean only its own partial files.
5. If a commit exists, reviewers start from that SHA and do not re-implement it. Validate the commit, then continue at the next slice.
6. A crashed DB test may leave locks/transactions in the disposable DB: reset only the disposable schema/database, never production data; rerun migrations from `001` in order.
7. A staged media file may be deleted only inside the isolated test `MEDIA_ROOT` or by the media cleanup path; never guess-delete from a real configured root.
8. If a requirement cannot be grounded in the current schema/API, stop with a blocker and add a planner remediation note; do not invent a compatibility layer or external integration.
9. Terra rejection always becomes a new bounded regression-test-first remediation slice. Reviewer must not patch production code directly.

---

## 7. Final workflow handoff

- **planner-fable:** re-check baseline and freeze exact contracts; this artifact is the campaign source of truth.
- **coder-kimi:** execute A1→A4, B1→B5, C1→C3 in order, one commit per slice, with RED/GREEN and real PostgreSQL gate.
- **reviewer-terra:** review each commit against the slice acceptance and architectural boundary, especially atomic confirmation, server-derived IDs, media identity/cleanup, fingerprint verification, canonical source IDs, correction idempotency, MFP pending semantics and direct-import prohibition.
- **parent/orchestrator:** do not push/merge until C3 passes and Terra approves current HEAD. Report any external-provider or Telegram verification honestly as out of scope unless separately provisioned and tested.
