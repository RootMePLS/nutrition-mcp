# Slice 5 Implementation Plan — Supplement Regimens and Append-Only Intake State

> **For the implementer (coder-kimi dispatch):** Execute task-by-task in the RED→GREEN order below. **No production code before the named failing test is observed failing.** Do NOT implement Slice 6+ (sports-snack meal linkage, reports/flags/summary), do NOT alter Slice 2–4 tool semantics, and do NOT edit shipped migrations `001`–`009`.

**Governing authority (this plan may not narrow any of it):**

- `.hermes/plans/2026-08-06-slice-5-regimens-intakes-brief.md` (the Slice 5 acceptance lock)
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md` — B3, B4, B5, B7, B10, C2, C3
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md` — Slice 5 (lines 206–216), MCP contracts (§5), AC matrix rows B3–B5/B7/B10, transactional rules (§4), adversarial gates (§8)

**Goal:** Ship the public, user-scoped supplement regimen and intake-history vertical path: seven MCP tools (`create_supplement_regimen`, `list_supplement_regimens`, `set_supplement_regimen_active`, `resolve_supplement_product`, `log_supplement_intake`, `get_supplement_intakes`, `get_supplement_regimen_status`) over locked transactional services, append-only intake facts with immutable per-version nutrient snapshots, and the exact `undefined | done | missed` visible projection — proven against real PostgreSQL and the real public MCP transport.

**Architecture:** All domain logic lives in `src/supplements.ts` beside the Slice 2 product repository, reusing its error taxonomy, `withTransaction` + root-lock + DB-unique-index idempotency pattern (the migration-008 lesson: the database, not a lookup, serializes races), and its readback-assembly style. `src/mcp.ts` handlers only adapt args, map typed domain errors to stable codes via the existing `supplementToolError` mapper (extended), and emit `outputSchema` + `structuredContent` through `withAnalytics` — identical to the shipped Slice 2/4 registrations. Schedule occurrence derivation is a pure function over the existing `src/tz.ts` helpers; nothing schedules, polls, reminds, or auto-marks.

**Tech stack / conventions in force:** Bun + TypeScript + `pg` + zod + MCP SDK. DB suites reset `public` and replay the full migration chain; `scripts/test-db-gate.ts` runs destructive suites serially and enforces `DATABASE_URL === DATABASE_URL_TEST`. Strict ISO-8601 timestamps at every public mutation boundary use `isStrictIsoTimestamp` (`src/meal-types.ts:237`, including the Slice 4 terra fixes: 24:00 rejection and UTC-offset range bounds).

---

## 0. Environment safety (read before running anything)

Every destructive DB command in this plan targets the **documented disposable database `nutrition_mcp_test` only**. The `.env` runtime database `nutrition_mcp` is NOT disposable and must never appear in `DATABASE_URL_TEST`.

```bash
# One-time, safe if it already exists:
createdb nutrition_mcp_test 2>/dev/null || true

# Every test shell (both vars MUST match or the gate refuses):
export DATABASE_URL_TEST='postgres://localhost:5432/nutrition_mcp_test'
export DATABASE_URL="$DATABASE_URL_TEST"
```

Never run `bun run test:db` or any `*.integration.test.ts` with `DATABASE_URL` pointing at the runtime DB; the gate (`scripts/test-db-gate.ts:6-18`) refuses mismatches, but the per-file `bun test` runs are only protected by you exporting the disposable URL first. Never commit or print a production DSN.

---

## 1. Verified baseline (inspected live at accepted Slice 4 HEAD)

Baseline verified: `git rev-parse HEAD` = `0fbe369dbf8551d5ad4f847727d5efdc35c0460b` on `main`, matching the brief. Working tree contains untracked plan files only.

| Live artifact (path:lines at HEAD)                                                                   | Observed fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Consequence for Slice 5                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `db/migrations/006_meal_reuse_and_supplements.sql:196-294`                                           | `supplement_regimens` (product/version FK, `dose_servings > 0`, `schedule jsonb NOT NULL`, `timezone`, `starts_on`/`ends_on` with CHECK, `active`, created/updated/deactivated metadata), `supplement_intake_events` (append-only: `state_action CHECK ('done','missed','cleared')`, `servings > 0`, `occurred_at timestamptz`, `reason`, `actor`, `source_intake_id`/`supersedes_intake_id`, `idempotency_key NOT NULL`, unique `uniq_supplement_intake_user_idem (user_id, idempotency_key)`), `supplement_intake_nutrient_snapshots` (unique `(intake_id, nutrient_key, unit)`), `supplement_intake_meal_links` all already exist. | **Core schema exists; writes are pure INSERTs.** The `(user_id, idempotency_key)` unique index is the DB-level idempotency/concurrency anchor for intakes. `supplement_intake_meal_links` stays untouched (Slice 6).                                                                                                                                                                                      |
| `db/migrations/007_ownership_lineage_integrity.sql:180-250`                                          | Composite FKs force: regimen `(product_id, product_version, user_id)` → same-user product version; intake `(product_id, product_version, user_id)` likewise; intake `(regimen_id, user_id)` → same-user regimen; snapshots bind `(intake_id, user_id, product_id, product_version)` to the actual intake AND `(product_id, product_version, nutrient_key, unit)` to a real label nutrient row.                                                                                                                                                                                                                                        | Cross-user or fabricated bindings are rejected by the database itself. Snapshots physically cannot record a nutrient that is not on that exact label version — NULL-vs-zero truth is structural.                                                                                                                                                                                                          |
| `db/migrations/006:...` — `supplement_regimens` has **no idempotency column**                        | Unlike products (008) and intakes (006), regimen creation has no DB-enforced retry identity. Parent plan §4: “Idempotency keys bind user + operation + immutable identity/content” for ALL create operations, and §8 gate 5/6 demand idempotent, concurrency-safe mutations.                                                                                                                                                                                                                                                                                                                                                          | **Proven gap ⇒ one forward-only additive migration `010_supplement_regimen_idempotency.sql`** (nullable `idempotency_key` column + partial unique index, exactly the 008 pattern). Never edit 006–009. See §2 decision 2.                                                                                                                                                                                 |
| `src/supplement-types.ts` (shipped Slice 1)                                                          | `validateRegimenSchedule` (IANA tz via `Intl`, `daily                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | weekly`, `HH:MM`, ISO weekdays 1–7, no weekdays on daily), `projectIntakeVisibleState` (`done`→done, `missed`→missed, anything else→`undefined`), `normalizeSupplementAlias`(NFKC+trim+collapse+lower),`deriveSupplementIntakeIdempotencyFingerprint`(user, key, product, version, servings, occurred_at, state_action),`isFoodCompatibleNutrientKey`. All unit-tested in `src/supplement-types.test.ts`. | Reuse these verbatim — do not re-validate schedules or re-derive projection in new code paths. New pure helpers (occurrence derivation, chain reduction, regimen fingerprint) join this module. |
| `src/supplements.ts:44-76, 605-720`                                                                  | Typed domain errors with readonly `code` (`supplement_validation_failed`, `supplement_product_not_found`, `supplement_product_inactive`, `idempotency_conflict`); `createSupplementProduct` shows the proven race pattern: bounded retry loop catching SQLSTATE 23505 on the **named** unique index, convergence lookup, fingerprint comparison → dedup readback or stable conflict.                                                                                                                                                                                                                                                  | Mirror exactly for `logSupplementIntake` (constraint `uniq_supplement_intake_user_idem`) and `createSupplementRegimen` (new 010 index). Same error-class style for the new errors.                                                                                                                                                                                                                        |
| `src/supplements.ts:838-850` (`getSupplementProduct`)                                                | Deleted products and other users' products both resolve as not found — no existence leak.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Same closed-fail contract for regimens and intake reads/writes.                                                                                                                                                                                                                                                                                                                                           |
| `src/mcp.ts:1888-1979, 5961-6270`                                                                    | `SUPPLEMENT_*` zod schema constants; `supplementToolError` mapper; five product tools registered with `withAnalytics`, truthful annotations, `outputSchema` + `structuredContent` on every path, `mealEventsPool` injection via `registerTools(server, userId, widgets, alcohol, deps)`.                                                                                                                                                                                                                                                                                                                                              | Extend the same section: new schema constants, extend `supplementToolError`, register the seven Slice 5 tools. No new harness or wiring concept.                                                                                                                                                                                                                                                          |
| `src/mcp.ts:2751-2800` (`reuse_meal_calculation`)                                                    | Strict-timestamp inputs use `z.string().refine(isStrictIsoTimestamp, …)`; explicit user confirmation is a schema-level requirement on the reuse mutation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `occurred_at` on `log_supplement_intake` uses the identical refine. Intake authorization = explicit tool invocation (see §2 decision 8) — no confirmation enum is added to supplement tools because the governing plan's tool table (§5) defines `log_supplement_intake` without one.                                                                                                                     |
| `src/meal-reuse.ts:664-668, 922`                                                                     | `opts.beforeCommit?: () => Promise<void>` test-only hook convention for injected post-child/pre-commit rollback proof.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `logSupplementIntake` and `createSupplementRegimen` take the same hook.                                                                                                                                                                                                                                                                                                                                   |
| `src/tz.ts`                                                                                          | `validateTz`, `dateInTz`, `dowInTz` (0=Sun..6=Sat), `zonedWallClockToUtc(y,mo,d,hh,mi,se,tz)` with gap/ambiguity handling, `shiftLocalDate`, `zonedDayStartUtc`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Occurrence derivation is pure TypeScript over these helpers. ISO weekday 1–7 (schedule) maps to `dowInTz` via `isoDow = ((dow + 6) % 7) + 1`.                                                                                                                                                                                                                                                             |
| `src/supplements.integration.test.ts:40-62`, `src/mcp-supplements.integration.test.ts:37-67, 88-122` | Both suites reset `public` and replay the enumerated migration chain 001–009; `withSupplementTools(pool, userId, run)` is the real `McpServer` + `Client` + `InMemoryTransport` harness parameterized by user.                                                                                                                                                                                                                                                                                                                                                                                                                        | Slice 5 tests extend these two suites and the shared harness; the chain arrays gain `010`.                                                                                                                                                                                                                                                                                                                |
| `scripts/test-db-gate.ts:23-54`                                                                      | Suites already include `src/supplements.integration.test.ts` and `src/mcp-supplements.integration.test.ts`; zero-test suites fail the gate; migration array is 001–009.                                                                                                                                                                                                                                                                                                                                                                                                                                                               | **No gate suite change.** Only the migration array gains `010`.                                                                                                                                                                                                                                                                                                                                           |
| `src/food-tracking-docs.test.ts:10-59`                                                               | Docs tests derive the migration chain from the `db/migrations/` directory: every migration file must appear in `docs/food-tracking-agent-driven.md` AND in a README `psql … -f` operator line.                                                                                                                                                                                                                                                                                                                                                                                                                                        | Adding `010` makes docs tests fail (a free RED) until README + docs name it. Tool inventory rows in README follow the Slice 2/4 precedent.                                                                                                                                                                                                                                                                |
| Files enumerating the migration chain (grep `009_`)                                                  | `scripts/test-db-gate.ts`, `src/db.integration.test.ts`, `src/supplements.integration.test.ts`, `src/mcp-supplements.integration.test.ts`, `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts`, `README.md`, `docs/food-tracking-agent-driven.md`.                                                                                                                                                                                                                                                                                                                                                              | The exhaustive 010 update list. Nothing else hardcodes the chain.                                                                                                                                                                                                                                                                                                                                         |
| `package.json` scripts                                                                               | `test:unit`, `test:db`, `typecheck`, `format:check`. CI expects prettier-clean tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Verification ladder §9 uses exactly these.                                                                                                                                                                                                                                                                                                                                                                |

**Blocker status:** none. One additive migration (010) is required and explicitly permitted by the brief (“if a real gap is proven, append a forward-only migration and upgrade coverage, never rewrite shipped migrations”).

---

## 2. Contradictions, gaps, and declared defaults (no silent narrowing)

1. **B6 (sports snack linkage) vs the Slice 5 hard boundary.** The release brief B6 requires a caloric `done` intake to atomically create a snack meal event, but this slice's lock forbids exactly that (“Do NOT create sports-nutrition snack meal events or intake meal links. That is Slice 6 only”), and demands proof that sports intakes here produce **no meal root**. This is a deliberate slice ordering, not a narrowing: B6 lands in Slice 6. **Default:** `log_supplement_intake` in this slice appends the intake fact + snapshots for BOTH categories and never touches `meal_events`/`supplement_intake_meal_links`; its public description states plainly that meal linkage for caloric sports nutrition is not yet performed (C1 truthfulness — the tool must not promise Slice 6 behavior). The no-meal-root test covers both `supplement` and `sports_nutrition` `done` intakes.
2. **Regimen create idempotency has no schema support.** Parent plan §4 requires idempotent creates with DB-enforced convergence (the 008 lesson proved lookup-only checks race), but `supplement_regimens` carries no key column. **Default:** additive forward-only `db/migrations/010_supplement_regimen_idempotency.sql`: `ADD COLUMN IF NOT EXISTS idempotency_key text` + partial unique index `uniq_supplement_regimens_user_idem ON supplement_regimens (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`. Nullable (keys stay optional, per product-create precedent), user-scoped, rerun-safe. Update every chain enumeration named in §1.
3. **What is an “occurrence”, and how do facts attach to it?** B4/status reads need per-occurrence state, but intake facts are free-standing (`occurred_at`, optional `regimen_id`). **Default:** an occurrence is `(regimen_id, local_date)` derived from the regimen's declarative schedule in the regimen's timezone (daily: every date in `[starts_on, min(ends_on, window_end)]`; weekly: dates whose ISO weekday is in `weekdays`). An intake fact matches an occurrence iff `fact.regimen_id = regimen.id` AND `dateInTz(fact.occurred_at, schedule.timezone) === occurrence.local_date`. The occurrence's visible state is the projection of the **latest matching fact** (order `created_at DESC, id DESC`); no matching fact ⇒ `undefined`. Facts without a regimen are ad-hoc intakes: they appear in `get_supplement_intakes` but never claim a regimen occurrence.
4. **“Latest fact” vs explicit supersession.** The table has `supersedes_intake_id`, but making chain-walking the state authority would let a mis-linked fact orphan history. **Default:** state authority is append order (`created_at, id`) within the occurrence/product grouping; `supersedes_intake_id` + `reason` + `actor` are **audit metadata** recording _why_ a correcting fact was appended. `supersedes_intake_id`, when given, must reference an existing same-user fact for the same product (any version) or the mutation fails validation with zero writes. This keeps the auditable correction story (B4) without a second, contradictable state mechanism.
5. **Snapshots for which actions?** Snapshots exist to preserve consumed-nutrient truth for B8 aggregates; `missed`/`cleared` consume nothing. **Default:** snapshot rows (one per label nutrient of the bound product version, `scaled_amount = amount × servings`) are written **only for `state_action = 'done'`** facts, atomically in the same transaction. `missed`/`cleared` facts persist with zero snapshot rows. Snapshots are never updated or deleted — a later `cleared` changes the _projection_, not history; downstream aggregation (Slice 7) filters by current visible state.
6. **`timezone` column vs `schedule.timezone`.** Migration 006 stores both a `timezone` column and a `schedule jsonb` whose validator requires `schedule.timezone`. Two sources can diverge. **Default:** `schedule.timezone` is the single caller-supplied truth; the service writes `timezone = schedule.timezone` (denormalized for SQL) and rejects any payload where a separately supplied timezone disagrees — the MCP input schema simply does not expose a separate timezone field, so divergence is unrepresentable at the public boundary.
7. **Which product version does a regimen/intake bind?** **Default:** optional `product_version` input; omitted ⇒ the product's `current_version` at mutation time. A supplied version must exist for that product (else new stable error `supplement_product_version_not_found`). The bound version is immutable thereafter: label revisions never rewrite regimen intent or intake facts (proven by the revision-immutability tests). The product must be caller-owned and `active` for regimen creation, regimen re-activation, and intake logging; deleted ⇒ closed-fail `supplement_product_not_found` (same not-found shape as unknown/cross-user — no existence leak).
8. **“Explicit authorized intake mutation” — confirmation enum or not?** Slice 4's reuse mutation takes a confirmation enum; the governing plan's §5 contract for `log_supplement_intake` requires “explicit authorized mutation: direct product ID/version or unique alias resolution, servings/time, state, idempotency” and no confirmation field. **Default:** authorization = invoking the mutation tool itself (B7's line is search/suggestion-vs-write, which the read-only tools' zero-write tests prove); no confirmation enum is added. Declared so reviewers don't mistake this for narrowing — adding one would instead narrow the governing §5 contract.
9. **Alias resolution result shape: error or data?** Ambiguity must “produce candidates/error and zero writes” (brief §3). **Default:** `resolve_supplement_product` (read-only) returns a **structured result**, never throws for ambiguity: `resolution_status: 'resolved' | 'ambiguous' | 'not_found'` with `candidates[]` (product_id, category, display_name, brand, form, current_version, matched_alias) — Hermes needs the candidates to ask the user. `log_supplement_intake` given an ambiguous alias **throws** stable `supplement_alias_ambiguous` (message carries the candidate display names/ids) with zero domain writes. Alias matching for both is exact match on `normalizeSupplementAlias(input)` against current-version aliases of the caller's active products, plus current display_name/short_name normalized-equality as a fallback — lexical, never fuzzy-picks. `product_id` and `alias` are mutually exclusive inputs; direct UUID is authoritative and skips resolution.
10. **Regimen deactivate/reactivate semantics.** `set_supplement_regimen_active(regimen_id, active)` is the explicit state operation from the governing plan. **Default:** it locks the regimen row (user-scoped `FOR UPDATE`), no-ops idempotently when the state already matches (readback with `changed: false`), sets `deactivated_at`/`updated_at` on deactivate, clears `deactivated_at` on reactivate. Reactivation requires the bound product to still be active (deleted product ⇒ `supplement_product_not_found`); deactivation is always allowed. Unknown/cross-user regimen ⇒ new stable `supplement_regimen_not_found`.
11. **Logging against a regimen.** **Default:** when `regimen_id` is supplied: it must be caller-owned (else `supplement_regimen_not_found`), **active** (else new stable `supplement_regimen_inactive` — the brief's “inactive … regimen must fail closed”), and the intake's product/version must equal the regimen's bound product/version; the input schema therefore forbids combining `regimen_id` with `product_id`/`alias`/`product_version` (the regimen IS the product selection). Ad-hoc logging (no regimen) is unrestricted by regimen state.
12. **`occurred_at` bounds.** **Default:** strict ISO-8601 with explicit offset via `isStrictIsoTimestamp` (Slice 4 convention, including 24:00 and offset-range rejection), and it must not be more than 24h in the future at write time (mirrors existing meal-event sanity bounds; prevents accidental far-future facts corrupting occurrence projections). Millisecond-equal comparison (`Date.parse`) for idempotency identity, per Slice 4 decision 4 — `timestamptz` round-trips lose string identity.
13. **Status/read windows are bounded.** Occurrence derivation over an unbounded window is a DoS vector and an unbounded loop. **Default:** `get_supplement_regimen_status` takes required `from_date`/`to_date` (`YYYY-MM-DD`, validated), inclusive, `to_date >= from_date`, window ≤ 92 days, intersected with `[starts_on, ends_on]`; occurrences are derived in the regimen's timezone. `get_supplement_intakes` takes optional `from`/`to` strict timestamps plus optional `product_id`/`regimen_id` filters and a `limit` (default 100, max 500), newest-first. Read tools disclose derived data only; no “unmarked” advice semantics (that's Slice 7 flags).
14. **Regimen idempotency identity.** **Default:** new pure `deriveSupplementRegimenIdempotencyFingerprint` in `src/supplement-types.ts` hashing `(user_id, idempotency_key, product_id, product_version, dose_servings, stableStringify(schedule), starts_on, ends_on)`. Replay with equal identity ⇒ dedup readback; same key, different identity ⇒ `idempotency_conflict` (shared stable code). Concurrency serializes on the 010 partial unique index with the bounded-retry pattern from `createSupplementProduct` (`isCreateKeyRaceViolation` generalized to accept a constraint name).
15. **Intake idempotency replay.** The shipped fingerprint helper covers `(user_id, key, product, version, servings, occurred_at, state_action)`. `regimen_id`, `reason`, and `supersedes_intake_id` are **not** identity. **Default:** replay convergence compares the fingerprint fields only (millisecond-equal `occurred_at`); a matching replay returns the original fact readback (`deduplicated: true`) even if non-identity fields differ; a differing identity is `idempotency_conflict`. Declared so the executable conflict tests assert one exact rule.
16. **No scheduler, no auto-marking — restated as testable invariants.** Regimen create/read/list/status and alias resolution write zero rows in `supplement_intake_events`, `supplement_intake_nutrient_snapshots`, `meal_events` (all children), `supplement_intake_meal_links`, and enqueue nothing (there is no queue in this repo to touch). “Unmarked” is a derived `undefined` occurrence in a read result — never a stored row.

---

## 3. Scope boundary

### In scope

- Migration `010_supplement_regimen_idempotency.sql` + chain-array/docs updates.
- Pure contracts in `src/supplement-types.ts` (+ tests): occurrence derivation, occurrence-state reduction, regimen idempotency fingerprint.
- Domain services in `src/supplements.ts` (+ integration tests): `createSupplementRegimen`, `listSupplementRegimens`, `setSupplementRegimenActive`, `resolveSupplementProduct`, `logSupplementIntake`, `getSupplementIntakes`, `getSupplementRegimenStatus`; new typed errors.
- Seven public MCP tools in `src/mcp.ts` (+ transport tests): strict input schemas, typed output schemas, structured content, truthful annotations, analytics, stable error mapping.
- README tools-table rows + one docs section; migration chain docs truth.

### Explicitly out of scope (do not build)

- Sports-nutrition snack meal events or `supplement_intake_meal_links` writes (Slice 6).
- Reporting aggregates, data flags, `get_supplement_nutrition_summary`, `get_supplement_data_flags` (Slice 7).
- Cron/scheduler/reminders/notifications, automatic intake marking, provider calls/workers, MyFitnessPal, OCR/STT/vision, Telegram, UI/widgets for supplements, medical/dosage advice of any kind.
- Any edit to migrations `001`–`009`, to Slice 2 product tools' behavior, to Slice 3/4 reuse behavior, or to alcohol/food tracking paths.

---

## 4. Design to implement (exact shapes)

### 4.1 Migration — `db/migrations/010_supplement_regimen_idempotency.sql`

```sql
-- Forward-only migration: PostgreSQL-enforced create idempotency for
-- supplement regimens (Slice 5).
--
-- Why a new migration instead of editing 006: 006-009 are shipped and may be
-- applied by existing deployments (main auto-deploys). 010 is additive and
-- forward-safe: one nullable column plus one partial unique index; nothing is
-- altered or dropped, and it is safe to rerun.
--
-- supplement_regimens has no shipped writer before Slice 5, so the column
-- addition applies cleanly to every deployment that has only run shipped code.
--
-- Run after 009: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/migrations/010_supplement_regimen_idempotency.sql

ALTER TABLE supplement_regimens
    ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_supplement_regimens_user_idem
    ON supplement_regimens (user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
```

### 4.2 New pure contracts — `src/supplement-types.ts`

```ts
// Regimen create idempotency identity (mirrors the intake helper).
export interface SupplementRegimenIdempotencyIdentity {
    user_id: string;
    idempotency_key: string;
    product_id: string;
    product_version: number;
    dose_servings: number;
    schedule: RegimenSchedule;
    starts_on: string; // YYYY-MM-DD
    ends_on: string | null;
}
export function deriveSupplementRegimenIdempotencyFingerprint(
    identity: SupplementRegimenIdempotencyIdentity,
): string; // "supplement-regimen:" + sha256Hex([...]) with stable schedule serialization

// Declarative occurrence derivation. Pure; bounded by caller-validated window.
// Uses dateInTz/dowInTz semantics: ISO weekday = ((dowInTz + 6) % 7) + 1.
export interface RegimenOccurrence {
    local_date: string; // YYYY-MM-DD in schedule.timezone
    local_time: string; // schedule.local_time
}
export function deriveRegimenOccurrences(
    schedule: RegimenSchedule,
    startsOn: string,
    endsOn: string | null,
    windowFrom: string,
    windowTo: string,
): RegimenOccurrence[];
// Effective range = [max(startsOn, windowFrom), min(endsOn ?? windowTo, windowTo)];
// empty when inverted. daily → every date; weekly → dates whose ISO weekday ∈ weekdays.

// Latest-fact occurrence reduction (state authority = append order).
export interface IntakeFactForProjection {
    id: string;
    regimen_id: string | null;
    occurred_at: string | Date;
    state_action: SupplementIntakeStateAction;
    created_at: string | Date;
}
export function reduceOccurrenceState(
    facts: IntakeFactForProjection[],
): SupplementIntakeVisibleState;
// sort by (created_at, id) ascending, project the last action via
// projectIntakeVisibleState; empty → "undefined".
```

### 4.3 New domain errors — `src/supplements.ts`

```ts
export class SupplementAliasAmbiguousError extends Error {
    readonly code = "supplement_alias_ambiguous";
    constructor(readonly candidates: ResolvedProductCandidate[]) {
        super(
            `supplement_alias_ambiguous: alias matches ${candidates.length} products; pass a direct product_id (candidates: ${candidates.map((c) => `${c.display_name} ${c.product_id}`).join(", ")})`,
        );
        this.name = "SupplementAliasAmbiguousError";
    }
}
export class SupplementProductVersionNotFoundError extends Error {
    readonly code = "supplement_product_version_not_found";
    // "this product has no such label version"
}
export class SupplementRegimenNotFoundError extends Error {
    readonly code = "supplement_regimen_not_found";
    // unknown id or another user's regimen — indistinguishable by design
}
export class SupplementRegimenInactiveError extends Error {
    readonly code = "supplement_regimen_inactive";
    // "regimen is deactivated; reactivate it or log an ad-hoc intake"
}
```

`SupplementValidationError`, `SupplementProductNotFoundError`, `SupplementProductInactiveError`, `SupplementIdempotencyConflictError` are reused as-is. Extend `supplementToolError` in `src/mcp.ts` with the four new classes (message = stable code, mirroring the existing style; `supplement_alias_ambiguous` message includes the candidates).

### 4.4 Service signatures — `src/supplements.ts`

```ts
// REGIMENS ------------------------------------------------------------------
export interface CreateSupplementRegimenCommand {
    user_id: string;
    product_id: string;
    product_version?: number | null; // default: current at create time
    dose_servings: number; // finite, > 0
    schedule: RegimenSchedule; // validated via validateRegimenSchedule
    starts_on: string; // YYYY-MM-DD
    ends_on?: string | null; // >= starts_on
    idempotency_key?: string | null;
    created_by: string;
}
export interface SupplementRegimenReadback {
    regimen_id: string;
    product_id: string;
    product_version: number;
    product_display_name: string; // from the BOUND version (not current)
    category: SupplementProductCategory;
    dose_servings: number;
    schedule: RegimenSchedule;
    starts_on: string;
    ends_on: string | null;
    active: boolean;
    created_at: string;
    updated_at: string;
    deactivated_at: string | null;
}
export async function createSupplementRegimen(
    pool: Pool,
    command: CreateSupplementRegimenCommand,
    opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<{ regimen: SupplementRegimenReadback; deduplicated: boolean }>;
// Tx: validate → lock product root FOR UPDATE (user-scoped; not found /
// inactive fail closed) → resolve/verify version → idempotency convergence
// lookup on (user_id, key) → INSERT → readback. Race: bounded retry on 23505
// constraint 'uniq_supplement_regimens_user_idem' (generalize
// isCreateKeyRaceViolation to take the constraint name).

export async function listSupplementRegimens(
    pool: Queryable,
    userId: string,
    options: {
        includeInactive?: boolean;
        productId?: string;
        limit?: number;
    } = {},
): Promise<SupplementRegimenReadback[]>; // pure read; newest-first

export async function setSupplementRegimenActive(
    pool: Pool,
    userId: string,
    regimenId: string,
    active: boolean,
): Promise<{ regimen: SupplementRegimenReadback; changed: boolean }>;
// Tx: lock regimen row user-scoped FOR UPDATE → not found fails closed →
// no-op when state matches → reactivation checks product still active.

// ALIAS RESOLUTION ----------------------------------------------------------
export interface ResolvedProductCandidate {
    product_id: string;
    category: SupplementProductCategory;
    display_name: string;
    brand: string | null;
    form: string | null;
    current_version: number;
    matched_alias: string; // the alias/name that matched
}
export interface ResolveSupplementProductResult {
    resolution_status: "resolved" | "ambiguous" | "not_found";
    candidates: ResolvedProductCandidate[]; // 1 | >1 | 0 entries
}
export async function resolveSupplementProduct(
    pool: Queryable,
    userId: string,
    query: { product_id?: string; alias?: string },
): Promise<ResolveSupplementProductResult>;
// Read-only. product_id path: active+owned → resolved, else not_found.
// alias path: normalizeSupplementAlias → exact match on current-version
// normalized aliases OR normalized display/short name, active products only.

// INTAKES --------------------------------------------------------------------
export interface LogSupplementIntakeCommand {
    user_id: string;
    product_id?: string | null; // XOR alias XOR regimen_id (schema-enforced)
    alias?: string | null;
    product_version?: number | null; // only with product_id/alias
    regimen_id?: string | null; // implies the regimen's product/version
    servings: number; // finite, > 0
    occurred_at: string; // strict ISO, ≤ now + 24h
    state_action: SupplementIntakeStateAction; // done | missed | cleared
    reason?: string | null;
    supersedes_intake_id?: string | null;
    idempotency_key: string; // required (column is NOT NULL)
    actor: string;
}
export interface SupplementIntakeFactReadback {
    intake_id: string;
    product_id: string;
    product_version: number;
    product_display_name: string; // bound version's name
    category: SupplementProductCategory;
    regimen_id: string | null;
    servings: number;
    occurred_at: string;
    state_action: SupplementIntakeStateAction; // raw action (audit)
    visible_state: SupplementIntakeVisibleState; // projection of THIS fact
    reason: string | null;
    actor: string;
    supersedes_intake_id: string | null;
    created_at: string;
    nutrient_snapshots: {
        nutrient_key: string;
        unit: string;
        original_amount: number;
        scaled_amount: number;
    }[]; // empty for missed/cleared
}
export async function logSupplementIntake(
    pool: Pool,
    command: LogSupplementIntakeCommand,
    opts: { beforeCommit?: () => Promise<void> } = {},
): Promise<{ intake: SupplementIntakeFactReadback; deduplicated: boolean }>;
// Tx: validate (strict ISO, servings, action enum, XOR selection) →
// resolve product (direct id | unique alias | regimen binding; ambiguous
// alias throws with zero writes) → lock product root FOR UPDATE, verify
// owned+active(+version exists) → if regimen_id: verify owned+active+matching
// binding → verify supersedes target exists (same user+product) →
// idempotency convergence on (user_id, key): fingerprint-equal → dedup
// readback, differing → conflict → INSERT fact → INSERT snapshots (done
// only; one row per label nutrient of the bound version, scaled) →
// opts.beforeCommit → readback. Race: bounded retry on 23505
// 'uniq_supplement_intake_user_idem'.

export async function getSupplementIntakes(
    pool: Queryable,
    userId: string,
    options: {
        productId?: string;
        regimenId?: string;
        from?: string; // strict ISO
        to?: string;
        limit?: number; // default 100, max 500
    } = {},
): Promise<SupplementIntakeFactReadback[]>; // newest-first by occurred_at, id

// REGIMEN STATUS (derived; read-only) ----------------------------------------
export interface RegimenOccurrenceStatus {
    local_date: string;
    local_time: string;
    visible_state: SupplementIntakeVisibleState; // undefined | done | missed
    latest_intake_id: string | null;
}
export async function getSupplementRegimenStatus(
    pool: Queryable,
    userId: string,
    regimenId: string,
    window: { from_date: string; to_date: string }, // ≤ 92 days
): Promise<{
    regimen: SupplementRegimenReadback;
    occurrences: RegimenOccurrenceStatus[];
}>;
// deriveRegimenOccurrences ∩ facts WHERE regimen_id = $1; per-occurrence
// latest fact by (created_at, id) via dateInTz(occurred_at, tz) grouping;
// reduceOccurrenceState. Includes inactive regimens (history stays readable).
```

### 4.5 MCP surface — `src/mcp.ts`

Schema constants (place beside the existing `SUPPLEMENT_*` block, ~line 1980):

```ts
const REGIMEN_SCHEDULE_INPUT_SCHEMA = z
    .object({
        timezone: z.string().min(1),
        frequency: z.enum(["daily", "weekly"]),
        local_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        weekdays: z.array(z.number().int().min(1).max(7)).optional(),
    })
    .strict(); // full semantic validation stays in validateRegimenSchedule

const SUPPLEMENT_REGIMEN_OUTPUT_SCHEMA = {
    /* mirrors SupplementRegimenReadback */
};
const SUPPLEMENT_INTAKE_FACT_OUTPUT_SCHEMA = {
    /* mirrors SupplementIntakeFactReadback; visible_state: z.enum(["undefined","done","missed"]) */
};
const RESOLVE_PRODUCT_OUTPUT_SCHEMA = {
    resolution_status: z.enum(["resolved", "ambiguous", "not_found"]),
    candidates: z.array(z.object({/* ResolvedProductCandidate */})),
};
const REGIMEN_STATUS_OUTPUT_SCHEMA = {
    /* regimen + occurrences[] with visible_state enum */
};
```

| Tool                            | Annotations                                                         | Input schema (zod, strict bounds)                                                                                                                                                                                                                                                                                         | Notes                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_supplement_regimen`     | readOnly:false, destructive:false, idempotent:true, openWorld:false | `product_id: uuid`, `product_version?: int ≥ 1`, `dose_servings: z.number().positive().finite()`, `schedule: REGIMEN_SCHEDULE_INPUT_SCHEMA`, `starts_on: /^\d{4}-\d{2}-\d{2}$/`, `ends_on?` same nullable, `idempotency_key?: min 1 max 255`                                                                              | Description MUST state: creates intent only — no intake, no meal event, no scheduler job, no reminder.                                                                                                                          |
| `list_supplement_regimens`      | readOnly:true                                                       | `include_inactive?: boolean`, `product_id?: uuid`, `limit?: 1..200`                                                                                                                                                                                                                                                       |                                                                                                                                                                                                                                 |
| `set_supplement_regimen_active` | readOnly:false, idempotent:true                                     | `regimen_id: uuid`, `active: boolean`                                                                                                                                                                                                                                                                                     | Explicit activate/deactivate; returns `changed`.                                                                                                                                                                                |
| `resolve_supplement_product`    | readOnly:true                                                       | `product_id?: uuid`, `alias?: min 1` — handler rejects both/neither via `SupplementValidationError`                                                                                                                                                                                                                       | Returns candidates structurally; NEVER writes.                                                                                                                                                                                  |
| `log_supplement_intake`         | readOnly:false, destructive:false, idempotent:true                  | `product_id?: uuid`, `alias?: min 1`, `product_version?: int ≥ 1`, `regimen_id?: uuid`, `servings: positive finite`, `occurred_at: z.string().refine(isStrictIsoTimestamp, …)`, `state_action: z.enum(["done","missed","cleared"])`, `reason?: max 1000`, `supersedes_intake_id?: uuid`, `idempotency_key: min 1 max 255` | Handler enforces XOR(product_id, alias, regimen_id). Description states: appends an immutable fact; visible state is undefined/done/missed; caloric meal linkage is NOT performed by this version; data-only, no dosage advice. |
| `get_supplement_intakes`        | readOnly:true                                                       | `product_id?: uuid`, `regimen_id?: uuid`, `from?`/`to?` strict ISO, `limit?: 1..500`                                                                                                                                                                                                                                      | Emits raw actions as audit plus `visible_state`; public state vocabulary is exactly the 3-value enum.                                                                                                                           |
| `get_supplement_regimen_status` | readOnly:true                                                       | `regimen_id: uuid`, `from_date`/`to_date: YYYY-MM-DD`                                                                                                                                                                                                                                                                     | Handler enforces window ≤ 92 days. Derived occurrences; no write, no reminder.                                                                                                                                                  |

All seven: `withAnalytics(name, fn, { userId })`, `outputSchema` + `structuredContent` on every path, errors via extended `supplementToolError`. Data-only language everywhere — no medical/dosage advice in any description or output string (checked by an executable test, Task 12).

---

## 5. AC-to-artifact-and-executable-proof matrix

Every proof row runs against **real PostgreSQL** (disposable `nutrition_mcp_test`) and, where named, the **real public MCP transport** (`McpServer` + `Client` + `InMemoryTransport` via `withSupplementTools`). Unit-only proof is never accepted for a locked DB/transport requirement.

| Locked requirement (brief §)                                                                                              | Implementation artifacts                                              | Executable proof (suite :: test)                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §1 regimen create: product/version binding, positive dose, validated schedule, tz, start/end, active, audit metadata (B3) | 010 migration; `createSupplementRegimen`; `create_supplement_regimen` | `supplements.integration.test.ts` :: “create regimen persists version binding, schedule, window, audit metadata”; “defaults to current version and pins it”; “rejects nonpositive dose / invalid schedule / ends_on < starts_on / bad tz with zero rows”. `mcp-supplements.integration.test.ts` :: same through the tool + malformed-payload schema rejections.                                                                       |
| §1 read/list + explicit active/deactivate (B3)                                                                            | `listSupplementRegimens`, `setSupplementRegimenActive`; 2 tools       | integration :: “list scopes to user, filters inactive”; “deactivate stamps deactivated_at; reactivate clears it; matching state is a no-op readback”; “reactivation with deleted product fails closed”. transport :: same + `changed` flag.                                                                                                                                                                                           |
| §1 regimen/read never creates intake/meal/scheduler/reminder (B3, B7)                                                     | (invariant)                                                           | Both suites :: after create/list/status/resolve, `tableCount` = 0 for `supplement_intake_events`, `supplement_intake_nutrient_snapshots`, `meal_events`, `supplement_intake_meal_links` (extend `tableCount` helper).                                                                                                                                                                                                                 |
| §2 explicit intake mutation: direct ID/version or safe alias, positive servings, time, action, idempotency (B5)           | `logSupplementIntake`; `log_supplement_intake`                        | integration :: “direct product id logs a done fact”; “explicit historical version binds that version”; “regimen_id path binds the regimen's product/version”; “nonpositive/nonfinite servings, bad enum, loose timestamp (offset-less, 24:00, +15:00 offset), far-future occurred_at all rejected with zero rows”. transport :: direct-ID and alias paths end-to-end.                                                                 |
| §2 append-only + audit (actor/time/reason/supersession) (B4)                                                              | fact INSERTs only; readback carries audit fields                      | integration :: “no UPDATE/DELETE API exists; correcting appends a fact with reason/actor/supersedes link and both facts stay readable”; “supersedes target must exist, same user+product, else validation error zero writes”; SQL-level assert that original rows are byte-identical after correction.                                                                                                                                |
| §2 internal done                                                                                                          | missed                                                                | cleared; public exactly undefined                                                                                                                                                                                                                                                                                                                                                                                                     | done        | missed; absent/cleared ⇒ undefined; no automatic marking (B4) | `projectIntakeVisibleState`, `reduceOccurrenceState`; status/intake reads | `supplement-types.test.ts` :: reducer transition/order tests (absent, done, done→cleared, done→missed→cleared, same-timestamp tie by id). integration :: occurrence projection from real rows. transport :: “every visible_state string across get_supplement_intakes / get_supplement_regimen_status responses ∈ {undefined,done,missed}; raw 'cleared' appears only in the audit state_action field”; “creating a regimen with due past occurrences leaves them undefined (nothing auto-marks)”. |
| §2 snapshots: version nutrients × servings; unknown-vs-zero; label revision never changes history (B1/B10 slice-cut)      | snapshot INSERTs in `logSupplementIntake`                             | integration :: “done intake snapshots every label nutrient scaled (incl. explicit 0 → 0)”; “absent label nutrient ⇒ absent snapshot row, never zero”; “missed/cleared write zero snapshots”; “revise label to v2 after v1 intake: snapshots and readback still show v1 values; new intake at current binds v2”.                                                                                                                       |
| §3 direct ID; owned+active+valid version (B5)                                                                             | resolution branch in service                                          | integration :: cross-user id, deleted product, unknown version each fail closed with stable code + zero writes; transport :: same codes through tools.                                                                                                                                                                                                                                                                                |
| §3 alias unique/ambiguous/zero-write; no existence leak (B5)                                                              | `resolveSupplementProduct`; ambiguous throw in log                    | integration :: “unique alias resolves read-only”; “two products sharing normalized alias ⇒ ambiguous with both candidates, zero writes”; “u2's alias never matches u1 products (not_found, indistinguishable from nonexistent)”; “log via ambiguous alias throws supplement_alias_ambiguous, `domainTableCounts`-style before/after equality”. transport :: resolve returns candidates; ambiguous log rejected; row counts unchanged. |
| §3 read-only resolve/list/status make no domain writes (B7)                                                               | (invariant)                                                           | transport :: before/after full-table count equality across every read tool call, including error paths.                                                                                                                                                                                                                                                                                                                               |
| §4 seven tools, strict schemas, typed output, analytics, truthful annotations, stable errors                              | `src/mcp.ts` registrations                                            | transport :: “listTools advertises exactly the seven new tools with input+output schemas and truthful readOnlyHint values” (extend `SUPPLEMENT_TOOL_NAMES`); every mutation/readback parses against declared outputSchema (SDK validates structuredContent automatically); stable code assertions per error case; analytics rows appear in `tool_analytics` for at least one call.                                                    |
| §4 data-only, no medical/dosage advice                                                                                    | descriptions/outputs                                                  | transport :: regex sweep over the seven tools' descriptions + sampled outputs forbidding `/dosage advice                                                                                                                                                                                                                                                                                                                              | should take | recommended dose                                              | consult                                                                   | interaction/i`-class phrasing (mirror C1 style).                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| §5 hard boundary: NO snack meal events / intake meal links                                                                | (absence of code)                                                     | integration + transport :: “sports_nutrition done intake creates ZERO meal_events roots/versions/items/results and ZERO supplement_intake_meal_links rows”; same for supplement category; grep-level review that `logSupplementIntake` never imports `createMealEvent`.                                                                                                                                                               |
| §6 retries/conflicts/concurrency                                                                                          | idempotency design §2.14–15                                           | integration :: “same-key same-identity replay returns deduplicated original for intake AND regimen”; “same key differing servings/time/action/schedule ⇒ idempotency_conflict, no second row”; “`Promise.all` two concurrent same-key `logSupplementIntake` (separate pool clients) converge on one fact + one snapshot set”; same for `createSupplementRegimen`.                                                                     |
| §6 rollback after snapshot work                                                                                           | `opts.beforeCommit`                                                   | integration :: “injected failure after fact+snapshot inserts, before commit ⇒ zero rows in intake/snapshot tables; product/regimen rows untouched”; same for regimen create.                                                                                                                                                                                                                                                          |
| §6 migration chain / DB gate convention (C2)                                                                              | 010 + chain arrays                                                    | `db.integration.test.ts` migration replay incl. 010; upgrade-fixture test: apply 001–009, seed a regimen-less product + profile/alcohol + meal event, apply 010, assert old rows intact and the new index exists (`pg_indexes`). `bun run test:db` green.                                                                                                                                                                             |
| §6 preserve legacy food/alcohol paths (C3)                                                                                | zero edits to those paths                                             | `bun test src/alcohol.test.ts`; `bun run test:unit`; full DB gate green (all pre-existing suites).                                                                                                                                                                                                                                                                                                                                    |
| Docs truth (C1)                                                                                                           | README rows, docs section                                             | `food-tracking-docs.test.ts` (auto: 010 in README psql line + docs); manual check: no claim of reminders/auto-marking/meal-linkage/reports.                                                                                                                                                                                                                                                                                           |

---

## 6. Dependency-ordered RED→GREEN tasks

Run every `bun test` below with the §0 env exports in place. Commit after each GREEN (+format) step with the message given.

### Task 1 — Migration 010 + chain truth

**Files:** Create `db/migrations/010_supplement_regimen_idempotency.sql` (§4.1). Modify: `scripts/test-db-gate.ts`, `src/db.integration.test.ts`, `src/supplements.integration.test.ts`, `src/mcp-supplements.integration.test.ts`, `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts` (append 010 to each `MIGRATIONS`/`migrations` array), `README.md` (psql line after 009, storage/migration list), `docs/food-tracking-agent-driven.md` (chain mention).

1. **RED:** create the SQL file only. Run `bun test src/food-tracking-docs.test.ts` → FAIL (README/docs missing `010_…`). Also add to `src/db.integration.test.ts` a test “migration 010 adds regimen idempotency index over an already-applied 001–009 database” that applies 001–009, seeds one product (reuse Slice 2 fixtures/SQL), one profile with alcohol enabled, one meal event, then applies 010 twice (rerun-safety) and asserts: old rows unchanged, `uniq_supplement_regimens_user_idem` present in `pg_indexes`, `idempotency_key` column exists. Run it → FAIL before array/docs updates are complete.
2. **GREEN:** update all six chain arrays + README + docs. `bun test src/food-tracking-docs.test.ts src/db.integration.test.ts` → PASS.
3. Commit: `feat: slice 5 — migration 010 regimen create idempotency + chain truth`

### Task 2 — Pure contracts: occurrence derivation, occurrence reduction, regimen fingerprint

**Files:** Modify `src/supplement-types.ts`, `src/supplement-types.test.ts`.

1. **RED:** add unit tests: regimen fingerprint deterministic / conflicts on any identity field / stable across schedule key order; `deriveRegimenOccurrences` daily range, weekly weekday filtering, window∩[starts,ends] clipping, inverted window ⇒ empty, DST-transition date still yields exactly one occurrence per local date; `reduceOccurrenceState` transitions (empty ⇒ undefined; done; done→cleared ⇒ undefined; done→missed; equal created_at tie by id; never emits "cleared"). Run `bun test src/supplement-types.test.ts` → FAIL.
2. **GREEN:** implement §4.2 (fingerprint uses `sha256Hex` + the module's stable serialization idea from `supplements.ts` — export `stableStringify` from `supplements.ts` or duplicate the 14-line helper locally; prefer exporting to stay DRY). PASS.
3. Commit: `feat: slice 5 — pure regimen occurrence and intake-state contracts`

### Task 3 — Regimen repository: create

**Files:** Modify `src/supplements.ts`, `src/supplements.integration.test.ts`.

1. **RED:** integration tests (new `describeDb` block): persist + readback of every field (§5 row 1); current-version default pinning; explicit historical version binding; unknown version ⇒ `supplement_product_version_not_found`; cross-user/deleted product ⇒ `supplement_product_not_found`; validation rejections (dose ≤ 0, invalid schedule via `validateRegimenSchedule`, `ends_on < starts_on`, junk `starts_on`) with zero `supplement_regimens` rows; same-key replay dedup; same-key different-identity conflict; `Promise.all` concurrent same-key creates converge to one row; `beforeCommit` rollback leaves zero rows; creating a regimen writes zero intake/snapshot/meal/link rows. → FAIL (functions missing).
2. **GREEN:** implement `createSupplementRegimen` + new error classes (§4.3, §4.4). Generalize the 23505 helper: `isKeyRaceViolation(err, "uniq_supplement_regimens_user_idem")`. PASS: `bun test src/supplements.integration.test.ts --max-concurrency 1`.
3. Commit: `feat: slice 5 — transactional idempotent regimen creation`

### Task 4 — Regimen repository: list + set-active

**Files:** same as Task 3.

1. **RED:** list is user-scoped (u2 sees nothing of u1), excludes inactive by default, filters by product, newest-first; deactivate stamps `deactivated_at` + `updated_at`, `changed: true`; repeat deactivate ⇒ `changed: false`, timestamps untouched; reactivate clears `deactivated_at`; reactivate with deleted product ⇒ `supplement_product_not_found`; unknown/cross-user regimen ⇒ `supplement_regimen_not_found`; label revision after create does NOT move the regimen's bound version (`product_version` and `product_display_name` still v1). → FAIL.
2. **GREEN:** implement both functions. PASS.
3. Commit: `feat: slice 5 — regimen listing and explicit active-state operation`

### Task 5 — Alias/product resolution (read-only)

**Files:** same.

1. **RED:** direct id resolved/not_found (deleted, cross-user, unknown identical); unique normalized alias (case/whitespace/NFKC variants) ⇒ resolved with matched_alias; display-name and short-name normalized-equality resolve; two same-user products sharing a normalized alias ⇒ ambiguous with both candidates; alias on historical version only (post-revision) does NOT match; u2 alias never leaks u1; every call leaves all domain table counts unchanged. → FAIL.
2. **GREEN:** implement `resolveSupplementProduct` (single SQL over current-version aliases + name equality on `normalizeSupplementAlias`; note: compare normalized input against `normalized_alias` with `=`, not ILIKE — resolution is exact, unlike `searchSupplementProducts`). PASS.
3. Commit: `feat: slice 5 — read-only alias and product resolution`

### Task 6 — Intake logging: validation + direct-ID/alias/regimen paths + snapshots

**Files:** same.

1. **RED:** the §5 rows for B5/B4/snapshots/hard-boundary: done fact via direct id (readback fields, snapshot rows scaled, explicit 0 preserved, absent nutrient absent); µg-style generic keys snapshot fine; historical version binding; unique-alias path; ambiguous-alias throw + zero writes; regimen path binds regimen's product/version, rejects combining selectors (service-level validation error), inactive regimen ⇒ `supplement_regimen_inactive`, cross-user regimen ⇒ `supplement_regimen_not_found`; missed/cleared facts persist with zero snapshots; supersedes audit chain (valid ref ok, dangling/cross-product ref rejected); strict-timestamp rejections (offset-less, `24:00`, `+15:00`, future > 24h); sports_nutrition AND supplement done intakes produce zero `meal_events`/`supplement_intake_meal_links` rows. → FAIL.
2. **GREEN:** implement `logSupplementIntake` per §4.4. Fact insert uses the shipped fingerprint helper only for identity comparison; the DB row stores the caller's raw `idempotency_key` (the unique index anchors it). PASS.
3. Commit: `feat: slice 5 — append-only intake facts with immutable nutrient snapshots`

### Task 7 — Intake idempotency, concurrency, rollback

**Files:** same.

1. **RED:** same-key same-identity replay (different `reason`) ⇒ `deduplicated: true`, same `intake_id`, snapshot count unchanged; same key differing servings / occurred_at / action / product ⇒ `idempotency_conflict`, table counts unchanged; `Promise.all` two concurrent same-key calls ⇒ exactly one fact + one snapshot set, both resolve or one gets the stable conflict; `beforeCommit` failure after fact+snapshot inserts ⇒ zero rows in both tables and product/regimen tables untouched. → FAIL.
2. **GREEN:** bounded-retry convergence loop mirroring `createSupplementProduct` (constraint `uniq_supplement_intake_user_idem`; millisecond-equal `occurred_at` comparison). PASS.
3. Commit: `feat: slice 5 — DB-serialized intake idempotency, concurrency, and rollback atomicity`

### Task 8 — Reads: intake history + derived regimen status

**Files:** same.

1. **RED:** `getSupplementIntakes` newest-first, user-scoped, product/regimen/time filters, limit clamp, audit fields + per-fact `visible_state`, cleared facts read back with `visible_state: "undefined"`; post-revision reads still show bound-version snapshots. `getSupplementRegimenStatus`: daily regimen over a week with done/missed/cleared/absent days ⇒ exact per-occurrence states; weekly weekday filtering; window clipping to `[starts_on, ends_on]`; window > 92 days rejected; occurrence date matched in regimen tz (log at 23:30 local with non-UTC offset lands on the local date); inactive regimen still readable; cross-user ⇒ not found; reads write nothing. → FAIL.
2. **GREEN:** implement both reads using `deriveRegimenOccurrences` + `reduceOccurrenceState` + `dateInTz`. PASS.
3. Commit: `feat: slice 5 — intake history and derived regimen occurrence status reads`

### Task 9 — MCP registration (seven tools)

**Files:** Modify `src/mcp.ts`, `src/mcp-supplements.integration.test.ts`.

1. **RED:** extend `SUPPLEMENT_TOOL_NAMES` with the seven names; new transport test “listTools advertises the twelve supplement tools with schemas and truthful annotations (read tools readOnlyHint true; mutations false)”. → FAIL (tools unregistered).
2. **GREEN:** add schema constants (§4.5), extend `supplementToolError` with the four new error classes, register all seven tools (handler-level XOR check for `resolve`/`log` selectors throwing `SupplementValidationError`; window ≤ 92 days check in status handler). PASS listTools test.
3. Commit: `feat: slice 5 — public regimen/intake MCP tool family`

### Task 10 — Transport vertical + adversarial tests

**Files:** Modify `src/mcp-supplements.integration.test.ts`.

1. **RED→GREEN loop** (tests should mostly pass immediately; fix handlers where they don't): full happy path through tools (create product → create regimen → log done/missed/cleared → get_supplement_intakes → get_supplement_regimen_status with exact 3-state assertions); u1/u2 isolation for every new tool (u2 harness sees not_found / empty and can never mutate u1 rows — assert via direct SQL counts); ambiguous alias through `log_supplement_intake` ⇒ `isError` with `supplement_alias_ambiguous` and unchanged counts; `resolve_supplement_product` ambiguous returns candidates; malformed payloads (bad uuid, bad enum, loose timestamp, negative servings, weekday 8, both product_id+alias) rejected at schema/handler with zero writes; read-only tools leave all table counts unchanged; sports done intake through the tool ⇒ zero meal roots (transport-level proof of the hard boundary); structuredContent of every success parses against the declared output schema; description sweep test for medical-advice phrases; replayed tool call with same idempotency_key returns `deduplicated: true`.
2. Run: `bun test src/mcp-supplements.integration.test.ts --max-concurrency 1` → PASS.
3. Commit: `test: slice 5 — adversarial public-transport regimen/intake gates`

### Task 11 — Docs truth pass

**Files:** Modify `README.md` (tools table: seven rows, one line each, truthful — “no scheduler/reminder; caloric meal linkage arrives with the sports-snack slice”), `docs/food-tracking-agent-driven.md` (one section: regimen = declarative intent; intake facts append-only; visible states exactly undefined/done/missed with cleared→undefined; snapshots pin the bound label version; explicit-mutation-only boundary; no reports/flags/reminders yet).

1. **RED:** if desired, extend `requiredContractPhrases` in `src/food-tracking-docs.test.ts` with `"undefined"`-cycle phrasing and `"no scheduler"`; run docs test → FAIL.
2. **GREEN:** write the docs; PASS `bun test src/food-tracking-docs.test.ts`.
3. Commit: `docs: slice 5 — regimen/intake tool rows and boundary truth`

### Task 12 — Full acceptance ladder + format

```bash
bun run format          # then: git add -A
bun run test:unit       # expect: all pass, 0 fail
bun run test:db         # expect: all 12 suites pass, none run zero tests
bun run typecheck       # expect: clean
bun run format:check    # expect: clean
git diff --check        # expect: empty
```

Commit: `style: prettier format slice 5 sources` (if format changed anything).

---

## 7. Required adversarial acceptance gates (independent review checklist)

All through real PostgreSQL + real transport; helper-unit proof alone does not count:

1. **Chain/upgrade:** empty reset replays 001→010; populated 001→009 fixture survives 010 (twice).
2. **User scope:** u2 cannot list/resolve/status/log/mutate anything of u1's regimens/intakes; not-found responses are indistinguishable from nonexistence.
3. **Version truth:** regimen and intake bind a pinned version; label revision changes neither historical snapshots nor regimen binding; explicit historical version works; unknown version fails closed.
4. **State truth:** public vocabulary is exactly `undefined|done|missed` in every response; absent and cleared both project undefined; internal `cleared` visible only as audit `state_action`; nothing auto-marks a due occurrence.
5. **Idempotency:** replay converges (regimen + intake); changed identity conflicts with the shared stable `idempotency_conflict` code; no duplicate facts/snapshots/regimens.
6. **Concurrency:** `Promise.all` same-key races converge via the named unique indexes (010 + `uniq_supplement_intake_user_idem`), never two rows, never partial children.
7. **Rollback:** injected post-snapshot/pre-commit failure leaves zero operation-owned rows and pristine product/regimen state.
8. **Deleted/inactive:** deleted product (create/log/reactivate) and inactive regimen (log) fail closed with stable codes and zero writes.
9. **Payload hardening:** invalid UUID/date/schedule/weekdays, nonpositive/nonfinite servings, loose/24:00/out-of-range-offset/far-future timestamps, empty idempotency key, both-or-neither product selectors, dangling supersedes ref — all rejected before durable writes.
10. **NULL vs zero:** absent label nutrient ⇒ absent snapshot; explicit 0 ⇒ scaled 0 in snapshot and readback.
11. **Write boundary (B7):** every read tool (list/resolve/intakes/status) leaves all domain table counts unchanged, including on error paths; every write happens only inside its named mutation tool.
12. **Hard slice boundary:** sports and non-sports done intakes create zero meal roots/versions/items/results and zero intake-meal links; no code path in this slice imports `createMealEvent`.
13. **Regression:** alcohol suite, all pre-existing DB suites, and `test:unit` stay green; no shipped migration file differs (`git diff db/migrations/00*.sql` empty).

## 8. No-silent-narrowing check (explicit)

- B3 fully covered (create/read/list/active-state; no scheduler/auto-mark) — nothing narrowed.
- B4 fully covered (append-only, 3-state projection, cycle undefined→done→missed→undefined via cleared, audit who/when/why/supersession).
- B5 fully covered (direct ID, unique-alias confirm-then-log flow via read-only resolve + explicit mutation, ambiguity fails with candidates and zero writes).
- B7 covered as executable zero-write invariants for every read path.
- B10 rows relevant to this slice covered (user scope, version immutability, three states, ambiguous alias, malformed payloads, retry/concurrency/rollback, NULL-vs-zero, deleted/inactive, no meal event) — the caloric-linked-event retry/rollback rows of B10 are Slice 6 scope by the governing plan's slice cut, not dropped.
- B6 deferred to Slice 6 **by the brief's own hard boundary**, disclosed in tool description and docs (decision 1) — deferral, not narrowing.
- §5 tool family implemented completely (all seven names).
- §6 executable-acceptance list mapped 1:1 in §5 matrix; every gate is real-PG and/or real-transport.
- C2/C3 preserved via migration-010 upgrade fixture, full gate, and alcohol suite.
- Widening beyond the lock: none (no reports, no flags, no summary, no links, no extra tools).

## 9. Verification commands (exact, this repo)

```bash
cd /Users/fishhead/.workspace/projects/nutrition-mcp

# Environment safety — disposable DB ONLY (see §0):
export DATABASE_URL_TEST='postgres://localhost:5432/nutrition_mcp_test'
export DATABASE_URL="$DATABASE_URL_TEST"

# Narrow RED/GREEN loops
bun test src/supplement-types.test.ts
bun test src/food-tracking-docs.test.ts
bun test src/db.integration.test.ts --max-concurrency 1
bun test src/supplements.integration.test.ts --max-concurrency 1
bun test src/mcp-supplements.integration.test.ts --max-concurrency 1

# Regression focus
bun test src/alcohol.test.ts

# Full acceptance ladder
bun run test:unit
bun run test:db
bun run typecheck
bun run format:check
git diff --check
```

The DB gate resets `public` and replays 001–010 before each suite and refuses to run unless `DATABASE_URL === DATABASE_URL_TEST`. Both existing supplement suites are already gate-listed; a suite running zero tests fails the gate, so the new tests are automatically enforced. No `psql` dependency in tests — keep migration replay Bun/driver-based as the suites already do.

## 10. First dispatch

Task 1 (migration 010 + chain truth). It is the only schema decision, it produces an immediate honest RED via the docs tests, and every later task depends on the replayed chain including 010.
