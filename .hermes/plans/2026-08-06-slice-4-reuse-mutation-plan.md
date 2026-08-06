# Slice 4 Implementation Plan — Confirmed Meal-Reuse Mutation (`reuse_meal_calculation`)

> **For the implementer (coder-kimi dispatch):** Execute task-by-task in the RED→GREEN order below. **No production code before the named failing test is observed failing.** Do not implement Slice 5+ (regimens/intake/snack linkage/reports/flags), do not alter Slice 3 discovery semantics, and do not touch shipped migrations `001`–`009`.

**Governing authority (this plan may not narrow any of it):**

- `.hermes/plans/2026-08-06-slice-4-reuse-mutation-brief.md` (the Slice 4 acceptance lock)
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md` — A3, A4, A5, B7, C2, C3
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md` — Slice 4 (lines 192–204), AC matrix rows A3/A4/A5, stable error taxonomy (§5), adversarial gates (§8)

**Goal:** Ship the public `reuse_meal_calculation` MCP mutation: an explicit-confirmation, server-copy-only, transactional, idempotent creation of a fresh meal event from a precise prior event/version, with immutable lineage, fail-closed eligibility, and real-PostgreSQL + real-transport executable proof.

**Architecture:** One transaction in `src/meal-reuse.ts` locks the idempotency identity and the exact source event/version, enforces eligibility against real persisted provenance (`deriveAggregateProvenance` policy), copies server-read source items/provider evidence/canonical facts byte-for-byte into a fresh root + version 1 (carrying the source bundle fingerprint so the copy re-derives `ready`), writes lineage into the shipped `meal_event_reuse_sources` / `meal_event_reuse_provider_sources` tables, and returns the public provenance readback. The MCP layer only adapts args and maps typed domain errors to stable codes, exactly like the Slice 2 supplement tools.

**Tech stack / conventions in force:** Bun + TypeScript + `pg` + zod + MCP SDK. Tools registered in `src/mcp.ts` via `server.registerTool` + `withAnalytics` + `outputSchema`/`structuredContent`. DB suites reset `public` and replay migrations 001–009; `scripts/test-db-gate.ts` enforces `DATABASE_URL === DATABASE_URL_TEST` and already lists `src/meal-reuse.integration.test.ts` and `src/mcp-reuse.integration.test.ts` (no gate edit needed — a suite that runs zero tests fails the gate, so new tests are automatically enforced).

---

## 1. Verified baseline (inspected live at Slice 3 HEAD)

Baseline verified: `git rev-parse HEAD` = `927ac25d3c06ece92c4043c41a8c4cba474d354a` on `main`, matching the brief. Untracked files are plans only.

| Live artifact (path:lines at HEAD)                                                          | Observed fact                                                                                                                                                                                                                                                                                                                                                                                             | Consequence for Slice 4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db/migrations/006_meal_reuse_and_supplements.sql:19-61`                                    | `meal_event_reuse_sources` (PK `(event_id,version)`, FKs to both version pairs, `confirmation_received boolean NOT NULL`, `reuse_idempotency_key NOT NULL`, unique `uniq_meal_reuse_user_idem (user_id, reuse_idempotency_key)`, index on source pair) and `meal_event_reuse_provider_sources` (unique `target_provider_result_id`, unique `(event_id,version,source_provider_result_id)`) already exist. | **No new migration is needed.** Lineage persistence is pure INSERTs. The `(user_id, reuse_idempotency_key)` unique index is the DB-level idempotency/concurrency anchor for the reuse operation itself.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `db/migrations/007_ownership_lineage_integrity.sql`                                         | Composite FKs force: lineage `user_id` owns BOTH target and source events; provider-mapping rows carry `source_event_id`/`source_version NOT NULL` and must reference real provider rows of the declared pairs, with `source_request_fingerprint` matching the actual source row.                                                                                                                         | The copy service must insert mapping rows with the declared source pair columns; any fabricated relationship is rejected by the database itself. Tests can rely on constraint names for negative assertions.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `db/migrations/002_food_tracking.sql:171-198`                                               | Provider-result uniqueness is `(event_id, version, scope_key, provider, request_fingerprint)`; `source_id` NOT NULL.                                                                                                                                                                                                                                                                                      | Copying the source's `request_fingerprint`/`source_id`/`raw_payload`/`provenance` byte-for-byte onto a NEW `event_id` cannot collide. No fingerprint rewriting needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/meal-types.ts:325-350`                                                                 | `ReuseIdempotencyIdentity` + `deriveReuseIdempotencyFingerprint` shipped in Slice 1: hash of `user_id, reuse_idempotency_key, source_event_id, source_version, reported_at, consumed_at`, prefixed `reuse:`.                                                                                                                                                                                              | Use this as the target `meal_events.idempotency_key` — the "server-generated distinct occurrence identity" required by the brief. Same command replays converge in `createMealEvent`-style root dedup; changed identity yields a different root key and is caught as a conflict by the lineage unique index inside the same transaction (no partial rows survive the abort).                                                                                                                                                                                                                                                                           |
| `src/meal-events.ts:725-923`                                                                | `createMealEvent(pool, command, transactionClient?)` exists with `INSERT … ON CONFLICT` root idempotency and a unique-violation convergence catch.                                                                                                                                                                                                                                                        | The seam exists, BUT the generic create path recomputes canonical from provider inputs, leaves `calculation_bundle_fingerprint` NULL, and builds its own `audit_evidence` — a copy through it would derive `compatibility`/`pending`, not `ready`. Slice 4 therefore uses a **dedicated copy writer** (§4.3) that inserts the version row WITH the source bundle fingerprint and copies canonical rows (including `audit_evidence`) verbatim, remapping `source_result_ids` to the new provider-row ids. `src/meal-events.ts` needs **no modification** (fallback: if a truly minimal seam is required, only a narrow export — never behavior change). |
| `src/meal-events.ts:281-343` (`deriveAggregateProvenance`)                                  | `ready` requires: 3 named providers (`nutrition-local`,`own`,`myfitnesspal`) all `succeeded` with source_id/fingerprint/algorithm/raw_payload/provenance (non-compatibility)/basis/units; canonical `ready`, non-`insufficient_data`, `source_result_ids` = exactly those 3 result ids, `audit_evidence.fingerprint === version.calculation_bundle_fingerprint`.                                          | (a) Source eligibility = this exact function returning `ready` with `compatibility === false` on the requested version's aggregate — no bespoke policy. (b) The copy must remap `source_result_ids` and carry the source fingerprint on the target version row or the target could never re-derive `ready`.                                                                                                                                                                                                                                                                                                                                            |
| `src/meal-events.ts:1066-1268`                                                              | `getMealEvent` runs 6 reads via `Promise.all` on a `Pool` — cannot run on a single `PoolClient`. `getMealEventProvenance(pool,userId,eventId,version?)` is the user-scoped public readback (active-only root, current-or-explicit-historical, `is_current`).                                                                                                                                              | The in-transaction source snapshot needs a new **sequential** client-based reader in `src/meal-reuse.ts` (§4.2). Post-commit readback and all "copied facts re-readable" proofs use the existing public `getMealEventProvenance` / `get_calculation_provenance` path unchanged.                                                                                                                                                                                                                                                                                                                                                                        |
| `src/calculation-bundles.ts:23,451` + `src/calculation-bundles.integration.test.ts:199,625` | `beforeCommit?: () => Promise<void>` options-hook convention for injected post-child/pre-commit rollback tests.                                                                                                                                                                                                                                                                                           | `reuseMealCalculation` takes the same test-only `opts.beforeCommit` hook.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/mcp.ts:5538-5560` (`confirm_meal_capture`)                                             | Server confirmation policy is `z.enum(["добавь", "add", "confirm"])`.                                                                                                                                                                                                                                                                                                                                     | `reuse_meal_calculation` reuses the identical enum — "explicit confirmation accepted by server policy" stays one policy, not two.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/mcp.ts:5746-5760` (`supplementToolError`)                                              | Typed domain errors with stable `code` fields are mapped to stable public `Error` messages in one handler-local mapper; cross-user/deleted resolve as not-found.                                                                                                                                                                                                                                          | Mirror exactly: reuse domain errors in `src/meal-reuse.ts`, one `reuseToolError` mapper in `src/mcp.ts`. Reuse the existing shared code string `idempotency_conflict` (parent plan §5).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `src/mcp.ts:136-213, 2550-2643`                                                             | `SEARCH_MEALS_OUTPUT_SCHEMA` and the evolved `search_meals` registration (read-only; structured 90d discovery).                                                                                                                                                                                                                                                                                           | Slice 4 does not touch `search_meals` behavior. Discovery output remains the source of the precise `(source_event_id, source_version)` pair callers pass in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/meal-reuse.fixtures.ts`                                                                | Test-only fixtures: `seedMealEvent`, `readyBundle`/`unavailableBundle` + `commitBundle` (real three-provider ready evidence through real write paths), `correctMeal`, `deleteMealEvent`, `seedVariationCorpus`, `domainTableCounts` (already counts both lineage tables), `withReuseTools(pool, userId, run)` real `McpServer`+`Client`+`InMemoryTransport` harness.                                      | All Slice 4 suites build on these fixtures; extend the module, do not fork a new harness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/mcp-reuse.integration.test.ts:119-124`                                                 | Guard test: "listTools does not advertise reuse_meal_calculation (Slice 4 guard)".                                                                                                                                                                                                                                                                                                                        | This test MUST be replaced in the same commit that registers the tool (Task 8) — otherwise the DB gate fails. Its replacement asserts the tool IS advertised with truthful mutation annotations.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `scripts/test-db-gate.ts`                                                                   | Migration array already 001–009; suites already include both reuse suites; zero-test suites fail the gate.                                                                                                                                                                                                                                                                                                | No gate change. All new tests land in the two existing reuse suites.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/food-tracking-docs.test.ts`                                                            | Docs tests derive the migration chain from the directory; README must contain a `psql … -f` line per migration. No per-tool inventory assertion exists.                                                                                                                                                                                                                                                   | No new migration ⇒ no docs-test change forced. A README tools-table row for the new tool follows the Slice 3 precedent (commit `927ac25`) and C1 truthfulness (Task 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `package.json`, `.env` (gitignored)                                                         | Gates: `bun run test:unit`, `bun run test:db`, `bun run typecheck`, `bun run format:check`. Real destructive DB runs require an explicit disposable `DATABASE_URL_TEST` equal to `DATABASE_URL`.                                                                                                                                                                                                          | Verification section §8 uses these exact commands. Never commit or print a real DSN.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 2. Declared decisions, contradictions, and defaults (no silent narrowing)

1. **Copy writer instead of `createMealEvent` for children.** The brief requires the target's copied facts to be re-readable as exactly the source facts, and `getMealEventProvenance` to re-derive them. `createMealEvent`'s child path _recomputes_ canonical and marks the version compatibility (NULL fingerprint) — a reuse through it would publicly read `pending`/`compatibility: true`, contradicting "copied canonical facts". **Default:** a dedicated transactional writer copies rows verbatim and stamps `calculation_bundle_fingerprint = source fingerprint` on the target version row, so `deriveAggregateProvenance` re-derives `ready` from the copied evidence (the audit `fingerprint` field matches). This is data-level copying, not recomputation — nothing is fabricated; the fingerprint is truthful because it _is_ the same bundle content, and the lineage row additionally records `source_bundle_fingerprint`.
2. **What is copied.** Brief §3: "Copy only server-read source items, provider evidence, canonical facts, and source identity." **Default:** copy `meal_event_items` (all columns), ALL `meal_event_nutrition_results` rows of the source version (event scope and item scopes, byte-for-byte including `source_id`, `request_fingerprint`, `raw_payload`, `provenance`, `basis`, `units`, nutrient columns, status), and ALL `meal_event_canonical_results` rows (event + item scopes) with `source_result_ids` remapped to the new provider-row ids and `audit_evidence` copied verbatim. Do NOT copy `meal_event_inputs` (raw occurrence evidence) or `meal_event_media` (storage keys are identity-bound to the source event/version); the target's evidence of origin is the lineage row. `meal_type` is copied from the source root. No sync-journal row is written (`external_write_authorized` is not a reuse concept).
3. **Requested historical versions are reusable.** A3/A4 speak of "the requested current/historical version"; Slice 3 discovery candidates expose only current versions, but the mutation accepts a precise pair. **Default policy:** any version `v` with a persisted `meal_event_versions` row for an active, caller-owned source is reusable iff that exact version's aggregate independently derives `ready`/non-compatibility. The readback discloses `source_was_current: boolean`. "Current-vs-requested-historical policy breach" = the requested version has no persisted row (v < 1, v > current with no row, or any gap) → stable `meal_reuse_source_version_not_current_or_historical`. This widens nothing and narrows nothing: current and eligible-historical both work; nonexistent fails closed.
4. **Idempotency identity comparison uses millisecond-equal timestamps.** The lineage table stores no fingerprint column; identity is recomputable from persisted truth: lineage `(source_event_id, source_version, reuse_idempotency_key, user_id)` + target root `(reported_at, consumed_at)`. `timestamptz` round-trips lose sub-ms precision and ISO string variants (`Z` vs `+00:00`) differ; **default:** identity equality compares `Date.parse` millisecond values, not strings. `deriveReuseIdempotencyFingerprint` is still used to build the target root's `idempotency_key` (occurrence identity, `reuse:`-prefixed so it can never collide with a caller's `log_meal_event` key space by accident).
5. **Unknown extra args are stripped, and the test proves they are inert.** MCP SDK `registerTool` input shapes strip unrecognized keys rather than reject. The brief's "does not accept caller-supplied canonical totals / provider results / fingerprints / source evidence" is enforced by (a) the schema simply having no such fields, and (b) an executable proof that a call smuggling `canonical`, `provider_results`, `nutrients`, and `bundle_fingerprint` junk args persists ONLY source-derived values (forged numbers appear nowhere in any target row). Declared here so reviewers do not mistake stripping for acceptance.
6. **Confirmation enum, not free text.** "Explicit confirmation accepted by server policy" = the same `z.enum(["добавь", "add", "confirm"])` the shipped `confirm_meal_capture` uses. A missing or non-enum value is a transport-level validation error and performs zero reads/writes.
7. **Error taxonomy (stable public codes).** From parent plan §5, implemented as typed classes in `src/meal-reuse.ts` with readonly `code`, mapped in `src/mcp.ts`:
    - `meal_reuse_source_not_found` — source absent, deleted, or another user's (indistinguishable by design; no existence leak),
    - `meal_reuse_source_version_not_current_or_historical` — owned active source but requested version has no persisted row,
    - `meal_reuse_source_ineligible: <category>` — version exists but provenance is not fully ready; category ∈ `compatibility | pending | unavailable | missing` (from `deriveAggregateProvenance`),
    - `idempotency_conflict` — same key, different semantic identity (shared code with supplements, per parent plan),
    - zod validation issues surface as MCP validation errors (invalid UUID, bad timestamps, empty key, bad confirmation).
      Every rejection path writes nothing (proven by `domainTableCounts`).
8. **Analytics `categorizeError` compatibility.** `withAnalytics` categorizes by message substring; reuse error messages contain their stable code as the message prefix (mirroring `supplementToolError`'s `throw new Error("supplement_product_not_found")` style) — no analytics change required.
9. **No `search_meals` change.** The only permitted Slice-3-adjacent edit is the guard-test flip in `src/mcp-reuse.integration.test.ts` (it exists precisely to be flipped by this slice). If implementation genuinely needs a shared read seam from Slice 3 code, it may import existing exports of `meal-reuse.ts`/`meal-events.ts`; it may not alter their behavior.
10. **No new migration expected.** 006+007 already cover lineage. If a genuine schema gap emerges (it should not), the rule is: additive forward-only `db/migrations/010_*.sql` + updates to every migration array (`scripts/test-db-gate.ts`, both reuse suites, other suites' arrays as they enumerate the chain) + README `psql -f` line + docs chain (enforced by `food-tracking-docs.test.ts`). Never edit shipped `006`–`009`.

**Blocker status:** none. All substrate (schema, fingerprint contract, harness, gate) is live at HEAD.

## 3. Scope boundary

**In scope:** the `reuse_meal_calculation` public mutation, its domain service + eligibility + lineage persistence in `src/meal-reuse.ts`, typed output schema + registration + error mapping in `src/mcp.ts`, pure unit tests in `src/meal-reuse.test.ts`, real-PG repository tests in `src/meal-reuse.integration.test.ts`, real-transport tests in `src/mcp-reuse.integration.test.ts`, fixture extensions in `src/meal-reuse.fixtures.ts`, README tools-table row + one docs paragraph.

**Explicitly out of scope (do not build):** Slice 5+ regimens/intake/sports-snack linkage/reports/flags/docs closeout; any change to Slice 3 ranking/output semantics; OCR/STT/vision, Telegram, provider calls/workers, MyFitnessPal delivery, scheduler/reminders, medical advice; edits to shipped migrations `006`–`009`; changes to alcohol tracking or existing food paths.

---

## 4. Design to implement (exact shapes)

### 4.1 Domain errors — `src/meal-reuse.ts`

```ts
export class MealReuseSourceNotFoundError extends Error {
    readonly code = "meal_reuse_source_not_found";
    constructor() {
        super("no reusable meal event with this id exists for this user");
        this.name = "MealReuseSourceNotFoundError";
    }
}

export class MealReuseSourceVersionError extends Error {
    readonly code = "meal_reuse_source_version_not_current_or_historical";
    constructor() {
        super(
            "requested source version is neither the current nor a persisted historical version",
        );
        this.name = "MealReuseSourceVersionError";
    }
}

export type MealReuseIneligibleCategory =
    "compatibility" | "pending" | "unavailable" | "missing";

export class MealReuseSourceIneligibleError extends Error {
    readonly code = "meal_reuse_source_ineligible";
    constructor(readonly category: MealReuseIneligibleCategory) {
        super(
            `meal_reuse_source_ineligible: ${category} — source version lacks complete ready provider/canonical evidence; nothing was created and no value was fabricated`,
        );
        this.name = "MealReuseSourceIneligibleError";
    }
}

export class MealReuseIdempotencyConflictError extends Error {
    readonly code = "idempotency_conflict";
    constructor() {
        super(
            "idempotency_conflict: this reuse idempotency key was already used with a different source event/version or timestamps",
        );
        this.name = "MealReuseIdempotencyConflictError";
    }
}
```

### 4.2 Pure helpers (unit-testable, no I/O) — `src/meal-reuse.ts`

```ts
/** Millisecond-equal identity comparison (decision §2.4). */
export function reuseIdentityMatches(
    stored: {
        source_event_id: string;
        source_version: number;
        reported_at: string; // ISO from timestamptz round-trip
        consumed_at: string;
    },
    incoming: {
        source_event_id: string;
        source_version: number;
        reported_at: string;
        consumed_at: string;
    },
): boolean;

/** Map deriveAggregateProvenance output to an eligibility verdict. */
export function classifyReuseEligibility(derived: {
    provenance_status: "ready" | "pending" | "unavailable" | "missing";
    compatibility: boolean;
}):
    | { eligible: true }
    | { eligible: false; category: MealReuseIneligibleCategory };
// compatibility===true → "compatibility" (even if status says pending);
// otherwise category = provenance_status when it is not "ready".
```

### 4.3 The mutation service — `src/meal-reuse.ts`

```ts
export interface ReuseMealCalculationCommand {
    user_id: string;
    source_event_id: string;
    source_version: number;
    reported_at: string; // fresh, caller-supplied, ISO
    consumed_at: string; // fresh, caller-supplied, ISO — REQUIRED (brief §1)
    idempotency_key: string; // non-empty
    created_by: string; // "reuse_meal_calculation"
}

export interface ReuseMealCalculationResult {
    event_id: string;
    version: 1;
    deduplicated: boolean;
    source_event_id: string;
    source_version: number;
    source_was_current: boolean;
    source_bundle_fingerprint: string;
    provenance_status: "ready"; // by construction; asserted from readback, never assumed
    compatibility: false;
}

export async function reuseMealCalculation(
    pool: Pool,
    command: ReuseMealCalculationCommand,
    opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<ReuseMealCalculationResult>;
```

Transaction body (single `withTransaction(pool, …)`), in exactly this order:

1. **Runtime validation** (before any query): UUID-shaped `source_event_id`, integer `source_version >= 1`, `Date.parse`-valid `reported_at`/`consumed_at`, non-empty trimmed `idempotency_key` ≤ 255. Throw `MealEventValidationError`-style typed error (reuse zod at the MCP layer; the service re-checks cheaply so direct service misuse also fails closed).
2. **Idempotency lock:** `SELECT r.source_event_id, r.source_version, e.reported_at, e.consumed_at, r.event_id FROM meal_event_reuse_sources r JOIN meal_events e ON e.id = r.event_id WHERE r.user_id = $1 AND r.reuse_idempotency_key = $2 FOR UPDATE OF r`. If a row exists: `reuseIdentityMatches` → **match:** return the original readback (`deduplicated: true`, re-derive provenance via step 8's readback on the existing event) with **zero writes**; **mismatch:** throw `MealReuseIdempotencyConflictError` (transaction aborts; no rows).
3. **Source root lock (fail-closed scope):** `SELECT id, current_version, meal_type FROM meal_events WHERE id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`. Empty ⇒ `MealReuseSourceNotFoundError` (covers absent + deleted + cross-user with one indistinguishable answer).
4. **Version existence:** `SELECT 1 FROM meal_event_versions WHERE event_id = $1 AND version = $2`. Empty ⇒ `MealReuseSourceVersionError`. Record `source_was_current = (source_version === current_version)`.
5. **Sequential in-transaction source snapshot:** new `async function readSourceAggregateForReuse(client, eventId, version)` — sequential (PoolClient forbids concurrent queries) SELECTs of the version row, items (ORDER BY ordinal), ALL provider result rows (event + item scopes, every column incl. `id`), ALL canonical rows (every column incl. `id`, `audit_evidence`, `source_result_ids`), assembled into the existing `MealEventAggregate` shape (reuse mapping code patterns from `getMealEvent`; journal/media/inputs may be empty arrays — they do not participate in provenance derivation for eligibility... **NOTE:** `deriveAggregateProvenance` only reads `provider_results`, `canonical`, `version.calculation_bundle_fingerprint` — construct exactly those faithfully).
6. **Eligibility:** `classifyReuseEligibility(deriveAggregateProvenance(aggregate))`; ineligible ⇒ `MealReuseSourceIneligibleError(category)`. Additionally require `aggregate.version.calculation_bundle_fingerprint !== null` (belt-and-braces; `ready` already implies it) — the fingerprint is copied to the target so it must exist.
7. **Copy-write the target graph** (all on the same client):
    - root: `INSERT INTO meal_events (id, user_id, reported_at, consumed_at, meal_type, idempotency_key, external_write_authorized) VALUES ($1,$2,$3,$4,$5,$6,false)` with `id = crypto.randomUUID()`, timestamps = the caller's fresh values via `resolveConsumedAt` semantics (both explicit), `meal_type` = source root's, `idempotency_key = deriveReuseIdempotencyFingerprint({user_id, reuse_idempotency_key: command.idempotency_key, source_event_id, source_version, reported_at, consumed_at})`. Plain INSERT (no ON CONFLICT): step 2's lock already resolved sequential replays; a concurrent racer aborts on `uniq_meal_events_user_idem` or `uniq_meal_reuse_user_idem` and converges in step 9.
    - version: `INSERT INTO meal_event_versions (event_id, version, parser_policy_version, created_by, calculation_bundle_fingerprint) VALUES ($1, 1, $2, $3, $4)` with `parser_policy_version` copied from the source version row, `created_by = command.created_by`, fingerprint = source's.
    - items: verbatim INSERT per source item (ordinal, raw_item_text, normalized_name, quantity, portion_value, portion_unit, notes).
    - provider rows: verbatim INSERT per source provider row (both scopes) `RETURNING id`; build `Map<sourceResultId, targetResultId>`.
    - canonical rows: verbatim INSERT per source canonical row (both scopes) with `source_result_ids` = source ids mapped through the Map (fail loudly if any id is unmapped), `audit_evidence` copied verbatim (JSON.stringify of the source object), `algorithm_version` copied.
    - lineage: `INSERT INTO meal_event_reuse_sources (event_id, version, user_id, source_event_id, source_version, source_canonical_result_id, source_bundle_fingerprint, reuse_idempotency_key, confirmation_received, created_by) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, true, $8)` where `source_canonical_result_id` = the source event-scope canonical row's `id`.
    - provider mappings: one `INSERT INTO meal_event_reuse_provider_sources (event_id, version, target_provider_result_id, source_provider_result_id, source_request_fingerprint, source_event_id, source_version) …` per copied provider row (007's composite FKs verify every value against real rows).
    - `await opts.beforeCommit?.();`
8. **In-transaction readback:** `readPersistedWriteStatus(client, targetId, 1)` — assert `provenance_status === "ready"` and `compatibility === false`; if not, `throw new Error("reused event readback did not derive ready — copy is incomplete")` (aborts; nothing persists; nothing fabricated).
9. **Outer catch (concurrency convergence),** mirroring `createMealEvent`'s and supplements' pattern: on PG `23505` for constraint containing `uniq_meal_reuse_user_idem` OR `uniq_meal_events_user_idem`, open a fresh transaction, re-run step 2's SELECT (now committed winner is visible): identity match ⇒ return winner readback `deduplicated: true`; mismatch ⇒ `MealReuseIdempotencyConflictError`; row still absent ⇒ rethrow original error.

Also add read helper for tests and the tool's structured output:

```ts
export async function getReuseLineage(
    pool: Pool,
    userId: string,
    eventId: string,
): Promise<{
    source_event_id: string;
    source_version: number;
    source_canonical_result_id: string | null;
    source_bundle_fingerprint: string | null;
    reuse_idempotency_key: string;
    confirmation_received: boolean;
    copied_at: string;
    provider_mappings: Array<{
        target_provider_result_id: string;
        source_provider_result_id: string;
        source_request_fingerprint: string;
    }>;
} | null>; // user-scoped; null for cross-user/absent — no existence leak
```

### 4.4 MCP surface — `src/mcp.ts`

Export a typed output schema (next to `SEARCH_MEALS_OUTPUT_SCHEMA`):

```ts
export const REUSE_MEAL_OUTPUT_SCHEMA = z
    .object({
        event_id: z.string().uuid(),
        version: z.literal(1),
        deduplicated: z.boolean(),
        reported_at: z.string(),
        consumed_at: z.string(),
        meal_type: z.string().nullable(),
        provenance_status: z.enum([
            "ready",
            "pending",
            "unavailable",
            "missing",
        ]),
        compatibility: z.boolean(),
        bundle_fingerprint: z.string().nullable(),
        canonical: z
            .object({
                status: z.enum(["pending", "ready", "low_confidence"]),
                consensus_status: z.enum([
                    "two_agree_one_outlier",
                    "all_agree",
                    "no_consensus",
                    "insufficient_data",
                ]),
                calories: z.number().nullable(),
                protein_g: z.number().nullable(),
                carbs_g: z.number().nullable(),
                fat_g: z.number().nullable(),
                fiber_g: z.number().nullable(),
                sugar_g: z.number().nullable(),
                alcohol_g: z.number().nullable(),
            })
            .strict()
            .nullable(),
        components: z.array(
            z
                .object({
                    ordinal: z.number().int().min(0),
                    raw_item_text: z.string(),
                    normalized_name: z.string().nullable(),
                    quantity: z.number().nullable(),
                    portion_value: z.number().nullable(),
                    portion_unit: z.string().nullable(),
                    notes: z.string().nullable(),
                })
                .strict(),
        ),
        source: z
            .object({
                source_event_id: z.string().uuid(),
                source_version: z.number().int().min(1),
                source_was_current: z.boolean(),
                source_bundle_fingerprint: z.string(),
                confirmation_received: z.literal(true),
            })
            .strict(),
    })
    .strict();
```

Registration (after `search_meals`; handler adapts args, maps errors, reads back through the public path):

```ts
const reuseToolError = (error: unknown): never => {
    if (error instanceof MealReuseSourceNotFoundError)
        throw new Error("meal_reuse_source_not_found");
    if (error instanceof MealReuseSourceVersionError)
        throw new Error("meal_reuse_source_version_not_current_or_historical");
    if (error instanceof MealReuseSourceIneligibleError)
        throw new Error(error.message); // message already prefixed with the stable code + category
    if (error instanceof MealReuseIdempotencyConflictError)
        throw new Error(error.message); // prefixed idempotency_conflict
    throw error;
};

server.registerTool(
    "reuse_meal_calculation",
    {
        title: "Reuse Meal Calculation",
        description:
            "Create a NEW meal event from one precise prior event/version the user explicitly confirmed reusing. The server copies the source's persisted provider evidence and canonical calculation as immutable copied facts with a recorded source link — it never calls providers and never accepts caller-supplied nutrition values. Requires the source_event_id + source_version from search_meals reuse candidates, fresh reported_at/consumed_at for the new occurrence, a stable idempotency_key for safe retries, and the explicit user confirmation ('добавь'/'add'/'confirm'). Ineligible, deleted, or foreign sources fail with a stable error and create nothing.",
        annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
        },
        inputSchema: {
            source_event_id: z.string().uuid(),
            source_version: z.number().int().min(1),
            reported_at: z
                .string()
                .refine((s) => !Number.isNaN(Date.parse(s)), {
                    message: "reported_at must be a valid ISO 8601 timestamp",
                }),
            consumed_at: z
                .string()
                .refine((s) => !Number.isNaN(Date.parse(s)), {
                    message: "consumed_at must be a valid ISO 8601 timestamp",
                }),
            idempotency_key: z.string().min(1).max(255),
            confirmation: z.enum(["добавь", "add", "confirm"]),
        },
        outputSchema: REUSE_MEAL_OUTPUT_SCHEMA.shape,
    },
    async ({
        source_event_id,
        source_version,
        reported_at,
        consumed_at,
        idempotency_key,
    }) =>
        withAnalytics(
            "reuse_meal_calculation",
            async () => {
                const result = await reuseMealCalculation(mealEventsPool, {
                    user_id: userId,
                    source_event_id,
                    source_version,
                    reported_at,
                    consumed_at,
                    idempotency_key,
                    created_by: "reuse_meal_calculation",
                }).catch(reuseToolError);
                const readback = await getMealEventProvenance(
                    mealEventsPool,
                    userId,
                    result.event_id,
                    1,
                );
                if (!readback)
                    throw new Error("reused meal event readback missing");
                const payload = REUSE_MEAL_OUTPUT_SCHEMA.parse({
                    /* assemble from result + readback */
                });
                return {
                    content: [
                        {
                            type: "text",
                            text: JSON.stringify(payload, null, 2),
                        },
                    ],
                    structuredContent: payload,
                };
            },
            { userId },
        ),
);
```

Note the handler destructures ONLY the declared fields — smuggled extras never reach the service (proof in Task 9's forged-args test). `confirmation` is validated by zod and intentionally unused beyond validation; the service records `confirmation_received = true` only on the path that required it.

---

## 5. AC-to-artifact-and-executable-proof matrix

"PG" = real PostgreSQL via `DATABASE_URL_TEST`; "MCP" = real `McpServer`+`Client`+`InMemoryTransport` (`withReuseTools`). Every row's proof is a named test in a DB-gated suite.

| AC (Slice 4 lock §)                                                                                                     | Implementation artifacts                                                                | Executable proof (suite :: test)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 contract: precise pair, fresh timestamps, non-empty key, server-policy confirmation                                  | `src/mcp.ts` `reuse_meal_calculation` inputSchema (§4.4)                                | MCP :: "listTools advertises reuse_meal_calculation with mutation annotations and typed schema"; "missing confirmation is rejected with zero writes"; "invalid confirmation string is rejected"; "empty idempotency_key rejected"; "missing consumed_at rejected"; each asserts `isError`/protocol validation error AND `domainTableCounts` unchanged                                                                                                                                                                                                |
| §1 no caller-supplied totals/results/fingerprints/evidence                                                              | schema has no such fields; handler destructures declared fields only                    | MCP :: "forged canonical/provider/fingerprint args are inert: persisted target equals source values and forged numbers appear nowhere" (SQL scan of all target rows for the forged sentinel values, e.g. 9999)                                                                                                                                                                                                                                                                                                                                       |
| §1 strict runtime validation, typed output, annotations, analytics, stable errors                                       | `REUSE_MEAL_OUTPUT_SCHEMA`, `withAnalytics("reuse_meal_calculation")`, `reuseToolError` | MCP :: "structured round-trip parses against REUSE_MEAL_OUTPUT_SCHEMA"; "annotations: readOnlyHint false, idempotentHint true"; error-path tests assert exact stable message prefixes                                                                                                                                                                                                                                                                                                                                                                |
| §2 one transaction, lock + exact requested source/version                                                               | service steps 2–6 on one client (§4.3)                                                  | PG :: "reuse copies the requested HISTORICAL version after a correction, not the current one" (seed v1 ready → `correctMeal` to v2 → reuse v1 → target equals v1 facts, `source_was_current: false`); "reuse of the current version sets source_was_current true"                                                                                                                                                                                                                                                                                    |
| §2 fail closed: absent / cross-user / deleted / nonexistent version / compatibility / pending / unavailable / malformed | error taxonomy §4.1, eligibility §4.2/4.3 steps 3–6                                     | PG + MCP :: "absent source → meal_reuse_source_not_found"; "u2 cannot reuse u1's event: identical not_found, response never contains u1 item text"; "deleted source → not_found"; "version 99 → …not_current_or_historical"; "pending source (no bundle…seedMealEvent only) → ineligible: compatibility"; "unavailable bundle → ineligible: unavailable"; "ready-then-tampered canonical (SQL-nulled audit_evidence) → ineligible: pending, nothing created"; every case asserts `domainTableCounts` unchanged and no zero-valued canonical anywhere |
| §2 no existence leak                                                                                                    | single indistinguishable `meal_reuse_source_not_found`                                  | MCP :: cross-user test asserts the serialized error response equals the absent-source response shape and leaks no source text/ids                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §3 fresh root/version, supplied fresh timestamps, server-generated distinct occurrence identity                         | copy-writer step 7; `deriveReuseIdempotencyFingerprint` as root key                     | PG :: "target is a fresh root: new UUID ≠ source, version 1, reported_at/consumed_at equal the supplied fresh values (ms-exact), root idempotency_key = derived reuse fingerprint and ≠ source's key"                                                                                                                                                                                                                                                                                                                                                |
| §3 copy only server-read facts; no provider invocation; no user nutrition                                               | copy-writer; no network/bundle code paths in service                                    | PG :: "copied items/provider rows/canonical rows equal source rows column-for-column (ids and event_id excluded); provider request fingerprints and source_ids identical; canonical source_result_ids remapped to target result ids"; MCP :: "no external/provider call occurs" (the service performs only SQL — asserted structurally: no fetch/provider import in `meal-reuse.ts`, plus test seeds prove values come from DB truth only)                                                                                                           |
| §3 immutable lineage incl. precise relationships + source bundle fingerprint                                            | lineage + mapping INSERTs (step 7)                                                      | PG :: "lineage row records exact source pair, source event-scope canonical id, source bundle fingerprint, confirmation_received=true, the caller's reuse_idempotency_key"; "three provider-mapping rows bind each target result to its true source result and real source_request_fingerprint (007 FKs satisfied)"                                                                                                                                                                                                                                   |
| §3 source unchanged; target independently readable; copied facts + lineage re-readable                                  | no UPDATE touches source; `getMealEventProvenance`; `getReuseLineage`                   | PG :: "source aggregate byte-identical before/after reuse (full-row snapshot compare)"; MCP :: "get_calculation_provenance re-reads the target as ready/non-compatibility with the copied canonical values"; PG :: "getReuseLineage returns the persisted link and mappings; cross-user read returns null"                                                                                                                                                                                                                                           |
| §4 same key + identical command → original readback                                                                     | steps 2 & 9                                                                             | PG + MCP :: "retry with identical command returns the same event_id, deduplicated=true, and adds zero rows in every domain table"                                                                                                                                                                                                                                                                                                                                                                                                                    |
| §4 same key + changed identity → conflict, no extra rows                                                                | steps 2 & 9 identity compare                                                            | PG + MCP :: "same key with different source_version → idempotency_conflict, counts unchanged"; "same key with different consumed_at → idempotency_conflict"                                                                                                                                                                                                                                                                                                                                                                                          |
| §4 concurrent same-key attempts → exactly one graph, converge or declared conflict                                      | DB uniques `uniq_meal_reuse_user_idem`/`uniq_meal_events_user_idem` + outer catch       | PG :: "two separate Pool clients, Promise.all identical commands: both resolve to one event_id, exactly one deduplicated=false, table deltas exactly {1 root, 1 version, N items, 3 provider, K canonical, 1 lineage, 3 mappings}"; MCP :: same through two `withReuseTools` harnesses                                                                                                                                                                                                                                                               |
| §4 injected post-child/pre-commit failure → zero operation-owned rows, source intact                                    | `opts.beforeCommit` after ALL child/lineage inserts                                     | PG :: "beforeCommit throws after lineage insert: every domain table count returns to baseline, source snapshot unchanged, and a subsequent clean call with the same key succeeds"                                                                                                                                                                                                                                                                                                                                                                    |
| §5 real PG + real public transport, in DB gate                                                                          | suites already in `scripts/test-db-gate.ts`                                             | Gate run in §8; both suites must report the new tests (zero-test = gate failure)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| §5 preserve food/alcohol; no prior-migration edits                                                                      | no source-path edits; no migration files touched                                        | `bun test src/alcohol.test.ts`, `bun run test:unit`, full `bun run test:db` green; `git status` shows no `db/migrations/00[1-9]*` modification                                                                                                                                                                                                                                                                                                                                                                                                       |
| Parent B7 (search is never a write) unaffected                                                                          | `search_meals` untouched                                                                | Existing MCP :: "read-only: domain table counts unchanged across transport calls" keeps passing                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 6. Tasks in RED→GREEN order

Work from `/Users/fishhead/.workspace/projects/nutrition-mcp` on `main` at `927ac25`. Set up the disposable DB env once for integration loops:

```bash
export DATABASE_URL_TEST="${DATABASE_URL_TEST:?set a disposable PostgreSQL DATABASE_URL_TEST first}"
export DATABASE_URL="$DATABASE_URL_TEST"
```

### Task 0: Preflight — prove the baseline is green

Run: `git rev-parse HEAD` (expect `927ac25d3c06ece92c4043c41a8c4cba474d354a`), then `bun run test:unit` and `bun run test:db`. Expected: all pass. Do not proceed on a red baseline.

### Task 1: Pure helpers RED

**Files:** Modify `src/meal-reuse.test.ts` (append a new `describe("slice 4 pure reuse helpers")`).

Write failing tests for `reuseIdentityMatches` (ms-equal across `Z`/`+00:00`/sub-ms variants; mismatch on each field) and `classifyReuseEligibility` (`ready`+non-compat → eligible; compat → `compatibility` regardless of status; `pending`/`unavailable`/`missing` map through).

Run: `bun test src/meal-reuse.test.ts` — Expected: FAIL (exports missing).

### Task 2: Pure helpers GREEN

**Files:** Modify `src/meal-reuse.ts` (add §4.1 error classes + §4.2 helpers; no DB code yet).

Run: `bun test src/meal-reuse.test.ts` — Expected: PASS. Then `bun run typecheck`.

Commit: `git add src/meal-reuse.ts src/meal-reuse.test.ts && git commit -m "feat: slice 4 — pure reuse identity/eligibility contracts (RED->GREEN)"`

### Task 3: Repository happy-path RED

**Files:** Modify `src/meal-reuse.fixtures.ts` (add `snapshotAggregate(pool, eventId, version)` full-row SQL snapshot helper and `reuseCommand(overrides)` builder), `src/meal-reuse.integration.test.ts` (new `describeDb("reuse_meal_calculation repository (requires DATABASE_URL_TEST)")`).

Failing tests (seed with `seedMealEvent` + `commitBundle(readyBundle(...))`):

1. "creates a fresh root/version 1 with the supplied fresh timestamps and derived occurrence idempotency key"
2. "copies items, all provider rows, and all canonical rows column-for-column with remapped source_result_ids"
3. "persists lineage + three provider mappings with exact source identity and bundle fingerprint"
4. "target re-derives ready/non-compatibility through getMealEventProvenance"
5. "source aggregate is byte-identical before and after reuse"
6. "reuses the requested historical version after a correction (source_was_current=false)"
7. "getReuseLineage returns the link user-scoped; null for another user"

Run: `bun test src/meal-reuse.integration.test.ts --max-concurrency 1` — Expected: new tests FAIL (`reuseMealCalculation is not a function`), Slice 3 tests still PASS.

### Task 4: Service GREEN (happy path)

**Files:** Modify `src/meal-reuse.ts` — implement `readSourceAggregateForReuse`, `reuseMealCalculation` (§4.3 steps 1–8), `getReuseLineage`.

Run: `bun test src/meal-reuse.integration.test.ts --max-concurrency 1` — Expected: PASS. `bun run typecheck` — PASS.

Commit: `feat: slice 4 — transactional confirmed reuse copy service (real-PG proven)`

### Task 5: Fail-closed eligibility RED→GREEN

**Files:** Modify `src/meal-reuse.integration.test.ts`.

RED tests (each asserts the typed error `code`/category AND `domainTableCounts` unchanged AND no fabricated zero anywhere):
absent id; cross-user; deleted (`deleteMealEvent`); version 0 rejected by validation; version current+1 → version error; bundle-less pending source → `ineligible: compatibility`; `unavailableBundle` source → `ineligible: unavailable`; SQL-tampered source (null out `audit_evidence` on the ready canonical row) → `ineligible: pending`.

GREEN: adjust eligibility ordering only if a test exposes an ordering bug (scope check MUST precede version check precede eligibility, so cross-user never leaks a version error).

Run: `bun test src/meal-reuse.integration.test.ts --max-concurrency 1` — PASS.
Commit: `feat: slice 4 — fail-closed reuse eligibility with stable no-leak errors`

### Task 6: Idempotency + conflict RED→GREEN

**Files:** Modify `src/meal-reuse.integration.test.ts` (+ service fixes if needed).

RED: identical retry converges (same event_id, `deduplicated: true`, zero row delta); same key + different source_version → `idempotency_conflict`, zero delta; same key + different consumed_at → conflict; different keys + same source → two independent targets, two lineage rows.

Run/Commit: `feat: slice 4 — reuse idempotency convergence and stable conflicts`

### Task 7: Concurrency + rollback RED→GREEN

**Files:** Modify `src/meal-reuse.integration.test.ts`.

RED:

- "concurrent same-key reuse from two separate Pools converges on one graph": create a second `Pool`, `Promise.all` two identical `reuseMealCalculation` calls, assert one event_id across both results, exactly one `deduplicated: false`, and exact table deltas (1 root / 1 version / items / 3 provider / canonical / 1 lineage / 3 mappings); close the second pool.
- "injected post-child/pre-commit failure leaves zero operation-owned rows": `opts.beforeCommit` throws after lineage/mappings are inserted; assert counts return to baseline, source snapshot unchanged, and the same command afterwards succeeds cleanly.

GREEN: implement/harden the outer `23505` convergence catch (step 9).

Run/Commit: `feat: slice 4 — DB-serialized concurrent reuse and injected-rollback atomicity`

### Task 8: Public transport RED — flip the Slice 4 guard and register the tool

**Files:** Modify `src/mcp-reuse.integration.test.ts`, then `src/mcp.ts`.

RED first: REPLACE the guard test at `src/mcp-reuse.integration.test.ts:119-124` with "listTools advertises reuse_meal_calculation with mutation annotations and typed outputSchema" (asserts presence, `readOnlyHint === false`, `idempotentHint === true`, outputSchema properties incl. `source`, `canonical`, `provenance_status`; description mentions explicit confirmation and never claims provider calls). Add a new `describeDb("reuse_meal_calculation transport")` with the happy-path structured round-trip (call with `confirmation: "добавь"`, parse via exported `REUSE_MEAL_OUTPUT_SCHEMA`, assert copied canonical values e.g. calories 500 and `source.source_bundle_fingerprint`), plus a follow-up `get_calculation_provenance` re-read of the new event (ready, non-compatibility, same canonical).

Run: `bun test src/mcp-reuse.integration.test.ts --max-concurrency 1` — Expected: FAIL (tool unregistered).

GREEN: add `REUSE_MEAL_OUTPUT_SCHEMA`, `reuseToolError`, and the registration to `src/mcp.ts` (§4.4), importing the service + error classes from `./meal-reuse.js`.

Run: PASS. `bun run typecheck` PASS.
Commit: `feat: slice 4 — public reuse_meal_calculation over real MCP transport`

### Task 9: Transport adversarial RED→GREEN

**Files:** Modify `src/mcp-reuse.integration.test.ts`.

RED tests (all through `withReuseTools`; every rejection asserts `domainTableCounts` unchanged):

1. "missing confirmation is a validation error with zero writes"; "confirmation 'yes please' rejected".
2. "empty idempotency_key rejected"; "missing consumed_at rejected"; "malformed source_event_id rejected".
3. "forged canonical/provider/fingerprint args are inert" (pass `canonical: {calories: 9999}`, `provider_results: […]`, `bundle_fingerprint: "forged"` as extra args; call succeeds; SQL-assert no `9999`/`forged` in any target row; persisted values equal source).
4. "cross-user reuse attempt: stable meal_reuse_source_not_found, serialized response leaks nothing" (compare against absent-id response; assert no source item text in `JSON.stringify(result)`).
5. "deleted source / nonexistent version / pending source / unavailable source → exact stable public messages".
6. "same-key transport retry returns the original readback (deduplicated true)"; "same key different args → idempotency_conflict".
7. "concurrent transport calls: two harnesses, Promise.all, one graph" (mirror Task 7 through the public tool).
8. "requested historical version through the public tool after a correction copies v1 facts".
9. "existing read-only guarantee intact": `search_meals` calls still change no counts (existing test keeps passing).

GREEN: only handler/mapper fixes; domain logic changes go back through Task 4–7 suites.

Run: `bun test src/mcp-reuse.integration.test.ts --max-concurrency 1` — PASS.
Commit: `test: slice 4 — adversarial public-transport reuse gates`

### Task 10: Docs truth row (C1 precedent) + full acceptance

**Files:** Modify `README.md` (one tools-table row: `| \`reuse_meal_calculation\` | Create a new meal event from a confirmed past event/version by copying its stored calculation evidence with a source link — explicit confirmation required; no providers are called |`), `docs/food-tracking-agent-driven.md` (one short paragraph in the tools/boundary section: explicit confirmation, server-copied evidence, lineage, fail-closed eligibility, no provider invocation). Do NOT promise reports/regimens/OCR/reminders.

Run the complete ladder (expected all green):

```bash
bun run test:unit
bun run test:db
bun run typecheck
bun run format:check   # run `bun run format` first if prettier complains
git diff --check
```

Also verify no forbidden edits: `git status --short` must show changes ONLY in `src/meal-reuse.ts`, `src/meal-reuse.test.ts`, `src/meal-reuse.fixtures.ts`, `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts`, `src/mcp.ts`, `README.md`, `docs/food-tracking-agent-driven.md` (+ this plan family under `.hermes/plans/`). Zero diffs under `db/migrations/`.

Commit: `docs: slice 4 — reuse_meal_calculation tools-table row and boundary truth`

## 7. Required adversarial acceptance gates (reviewer checklist)

All through real PostgreSQL and the public MCP client/transport, not helper units:

1. Fresh reset replays 001→009; Slice 1–3 suites stay green (C2).
2. `u2` can neither reuse nor detect `u1`'s events; not-found responses are indistinguishable and leak no text/ids.
3. Version truth: current and persisted-historical versions reuse their own exact facts; nonexistent versions fail closed; the source root's `current_version` and all source rows are unmodified after every operation.
4. Provenance: target re-reads `ready`/non-compatibility via `get_calculation_provenance` with canonical values equal to the source version's; lineage + three provider mappings re-readable and FK-consistent (007).
5. Idempotency: identical replay converges with zero new rows; changed identity is a stable `idempotency_conflict` with zero new rows.
6. Concurrency: separate pool clients / separate transport harnesses with `Promise.all` produce exactly one root/version/provider/canonical/lineage/mapping graph; both callers converge or one receives only the declared conflict — never partial or doubled state.
7. Rollback: `beforeCommit` injection after ALL child + lineage inserts leaves zero operation-owned rows and an intact source; the key remains usable afterwards.
8. Payload hardening: invalid UUID/timestamps, empty key, bad confirmation, and smuggled canonical/provider/fingerprint fields never produce durable writes and never surface in persisted data.
9. No zero-fabrication: every rejection path is an error, never a 0-valued canonical; NULL nutrients in the source stay NULL in the copy.
10. No provider/network invocation exists anywhere in the reuse path (code inspection + no bundle/provider imports in the service; tests seed all evidence through real prior writes).
11. Alcohol + legacy food paths: `bun test src/alcohol.test.ts` and the full unit + DB gates pass unchanged (C3).
12. `search_meals` remains read-only and semantically untouched (B7 / Slice 3 lock).

## 8. Verification commands (repo conventions; destructive gate)

Run from `/Users/fishhead/.workspace/projects/nutrition-mcp`. The DB gate refuses mismatched URLs; use a disposable real PostgreSQL database. Never write a real DSN into committed files or this plan family.

```bash
# Narrow unit loops
bun test src/meal-reuse.test.ts

# Focused real-PG + real-transport loops (destructive to DATABASE_URL_TEST)
export DATABASE_URL_TEST="${DATABASE_URL_TEST:?set a disposable PostgreSQL DATABASE_URL_TEST first}"
export DATABASE_URL="$DATABASE_URL_TEST"
bun test src/meal-reuse.integration.test.ts --max-concurrency 1
bun test src/mcp-reuse.integration.test.ts --max-concurrency 1

# Full repository gates (test:db resets public schema per suite and enforces URL equality)
bun run test:unit
bun run test:db
bun run typecheck
bun run format:check
git diff --check
```

Acceptance = every command green, plus the reviewer checklist in §7, plus the file-scope check in Task 10.

## 9. No-silent-narrowing verification against the Slice 4 lock

- Lock §1 (contract): all five required inputs are required in the schema; nothing nutrition-shaped is accepted (decision §2.5 covers strip-vs-reject explicitly); typed output + annotations + analytics + stable errors specified — **not narrowed**.
- Lock §2 (eligibility/no-leak): every listed failure class has a named test and a single-transaction lock-then-check order; eligibility is the real persisted `deriveAggregateProvenance` policy, not a weaker proxy; not-found responses are indistinguishable — **not narrowed**. Decision §2.3 documents the one interpretation made (nonexistent-version = the policy breach) rather than silently choosing it.
- Lock §3 (persistence/provenance): fresh root/version with caller timestamps and a server-generated distinct occurrence identity; byte-for-byte copy of items/provider evidence/canonical facts; lineage + per-provider mappings + source bundle fingerprint in the shipped tables; source immutability and public re-readability each carry a test — **not narrowed**. Decisions §2.1–2.2 declare the two copy-mechanics choices openly.
- Lock §4 (atomicity/idempotency/concurrency): identical-retry convergence, changed-identity conflict, `Promise.all` separate-client races, and post-child/pre-commit injected rollback are all individually tested at BOTH the repository and public-transport layers — **not narrowed**.
- Lock §5 (executable acceptance): all proofs are real-PG + real `McpServer`/`Client`/`InMemoryTransport`, in suites the DB gate already enforces (zero-test suites fail the gate); food/alcohol preserved by full-gate runs; no shipped migration is edited and no new migration is expected (fallback rule stated in §2.10) — **not narrowed**.
- Out-of-scope list (§3) matches the brief's exactly; nothing from it was pulled into scope.

SLICE_4_PLAN_COMPLETE
