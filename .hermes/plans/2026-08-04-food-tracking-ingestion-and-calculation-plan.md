# Agent-driven food tracking: capture, calculation bundle, and persistence plan

> **For Hermes:** execute this plan through the staged workflow `planner → coder → reviewer`, using TDD and small commits. This document is a plan only; no production code is changed by the planner.

**Goal:** Make `nutrition-mcp` a durable, agent-facing storage/domain backend for food tracking while Hermes in Telegram remains the conversational ingestion and orchestration layer.

**Architecture:** Hermes receives Dmitrii’s text/photo/voice messages, parses them text-first, asks clarification questions, performs its own nutrition estimate, calls `nutrition-local` and MyFitnessPal MCP tools, applies the 10% consensus policy, and submits a validated calculation bundle to this repository. `nutrition-mcp` stores raw evidence/media metadata, capture state, prepared drafts, provider results, canonical results, corrections, idempotency keys, and the MyFitnessPal sync journal through PostgreSQL and MCP tools. The repository does not become a Telegram bot, webhook, STT worker, OCR/vision worker, or autonomous provider-calling service.

**Repository:** `/Users/fishhead/.workspace/projects/nutrition-mcp`  
**Baseline HEAD:** `94d82243f54efb0c4ef585ae9010e1b57c8035f3`  
**Runtime:** Bun + TypeScript + PostgreSQL + MCP SDK

---

## 1. Non-negotiable responsibility split

### Hermes in Telegram owns

1. Receiving Telegram text, photo, and voice messages.
2. Downloading or otherwise obtaining media bytes through its own available capabilities.
3. Parsing the user’s message and media into food-item/portion hypotheses.
4. Asking one clarification question at a time and deciding when the draft is complete.
5. Treating explicit user text and answers as highest-precedence evidence.
6. Performing the `own` nutrition calculation/estimate.
7. Calling the `nutrition-local` MCP server and MyFitnessPal MCP server through Hermes tool calls or host-provided bridges.
8. Handling provider responses, explaining uncertainty, applying the 10% consensus rule, and producing the proposed canonical nutrient result.
9. Asking for explicit confirmation. The confirmation phrase **“добавь”** (or an equivalent unambiguous add/log instruction) is the authorization boundary for writing a meal and for creating the MFP sync intent.
10. Retrying external tool calls and deciding whether to ask the user for a correction.
11. Calling this repository’s MCP tools with already-prepared, structured inputs; it must not rely on this repository to infer food from a photo or voice note.

### `nutrition-mcp` owns

1. Durable PostgreSQL storage and transaction boundaries.
2. Transport-neutral capture/session records when multi-turn persistence is required.
3. Raw message/evidence/media metadata preservation; binary bytes remain in the configured media store, not JSONB.
4. Prepared meal-draft/event write contracts and validation.
5. Persistence of all provider result payloads and statuses supplied by Hermes.
6. Deterministic canonical-result storage and the existing `consensus-10pct-v1` domain policy, either by validating the submitted canonical result or recomputing it from the submitted provider rows.
7. Idempotency for capture messages, confirmation, calculation bundles, event creation, corrections, and sync intent.
8. Append-only meal-event versions, reads/history, correction semantics, and the MyFitnessPal sync journal.
9. MCP schemas and honest status/error responses.

### Explicitly forbidden repository responsibilities

- Telegram bot token handling, Telegram webhook deployment, Telegram polling, or Telegram-specific routing.
- Speech-to-text, OCR, computer vision, image understanding, prompt execution, or LLM reasoning.
- Direct imports of the MyFitnessPal MCP server, `nutrition-local` MCP server, or any other MCP server into domain code.
- Undeclared network calls from the meal-event or nutrition domain modules.
- Autonomous background workers, cron retry loops, or an independent “food bot”.
- Claiming that an external provider was called merely because a provider row exists. Provider results must carry honest `succeeded`, `failed`, or `unavailable` status and raw provenance.

The only allowed external-provider integration in this repository is an explicitly injected host bridge at an adapter boundary, if a future deployment needs it. The default plan assumes Hermes performs those calls and passes their structured results to this MCP server.

---

## 2. Current repository truth at baseline

Already present and reusable at HEAD:

- `db/migrations/002_food_tracking.sql` defines `meal_events`, immutable `meal_event_versions`, ordered `meal_event_items`, `meal_event_inputs`, media metadata, provider-result rows, canonical-result rows, the MyFitnessPal sync journal, and backup-manifest contracts.
- `src/meal-types.ts` defines `CreateMealEventCommand`, evidence/media/provider contracts, nullable nutrient fields, provider statuses, sync states, and precedence `user_text > audio_transcript > photo_ocr > photo_vision > model_assumption`.
- `src/meal-events.ts` provides transactional event creation, correction/versioning, reads, provider-result persistence, canonical persistence, idempotency, and sync-journal state operations.
- `src/meal-consensus.ts` provides the pure 10% policy (`consensus-10pct-v1`), nullable-nutrient handling, near-zero behavior, pair/outlier selection, and no-consensus mean.
- `src/media-store.ts` provides generated storage keys, hash verification, root containment, read/delete, and staged-byte ordering seams.
- `src/mcp.ts` registers the existing prepared `log_meal_event` surface. Its current boundary is already honest: it receives prepared items/evidence/media/provider results and does not download attachments, parse photos, run OCR/vision, or call MyFitnessPal.
- Tests include `src/meal-events.test.ts`, `src/meal-consensus.test.ts`, `src/media-store.test.ts`, `src/mcp-food-tracking.test.ts`, `src/backup-policy.test.ts`, and PostgreSQL integration coverage in `src/db.integration.test.ts`.
- `src/db.ts` exposes `withTransaction(pool, fn)`.
- `README.md` documents a single-user, stateless-per-request MCP endpoint backed by local PostgreSQL; `CLAUDE.md` requires Bun, `bun:test`, and no Node/npm substitutions.

Known baseline facts to preserve in implementation handoff:

- `bun test --reporter dots` was previously observed as **401 pass, 51 skip, 0 fail, 1,790 assertions, 25 files** when the plan was audited.
- `bun run typecheck` was clean.
- `bun run format:check` had pre-existing failures in unrelated dated plans and legacy source files; the implementation must report those separately, not hide them or reformat unrelated files.
- No Telegram, STT, OCR/vision, `nutrition-local`, or real MyFitnessPal external call is currently verified by this repository.

Do not create a parallel flat meal model. Reuse the append-only event aggregate and add forward-only schema only when the existing tables cannot represent durable capture state or a new idempotency boundary.

---

## 3. Two-stage delivery boundary

```text
Telegram message/photo/voice
          |
          v
 Hermes: parse → clarify → own estimate → provider MCP calls
          |
          |  prepared capture/draft + provider results + canonical proposal
          v
Stage A: nutrition-mcp capture/evidence/storage MCP seams
          |
          v
Stage B: nutrition-mcp calculation-bundle validation/persistence seam
          |
          v
PostgreSQL: meal event + immutable version + raw evidence/media metadata
           + provider result rows + canonical result + MFP sync journal
```

### Stage A — backend capture/storage and Hermes-facing MCP contracts

Stage A is not Telegram ingestion. It supplies durable backend records that Hermes can call after it has received and parsed chat input.

It must provide:

- A transport-neutral `MealCapture` contract keyed by `user_id`, conversation/capture ID, and idempotency key.
- Start/append/read/answer/confirm/cancel operations as MCP-facing contracts, or one equivalent narrow MCP surface if the planner proves that fewer tools are safer.
- Raw text, external message IDs, user answers, media metadata/storage keys, and agent-supplied evidence retained without lossy parsing by the backend.
- A prepared `MealDraft` write contract containing ordered items and explicit provenance. Hermes supplies the draft; the repository validates and stores it.
- Durable state sufficient for a clarification spanning requests/process restarts, without asking the repository to generate the questions.
- Confirmation gating: the backend must reject calculation/event commit unless Hermes sends an explicit confirmed command. The backend must not interpret a photo or a guessed draft as confirmation.
- One confirmed capture maps to one `meal_event` root with N ordered items, using the existing event repository.

### Stage B — provider calculation bundle and canonical persistence seam

Stage B is not a provider orchestrator that independently calls three services. Hermes performs all reasoning and tool calls. The repository supplies a narrow, deterministic persistence seam:

- Hermes submits one calculation bundle containing the resolved draft snapshot, all available results for `nutrition-local`, `own`, and `myfitnesspal`, honest status/error metadata, request fingerprints, raw payloads, basis/units, and its proposed canonical result.
- The backend validates provider names/statuses, finite numeric values, nullable missing values, scope (`event` or item ordinal), basis/unit metadata, algorithm/model versions, and fingerprint consistency.
- The backend either recomputes canonical values from the submitted normalized provider rows using `computeConsensus`, or validates the agent’s proposal against that pure policy. Choose one mode in the planner handoff; do not implement two competing sources of truth. The recommended mode is backend recomputation for durable consistency while Hermes remains responsible for calling tools and explaining the outcome.
- The backend persists every raw/normalized provider row before or atomically with one canonical row per scope.
- Provider failure/unavailability never becomes numeric zero and does not roll back the confirmed local event.
- `добавь` creates explicit MFP authorization/journal intent; a pending journal row is never reported as a successful MFP sync.
- Repeating the same calculation fingerprint is idempotent. A changed portion, evidence snapshot, or provider input creates a new fingerprint and, when appropriate, a correction/version rather than mutating history.

---

## 4. Proposed contracts and exact file targets

### Stage A targets

**Create:**

- `src/meal-capture-types.ts` — transport-neutral `MealCaptureId`, `CaptureState`, `CaptureMessageInput`, `CaptureMediaInput`, `EvidenceInput`, `PreparedMealDraft`, `ClarificationAnswer`, `ConfirmCaptureCommand`, and result/error types. No Telegram SDK types, update objects, or vendor payloads.
- `src/meal-captures.ts` — transactional capture repository/service: start, append raw input, read state, store agent-supplied draft/evidence, confirm/cancel/expire, and idempotent transitions. It may call `withTransaction` but must not call external MCP tools.
- `src/meal-captures.test.ts` — pure validation, transition, precedence, and idempotency tests.
- `src/meal-captures.integration.test.ts` — PostgreSQL transaction/restart/idempotency tests.
- `db/migrations/003_meal_captures.sql` — only if durable capture state is required. Prefer `meal_captures`, `meal_capture_messages`, and `meal_capture_media` with unique external message/idempotency keys. Do not duplicate final `meal_event_inputs` unnecessarily.

**Modify narrowly:**

- `src/meal-types.ts` — share only the types needed to map `PreparedMealDraft` to `CreateMealEventCommand`; preserve existing provider names and nullable nutrient semantics.
- `src/media-store.ts` — only if a tested `stage → attach → cleanup` lifecycle is missing. Keep generated-key and hash/root-containment checks intact.
- `src/meal-events.ts` — add a narrow capture-to-event mapping or repository method; keep the existing transaction and append-only version rules.
- `src/mcp.ts` — register the selected capture/read/confirm tools with schemas and descriptions that say Hermes supplies prepared data. Keep `log_meal_event` as the low-level prepared seam unless a compatibility-preserving rename is required.
- `src/mcp-food-tracking.test.ts` — route/schema/idempotency tests for the selected MCP surface.
- `README.md` and `.env.example` — document the agent-driven boundary, media metadata contract, `MEDIA_ROOT`, and honest unavailable external integrations. Do not add bot-token configuration.

### Stage B targets

**Create:**

- `src/nutrition-bundle-types.ts` — `CalculationBundle`, `ProviderCalculationResult`, `NutrientBasis`, `CalculationScope`, `ProviderError`, canonical proposal/validation result, and stable fingerprint inputs. Raw payloads remain JSON-compatible and opaque.
- `src/nutrition-bundle.ts` — pure validation/fingerprint/canonical-policy boundary plus a persistence-ready mapping. This module may call `computeConsensus`; it must not call any MCP server or network client.
- `src/nutrition-bundle.test.ts` — TDD coverage for contract validation, null/malformed values, deterministic ordering/fingerprints, consensus proposal validation/recomputation, and all provider statuses.
- `src/nutrition-bundle.integration.test.ts` — PostgreSQL persistence and re-read tests for raw provider rows, canonical rows, retries, and rollback.

**Modify narrowly:**

- `src/meal-events.ts` — expose a persistence operation for a confirmed calculation bundle, or extend `CreateMealEventCommand.provider_results` without weakening existing constraints. Ensure canonical source result IDs are the inserted row IDs.
- `src/meal-consensus.ts` — normally behavior remains unchanged. Add tests only if the new bundle boundary exposes a real contract defect; do not fork consensus logic.
- `src/mcp.ts` — add the calculation-bundle/confirmed-commit tool only after contract tests. Its description must state that Hermes supplies provider results and that the repository does not call external MCP servers.
- `src/mcp-food-tracking.test.ts` — assert pending/ready/low-confidence, failed/unavailable provider statuses, explicit confirmation, and retry behavior.
- `README.md` and `.env.example` — explain provider-result submission, `consensus-10pct-v1`, and the difference between MFP authorization journal state and successful external sync.

### Existing schema reuse and migration rule

`002_food_tracking.sql` already stores final raw evidence/media metadata, provider results, canonical results, and the sync journal. Add `003_meal_captures.sql` only if a multi-turn capture cannot be represented safely in existing tables. Binary media must remain under `MEDIA_ROOT`; PostgreSQL stores generated keys, hashes, MIME/size/dimensions/duration, and provenance metadata. Never store arbitrary Telegram payloads or binary bytes as an implementation shortcut.

Recommended capture columns:

- `meal_captures(id, user_id, conversation_key, idempotency_key, state, prepared_draft jsonb, confirmed_at, expires_at, created_at, updated_at)`
- `meal_capture_messages(id, capture_id, external_message_id, kind, text, raw_metadata jsonb, received_at)` with a unique `(capture_id, external_message_id)`
- `meal_capture_media(id, capture_id, storage_key, kind, MIME/size/hash/duration/dimensions, metadata jsonb)`

Question text and question selection remain Hermes-owned. If the backend stores a question/answer audit trail, it stores the agent-supplied question and answer as data; it does not decide what to ask.

---

## 5. TDD-first implementation slices

Each slice follows **RED → verify failure → GREEN → focused pass → REFACTOR → commit**. A coder must not implement a slice by first writing production code and retrofitting tests.

### A1 — Capture contract and raw evidence

**Files:** `src/meal-capture-types.ts`, `src/meal-captures.test.ts`.

**RED tests:** generic text/photo/audio metadata is accepted; duplicate external message and idempotency keys are no-ops; malformed timestamps, unsupported media, invalid hash/size, and empty required IDs fail closed; user text sorts above transcript/photo/assumption evidence while all evidence remains retained.

**GREEN boundary:** types, validation, deterministic evidence ordering, and fake repository interfaces only. No Telegram imports, no media download, no STT/OCR/vision, no provider calls.

**Acceptance:** Hermes can submit a prepared, transport-neutral capture payload and receive stable validation errors without the repository parsing it.

### A2 — Durable capture state and confirmation gate

**Files:** `db/migrations/003_meal_captures.sql` if required, `src/meal-captures.ts`, `src/meal-captures.integration.test.ts`.

**RED tests:** start/replay returns one capture; append is idempotent; agent-supplied draft is retained; `receiving → ready_to_confirm → confirmed` transitions are explicit; answer/cancel/expiry transitions are idempotent; unconfirmed capture cannot commit an event or calculation bundle; concurrent confirmation cannot create two roots; transaction rollback leaves no partial capture.

**GREEN boundary:** row-locked state transitions and durable raw metadata. The service does not ask questions and does not infer readiness from a photo.

**Acceptance:** a process restart does not lose a pending capture; the only confirmation input is an explicit agent command representing the user’s “добавь” intent.

### A3 — Media staging/attachment seam

**Files:** `src/media-store.ts` only if needed, `src/meal-captures.ts`, `src/meal-captures.test.ts`, `src/media-store.test.ts`.

**RED tests:** a host-staged byte stream is hash-verified and assigned a generated key; metadata is attached to a capture; size/MIME limits fail before commit; DB failure triggers cleanup; unsafe keys remain rejected.

**GREEN boundary:** accept bytes or already-staged metadata from the host; never download from Telegram and never inspect image/audio content.

**Acceptance:** raw media can be retained for audit/retry without implying that the repository performed transcription or vision analysis.

### A4 — Confirmed capture to one event

**Files:** `src/meal-captures.ts`, `src/meal-events.ts`, `src/mcp.ts`, `src/mcp-food-tracking.test.ts`, `src/meal-captures.integration.test.ts`.

**RED tests:** a confirmed two-item draft creates exactly one event root with two ordered items; raw evidence/media metadata attaches to the version; duplicate confirmation is deduplicated; unconfirmed capture cannot call event persistence; reported/consumed timestamps preserve existing semantics.

**GREEN boundary:** map Hermes’s prepared draft to existing `CreateMealEventCommand` and persist transactionally. Do not calculate nutrition here.

**Acceptance:** Stage A has a real MCP vertical path from agent-submitted capture → confirmation → one multi-item append-only event, with no Telegram endpoint.

### B1 — Calculation bundle contract

**Files:** `src/nutrition-bundle-types.ts`, `src/nutrition-bundle.test.ts`.

**RED tests:** all three provider names are representable; success/failed/unavailable is explicit; raw payload, basis/unit, scope, fingerprint, and algorithm/model version are required or explicitly nullable by contract; non-finite values and unknown providers fail; missing nutrients remain null; changed portion/evidence changes the fingerprint.

**GREEN boundary:** pure schemas and deterministic fingerprinting. Hermes remains the only caller of external tools.

**Acceptance:** a bundle submitted by Hermes has sufficient provenance to audit what was called, what was unavailable, and what was estimated.

### B2 — Consensus and canonical proposal boundary

**Files:** `src/nutrition-bundle.ts`, `src/nutrition-bundle.test.ts`.

**RED tests:** exact 10% boundary is inclusive; outlier pair selection, all-agree, no-consensus, near-zero, insufficient-data, null, and failed/unavailable behavior match `src/meal-consensus.ts`; provider order cannot alter the result; a mismatching submitted canonical proposal is rejected or replaced according to the chosen policy.

**GREEN boundary:** call `computeConsensus` exactly once per scope, with no provider invocation. Preserve `consensus-10pct-v1`, eligible/outlier providers, threshold, policy version, and source fingerprints.

**Acceptance:** Hermes can show its own reasoning/proposal, while persisted canonical data has one deterministic backend policy and never treats unavailable as zero.

### B3 — Persist bundle atomically and idempotently

**Files:** `src/meal-events.ts`, `src/nutrition-bundle.ts`, `src/nutrition-bundle.integration.test.ts`, `src/mcp-food-tracking.test.ts`.

**RED tests:** confirmed bundle stores all supplied provider rows at item/event scopes and one canonical row per scope; repeat fingerprint does not duplicate rows; changed input creates a distinct calculation/correction identity; provider failure still commits local event and other results; DB failure rolls back event/version/items/results together; canonical source IDs point to inserted provider rows.

**GREEN boundary:** use existing `meal_event_nutrition_results` and `meal_event_canonical_results`; extend `meal-events.ts` narrowly; preserve append-only correction semantics.

**Acceptance:** Stage B has a real agent-callable persistence path: Hermes calls external tools and submits results; nutrition-mcp stores and deterministically materializes the canonical result.

### B4 — MyFitnessPal authorization journal seam

**Files:** `src/meal-events.ts`, `src/mcp.ts`, `src/mcp-food-tracking.test.ts`, `src/nutrition-bundle.integration.test.ts`.

**RED tests:** only explicit confirmed add intent creates a pending MyFitnessPal journal row; no row is reported as synced; retry state transitions follow the existing journal state machine; an unavailable/failed MFP calculation is distinct from a pending write authorization; duplicate intent is idempotent.

**GREEN boundary:** journal/outbox state only. Do not import or invoke the MyFitnessPal MCP tool.

**Acceptance:** external sync can be driven later by Hermes/host infrastructure without falsifying delivery in this repository.

### B5 — MCP contract and documentation truth pass

**Files:** `src/mcp.ts`, `src/mcp-food-tracking.test.ts`, `README.md`, `.env.example`.

**RED tests:** schemas reject unconfirmed commits; responses distinguish `pending`, `ready`, `low_confidence`, `failed`, and `unavailable`; prepared `log_meal_event` remains honest; duplicate calls converge; no schema or tool description mentions a Telegram webhook/STT/vision worker.

**GREEN boundary:** wire only the selected agent-facing MCP operations with injected pool/media dependencies. Keep the HTTP server as MCP transport, not a Telegram ingress.

**Acceptance:** documentation and tool descriptions accurately state that Hermes performs parsing, clarification, calculations, and provider calls.

---

## 6. Acceptance criteria

### Stage A

- [ ] Hermes can submit text/photo/voice metadata through a transport-neutral MCP contract; the repository has no Telegram-specific type or route.
- [ ] Raw message metadata, agent-supplied evidence, and media metadata remain auditable; media bytes are staged via `MEDIA_ROOT`, not stored in JSONB.
- [ ] Explicit user text/answer has deterministic precedence over transcript/photo/assumption evidence; lower-precedence evidence is retained.
- [ ] Capture state is durable, idempotent, cancellable, and expiry-aware when multi-turn restart resilience is promised.
- [ ] The repository stores agent-supplied clarification answers but does not generate questions or parse answers.
- [ ] No provider calculation or event commit occurs before an explicit confirmation representing “добавь”.
- [ ] One confirmed capture with N items creates exactly one `meal_event` root and ordered `meal_event_items` in one transaction.
- [ ] Replayed messages, confirmations, and MCP requests do not duplicate captures, event roots, or child rows.
- [ ] Media/staging failure is explicit and retryable; the repository never claims STT/OCR/vision success.

### Stage B

- [ ] Hermes can submit `nutrition-local`, `own`, and `myfitnesspal` results with explicit success/failed/unavailable status and provenance.
- [ ] `own` is documented as Hermes’s estimate, not a repository-owned calculator.
- [ ] Provider results use one nullable nutrient contract with scope, basis/unit, raw payload, fingerprint, and algorithm/model version.
- [ ] Existing `computeConsensus` and `consensus-10pct-v1` are reused; boundary, outlier, no-consensus, missing, and near-zero behavior is covered.
- [ ] Canonical results are persisted per event/item scope with threshold, policy version, eligible/outlier providers, and source result IDs.
- [ ] Provider timeout/failure/unavailability does not roll back the confirmed local event or fabricate zero values.
- [ ] Same bundle fingerprint is idempotent; changed evidence/portion/provider input is distinguishable and correction-safe.
- [ ] MyFitnessPal calculation invocation remains Hermes-owned; the repository only stores submitted result data and explicit sync-journal intent.
- [ ] `добавь` is the authorization boundary; `pending` never means `synced`.
- [ ] Real PostgreSQL integration tests prove migration, transactions, idempotency, and re-read paths.
- [ ] No production code calls another MCP server directly, and no external Telegram/provider access is claimed without a separately configured integration test.

---

## 7. Verification commands

Run from `/Users/fishhead/.workspace/projects/nutrition-mcp`.

### Before and after every slice

```bash
git status --short
git diff --check
bun test <focused-test-files> --reporter dots
bun run typecheck
```

At RED, the focused test is expected to fail for the missing contract. Do not report a RED test as a completed feature.

### Full unit/type gates

```bash
bun test --reporter dots
bun run typecheck
bun run format:check
```

A coder must distinguish changed-file formatting from the known pre-existing repository-wide formatter failures and must not reformat unrelated files.

### PostgreSQL integration gate

Use the repository’s isolated local test database:

```bash
export DATABASE_URL_TEST='postgres://localhost:5432/nutrition_mcp_test'
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun test \
  src/db.integration.test.ts \
  src/meal-events.test.ts \
  src/mcp-food-tracking.test.ts \
  src/meal-captures.integration.test.ts \
  src/nutrition-bundle.integration.test.ts \
  --reporter dots
```

The harness must apply migrations in order: `001_initial_schema.sql`, `002_food_tracking.sql`, and `003_meal_captures.sql` if created. Output must show passing DB tests, not only skipped DB tests.

### Contract/boundary inspection

```bash
python - <<'PY'
from pathlib import Path
for path in [
    "src/meal-capture-types.ts",
    "src/meal-captures.ts",
    "src/nutrition-bundle-types.ts",
    "src/nutrition-bundle.ts",
    "src/mcp.ts",
]:
    p = Path(path)
    if p.exists():
        text = p.read_text()
        forbidden = ["telegram", "telegraf", "openai", "anthropic"]
        print(path, "bytes=", len(text), "forbidden-provider-imports=", [x for x in forbidden if x in text.lower()])
PY
```

This is a review aid, not a substitute for code review. Domain modules must have no direct MCP-server/network imports.

### MCP tests

```bash
DATABASE_URL_TEST="$DATABASE_URL_TEST" bun test \
  src/mcp-food-tracking.test.ts \
  --reporter dots
```

This verifies the local MCP transport and PostgreSQL persistence only. It does not verify Telegram, voice transcription, OCR/vision, nutrition-local, or MyFitnessPal external access.

### Final diff guard

```bash
git status --short
git diff --stat
git diff --check
git diff -- db/migrations src README.md .env.example
```

The final implementation must not include unrelated formatter churn, Telegram deployment files, bot tokens, or changes outside the approved slice.

---

## 8. Risks and guardrails

| Risk                                               | Guardrail                                                                                                                         |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Turning `nutrition-mcp` into a Telegram bot        | No Telegram SDK, webhook, token, polling, STT, OCR, or vision target files; all inputs are transport-neutral and agent-supplied.  |
| Backend re-parsing Hermes output                   | Store/validate structured drafts and evidence; do not add LLM/parser logic to domain code.                                        |
| Questions generated in the wrong layer             | Hermes owns question sequencing; repository stores optional question/answer audit data only.                                      |
| Provider MCP imported from domain code             | Use submitted provider-result contracts; any future bridge is injected at the host boundary.                                      |
| Hermes and backend disagree on consensus           | Reuse `computeConsensus` and make one explicit choice: recommended backend recomputation/validation from submitted provider rows. |
| Missing provider treated as zero                   | Nullable nutrients, explicit statuses, and consensus tests; `unavailable` is never numeric.                                       |
| One event per message/item                         | Durable capture ID plus unique idempotency key; final commit creates one root and ordered children.                               |
| “добавь” confused with successful MFP sync         | Store authorization as pending journal state; never emit `synced` without an external writer result.                              |
| Media orphaned after DB failure                    | Stage/verify first, commit metadata second, clean up on transaction failure.                                                      |
| Provider completion order changes canonical output | Sort by stable provider/scope identity before persistence and consensus.                                                          |
| Rewriting applied migration `002`                  | Add forward migration only; preserve existing event tables and data.                                                              |
| Fake external verification                         | Label all provider/Telegram tests as contract/fake tests unless real credentials and a separately approved adapter test exist.    |

---

## 9. Staged workflow handoff

1. **Planner:** inspect this plan against live HEAD and current migrations/tests. Resolve before coding: whether `003_meal_captures.sql` is necessary, the exact MCP tool names, and whether canonical persistence recomputes or validates Hermes’s proposal. Produce a short handoff note with no production edits.
2. **Coder:** implement Stage A in A1–A4 order, then Stage B in B1–B5 order. For each slice, write failing tests first, run the focused RED command, implement the minimum, run GREEN/typecheck, and commit only the bounded files. Stop and report if a required contract cannot be grounded in current code.
3. **Reviewer:** review each coder commit against this plan and acceptance criteria. Focus on the responsibility split, absence of autonomous bot behavior, one-capture/one-root identity, raw provenance/media lifecycle, confirmation/idempotency, canonical source IDs, consensus policy reuse, MFP pending semantics, and direct MCP/network imports.
4. **Remediation:** if reviewer finds a gap, planner writes a focused correction and coder implements it with new RED tests. Reviewer re-checks only after the coder’s verification commands pass.
5. **Completion gate:** merge only when focused tests, full tests, typecheck, migration-backed integration tests, diff hygiene, and documentation truth all pass or have explicitly recorded pre-existing exceptions.

### Recommended execution order

Start with **A1–A2** and a deterministic prepared-draft fixture. Then complete **A3–A4** against PostgreSQL. Implement **B1–B2 offline**, then **B3–B5** as the combined confirmed-bundle vertical path. This keeps Hermes’s Telegram capabilities and external MCP availability outside the repository test loop while still providing a durable, verifiable backend contract.

**Out of scope for this plan:** implementing or deploying a Telegram bot/webhook, adding STT/OCR/vision workers, importing another MCP server into this repository, making production external provider calls, or changing production code during planning.
