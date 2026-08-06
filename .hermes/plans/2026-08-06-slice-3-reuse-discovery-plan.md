# Slice 3 — Reusable-Meal Discovery (read-only) Implementation Plan

> **For Hermes / coder-kimi:** Execute tasks in order, one RED → GREEN cycle at a time. **No production code before the named failing test has been observed failing.** This slice is strictly read-only: do NOT build, register, or partially implement `reuse_meal_calculation` — that is Slice 4.

**Governing authority (do not narrow):**

- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-brief.md` — A1, A2, A5, B7, C2, C3
- `.hermes/plans/2026-08-06-nutrition-reuse-supplements-plan.md` — Slice 3 (lines 179–190), AC matrix rows A1/A2
- `.hermes/plans/2026-08-06-slice-3-reuse-discovery-brief.md` — Slice 3 acceptance lock (this plan's direct contract)

**Goal:** Evolve the public read-only `search_meals` tool into a lexical reusable-meal discovery surface: 90-day frequency-ranked recurring variations, each exposing at most two most-recent viable source candidates with enough persisted truth (event/version/components/consumed time/canonical/provenance status) for Hermes to explain a future reuse choice — with typed `outputSchema` + `structuredContent`, preserved human-text behavior, and zero writes.

**Architecture:** Keep the existing split. The text portion of `search_meals` (variations + recent entries prose) stays behaviorally intact on the existing `searchMeals` → `searchMealProjections` path. A NEW read module `src/meal-reuse.ts` owns the structured reuse-discovery contract: an uncapped 90-day lexical match query (reusing the proven ILIKE predicate builders), TypeScript variation grouping/ranking that reuses `normalizeDescription`, and per-candidate aggregate reads through the existing user-scoped `getMealEventProvenance` so canonical/provenance truth is derived by the exact same policy every other public read uses. No new tables, no new migration, no index change.

**Tech stack / conventions observed live:** Bun + TypeScript + `pg` + zod + `@modelcontextprotocol/sdk`. `registerTools(server, userId, widgetsEnabled, alcohol, deps)` in `src/mcp.ts` (line 1835). Public integration harness = `McpServer` + `Client` + `InMemoryTransport` (`src/mcp-supplements.integration.test.ts:88-121` is the parameterized-user variant to clone). DB suites reset `public` and replay migrations `001`–`009`; `scripts/test-db-gate.ts` runs destructive suites serially and enforces `DATABASE_URL === DATABASE_URL_TEST`.

---

## 1. Recon evidence (live repo, HEAD `5ca7a9e85d3cb6a80b8e10918c8cd3eead8f372f`)

| Live artifact                                                 | Observed fact                                                                                                                                                                                                                                                                                                           | Consequence for this slice                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/mcp.ts:2465-2545`                                        | `search_meals` registration: text-only content, NO `outputSchema`/`structuredContent`, `days` default 365, `limit` default 50, `readOnlyHint: true`. Description already says "keyword"/"case-insensitive" — no semantic claim exists today.                                                                            | Evolve this registration in place. Once `outputSchema` is declared, **every** return path (including the empty-result path at 2517-2527) must return `structuredContent` or the SDK fails the call (known repo pitfall, `CLAUDE.md` bulk-import notes + comment at `src/mcp.ts:429`).               |
| `src/meal-event-projection.ts:149-185`                        | `searchMealProjections` builds the lexical predicate: per-alternative token AND over `i.raw_item_text / i.normalized_name / i.notes` ILIKE, alternatives OR'd, user-scoped, `status='active'`, current-version join, escaped via `escapeLikePattern`, **`ORDER BY consumed_at DESC ... LIMIT $n` (default 50)**.        | The newest-first LIMIT before grouping is exactly the ranking-invalidating cap the acceptance lock forbids. The structured path must count frequency over the FULL 90-day match set. Fix: allow `limit: null` (no LIMIT) and have `src/meal-reuse.ts` call it uncapped with `sinceIso = now − 90d`. |
| `src/search.ts:44-50, 76-105`                                 | `normalizeDescription` (module-private) is the variation grouping key: lowercase, trim, collapse whitespace, strip trailing `.,!`. `groupMealVariations` sorts count desc, recency tie-break.                                                                                                                           | Reuse the SAME normalization for reuse variation keys (export it) so the structured grouping and the legacy text grouping can never disagree on what a "variation" is.                                                                                                                              |
| `src/meal-events.ts:1241-1268`                                | `getMealEventProvenance(pool, userId, eventId, version?)` is the user-scoped aggregate read: active-only, defaults to current version, returns `provenance_status` (`ready                                                                                                                                              | pending                                                                                                                                                                                                                                                                                             | unavailable | missing`), `compatibility`, `is_current`, and the full aggregate (items, canonical, provider results). | Per-candidate detail reads go through this function. Candidate eligibility truth = whatever this derives from persisted state; nothing else is claimed. |
| `src/meal-events.ts:254-343`                                  | `deriveProvenanceStatus` / `deriveAggregateProvenance`: `ready` requires bundle fingerprint + exactly 3 complete succeeded non-compatibility providers (`nutrition-local`,`own`,`myfitnesspal`) + complete canonical; any failed/unavailable provider ⇒ `unavailable`; no fingerprint ⇒ `pending`; nothing ⇒ `missing`. | Test fixtures must seed each status through real writers (see §6 seeding recipes) — no hand-faked status column exists.                                                                                                                                                                             |
| `src/mcp.ts:5092-5150` + `src/calculation-bundles.ts:141-161` | `get_calculation_provenance` is the house style for typed read tools: zod `outputSchema` (`.shape`), `structuredContent` parsed through the schema, UUID-validated input, user scoped, explicit `is_current`.                                                                                                           | Mirror this style for the evolved `search_meals` output schema. `.nullable()` fields are emitted as required `anyOf[type,null]` — build output literals with explicit `null`s (`CLAUDE.md` pitfall, `src/import.test.ts` precedent).                                                                |
| `src/mcp.ts:2513`                                             | The `search_meals` handler calls `searchMeals(userId, …)` from `src/db.ts:390`, which uses the **global pool**, not the injected `mealEventsPool`. Tests work only because the DB gate forces `DATABASE_URL === DATABASE_URL_TEST`.                                                                                     | New structured reads must use `mealEventsPool` (like every event read tool). Standalone test runs must export BOTH env vars (see §5).                                                                                                                                                               |
| `scripts/test-db-gate.ts:23-52`                               | Suites array (10 entries, ends with the two supplement suites); migrations array replays `001`–`009`. `test-unit-gate.ts` deletes DB env so DB suites self-skip in unit mode; a DB-gate suite that runs zero tests fails the gate ("hidden skip").                                                                      | Add the two new suites to the gate `suites` array. New test files must use the `describeDb = DATABASE_URL_TEST ? describe : describe.skip` convention AND replay `001`–`009` themselves (clone `src/mcp-supplements.integration.test.ts:37-67`).                                                    |
| `db/migrations/007..009` + `git log`                          | Slice 2 remediation shipped migrations `007` (composite ownership/lineage FKs), `008` (create-idempotency unique index), `009` (reconciliation). README/docs/tests already enumerate through `009` (docs tests derive the chain from the directory listing).                                                            | The governing plan's "001–006" wording is stale. Every migration array in new tests = `001`–`009`. **No new migration is needed for this slice** (see decision D6).                                                                                                                                 |
| `src/mcp-supplements.integration.test.ts:88-121`              | `withSupplementTools(pool, userId, run)` harness: parameterized user, `listTools()` exposure, `flushAnalytics()` in `afterEach` so fire-and-forget analytics writes don't land on a dropped schema.                                                                                                                     | Clone this harness (rename) for `src/mcp-reuse.integration.test.ts`. Keep the `flushAnalytics` afterEach — analytics DOES write a `tool_analytics` row per call, which matters for read-only row-count assertions (see D8).                                                                         |
| `src/calculation-acceptance.fixtures.ts`                      | Test-only fixture module pattern: seeders, scoped bundle builders, table-count helpers, shared event IDs. `commitCalculationBundle` (`src/calculation-bundles.ts:327`) is the real writer that produces non-compatibility provider/canonical evidence and sets the version fingerprint.                                 | Build `src/meal-reuse.fixtures.ts` the same way: `createMealEvent`/`correctMealEvent`/`commitCalculationBundle` seed ready/pending/unavailable/deleted/historical candidates through REAL write paths, not raw status forgery.                                                                      |
| `README.md:53`, `src/food-tracking-docs.test.ts`              | README tools table row for `search_meals` says "Search past meals by keyword, grouped into recurring variations…" — lexical, truthful, no semantic claim. Docs tests pin migration chain + boundary phrases; none reference `search_meals` behavior.                                                                    | No docs-test change is forced by this slice. A one-line README tools-table refresh is included (Task 10) so C1 stays exactly true once structured reuse candidates ship; the full docs pass remains Slice 8.                                                                                        |
| `.env.example`, `README.md:162-215`                           | Repo-supported test-DB configuration: `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test` via `.env` (gitignored; Bun auto-loads `.env`) or shell export. Gate refuses unless `DATABASE_URL` equals it.                                                                                                    | §5 documents the exact, secret-free procedure. No DSN ever goes into source or this plan beyond the localhost example already published in the repo.                                                                                                                                                |

---

## 2. Contradictions / gaps and decided defaults

**D1 — Governing plan says migrations "001–006"; repo is at 009.** Slice 2 remediation (commits `826e409`, `529d8c4`) added `007`–`009` after the governing plan was written. **Resolution:** all new test migration arrays and prose use `001`–`009`. This is a factual refresh, not a narrowing. _(Declared as deviation V1.)_

**D2 — Fixed 90-day ranking vs. existing `days` default 365.** The acceptance lock demands frequency ranking "over exactly the last 90 days", but the shipped tool accepts `days` (default 365) and its text output depends on it. **Resolution — dual contract:** the human-text sections keep their current inputs and behavior byte-compatible (existing `days`/`limit` still shape the prose and recent-entry list); the NEW `structuredContent` reuse block is computed independently on a fixed 90-day window with no input cap before grouping and ignores `days`/`limit`. The tool description and the output schema (`window_days: 90` literal) state this explicitly. This preserves "existing compatible human text behavior where practical" without letting a caller-supplied window silently change the locked ranking contract.

**D3 — What is a "viable" source candidate?** Slice 4's reuse eligibility (ready + complete + non-compatibility) is stricter than anything discovery can promise without pre-building Slice 4 policy. The lock's own test list requires "ready/pending/unavailable candidates" to appear — so viability cannot mean ready-only. **Resolution:** viable = active event, owned by the requesting user, current-version aggregate readable. Candidates carry the truthfully derived `provenance_status` (`ready|pending|unavailable|missing`), `compatibility`, and `bundle_fingerprint` so Hermes can explain why a candidate is or is not a good reuse source. Discovery asserts NO `reuse_eligible` boolean and makes no eligibility promise beyond persisted state (lock item 3: "only expose eligibility truth actually supported by persisted state"). Deleted events never match (`status='active'` predicate), so they are structurally non-viable.

**D4 — Current vs. historical version in candidates.** A search result variation groups whole events; an event's visible components/canonical are its CURRENT version. **Resolution:** each candidate exposes `source_version` = the event's current version at read time, plus `current_version` and `is_current` (always true for search-produced candidates — the field exists so the candidate DTO is honest and future-proof, mirroring `get_calculation_provenance`). The current/historical distinction is proven by test: after a correction creates version 2, discovery must return version-2 components/canonical with `source_version = 2` and must NOT leak version-1 data; version-1 remains reachable only via `get_calculation_provenance(event, version=1)`. Slice 4 — not search — is where a caller pins a historical version.

**D5 — Variation key normalization must not fork.** `normalizeDescription` is module-private in `src/search.ts`. Re-implementing it in `meal-reuse.ts` risks the structured and text groupings disagreeing. **Resolution:** export `normalizeDescription` from `src/search.ts` and reuse it. _(Declared as deviation V2 — a modification the governing Slice 3 file list already anticipates for `src/search.ts`.)_

**D6 — Index/migration question.** The lock allows a minimal additive index only if proven required. The structured query's predicate is `ILIKE '%token%'`, which a btree index cannot serve (pg_trgm could, but that is an extension decision far beyond a single-user deployment's need; `idx_meal_events_consumed_at` already bounds the 90-day scan). **Resolution: no migration, no new index.** Declared here so the absence is a decision, not an omission.

**D7 — Uncapped 90-day query volume.** Removing the LIMIT before grouping is required by the lock. Bounded risk: the window is 90 days, user-scoped, active-only — for the real deployment (single configured user) this is at most a few hundred rows of already-aggregated projections. Variations exposed are capped at 10 (`MAX_REUSE_VARIATIONS`, matching the text path's `maxVariations` default), candidates at 2 per variation, so per-candidate aggregate reads are ≤ 20. No further cap is added because any input cap before grouping is exactly what the lock forbids.

**D8 — "No writes" vs. analytics.** `withAnalytics` fire-and-forgets a row into `tool_analytics` on every tool call through the GLOBAL pool. **Resolution:** read-only row-count assertions cover the meal/reuse/supplement domain tables (`meal_events`, `meal_event_versions`, `meal_event_items`, `meal_event_nutrition_results`, `meal_event_canonical_results`, `meal_event_reuse_sources`, `meal_event_reuse_provider_sources`, `supplement_*`) — NOT `tool_analytics`, which is telemetry, not domain state. Tests `flushAnalytics()` in `afterEach` (supplements-suite convention). The lock's "no writes, no provider calls, no workers, no reuse mutation" is proven against domain tables plus the absence of any provider bridge/network seam in the new module (it imports only `pg` reads).

**D9 — Local env has no `DATABASE_URL_TEST`/`DATABASE_URL` exported.** Resolution in §5: the repo-supported path is a disposable local PostgreSQL database named in the developer's gitignored `.env` (Bun auto-loads it) or exported per shell. Neither this plan nor any committed file carries a real DSN beyond the repo's published localhost example.

**Blocker status:** none. All defaults above are implementable without contradicting the brief, the governing plan, or shipped behavior.

## 2a. Declared deviations from governing Slice 3 (lines 179–190)

- **V1:** Migration arrays are `001`–`009`, not `001`–`006` (repo moved past the governing plan; see D1).
- **V2:** File list additions beyond the governing slice's list, all test-only or trivially additive: `src/meal-reuse.test.ts` (pure unit tests — the governing plan's RED demands lexical/ranking tests and this is the unit-mode home), `src/meal-reuse.fixtures.ts` (test-only seeding module, mirroring the accepted `calculation-acceptance.fixtures.ts` pattern). `src/meal-event-projection.ts` and `src/search.ts` are modified exactly as the governing slice anticipates (uncapped limit option; exported normalization).
- **V3:** One-line README tools-table refresh for `search_meals` is pulled into this slice (Task 10) instead of waiting for Slice 8, because the tool's public contract visibly changes now and `main` auto-deploys to production (CLAUDE.md). The full docs/inventory truth pass remains Slice 8.
- **V4:** No structured `search_meals` claim of historical-version selection: candidates expose the current version only (D4). The governing A2 text ("current/historical marker") is satisfied by `is_current`/`current_version` fields plus the correction test, not by search-time version pinning.

---

## 3. AC-to-artifact / executable-proof matrix (every locked item)

| Lock item                                                                              | Implementation artifacts                                                                                                                                                                                                                                                                                                                                          | Executable proof (real PostgreSQL / public MCP transport)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Lexical discovery, not semantic**                                                 | Predicate reuse: `tokenizeQuery`/`escapeLikePattern` (`src/search.ts`), `searchMealProjections` with `limit: null` (`src/meal-event-projection.ts`); `match_mode: "lexical"` literal in DTO + zod schema; tool description says "lexical keyword match — not semantic/vector search".                                                                             | Unit: `src/meal-reuse.test.ts` token/case tests. PG: `src/meal-reuse.integration.test.ts` — case-insensitive component AND description/notes match; `%`/`_`/`\` escape literalness; u2 sees nothing of u1 (no existence leak: empty result, not error); deleted events absent. Transport: `src/mcp-reuse.integration.test.ts` asserts `structuredContent.match_mode === "lexical"` and that neither `listTools()` description nor output text contains "semantic", "vector", or "embedding". |
| **2. 90-day frequency ranking, recency tie-break, no pre-grouping cap, ≤2 candidates** | `rankReuseVariations` pure function + uncapped 90-day query in `src/meal-reuse.ts` (`searchReuseCandidates`), explicit `now` injection for deterministic windows.                                                                                                                                                                                                 | Unit: frequency desc, recency tie-break, ≤2 most-recent candidate selection, 10-variation cap. PG: seed 60+ matching events so a LIMIT-50-style cap would misrank — assert correct frequency order anyway (cap-invalidation regression test); seed events at 89/90/91 days — 91d excluded from counts, exactly-90d included.                                                                                                                                                                 |
| **3. Candidate read contract**                                                         | `ReuseSourceCandidate` DTO: `source_event_id`, `source_version`, `current_version`, `is_current`, ordered `components` (ordinal/raw/normalized/quantity/portion/notes), `consumed_at`, `meal_type`, `canonical` (status/consensus + 7 nullable nutrients), `provenance_status`, `compatibility`, `bundle_fingerprint`. Detail reads via `getMealEventProvenance`. | PG: ready candidate (3-provider bundle) shows `ready` + canonical values; pending (compatibility write) shows `pending` with canonical nulls staying `null` — assert `calories === null`, never `0`; unavailable-provider candidate shows `unavailable`; corrected event shows v2 components/canonical, `source_version === 2`, `is_current === true`, and no v1 item text anywhere in the result.                                                                                           |
| **4. Public MCP contract**                                                             | Evolved `search_meals` registration in `src/mcp.ts`: `SEARCH_MEALS_OUTPUT_SCHEMA` (zod), `structuredContent` on every path incl. empty, human text preserved, reads via `mealEventsPool`.                                                                                                                                                                         | Transport: `client.listTools()` proves the advertised `outputSchema` (required keys present); `client.callTool` returns `structuredContent` that parses against the schema; empty-match call returns structured `{variations: [], total_matches_90d: 0, ...}` plus the existing no-match prose; legacy text sections still contain "Variations (by frequency):" and "Most recent matching entries:" for a seeded corpus.                                                                     |
| **5. Executable proof + read-only + gates**                                            | `src/meal-reuse.integration.test.ts`, `src/mcp-reuse.integration.test.ts`, `src/meal-reuse.fixtures.ts`, `scripts/test-db-gate.ts` suites entries.                                                                                                                                                                                                                | Both suites replay `001`–`009` per test; domain-table row counts identical before/after every search call (D8 table list); no provider/network seam exists to invoke; `bun run test:unit`, `bun run test:db`, `bun run typecheck`, `bun run format:check` all green. Food paths & alcohol: untouched suites (`src/alcohol.test.ts`, `src/legacy-meal-tools.integration.test.ts`, `src/mcp-food-tracking.test.ts`) pass unchanged inside the same gate run.                                   |

Preservation rows (from the lock's item 5): **C2** — no migration shipped, chain untouched, every new array replays `001`–`009` from empty `public`. **C3** — zero alcohol-path edits; `search_meals` text path unchanged means alcohol formatting in other tools is untouched; the DB gate re-runs the existing alcohol-covering suites.

---

## 4. Target contracts (what GREEN must produce)

### 4.1 `src/meal-reuse.ts` — module surface

```ts
// src/meal-reuse.ts — READ-ONLY reusable-meal discovery. Lexical matching
// only (ILIKE over persisted item text/notes); this module performs no
// writes, no provider calls, and registers nothing. Slice 4 owns mutation.
import type { Pool } from "pg";
import { normalizeDescription } from "./search.js";
import {
    searchMealProjections,
    type MealEventProjection,
} from "./meal-event-projection.js";
import { getMealEventProvenance } from "./meal-events.js";

export const REUSE_WINDOW_DAYS = 90;
export const MAX_REUSE_VARIATIONS = 10;
export const MAX_REUSE_CANDIDATES = 2;

export interface ReuseCandidateComponent {
    ordinal: number;
    raw_item_text: string;
    normalized_name: string | null;
    quantity: number | null;
    portion_value: number | null;
    portion_unit: string | null;
    notes: string | null;
}

export interface ReuseCanonical {
    status: "pending" | "ready" | "low_confidence";
    consensus_status:
        | "two_agree_one_outlier"
        | "all_agree"
        | "no_consensus"
        | "insufficient_data";
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    sugar_g: number | null;
    alcohol_g: number | null;
}

export interface ReuseSourceCandidate {
    source_event_id: string;
    source_version: number; // version whose data is shown (current at read time)
    current_version: number;
    is_current: boolean;
    consumed_at: string; // ISO
    meal_type: string | null;
    components: ReuseCandidateComponent[]; // ordered by ordinal
    canonical: ReuseCanonical | null; // null when no canonical row: never zero-filled
    provenance_status: "ready" | "pending" | "unavailable" | "missing";
    compatibility: boolean;
    bundle_fingerprint: string | null;
}

export interface ReuseVariation {
    variation_key: string; // normalizeDescription output
    label: string; // newest occurrence's rendered description
    occurrences_90d: number;
    last_consumed_at: string;
    candidates: ReuseSourceCandidate[]; // ≤ 2, most recent first
}

export interface ReuseDiscovery {
    match_mode: "lexical";
    window_days: 90;
    generated_at: string;
    total_matches_90d: number;
    variations: ReuseVariation[]; // frequency desc, recency tie-break, ≤ 10
}

/** Pure: group + rank matches; no I/O. Exported for unit tests. */
export function rankReuseVariations(
    matches: Pick<MealEventProjection, "id" | "description" | "logged_at">[],
    opts?: { maxVariations?: number; maxCandidates?: number },
): {
    key: string;
    label: string;
    count: number;
    lastConsumedAt: string;
    candidateIds: string[];
}[];

/** DB read: uncapped 90d lexical match -> ranked variations -> ≤2 candidate aggregates each. */
export async function searchReuseCandidates(
    pool: Pool,
    userId: string,
    queries: string[],
    opts?: { now?: string }, // injectable clock for deterministic boundary tests
): Promise<ReuseDiscovery>;
```

Semantics locked here:

- Window: `consumed_at >= now − 90 days` (inclusive), `now` = `opts.now ?? new Date().toISOString()`.
- Match query = `searchMealProjections(pool, userId, queries, { sinceIso, limit: null })` — **no LIMIT**.
- Grouping key = `normalizeDescription(projection.description)`; ranking = count desc, then `last_consumed_at` desc; slice to 10 variations.
- Candidates = the 2 newest events (by `consumed_at`, then id desc for determinism) in each variation; details via `getMealEventProvenance(pool, userId, eventId)` (current version). If an event vanishes between the two queries (not expected in tests), it is skipped, never fabricated.
- Empty/blank token sets return `{ match_mode: "lexical", window_days: 90, generated_at, total_matches_90d: 0, variations: [] }`.

### 4.2 `src/meal-event-projection.ts` change (minimal)

`searchMealProjections` `opts.limit` becomes `number | null` (default stays `50`); `null` omits the `LIMIT` clause entirely. No other query change; existing callers are unaffected.

### 4.3 `src/search.ts` change (minimal)

`normalizeDescription` gains `export`. No behavior change.

### 4.4 Evolved `search_meals` registration (`src/mcp.ts`)

- Add module-level `SEARCH_MEALS_OUTPUT_SCHEMA` (zod, `.strict()` object mirroring `ReuseDiscovery`; follow the `CALCULATION_PROVENANCE_OUTPUT_SCHEMA` style — `z.enum` for statuses, `z.literal("lexical")` for `match_mode`, `z.literal(90)` for `window_days`, `.nullable()` for every nullable field so explicit `null`s are required).
- Registration keeps: name, `readOnlyHint: true` annotations, `queries`/`days`/`limit` input schema, `withAnalytics("search_meals", …)`.
- Registration adds: `outputSchema: SEARCH_MEALS_OUTPUT_SCHEMA.shape`.
- Handler: keep the existing text construction verbatim (both the empty and non-empty branches, still fed by `searchMeals(userId, queries, {limit, sinceIso(days)})`); additionally compute `const reuse = await searchReuseCandidates(mealEventsPool, userId, queries);` and return `structuredContent: SEARCH_MEALS_OUTPUT_SCHEMA.parse(reuse)` on **both** branches.
- Description: append truthful sentences — "Also returns machine-readable structuredContent: recurring variations ranked by frequency over exactly the last 90 days (recency tie-break), each with up to two most-recent source candidates (event/version, ordered components, consumed time, canonical nutrition status, provenance status) for explaining a possible reuse of a past confirmed calculation. Matching is lexical keyword matching (case-insensitive ILIKE over stored components/notes) — not semantic or vector search. This tool never writes; creating a new event from a past one is a separate explicit mutation." Do NOT name `reuse_meal_calculation` as an existing tool (it does not exist yet).

---

## 5. Truthful DB/transport gates — obtaining the disposable DSN (no secrets in source)

The repo-supported way (README §Environment variables, `.env.example`, `scripts/test-db-gate.ts`):

1. Create a disposable local database (any name; the repo's published example is `nutrition_mcp_test`):
    ```bash
    createdb nutrition_mcp_test   # or: psql -c 'CREATE DATABASE nutrition_mcp_test'
    ```
2. Provide the DSN via the developer's **gitignored** `.env` (Bun auto-loads it) or a shell export. Never commit it, never paste a real remote DSN into tests, plans, or docs:
    ```bash
    export DATABASE_URL_TEST="postgres://localhost:5432/nutrition_mcp_test"
    export DATABASE_URL="$DATABASE_URL_TEST"   # required: analytics + legacy reads use the global pool,
                                               # and the DB gate refuses mismatched URLs (test-db-gate.ts:13-18)
    ```
3. Gate truthfulness rules (already enforced by the repo, restated as acceptance):
    - `bun run test:db` REFUSES to run without `DATABASE_URL_TEST` and refuses `DATABASE_URL !== DATABASE_URL_TEST`. Suites are destructive (`DROP SCHEMA public CASCADE`).
    - A DB suite observed "passing" without env set is a hidden skip (`describeDb` → `describe.skip`); the gate fails any suite that ran zero tests. **A RED must be observed with the env vars set**, otherwise it proves nothing.
    - `bun run test:unit` intentionally strips DB env; new DB suites must self-skip cleanly there (the `describeDb` pattern gives this for free) and must not fail the unit gate.

---

## 6. Test seeding recipes (real writers only — `src/meal-reuse.fixtures.ts`)

All seeding goes through shipped write paths so persisted truth is real (D3). Fixture module mirrors `src/calculation-acceptance.fixtures.ts`: exported const event IDs, seed helpers taking `(pool, userId, overrides)`, a `domainTableCounts(pool)` helper returning counts for the D8 table list, and a cloned `withReuseTools(pool, userId, run)` transport harness (from `src/mcp-supplements.integration.test.ts:88-121`).

| Persisted state needed                              | Recipe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plain match, `pending` provenance                   | `createMealEvent(pool, { user_id, idempotency_key, reported_at, consumed_at, items: [...], inputs: [{source_kind:"user_text", content}], media: [], provider_results: [2 succeeded rows] , parser_policy_version, created_by })` — no bundle ⇒ fingerprint null ⇒ `pending`. Vary `consumed_at` for window/recency control.                                                                                                                                                                                                                              |
| `ready` candidate                                   | Seed event as above (provider_results may be empty), then `commitCalculationBundle(pool, readyBundle(event_id, 1), { user_id })` where `readyBundle` supplies ALL THREE providers (`nutrition-local`, `own`, `myfitnesspal`) each `succeeded` with `source_id`, `request_fingerprint`, `algorithm_version`, non-empty `raw_payload`, non-compatibility `provenance`, `basis`, `units`, plus event-scope nutrients (clone `scopedProvider` from `calculation-acceptance.fixtures.ts`, add the third provider, fingerprint via `stableBundleFingerprint`). |
| `unavailable` candidate                             | Same bundle recipe but one provider `status: "unavailable"` with `error_code` (see `calculation-bundles.integration.test.ts:85-101` shape).                                                                                                                                                                                                                                                                                                                                                                                                              |
| Historical version (current/historical distinction) | `correctMealEvent(pool, { event_id, correction_idempotency_key, correction_reason, items: [changed components], ... })` ⇒ version 2 becomes current.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Deleted event                                       | Seed, then `UPDATE meal_events SET status='deleted', deleted_at=now() WHERE id=$1 AND user_id=$2` (the shipped `deleteMeal` semantics, `src/db.ts:400-405`).                                                                                                                                                                                                                                                                                                                                                                                             |
| Cross-user corpus                                   | Same recipes with `user_id: "u2"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Cap-invalidation corpus                             | Loop-seed 55 events of variation A spread across days 5–85 and 8 events of variation B in the last 4 days (all matching one query token). A newest-first LIMIT-50 would drop old A rows and misrank; correct output ranks A (55) above B (8).                                                                                                                                                                                                                                                                                                            |

Boundary corpus: with injected `now = "2026-08-06T12:00:00.000Z"`, seed identical-description events at `now − 89d`, exactly `now − 90d`, and `now − 91d` — expect `occurrences_90d = 2`.

---

## 7. Dependency-ordered TDD tasks

Run everything from `/Users/fishhead/.workspace/projects/nutrition-mcp`. Commit after each GREEN (+format). Never commit a RED.

### Task 0 — Preflight (no code)

1. `git status --short` — expect only the untracked Slice 3 brief/plan under `.hermes/plans/`; working tree otherwise clean at `5ca7a9e`.
2. Set up the disposable DB + env per §5.
3. Baseline: `bun run test:unit` → green; `bun run test:db` → all 10 suites green. If baseline is red, STOP and escalate — this slice must not start on a broken base.

### Task 1 — RED: pure ranking + normalization contract (`src/meal-reuse.test.ts`, new)

Unit-mode file (no DB, no `describeDb`). Write failing tests importing from not-yet-existing `./meal-reuse.js` and the not-yet-exported `normalizeDescription`:

- `rankReuseVariations` groups by `normalizeDescription` key (case/whitespace/trailing-punct variants of "Oatmeal with raisins" collapse; "oatmeal with banana" stays distinct).
- Frequency desc; equal counts → newer `lastConsumedAt` first.
- `candidateIds`: at most 2, newest `logged_at` first; deterministic id tie-break.
- Caps: 11 distinct variations in → 10 out (`maxVariations` default), override works.
- Empty input → `[]`.
- `normalizeDescription` is exported from `./search.js` and behaves per the existing private implementation (spot-check: `" OATMEAL  with raisins. "` → `"oatmeal with raisins"`).

Run: `bun test src/meal-reuse.test.ts` → expect FAIL (module/exports missing). Observe the failure.

### Task 2 — GREEN: pure layer

1. `src/search.ts`: add `export` to `normalizeDescription` (no other change).
2. Create `src/meal-reuse.ts` with the §4.1 types + `rankReuseVariations` implementation ONLY (constants included; `searchReuseCandidates` may be declared but not yet implemented — prefer omitting until Task 6 to keep GREEN minimal).
3. `bun test src/meal-reuse.test.ts` → PASS. `bun test src/search.test.ts` → still PASS.
4. `bun run format && bun run typecheck`
5. `git add src/meal-reuse.ts src/meal-reuse.test.ts src/search.ts && git commit -m "feat: slice 3 — pure lexical reuse-variation ranking (90d contract helpers)"`

### Task 3 — RED: uncapped projection search (`src/meal-reuse.integration.test.ts`, new — first describe block)

Create the integration file with the `describeDb` guard, `MIGRATIONS` array `001`–`009`, per-test `resetSchema`, `flushAnalytics` afterEach (clone the supplements-suite skeleton). Also create `src/meal-reuse.fixtures.ts` with the seeders from §6 as needed per task.

First failing tests (direct repository level):

- Seed 55 matching events for u1; `searchMealProjections(pool, "u1", ["oat"], { limit: null })` returns all 55 (current code: TS/type error or 50-row result → RED either way).
- `limit: null` still respects `sinceIso`, user scope, `status='active'`.

Run: `DATABASE_URL_TEST=... DATABASE_URL=... bun test src/meal-reuse.integration.test.ts --max-concurrency 1` → observe FAIL.

### Task 4 — GREEN: `limit: number | null`

1. `src/meal-event-projection.ts`: change `opts: { limit?: number | null; sinceIso?: string }`; when `limit === null`, do not push the limit param and omit `LIMIT`; default `50` unchanged.
2. Rerun Task 3 command → PASS. Also `bun test src/search.test.ts` and `bun run typecheck` (other callers unaffected).
3. Commit: `git add src/meal-event-projection.ts src/meal-reuse.integration.test.ts src/meal-reuse.fixtures.ts && git commit -m "feat: slice 3 — uncapped lexical projection search (limit: null)"`

### Task 5 — RED: `searchReuseCandidates` PG semantics (extend `src/meal-reuse.integration.test.ts`)

Failing tests (all against real PG, injected `now`):

1. **90-day boundary:** 89d/90d/91d corpus → `occurrences_90d === 2`; 91d event never appears as a candidate.
2. **Cap-invalidation regression:** §6 corpus (55×A old + 8×B recent) → variations[0] is A with 55, variations[1] is B with 8.
3. **Recency tie-break:** two variations with equal counts → newer last occurrence first.
4. **Candidate cap + order:** variation with 5 occurrences → exactly 2 candidates, newest first; `last_consumed_at` equals candidate[0].consumed_at.
5. **Lexical case/escape:** query `"OAT"` matches lowercase items; seeded item text `"50%_off\\ bar"` matched by query `"50%_off\\"` literally and NOT by `"500off"` (escape proof); token AND within an alternative; two alternatives OR.
6. **Candidate contract — ready:** ready-seeded candidate → `provenance_status: "ready"`, `compatibility: false`, non-null `bundle_fingerprint`, canonical values echo the committed bundle consensus.
7. **Candidate contract — pending/unavailable, no zero fabrication:** pending candidate's absent canonical nutrients are `null` (explicitly assert `!== 0`); unavailable-provider candidate → `"unavailable"`.
8. **Current vs historical:** corrected event (v2 changes "raisins"→"banana") groups under the v2 description; candidate `source_version === 2`, `current_version === 2`, `is_current === true`; serialized result contains no v1-only item text.
9. **User isolation:** u2 corpus seeded; `searchReuseCandidates(pool, "u1", …)` result JSON contains no u2 event id / item text; u2 query for u1-only terms → `total_matches_90d === 0`, `variations: []` (empty, not an error — no existence leak).
10. **Deleted excluded:** deleting one of a variation's events removes it from counts and candidates.
11. **Read-only:** `domainTableCounts` identical before/after every `searchReuseCandidates` call (D8 table list).
12. **Components ordering:** multi-item event → `components` sorted by ordinal with raw/normalized/portion/notes fields populated as seeded.

Run the file → observe FAIL (`searchReuseCandidates` missing).

### Task 6 — GREEN: implement `searchReuseCandidates`

Implementation per §4.1 semantics: uncapped match via `searchMealProjections(..., { sinceIso: now−90d, limit: null })` → `rankReuseVariations` → per candidate `getMealEventProvenance(pool, userId, eventId)` → assemble `ReuseDiscovery` with explicit `null`s. No new SQL beyond the two existing read paths; no writes; no imports from provider/bundle-commit modules.

Run: the Task 5 command → PASS. `bun run format && bun run typecheck`.
Commit: `git add src/meal-reuse.ts src/meal-reuse.integration.test.ts src/meal-reuse.fixtures.ts && git commit -m "feat: slice 3 — 90d reuse-candidate discovery read (real-PG proven)"`

### Task 7 — RED: public transport contract (`src/mcp-reuse.integration.test.ts`, new)

Clone the harness (parameterized `userId`), same migrations/reset/`flushAnalytics`. Failing tests:

1. **listTools proves the schema:** `search_meals` tool entry has `outputSchema` whose `properties` include `match_mode`, `window_days`, `generated_at`, `total_matches_90d`, `variations`; description contains "lexical" and does NOT contain "semantic"/"vector"/"embedding" (case-insensitive scan).
2. **listTools proves absence of the mutation:** no tool named `reuse_meal_calculation` is advertised (Slice 4 guard).
3. **Structured round-trip:** seed ready+pending corpus via fixtures; `call("search_meals", { queries: ["oatmeal"] })` → `isError` not true; `structuredContent` parses with `SEARCH_MEALS_OUTPUT_SCHEMA.parse` (import from `./mcp.js`); assert variation ranking, ≤2 candidates, candidate fields incl. `source_event_id`/`source_version`/`provenance_status`/canonical nulls preserved.
4. **Text preserved:** same call's `content[0].text` still contains `"Variations (by frequency):"` and `"Most recent matching entries:"` and the `[id: ...]` entry format.
5. **Empty path:** unmatched query → text starts with `"No past meals matching"` AND `structuredContent` present with `variations: []`, `total_matches_90d: 0` (schema-parse it).
6. **Structured window independent of `days`:** call with `days: 3650` where a matching event exists at 100 days ago and one at 10 days ago → text's recent entries may include the old one, but `structuredContent.total_matches_90d === 1` and only the 10-day event appears in candidates.
7. **Cross-user at the transport:** harness registered as `"u2"` → u1 corpus invisible (empty structured result, no u1 ids in the full serialized response).
8. **Read-only at the transport:** `domainTableCounts` unchanged across all `search_meals` calls.

Run: `DATABASE_URL_TEST=... DATABASE_URL=... bun test src/mcp-reuse.integration.test.ts --max-concurrency 1` → observe FAIL (no outputSchema/structuredContent yet).

### Task 8 — GREEN: evolve `search_meals` (`src/mcp.ts`)

Per §4.4: export `SEARCH_MEALS_OUTPUT_SCHEMA`, add `outputSchema` to the registration, compute `searchReuseCandidates(mealEventsPool, userId, queries)` in the handler, attach parsed `structuredContent` on both branches, extend the description. Keep `withAnalytics`, annotations, input schema, and both text branches byte-identical.

Run: Task 7 command → PASS. Then regression sweep:

```bash
bun test src/mcp.test.ts
bun run test:unit
DATABASE_URL_TEST=... DATABASE_URL=... bun test src/mcp-food-tracking.test.ts --max-concurrency 1
DATABASE_URL_TEST=... DATABASE_URL=... bun test src/legacy-meal-tools.integration.test.ts --max-concurrency 1
```

(legacy suite needs `RUN_LEGACY_MEAL_DB_TESTS=1` when run standalone — the gate sets it.) Expect all green; the legacy suite's `search_meals` assertions (`legacy-meal-tools.integration.test.ts:325,525,555`) must pass unmodified — if they fail, the text contract regressed: fix the handler, not the test.

Commit: `git add src/mcp.ts src/mcp-reuse.integration.test.ts && git commit -m "feat: slice 3 — search_meals typed reuse-discovery output over public transport"`

### Task 9 — Gate wiring + full acceptance ladder

1. `scripts/test-db-gate.ts`: append to `suites`:
    ```ts
    "src/meal-reuse.integration.test.ts",
    "src/mcp-reuse.integration.test.ts",
    ```
    (migrations array already ends at `009` — no change.)
2. Full ladder:
    ```bash
    bun run test:unit          # new DB suites must self-skip cleanly, unit gate green
    bun run test:db            # 12 suites, zero fail, zero hidden skips
    bun run typecheck
    bun run format:check
    git diff --check
    ```
3. Commit: `git add scripts/test-db-gate.ts && git commit -m "test: slice 3 — reuse discovery suites join the DB gate"`

### Task 10 — Minimal docs truth line (V3)

1. `README.md:53` `search_meals` row → extend to state the shipped truth, e.g.: `Search past meals by keyword (lexical, case-insensitive), grouped into recurring variations; also returns typed 90-day reuse-candidate data (source event/version, components, canonical/provenance status)`. Do NOT add rows for tools that don't exist; do not touch migration prose (unchanged chain).
2. `bun test src/food-tracking-docs.test.ts` → PASS (no phrase pins reference search_meals; migration checks unaffected).
3. `bun run format:check && git diff --check`
4. Commit: `git add README.md && git commit -m "docs: slice 3 — search_meals tools-table row reflects reuse discovery output"`

---

## 8. Adversarial acceptance gates (reviewer checklist)

All through real PostgreSQL and/or the public transport:

1. **Ranking integrity:** the 55/8 corpus cannot be misranked by any internal cap; 90-day boundary inclusive at exactly −90d, exclusive beyond.
2. **No leakage:** u2's transport search of u1 terms returns an empty result (not an error, no ids, no item text anywhere in the serialized response).
3. **No fabrication:** pending/unavailable candidates carry `null` nutrients where nothing is persisted; assert `!== 0` explicitly.
4. **Version truth:** corrected events surface only current-version components/canonical; `source_version === current_version`; no stale v1 text.
5. **Read-only:** domain-table counts (D8 list) identical across every discovery call, repository-level and transport-level; no import path from `meal-reuse.ts` to `commitCalculationBundle`, `createMealEvent`, or any network/provider seam (assert via review, and the module imports only read functions).
6. **No Slice 4 pre-build:** `listTools()` contains no `reuse_meal_calculation`; `meal_event_reuse_sources` / `meal_event_reuse_provider_sources` row counts stay 0 throughout.
7. **Schema honesty:** `structuredContent` parses against the exact advertised `outputSchema` on every path including empty; `match_mode` is the literal `"lexical"`; no "semantic"/"vector"/"embedding" anywhere in tool text.
8. **Gate honesty:** both new suites appear in `scripts/test-db-gate.ts` and run non-zero test counts in `bun run test:db`; unit gate stays green with DB env stripped.
9. **Regression:** existing `search_meals` transport assertions, alcohol tests, and food-path suites pass unmodified.

## 9. Explicitly out of scope (fail the review if present)

`reuse_meal_calculation` or any mutation/registration thereof; copied evidence writes; lineage-table writes; confirmation/idempotency mutation logic; new migrations or index changes; product/regimen/intake/sports-nutrition work; providers, OCR/STT/vision, Telegram, MyFitnessPal sync, cron/reminders; semantic/vector/embedding search or claims thereof; changes to alcohol behavior; broad docs rewrites (Slice 8).

## 10. Verification commands (consolidated)

```bash
cd /Users/fishhead/.workspace/projects/nutrition-mcp
export DATABASE_URL_TEST="postgres://localhost:5432/nutrition_mcp_test"   # disposable DB per §5
export DATABASE_URL="$DATABASE_URL_TEST"

# focused loops
bun test src/meal-reuse.test.ts
bun test src/meal-reuse.integration.test.ts --max-concurrency 1
bun test src/mcp-reuse.integration.test.ts --max-concurrency 1

# acceptance ladder
bun run test:unit
bun run test:db
bun run typecheck
bun run format:check
git diff --check
```
