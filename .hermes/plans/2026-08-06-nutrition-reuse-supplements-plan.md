# Nutrition Reuse + Supplements Release 1 — Implementation Plan

> **For Hermes / coder-kimi:** Execute one dependency-ordered TDD vertical slice at a time. **No production code before the named failing test is observed.** Do not add Telegram, OCR/STT/vision, provider calls/workers, MyFitnessPal sync, or cron/scheduler code.

**Governing brief:** `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md` (authoritative; do not narrow its ACs).

**Goal:** Add durable, user-scoped reuse of a confirmed historical meal calculation and a versioned supplement/sports-nutrition catalogue, regimen/intake history, caloric-snack linkage, and read boundaries for a later Hermes weekly report.

**Architecture:** Preserve the existing split: Hermes finds text/labels, clarifies aliases, and supplies explicit confirmation; `nutrition-mcp` validates MCP payloads, owns PostgreSQL truth, immutable versions/history, scoping, idempotency, transactions, and read models. Reuse copies server-read source evidence into a new event; caloric intake copies server-read label-version data into a linked snack event without calling any provider. New product/intake tables are additive after migrations `001`–`005`; existing meal event/projection paths and opt-in alcohol behavior remain intact.

**Tech stack / observed conventions:** Bun + TypeScript + `pg` + zod + MCP SDK + PostgreSQL. `src/mcp.ts` registers tools; `registerTools()` takes an injectable meal-event pool and the public integration harness uses `McpServer` + `Client` + `InMemoryTransport` (`src/mcp-food-tracking.test.ts:74-113`). DB suites reset `public` and replay migrations; `scripts/test-db-gate.ts` runs destructive suites serially with `DATABASE_URL === DATABASE_URL_TEST`.

---

## 1. Recon evidence and current constraints

| Live artifact                                                                                                               | Observed fact                                                                                                                                                                                                        | Planning consequence                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `db/migrations/002_food_tracking.sql:55-232`                                                                                | `meal_events` has root `user_id`, active/deleted state, current version, unique `(user_id,idempotency_key)`; version children are immutable; provider/canonical rows are versioned.                                  | Reuse and sports snack must make a fresh root and child rows, never mutate source rows. Root user key provides the idempotency/concurrency anchor.                                                                                               |
| `src/meal-events.ts:725-923,929-1059`                                                                                       | `createMealEvent` is transactional and uses `INSERT … ON CONFLICT`; corrections lock root and append a version. `getMealEventProvenance` filters active owner/current-or-requested historical version (`1241-1267`). | Implement server-side reuse eligibility and source snapshot reads beside this repository layer, using explicit locks and its transaction seam rather than a check-then-insert handler.                                                           |
| `src/meal-events.ts:203-275,281-342`                                                                                        | “ready” requires exactly three complete provider results and canonical audit evidence; missing/unavailable remains explicit and never becomes zero.                                                                  | A3 source eligibility must demand `ready`, complete, non-compatibility provenance. B6 label-derived snacks must disclose their label provenance and may be pending/non-provider-ready; do not lie that a label was a three-provider calculation. |
| `src/calculation-bundles.ts:327-466`                                                                                        | Bundle commit locks a version, scopes optional user ID, detects fingerprint conflicts, rolls back atomically, and replaces legacy compatibility placeholders.                                                        | Reuse must not call bundle tools/providers. It should persist copied provider/canonical evidence in its own one-transaction service; B6 should use stored label data only.                                                                       |
| `src/meal-event-projection.ts:72-184` and `src/search.ts`                                                                   | Search is case-insensitive `ILIKE` over current event items/notes, user scoped and active only. It returns newest-first matches, then TypeScript exact-normalized grouping by count/recency/median.                  | Evolve search to a read model designed for reuse: 90-day occurrence frequency plus two most recent viable event/version candidates and provenance/source IDs; do not claim vector/semantic matching.                                             |
| `src/mcp.ts:2355-2435`                                                                                                      | `search_meals` currently has text-only content, 365-day default and no `outputSchema`/structured result.                                                                                                             | Retain backwards-compatible `search_meals` text behavior where practical, but add machine-readable reuse candidates and a fixed 90-day recurring ranking contract; no search becomes a write.                                                    |
| `src/mcp.ts:4982-5053`                                                                                                      | Public provenance reads are UUID-validated, user-scoped, default current with explicit historical version, and emit typed structured content.                                                                        | Mirror this input/output/schema/error style for reuse, products, regimens, intakes, flags and report aggregate tools.                                                                                                                            |
| `src/mcp-food-tracking.test.ts`, `src/calculation-bundles.integration.test.ts`, `src/legacy-meal-tools.integration.test.ts` | Existing real-PG and real-InMemoryTransport gates cover migrations, rollback, user scope, idempotency, provenance round-trip and bundle concurrency.                                                                 | New release tests must be DB-gated and added to `scripts/test-db-gate.ts`; unit-only schema/listTools tests do not satisfy A5/B10.                                                                                                               |
| `src/db.ts:32`, `src/mcp.ts:5609-5615`, docs                                                                                | Production endpoint configures `SINGLE_USER_ID`; integration tests inject `u1`/`u2`.                                                                                                                                 | Treat cross-user tests as a storage/API invariant, while documenting current runtime as single-user/no-auth rather than claiming multitenant authorization.                                                                                      |
| `README.md`, `docs/food-tracking-agent-driven.md`, `src/food-tracking-docs.test.ts`                                         | Public docs accurately state host/backend boundary, migrations 001–005, null-vs-zero, and no provider worker.                                                                                                        | Update only for shipped tools/migrations; extend phrase tests and tool inventory. Preserve alcohol tracking statements/tests.                                                                                                                    |

## 2. Contradictions/gaps and proposed defaults (decisions for implementation)

1. **Current search is not adequate for A2.** It groups after a capped newest-first query and has no event/version/provenance output. **Default:** keep lexical, case-insensitive relaxed component/description matching (token AND within an alternative, alternatives OR), explicitly call it lexical—not semantic/vector—and create a DB query/read DTO which ranks qualifying variation frequency over the last 90 days before limiting candidates.
2. **“Recurring variation” conflicts with source-specific reuse.** A group has many versions/events but A3 requires a precise prior event/version. **Default:** a search result has one variation summary plus exactly up to two recent _viable source candidates_, each carrying `source_event_id`, `source_version`, consumed time, original ordered components, canonical, current/historical marker, and provenance availability. `reuse_meal_calculation` accepts only that precise pair—not a group key or caller-provided macros.
3. **Source evidence copying vs lineage clarity.** Provider row uniqueness is keyed by `event_id`, version, scope, provider, and request fingerprint (`002:171-198`), so a new target event can retain the exact source `source_id`, request fingerprint, raw payload, provenance, status, and nutrient values without collision. **Default:** copy those persisted values byte-for-byte at the data level and add explicit reuse lineage tables recording source event/version/result IDs plus the source bundle fingerprint; never overwrite source data, synthesize values, or call external providers. The new occurrence and its copied evidence remain independently readable while the immutable source relationship is auditable.
4. **A3 “complete/ready” is stricter than most legacy writes.** `log_meal`/`update_meal` compatibility rows are deliberately incomplete. **Default:** reuse eligibility is exactly active source + requested version exists + source belongs to caller + `deriveAggregateProvenance(...).provenance_status === "ready"` + current/historical request policy + canonical event scope ready/non-insufficient + three complete succeeded non-compatibility providers. Return stable code `meal_reuse_source_ineligible` with a safe reason category, never zero totals.
5. **Product nutrients are broader than the seven meal canonical fields.** `NUTRIENT_FIELDS` is intentionally fixed (`src/meal-types.ts:81-104`). **Default:** store every label-supplied nutrient as a generic immutable `nutrient_key`, display name, numeric amount and explicit unit. Known food-compatible keys (`calories`, `protein_g`, `carbs_g`, `fat_g`, `fiber_g`, `sugar_g`, `alcohol_g`) are mapped only for snack-event materialization and combined report totals; unfamiliar keys remain present in supplement-only aggregates and are never coerced to zero/conversion guesses.
6. **B6 exact label nutrition vs existing three-provider readiness model.** A verified label is not a provider consensus bundle and migration `002` restricts providers to three names. **Default:** for caloric sports intake, create a snack `meal_event` through the existing transactional create path using a server-generated `own` result whose `source_id`/provenance explicitly identifies the product-version label snapshot, with canonical values derived from stored compatible nutrients and `calculation_bundle_fingerprint = NULL`. It is transparent `pending`/label-derived evidence, not `ready`, not a provider run, and it must retain all generic label nutrients in the intake snapshot tables. This requires no provider enum migration and avoids a false three-provider claim.
7. **“Current state supports exactly undefined/done/missed” needs a clear action.** An append-only table cannot erase a row. **Default:** append actions `done`, `missed`, `cleared`; project `cleared` as user-visible `undefined`. The public API only emits `undefined | done | missed`, with history retaining action, actor, timestamp, reason, and supersession link. A missing row also projects `undefined`.
8. **Active regimen schedule without a scheduler.** **Default:** store a validated declarative schedule (`timezone`, `frequency: daily|weekly`, local time, weekday list for weekly) and derive requested-window occurrences in SQL/TypeScript read code; do not materialize jobs, poll, send reminders, or automatically write intake states. “Unmarked” is a derived past-due occurrence with current state `undefined`.
9. **Alias lookup may be ambiguous.** **Default:** normalized case-insensitive alias matching is user scoped. A direct UUID product ID is authoritative; an alias with zero matches returns not-found, one match returns a read-only resolution candidate, and >1 returns `supplement_alias_ambiguous` with candidates and does no intake write. `log_supplement_intake` requires a direct ID or a unique resolved alias plus an explicit authorized mutation call.
10. **Current production is configured single-user but ACs require user scoping.** **Default:** all new tables/query predicates include `user_id`; every repository method takes it; `registerTools` uses configured user as now. Tests inject two IDs and prove no read/write leakage, while docs retain the honest no-auth/single-user statement.
11. **No current date-parameter conventions for supplement reports.** **Default:** expose an explicit bounded inclusive date-range read tool with IANA timezone handling following existing range tools, returning `{food, supplement, total}` nutrient series and presence/count metadata. It is an efficient Release-2 query boundary, not a weekly report or cron.

**Blocker status:** no architectural blocker after these defaults. Product category vocabulary and label-source shape should be settled in the first RED tests; use `supplement | sports_nutrition` and JSONB evidence unless the owner directs a narrower taxonomy.

---

## 3. Scope boundary

### In scope

- A1–A5 reusable historical meal search + explicit-confirmation reuse mutation.
- B1–B10 user-scoped immutable products/label revisions, aliases, regimens, append-only intake state, caloric snack linkage, reporting boundary, and data-only flags.
- Additive migration(s), clean DB reset support, public MCP schemas/structured output, PostgreSQL and transport tests, truthful docs/inventory/tests.

### Explicitly out of scope

- Telegram ingestion, webhooks, OCR/STT/vision, image hosting/processing, parsing labels from images, external provider calls/workers, MyFitnessPal synchronization, scheduling/reminders/cron, automatic supplement intake marking, weekly-report delivery/UI polish, medical advice/interaction/diagnosis/contraindication/dosage recommendation, semantic/vector search, and changes to alcohol tracking behavior.

---

## 4. Target data model and migration strategy

### Migration `db/migrations/006_meal_reuse_and_supplements.sql`

Make one forward-only **additive and idempotent** migration after `005`. Use `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`, and named/index existence guards matching migrations `003`–`005`. Do not alter/drop existing meal/capture/profile/alcohol objects. `scripts/test-db-gate.ts` and all test-local migration arrays must replay `001` through `006` from an empty `public` schema.

#### Reuse lineage

- `meal_event_reuse_sources`: one row per new reused event/version: `event_id`, `version`, `user_id`, `source_event_id`, `source_version`, `source_canonical_result_id` nullable only if schema lacks selected ID in DTO, `source_bundle_fingerprint`, `copied_at`, `reuse_idempotency_key`, `confirmation_received`, `created_by`; FK both event/version pairs with `ON DELETE RESTRICT`; unique `(event_id, version)` and `(user_id, reuse_idempotency_key)`.
- `meal_event_reuse_provider_sources`: maps each target provider result row to its source provider result UUID and source request fingerprint. This keeps copied evidence auditable even if target request fingerprint is occurrence-specific.
- Index source pair and user/idempotency lookups. Do not add nullable “reuse” flags to arbitrary legacy data.

#### Product catalogue (root/version/label facts)

- `supplement_products`: UUID root, `user_id`, `category CHECK ('supplement','sports_nutrition')`, `status CHECK ('active','deleted')`, `current_version`, immutable creation metadata/timestamps/deletion timestamp. Unique product root ID; indexes `(user_id,status)`, case-insensitive current-name lookup support.
- `supplement_product_versions`: composite `(product_id, version)`, `user_id` duplicated for scoping, `revision_idempotency_key`, `display_name`, nullable `short_name`, `brand`, `form`, `serving_amount`, `serving_unit`, `serving_description`, `label_evidence jsonb NOT NULL`, `label_source_kind`, `created_by`, `created_at`, `prior_version`; unique `(product_id, revision_idempotency_key)` where non-null; FK to prior version deferrable if necessary. A revision inserts a new version and moves root pointer inside one transaction; no UPDATE of historical facts.
- `supplement_product_aliases`: UUID, `product_id`, `version`, `user_id`, raw alias, normalized alias; preserve aliases with the label version. Index `(user_id, normalized_alias)` **non-unique** so ambiguity is representable. Reject empty aliases and duplicate identical aliases within one product-version at runtime/unique constraint as appropriate.
- `supplement_product_nutrients`: UUID, `product_id`, `version`, `nutrient_key`, `display_name`, `amount numeric NOT NULL`, `unit text NOT NULL`, `source_evidence jsonb NOT NULL`; unique `(product_id, version, nutrient_key, unit)`. Omit unknown values rather than storing a synthetic zero/NULL row. A supplied numeric zero is persisted as `0`.
- `supplement_product_label_limits`: optional immutable product-version nutrient/key/unit + `maximum_amount` for transparent label-defined-limit flags only; no advice semantics.

#### Regimens, intakes, snack linkage

- `supplement_regimens`: UUID, `user_id`, `product_id`, `product_version`, `dose_servings numeric > 0`, validated `schedule jsonb`, `timezone`, `starts_on`, nullable `ends_on`, `active`, created/updated/deactivated metadata. FK product/version. A regimen always binds a historical version, so later labels do not rewrite intent/facts.
- `supplement_intake_events`: UUID append-only state fact: `user_id`, product/version, optional regimen, `servings > 0`, `occurred_at`, `state_action CHECK ('done','missed','cleared')`, `reason`, `actor`, `source_intake_id`/`supersedes_intake_id` nullable, `idempotency_key`, `created_at`. Unique `(user_id,idempotency_key)`; no update/delete API. The projection maps latest fact for the occurrence identity to exactly `undefined|done|missed`.
- `supplement_intake_nutrient_snapshots`: one immutable snapshot row for each supplied product-version nutrient scaled by servings, preserving product version/key/unit/original amount/scaled amount. This is the source for B8 aggregates and proves a later label revision cannot change historical intake.
- `supplement_intake_meal_links`: one-to-one intake ↔ snack event/version bridge with `user_id`, source product/version and idempotency fingerprint; unique `intake_id`, unique target event/version. Both directions become queryable; use `ON DELETE RESTRICT`.

### Transactional rules

- All create/revise/regimen/intake/reuse operations use `withTransaction(pool, ...)` and locks of the authoritative root/selected version before child insertion.
- Idempotency keys bind user + operation + immutable identity/content. Same identity returns existing readback; same key with a differing source/product/version/servings/time/action/fingerprint returns a stable conflict and makes no rows.
- Add test-only `beforeCommit` hook options only where existing bundle tests use them, so rollback can be injected after all child/link rows exist and before commit.
- Lock rows/unique indexes—not handler pre-checks—to make concurrent retry attempts converge. Re-read winner on unique violation where PostgreSQL visibility/race requires it.

---

## 5. MCP surface (names and contracts to implement)

Use `z` schemas in `src/mcp.ts`, `outputSchema` + `structuredContent` on every new public tool, truthful `annotations`, `withAnalytics`, and UUID/finite-positive/timestamp bounds consistent with current registrations.

| Tool                                                                                     | Write/read contract                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Evolved `search_meals`                                                                   | Read-only lexical relaxed component/description match, user scoped; returns variation frequency in 90 days and up to two viable provenance-ready alternatives. Preserve human text but add typed structured result.                                                                    |
| `reuse_meal_calculation`                                                                 | Mutation; requires `source_event_id`, `source_version`, new `reported_at`/`consumed_at`, non-empty idempotency key, and explicit confirmation enum/string accepted by server policy. Server copies only persisted source evidence/canonical data; no totals/provider payload accepted. |
| `create_supplement_product`                                                              | Explicit mutation with verified label evidence, category, serving, names/aliases, supplied nutrient list and optional label limits; returns product/version readback.                                                                                                                  |
| `list_supplement_products`, `get_supplement_product`, `search_supplement_products`       | Read-only current product listing/detail/search by name/alias, user scoped, deleted excluded by default.                                                                                                                                                                               |
| `revise_supplement_product_label`                                                        | Explicit mutation; inserts a new immutable version/revision only; returns root/current and historical version identifiers.                                                                                                                                                             |
| `create_supplement_regimen`, `list_supplement_regimens`, `set_supplement_regimen_active` | Explicit add/change of regimen state; never schedules or writes intake.                                                                                                                                                                                                                |
| `resolve_supplement_product`                                                             | Read-only explicit alias/product-ID resolution; returns candidates/ambiguous state and never writes.                                                                                                                                                                                   |
| `log_supplement_intake`                                                                  | Explicit authorized mutation: direct product ID/version or unique alias resolution, servings/time, state `done                                                                                                                                                                         | missed | cleared`, idempotency. `done` for sports nutrition atomically creates/links snack event; non-caloric does not. |
| `get_supplement_intakes`, `get_supplement_regimen_status`                                | Read-only facts/history/current state and derived unmarked occurrences; emits only visible states `undefined                                                                                                                                                                           | done   | missed`.                                                                                                       |
| `get_supplement_nutrition_summary`                                                       | Read-only bounded date range: separate food, supplement/sports contribution, and compatible total by nutrient key/unit plus coverage/counts. No report delivery.                                                                                                                       |
| `get_supplement_data_flags`                                                              | Read-only transparent flags: duplicate active exposure, explicit label-limit sum, unmarked active-regimen occurrence. Text/schema must deny medical advice.                                                                                                                            |

Stable errors should be typed/domain errors mapped by handlers to predictable messages/codes: `meal_reuse_source_not_found`, `meal_reuse_source_ineligible`, `meal_reuse_source_version_not_current_or_historical`, `supplement_product_not_found`, `supplement_product_inactive`, `supplement_alias_ambiguous`, `supplement_regimen_inactive`, `idempotency_conflict`, and validation issues. Do not expose another user’s existence; cross-user/deleted reads should resolve as not found.

---

## 6. AC-to-artifact-and-executable-proof matrix

| AC  | Implementation artifacts                                                                                   | Executable proof (must run against real PostgreSQL/public MCP transport where stated)                                                                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `src/meal-reuse.ts`, `src/meal-event-projection.ts`, `src/search.ts`, `src/mcp.ts`; migration 006 indexes  | Unit lexical token/case/escape tests; `src/meal-reuse.integration.test.ts` proves active/current user scope and component/description matching; `src/mcp-reuse.integration.test.ts` calls `search_meals` through `InMemoryTransport`.                           |
| A2  | Reuse search DTO/schema/output and 90-day ranking query                                                    | Seed variations inside/outside 90d; assert frequency desc, recency tie break, exactly two viable alternatives, components/consumed time/canonical/status/source event/version/provenance fields, and no semantic-search claim.                                  |
| A3  | lineage tables + `reuseMealCalculation()` + `reuse_meal_calculation` registration                          | Public tool test proves explicit confirmation required; fresh event/version/new timestamps; no provider bridge invoked; copied provider/canonical facts and source link re-read exactly; retry returns same root.                                               |
| A4  | eligibility helper/domain errors/owner-active-version locked lookup                                        | PG + transport cases: absent, cross-user, deleted, nonexistent version, ineligible compatibility/pending/unavailable/malformed source, stale/current policy error; all assert stable actionable code and zero target writes/no zero fabrication.                |
| A5  | DB-gated reuse tests + DB gate script                                                                      | `src/meal-reuse.integration.test.ts` and `src/mcp-reuse.integration.test.ts`: exact persistence/current+historical selection/user scope/idempotency/two concurrent calls/after-child injected rollback/deleted/malformed source/re-read provenance.             |
| B1  | migration 006 product/version/alias/nutrient/limit tables; `src/supplement-types.ts`, `src/supplements.ts` | PG readback asserts user scope/category/names/aliases/brand/form/serving/evidence; generic supplied nutrients and units persist; omitted unknown absent and explicit numeric 0 preserved.                                                                       |
| B2  | product repositories, zod MCP schemas and product tool registrations                                       | Unit malformed validator tests; transport `create/get/list/search/revise` tests; PG proves revision inserts version N+1 and historical row/nutrients unchanged.                                                                                                 |
| B3  | regimen table/types/repository/tools                                                                       | PG + MCP prove product/version/dose/schedule/start/end/active state persist; no occurrence/intake/event is created by regimen creation/read.                                                                                                                    |
| B4  | append-only intake table/state projection                                                                  | Unit state reducer transition tests and PG history tests prove absent/cleared → `undefined`, done, missed, cleared → undefined; facts never mutate and actor/time/reason/supersession remain readable.                                                          |
| B5  | alias normalization/resolution/log service/tool                                                            | Transport test direct ID success; unique alias returns confirmation candidate then explicit log; ambiguous aliases return candidates/error with zero intake/event writes; invalid/malformed payload rejected.                                                   |
| B6  | intake snapshot/link tables; transactional `logSupplementIntake` and meal-event bridge                     | Real PG + MCP: sports `done` creates one snack event/link with exact stored version scaled nutrients/provenance, no provider callable; retries/concurrency converge; injected failure rolls back intake/snapshots/event/link; ordinary supplement has no event. |
| B7  | mutation tool schemas/handlers; read-only annotations/tests                                                | `list/search/resolve/status/flags/summary` calls assert no counts change; product/regimen/intake/event only arise from explicit mutation and confirmation-required paths.                                                                                       |
| B8  | aggregate query/service/tool                                                                               | Seed food + product nutrients and assert separate food/supplement/total values, compatible unit grouping, dates/user scope, counts/presence, NULL/absent vs explicit zero; no cron/report message.                                                              |
| B9  | data-flag query/service/tool                                                                               | Deterministic data-only flag tests for active duplicate nutrient exposure, label-defined limit sums only, and derived unmarked occurrence; assert text never gives medical/dose advice.                                                                         |
| B10 | all supplement PG and transport suites; migration arrays/gate                                              | Run migration chain fresh; cross-user/version/revision/state/alias/malformed/retry/concurrency/rollback/NULL-zero/noncaloric/deleted/inactive regimen/product cases through listed suites.                                                                      |
| C1  | `README.md`, `docs/food-tracking-agent-driven.md`, `src/food-tracking-docs.test.ts`, tool inventory        | Docs tests/name inventory check shipped tools and explicit absences: no weekly report/OCR/provider recalculation/medical analysis/reminders.                                                                                                                    |
| C2  | `006` additive migration and every migration array in tests/scripts                                        | Fresh reset replays 001–006; upgrade fixture applies 001–005, seeds existing event/profile/alcohol data, applies 006, asserts existing food paths survive; `bun run test:db`.                                                                                   |
| C3  | no alcohol implementation changes; existing alcohol docs/tests untouched                                   | `bun test src/alcohol.test.ts` plus `bun run test:unit` and DB gate; regression fixture retains `alcohol_tracking_enabled`/UK unit profile after 006.                                                                                                           |

---

## 7. Dependency-ordered bounded TDD vertical slices

Dispatch **one coder-kimi only after the prior slice is green and independently reviewed**. Each slice lists the intended red test, minimal green work, and its proof. Do not batch future slices into the current patch.

### Slice 1 — Additive schema and pure supplement/reuse contracts

**Files:**

- Create: `db/migrations/006_meal_reuse_and_supplements.sql`
- Create: `src/supplement-types.ts`, `src/supplement-types.test.ts`
- Modify: `src/meal-types.ts` only if shared non-product lineage types genuinely reduce duplication
- Modify: `src/db.integration.test.ts`, `src/food-tracking-docs.test.ts` migration expectations

**RED:** Write pure tests for product category, nutrient identity/NULL-vs-zero, schedule validation, state-action projection, alias normalization, and idempotency identity. Add a real-PG migration test that applies 001–005, seeds profile/alcohol + meal event, applies 006, and asserts old rows remain and new tables/constraints/indexes exist.

**GREEN:** Add 006 and pure validators/types only. Keep generic label nutrients separate from seven meal fields; no MCP registration yet.

**Proof:** Focused `bun test src/supplement-types.test.ts src/db.integration.test.ts`; inspect applied migration table schema from test with SQL assertions. This slice establishes C2/C3 substrate but does not claim any product tool.

### Slice 2 — Versioned product catalogue vertical path

**Files:**

- Create: `src/supplements.ts`, `src/supplements.integration.test.ts`
- Modify: `src/mcp.ts`
- Create: `src/mcp-supplements.integration.test.ts`
- Modify: `scripts/test-db-gate.ts`

**RED:** Repository PG tests for create/read/list/search and later label revision: owner scoping, aliases, generic nutrient evidence/units, explicit zero retained vs absent unknown, root current pointer and immutable old version. Transport tests first verify `client.listTools()` schemas then `create_supplement_product`, get/list/search calls and malformed payload failures.

**GREEN:** Implement locked transactional product creation/revision/repositories and MCP schemas/output DTOs. Reuse `withAnalytics`; duplicate the proven `withTools` InMemoryTransport harness rather than testing handlers directly.

**Proof:** real-PG product rows + public tool structured readback; revision and cross-user tests. Add the new suite to DB gate only when it resets 001–006 itself.

### Slice 3 — Reuse discovery read vertical path

**Files:**

- Create: `src/meal-reuse.ts`, `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts`
- Modify: `src/meal-event-projection.ts`, `src/search.ts`, `src/search.test.ts`, `src/mcp.ts`, `scripts/test-db-gate.ts`

**RED:** Seed multiple current/historical event versions across `u1/u2`, active/deleted, ready/pending/unavailable sources and 90-day boundary dates. Assert lexical case-insensitive component/description matching; variation rank frequency over exactly last 90 days; two viable alternatives only; output source/version/ordered items/consumed timestamp/canonical/status/provenance. Assert existing search formatting stays compatible where retained.

**GREEN:** Implement an explicitly lexical reuse candidate query/DTO, include user/status/version criteria, and add structured output to evolved `search_meals` without making it a mutation. Do not build embeddings or semantic search.

**Proof:** direct PG query semantics and real MCP client tool-list/call/read-only count assertions.

### Slice 4 — Confirmed meal-reuse mutation vertical path

**Files:**

- Modify: `src/meal-reuse.ts`, `src/meal-events.ts` only for a narrow transaction/readback seam if necessary, `src/mcp.ts`
- Modify: `db/migrations/006_meal_reuse_and_supplements.sql` only if Slice 1 omitted lineage tables (prefer not to churn; otherwise add migration 007 rather than edit shipped 006)
- Modify: `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts`

**RED:** Real MCP test calls `reuse_meal_calculation` with a precise ready source and explicit confirmation. Assert a fresh root/event version with new supplied timestamps, exact copied source facts/canonical, lineage and copied provider mappings, then `get_calculation_provenance` re-read. Add absent/cross-user/deleted/invalid/missing historical/source-not-ready/current-vs-requested-version tests. Add same-key retry, conflicting-key payload, `Promise.all` concurrent same-key calls, and injected post-child/pre-commit rollback.

**GREEN:** Lock source event/version and enforce all eligibility in one transaction; server-read and copy source evidence; create target with a distinct occurrence idempotency fingerprint; write lineage. Do not take nutrient totals/provider results from MCP args and do not call providers.

**Proof:** exact target table counts = one under retry/concurrency; zero after rollback/error; public transport errors stable/actionable and no fabricated values.

### Slice 5 — Regimens and append-only intake state vertical path

**Files:**

- Modify: `src/supplement-types.ts`, `src/supplements.ts`, `src/supplements.integration.test.ts`, `src/mcp.ts`, `src/mcp-supplements.integration.test.ts`

**RED:** Product-version-bound regimen tests; schedule validation tests; intake history reducer tests for absent/done/missed/cleared and supersession audit. Transport tests show direct ID, unique alias resolution, ambiguity candidates/no write, active/inactive/deleted checks, and read-only resolution never writes.

**GREEN:** Add locked regimen/intake services, append-only state facts/snapshots, and tool schemas. Derive `undefined` rather than persisting it as a completed/missed event. A regimen read may derive occurrence status, but no scheduler or automatic mark is allowed.

**Proof:** DB rows are immutable/history readable; public result uses only `undefined|done|missed`; duplicate retry/concurrent append uses unique idempotency and does not duplicate facts.

### Slice 6 — Atomic caloric sports intake → snack-event link

**Files:**

- Modify: `src/supplements.ts`, `src/supplements.integration.test.ts`, `src/mcp-supplements.integration.test.ts`, perhaps `src/meal-events.ts` only to use its existing `transactionClient` seam

**RED:** Seed version 1 caloric sports label with values, then revise label version 2. Confirm a v1 `done` intake creates one snack event and one bidirectional link; query every snapshotted value and event canonical/provider provenance to prove v1 values were used, including numeric 0. Add ordinary `supplement` done (no event), missed/cleared sports (no snack event unless product contract explicitly says only done), retry/concurrency, deleted product/inactive regimen, and a `beforeCommit` injected failure after event/link inserts.

**GREEN:** Inside the one transaction, append intake/snapshots then call `createMealEvent(pool, command, client)` with server-derived label data and link it. Use `meal_type: 'snack'`, no external authorization/sync, and label-specific provenance. No external provider/bundle call and no caller macro payload.

**Proof:** all-or-nothing counts across intake/snapshot/event/version/provider/canonical/link tables; public transport test re-reads the snack via provenance and confirms exactly stored label version; non-caloric test proves zero meal roots.

### Slice 7 — Release-2 reporting boundary and non-medical flags

**Files:**

- Modify: `src/supplements.ts`, `src/supplement-types.ts`, `src/supplements.integration.test.ts`, `src/mcp.ts`, `src/mcp-supplements.integration.test.ts`

**RED:** Seed food events and supplement intakes with compatible/incompatible units, absent nutrient versus numeric zero, duplicate active products, an explicit product label limit, and due/unmarked regimen dates. Assert per-user, bounded date-range output separates food/supplement/total; only compatible code+unit total; coverage/counts accurately disclose absence. Assert flags are facts, not advice, and reads make no writes.

**GREEN:** Implement efficient grouped SQL/read DTOs and tool output schemas. Compute schedule occurrences only for requested range/timezone. Return neutral data strings such as “duplicate recorded nutrient exposure,” never health/dose conclusions.

**Proof:** direct PG aggregation tests + InMemoryTransport calls plus no-mutation row-count assertions.

### Slice 8 — Docs/tool-inventory truth pass and full acceptance

**Files:**

- Modify: `README.md`, `docs/food-tracking-agent-driven.md`, `src/food-tracking-docs.test.ts`, `scripts/test-db-gate.ts`
- Modify: `.hermes/plans/INDEX.md` only if this plan is committed and the repository’s plan-index coverage policy requires its family row; do not represent planned tools as implemented.

**RED:** Update docs test required/forbidden phrases and tool inventory assertions before prose. Add migration `006` chain check. Add an alcohol regression assertion only if required by the changed test harness—not product behavior.

**GREEN:** Document exact shipped tools, confirmed reuse rule, label-derived snack provenance, state meanings, report-query boundary, and strict out-of-scope limits. Do not promise weekly reports/OCR/external recalculation/medical analysis/automatic reminders.

**Proof:** docs tests + complete unit/DB/format/typecheck ladder; inspect `git diff --check` and ensure only intended docs/plan index changes.

---

## 8. Required adversarial acceptance gates

Before Release 1 is accepted, an independent reviewer must see all of these **through real PostgreSQL and public MCP client/transport**, not only helper-unit tests:

1. Migration chain/upgrade: empty reset runs 001→006; already-populated 001→005 food/profile/alcohol data remains usable after 006.
2. User scope: `u2` cannot discover/reuse/read/revise/log/flag/report `u1` source/product/regimen/intake; responses do not leak that it exists.
3. Version truth: reuse selected historical version only when valid/eligible; label revision does not mutate old label/intake/snack facts; product current pointer and event current pointer correct.
4. Reuse provenance: exact source event/version and provider/canonical mapping survive target re-read; source is unchanged; no source-ready evidence means no target and no zero nutrients.
5. Idempotency: duplicate same mutation returns the original identity/readback; same key + changed semantic identity conflicts; no duplicate child/link/event rows.
6. Concurrency: use separate pool clients and `Promise.all` same-key attempts for reuse and caloric intake; exactly one root/fact/link wins and both calls converge or one gets the declared conflict—never partial/double rows.
7. Rollback: inject failure after deepest child event/link/snapshot work and before commit; assert all operation-owned rows absent and existing source/product facts intact.
8. Deleted/inactive rules: deleted meal source/product and inactive/ended regimen fail closed; search/list exclusions and direct attempts are tested.
9. Payload hardening: invalid UUID/date/schedule, negative/nonfinite servings/nutrients, duplicate aliases, unknown enum, unsupported label object, missing required evidence, malformed result objects, and extra untrusted canonical totals are rejected before durable writes.
10. Null/zero: unknown nutrient remains absent/null in label/intake/report output; actual zero persists/scales/aggregates as zero.
11. Authorization boundary: search/resolve/list/status/flags/summary cause no rows; every write requires its mutation call, and reuse requires explicit confirmation; no provider/worker/network action occurs.
12. Alcohol regression: existing `set_alcohol_tracking` UK-unit state continues to read/store/display per existing tests; new aggregates do not silently turn alcohol off/on.

---

## 9. Verification commands (real repository conventions)

Run from `/Users/fishhead/.workspace/projects/nutrition-mcp`. The DB gate is destructive and refuses mismatched URLs; use a disposable real PostgreSQL database, never a redacted README placeholder.

```bash
# Narrow unit RED/GREEN loops
bun test src/supplement-types.test.ts
bun test src/search.test.ts
bun test src/food-tracking-docs.test.ts

# Focused real-PostgreSQL + public MCP transport tests.
# DATABASE_URL_TEST must already be a real disposable DB URL.
export DATABASE_URL_TEST="${DATABASE_URL_TEST:?set a disposable PostgreSQL DATABASE_URL_TEST first}"
export DATABASE_URL="$DATABASE_URL_TEST"
bun test src/supplements.integration.test.ts --max-concurrency 1
bun test src/mcp-supplements.integration.test.ts --max-concurrency 1
bun test src/meal-reuse.integration.test.ts --max-concurrency 1
bun test src/mcp-reuse.integration.test.ts --max-concurrency 1

# Repository gates. test:db resets public schema before each listed suite and
# enforces DATABASE_URL === DATABASE_URL_TEST.
bun run test:unit
bun run test:db
bun run typecheck
bun run format:check
git diff --check
```

For migration-only diagnosis, keep it Bun/driver based as current gate does—do not add a host `psql` dependency to tests. Run `bun test src/alcohol.test.ts` during focused regression loops and `bun run test:unit` before considering alcohol behavior preserved.

---

## 10. Documentation truth checklist

Update only after a tool/migration is implemented and tested:

- `README.md`: tools table, storage/migration order (`006`), self-hosting chain, a concise reuse/supplement capability statement, and explicit no-report/no-reminder/no-medical/no-provider-recalculation boundaries.
- `docs/food-tracking-agent-driven.md`: preserve Hermes/backend ownership, document explicit confirmation, copied-source vs label-derived evidence status, immutable product/intake revision rules, and report-query/no-cron limit.
- `src/food-tracking-docs.test.ts`: pin new migration/tool/boundary truth and forbid stale promises.
- `CLAUDE.md`: update only if commands, test gate structure, or MCP runtime conventions actually changed; do not add speculative Release 2 instructions.
- `.hermes/plans/INDEX.md`: only on a committed plan-family lifecycle update according to its coverage audit; this planning-only artifact must not mark implementation complete.

## 11. Recommended first coder slice

**Slice 1: additive migration + pure contracts.** It resolves the only foundational choices (generic label nutrient facts, append-only projected intake state, schedule representation, table constraints) while proving upgrade/reset safety and preserving the existing food/alcohol paths. It is intentionally not a broad catalogue implementation; once green, Slice 2 can deliver the first public vertical product capability without schema churn.
