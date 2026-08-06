# Nutrition MCP gap-remediation campaign plan

Date: 2026-08-05
Author: planner-fable
Workflow: planner-fable -> coder-kimi (one slice per invocation) -> reviewer-terra (gate per slice)
Repository: `/Users/fishhead/.workspace/projects/nutrition-mcp`
Brief: `.hermes/plans/2026-08-05-gap-remediation-campaign-brief.md`
Audit: `.hermes/plans/2026-08-05-plan-vs-code-gap-audit.md` (Russian; UTF-8)

> **For Hermes:** Dispatch exactly one slice per coder-kimi invocation. Reviewer-terra gates each slice before the next one starts. Never send the whole campaign to one coder run.

**Goal:** Close the audited gaps in nutrition-mcp — per-scope canonical materialization, public capture-media path with byte lifecycle, NULL-vs-zero presence semantics, honest legacy provenance status, the missing DB/MCP acceptance matrix, DB readiness, Supabase drift, operator docs — starting from a safe closeout of the uncommitted provenance work.

**Architecture:** Append-only `meal_events` aggregate stays authoritative. Consensus stays backend-computed per scope. Hermes stays the orchestrator; nutrition-mcp exposes seams, never provider/Telegram imports.

**Tech stack:** Bun + TypeScript, `pg`, MCP TypeScript SDK (`InMemoryTransport` for tests), Zod, local PostgreSQL 16, prettier, migrations `db/migrations/001..005`.

`graphify-out/graph.json` does not exist (verified 2026-08-05). No graph evidence is used or invented in this plan.

---

## 0. Decisions and contradictions (resolved up front)

- **D1 — Dirty-tree partition.** The working tree holds one coherent provenance campaign plus mechanical formatting and historical plan files. Resolution: Slice S0 commits it as five focused commits (formatting -> test harness -> widget null fix -> provenance feature -> plan archive), in that order, gates re-run at defined boundaries, push only after the full gate is green. No feature work starts before S0 is accepted.
- **D2 — Capture media byte transport.** Audit offered (a) backend receives bytes vs (b) host staging adapter + receipt. Resolution: **(a)**. `attach_meal_capture_media` accepts base64 bytes (cap 8 MiB decoded); the backend stages through a capture-scoped `MediaStore`, verifies size + SHA-256, and cleans up on rollback. Rationale: no host adapter exists, and the brief demands the lifecycle be executable through the public MCP path today. A receipt-based adapter can be added later without breaking this contract (the tool's output already carries the generated identity).
- **D3 — Per-scope canonical output contract.** `CALCULATION_BUNDLE_OUTPUT_SCHEMA.canonical` is a single nullable object. Resolution: keep `canonical` as the event-scope row (backward compatible) and add `item_canonicals: array` (one entry per item ordinal). Additive, not breaking.
- **D4 — Totals presence contract.** `TOTALS_ITEM` core macros are non-nullable and `sumMeals` coalesces `NULL -> 0`. Resolution: make `calories/protein_g/carbs_g/fat_g` nullable in `TOTALS_ITEM`; a total is `null` only when **no** meal in the selection has a calculated value for that nutrient; a mixed selection sums the calculated values and exposes `meals_total`/`meals_calculated` counts so a partial sum is never mistaken for a complete one. Explicit stored `0` stays `0`. This changes declared output schemas of legacy tools — accepted (single-user deployment, honesty beats compatibility), and reviewer-terra treats the new contract as the spec.
- **D5 — Plan formatting debt.** Historical `.hermes/plans/*.md` keep global `format:check` red. Resolution: quarantined until S10. Every earlier slice's format gate is **changed-files-only** (`bunx prettier --check <files touched by the slice>`). Only S10 formats the historical plans and then flips the repository gate green.
- **D6 — `src/supabase.test.ts` rename.** The file no longer tests Supabase. Coder must read the file and rename to match its actual subject (expected: analytics/import glue); reviewer-terra fails S8 if the new name does not describe the tests inside.
- **D7 — Correction output schema.** `CALCULATION_CORRECTION_OUTPUT_SCHEMA = CALCULATION_BUNDLE_OUTPUT_SCHEMA` (alias, `src/calculation-bundles.ts:128`). Terra previously required a distinct explicit contract. Resolution: S6 gives corrections their own schema object including correction-specific fields (`prior_version`, `correction_reason`, `correction_author`), no longer an alias.
- **No contradiction found** between "preserve append-only model" and any audit item. Nothing in this campaign restores `meals`, compat views, provider imports, or fabricated zeros.

---

## 1. HEAD truth vs working-tree truth (reconciled before any edit)

### HEAD truth (`fdfa2e6`, matches `origin/main` at audit time)

- Migrations `001..005` exist and are applied by the DB gate.
- Capture lifecycle (start/append/answer/draft/get/cancel/expire/confirm), calculation bundle validate/commit, legacy tools on event projection, corrections via `correctMealEvent` — all present.
- **Absent from HEAD:** `get_calculation_provenance` and `commit_calculation_correction` MCP tools, `readPersistedWriteStatus` (`src/meal-events.ts`), `getMealEventProvenance`, `provenance_status` machinery, per-suite DB reset in `scripts/test-db-gate.ts`, `source_id`/`provenance`/`basis`/`units` on `ProviderResultInput`, trends-widget null fix. Verified with `git grep <symbol> fdfa2e6 -- src/` returning empty.

### Working-tree truth (dirty, must be preserved)

- 24 tracked files modified (+2464/-873), 40+ untracked plan files, no stash, no active writer process.
- Working tree adds the whole late provenance campaign: public readback + correction tools with strict output schemas, `readPersistedWriteStatus`, `getMealEventProvenance`, provider `source_id`/`provenance`/`basis`/`units` persistence, deterministic per-suite DB reset (drop schema + replay `001..005`), widget null-average fix, README/docs provenance sections.
- Two tracked plan files (`2026-08-04-supabase-to-pg-{brief,plan}.md`) carry formatting-only edits.
- `src/rate-limit.ts` and `src/foods.ts` diffs are prettier-mechanical only (verified by reading the diffs).

### Verified gate baseline (working tree, from audit; re-verify in S0 step 1)

- `bun run test:unit`: **445 pass, 0 fail, 84 DB-gated skip, 529 tests**.
- `DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db`: **82 pass, 0 fail, 0 skip, 7 suites**.
- `bun run typecheck`: pass. `git diff --check`: pass.
- `bun run format:check`: red **only** on historical `.hermes/plans/*.md` (14 files).

### Known-broken-by-design in the working tree (what this campaign fixes)

- `commitCalculationBundle` (`src/calculation-bundles.ts:232`): inserts provider rows per ordinal but calls `computeConsensus` once over **all** results, selects `source_result_ids` with `ordinal IS NULL` only, and inserts exactly one canonical row with `ordinal = NULL`. `commitCalculationCorrection` (`:366`) repeats this. `readPersistedWriteStatus` (`src/meal-events.ts:61`) reads back only the `ordinal IS NULL` canonical row (`src/calculation-bundles.ts:203` comment trail).
- Schema already supports the fix: `meal_event_canonical_results` has `ordinal` + generated `scope_key` + `UNIQUE (event_id, version, scope_key)` (`db/migrations/002_food_tracking.sql:204-231`). **No new migration is needed for S1.**
- `sumMeals` (`src/mcp.ts:394`) coalesces core macros with `?? 0`; `TOTALS_ITEM` (`src/mcp.ts:556`) declares them non-nullable.
- `saveCaptureMedia` (`src/meal-captures.ts:219`) exists; no MCP tool reaches it; `attach_meal_capture_media` matches nothing in the tree.
- `src/media-store.ts` has `generateStorageKey`/`isGeneratedStorageKey`/`createMediaStore` keyed by event/version — nothing capture-scoped, and nothing wires a `MediaStore` into `registerTools` (`src/mcp.ts:1238`, dependency seam `deps: { mealEventsPool?: Pool }` at `:1245`).
- `/health` (`src/index.ts:268`) returns `ok` unconditionally.
- `scripts/mcp-smoke.ts` calls 9 tools; missing `get_meals_today`, `get_meals_by_date_range`, `get_goal_progress`, `get_trends`, `get_meal_patterns`.
- Two tests in `src/mcp-food-tracking.test.ts` share the name `"rejects cross-user capture message, answer, and draft mutations"` (lines 343 and 454).
- Supabase drift: `supabase/migrations/*` (12 files), `src/supabase.test.ts`, `CLAUDE.md` line 7 claims analytics persist to a Supabase table, `docs/google-auth-setup.md`, stale comments in `src/import.ts` / `src/mcp.test.ts`.
- README self-hosting shows only migrations `001`/`002` as commands and names `001..003` as the order (`README.md:123-153`); real order is `001..005`.

---

## 2. Global campaign rules (apply to every slice)

1. **One slice per coder-kimi invocation.** The coder receives this plan plus the slice number. Reviewer-terra gates before the next slice.
2. **TDD is mandatory and visible.** Every code slice shows RED (new test failing, command + failing output), GREEN (implementation, command + passing output), REFACTOR (cleanup with gates still green). Tests must fail for the _right reason_ — reviewer-terra checks the RED failure message.
3. **Gates and exact env.** PostgreSQL runs the disposable DB. Canonical env for every DB/MCP command:
    ```bash
    export DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test
    export DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test
    ```
    (`scripts/test-db-gate.ts` refuses to run unless both are set and equal.)
    Full gate battery, run before every commit that touches `src/`, `db/`, or `scripts/`:
    ```bash
    bun run typecheck                      # expect: src/ typechecks clean
    bun run test:unit                      # expect: 0 fail; report pass/skip counts
    bun run test:db                        # expect: 0 fail, 0 skip; report pass count and suite count
    git diff --check                       # expect: silence
    bunx prettier --check <changed files>  # expect: all matched files use Prettier code style
    ```
4. **Counts are reported separately** in every slice handoff: `unit: X pass / Y skip / 0 fail`, `db: Z pass / 0 skip / 0 fail across N suites`. Baselines: unit 445/84/0, db 82/0/0/7. Counts may only grow; a shrink without an explanation in the handoff is a terra FAIL.
5. **Commit discipline.** Focused commits per logical task, conventional-commit style messages, no unrelated files staged (`git status --porcelain` reviewed before each commit). Push (`git push origin main`) only at slice end after the full gate battery is green.
6. **Never**: restore flat `meals` or a compat view; fabricate provider rows; turn `NULL` into `0`; mark pending journal rows `synced`; import Telegram/provider/STT/OCR/vision code into the domain layer; reset/clean/discard working-tree state.
7. **Preserve**: raw payloads, source IDs, provenance blobs, nullable missing values, immutable version history, user scoping on every mutator.
8. **Rollback safety.** No slice edits migrations `001..005` in place. New DDL, if any, arrives as a new numbered idempotent migration with a documented rollback (S-slices below state theirs). The disposable test DB can always be rebuilt: `dropdb nutrition_mcp_test && createdb nutrition_mcp_test` then re-run the gate (the gate replays `001..005` itself).
9. **External follow-ups stay external.** Telegram/STT/OCR/vision ingestion, Hermes parsing/clarification/own-estimate, nutrition-local/MFP calls, real MFP writer, backup scheduler/retention/restore drills, operational permanent delete: out of scope for every slice; the repo only keeps its existing seams (`ExternalWriter`, sync journal, `nullExternalWriter`).

### Dependency graph and recommended order

```
S0 (closeout)  ──────────────────────────────┐
  ├─> S1 (per-scope canonical) ─> S2 (concurrency + acceptance matrix)
  ├─> S3 (NULL presence contract) ─> S4 (legacy provenance status)
  ├─> S5 (capture media MCP + byte lifecycle) ─> S6 (capture output schemas + correction schema)
  ├─> S7 (DB readiness)                        (S6 also depends on S1's schema decision D3)
  ├─> S8 (Supabase cleanup)
  └─> S9 (operator docs + smoke)  [after S5 so smoke can include attach tool]
S10 (plan index + formatting)  [after S9]
S11 (truth sync + closeout)    [last]
```

Recommended serial order: **S0, S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11.** S3/S4, S5/S6, S7, S8 are mutually independent after their stated parents; if parallelism is ever wanted, S7 and S8 are the only safe candidates to interleave — everything else touches `src/mcp.ts` and will conflict.

---

## Slice S0 — Safe closeout of the dirty provenance working tree

**Goal:** Convert the uncommitted provenance/readback/output-schema work into five focused, reviewable commits on `main` and push, so every later slice starts from committed truth. This slice writes **no new production code**.

**Non-goals:** No behavior changes, no new tests, no fixing the scope bug (S1), no plan formatting (S10).

**Dependencies:** none. Blocks everything.

**Exact files/symbols:** the current `git status` set, partitioned below. Key symbols being landed: `readPersistedWriteStatus`, `getMealEventProvenance`, `get_calculation_provenance` + `commit_calculation_correction` tool registrations (`src/mcp.ts:4418`, `:4817`), `CALCULATION_PROVENANCE_OUTPUT_SCHEMA`, `resetDatabase` in `scripts/test-db-gate.ts`, `ProviderResultInput.source_id/provenance/basis/units` (`src/meal-types.ts:141`).

**Step 0 (re-verify truth, RED-equivalent for a no-code slice):**

```bash
cd /Users/fishhead/.workspace/projects/nutrition-mcp
git status --porcelain            # must match the audit inventory; STOP and report if a writer touched the tree
git stash list                    # must be empty
bun run typecheck && bun run test:unit
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
```

Expected: unit 445/84/0, db 82/0/0/7, typecheck clean. If any gate is red, STOP — escalate instead of "fixing" during closeout.

**Commit partition (order matters; each commit stages ONLY its listed files):**

1. `style: apply prettier to rate-limit and foods` — `src/rate-limit.ts`, `src/foods.ts`. After commit: `bun run typecheck && bun run test:unit` green.
2. `test: reset schema per DB suite and complete migration chains` — `scripts/test-db-gate.ts`, `src/backup-policy.test.ts`, `src/meal-captures.integration.test.ts`, `src/mcp-food-tracking.test.ts`. After commit: full DB gate green.
3. `fix: preserve null averages in trends widget` — `public/widgets/src/templates/trends.html`, `src/widgets.test.ts`. After commit: `bun run test:unit` green.
4. `feat: expose calculation provenance readback and public corrections` — `src/calculation-bundles.ts`, `src/calculation-bundles.test.ts`, `src/calculation-bundles.integration.test.ts`, `src/meal-events.ts`, `src/meal-events.test.ts`, `src/meal-types.ts`, `src/nutrition-bundle-types.ts`, `src/db.ts`, `src/db.integration.test.ts`, `src/mcp.ts`, `src/mcp.test.ts`, `src/legacy-meal-tools.integration.test.ts`, `README.md`, `docs/food-tracking-agent-driven.md`. After commit: FULL gate battery.
5. `docs: archive food-tracking campaign plans and audit` — both modified `.hermes/plans/2026-08-04-supabase-to-pg-*.md` and all untracked `.hermes/plans/*.md` including the audit, the brief, and this plan. Historical files are committed **as-is** (formatting debt is S10's).

**Acceptance commands (PostgreSQL/MCP gates):** the full battery from Global rule 3, run after commit 5, plus:

```bash
git log --oneline -6              # five new commits above fdfa2e6, messages as specified
git status --porcelain            # empty
git push origin main
git status -sb                    # ## main...origin/main (no ahead/behind)
```

**Documentation impact:** none beyond what the feature commit already carries.

**Commit boundary:** five commits exactly as partitioned; push at slice end.

**Reviewer-terra checklist (all PASS required):**

- [ ] `git log fdfa2e6..HEAD --oneline` shows exactly 5 commits with the stated scopes; `git show --stat <sha>` of each contains only its listed files. FAIL if any commit mixes partitions.
- [ ] `git grep -l readPersistedWriteStatus HEAD -- src/` non-empty (feature landed).
- [ ] Working tree clean; `main` == `origin/main`.
- [ ] Full gate battery green at HEAD; handoff reports unit and db counts separately and they are >= baseline with 0 fail / 0 db-skip.
- [ ] No file was deleted or reverted relative to the pre-slice working tree (`git diff <pre-slice-worktree-snapshot>` — coder records `git stash create` style snapshot sha in handoff via `git rev-parse` of a temporary tag `pre-s0` created at step 0: `git tag pre-s0 $(git stash create)`; terra compares and then deletes the tag).

**Risks/rollback:** Partition mistakes are recoverable — commits are local until the final push; `git reset --soft fdfa2e6` re-opens the tree without losing content. NEVER `git reset --hard`/`git checkout --`/`git clean` here. If intermediate commit 1–3 gate fails unexpectedly, stop and report; do not rebase-fix after push.

---

## Slice S1 — Per-scope calculation bundle and correction materialization

**Goal:** `commitCalculationBundle` and `commitCalculationCorrection` compute consensus **once per scope** (event + each item ordinal), persist one canonical row per scope, and build `source_result_ids` only from same-scope provider rows. Readback and output schemas expose item canonicals (decision D3).

**Non-goals:** Concurrency tests (S2), NULL aggregate semantics (S3), any migration change (schema already supports per-scope rows).

**Dependencies:** S0.

**Exact files/symbols:**

- Modify: `src/calculation-bundles.ts` — `recomputeCalculationBundle` (:183; becomes per-scope: returns `Map<ordinal|null, ConsensusOutcome>` or `{ event, items }` shape), `commitCalculationBundle` (:232; per-scope canonical INSERT loop, per-scope `source_result_ids` SELECT adds `AND ordinal IS NOT DISTINCT FROM $3`), `commitCalculationCorrection` (:366; same), `CALCULATION_BUNDLE_OUTPUT_SCHEMA` (:108; add `item_canonicals: z.array(CANONICAL_OUTPUT_SCHEMA.extend({ ordinal: z.number().int().min(0) }))`), `CALCULATION_PROVENANCE_OUTPUT_SCHEMA` (:131; same addition).
- Modify: `src/meal-events.ts` — `readPersistedWriteStatus` (:61) reads back ALL canonical rows for the version, not just `ordinal IS NULL`; `MealEventAggregate` (:298) carries `item_canonicals`; `getMealEventProvenance` (:1143) passes them through.
- Modify: `src/mcp.ts` — `canonicalOutput`/`buildCalculationBundleOutput` (:140) emit `item_canonicals`; provenance tool handler (:4418 block) emits them.
- Test: `src/calculation-bundles.test.ts` (unit: per-scope grouping of `recomputeCalculationBundle`), `src/calculation-bundles.integration.test.ts` (DB matrix), `src/mcp.test.ts` (output schema shape).

**RED tests (write first, run, show failure):**

Unit (no DB):

```ts
// src/calculation-bundles.test.ts
test("recomputeCalculationBundle groups consensus per scope", () => {
    const out = recomputeCalculationBundle(
        bundleWith(eventResults, item0Results, item1Results),
    );
    expect(out.event.nutrients.calories.value).toBe(500); // from event-scope providers only
    expect(out.items.get(0)!.nutrients.calories.value).toBe(300);
    expect(out.items.get(1)!.nutrients.calories.value).toBe(200);
});
```

DB matrix (extend `src/calculation-bundles.integration.test.ts`), cases required:

1. Bundle with event scope + items 0 and 1, all providers succeeded -> exactly 3 canonical rows (`scope_key` in `event`, `item:0`, `item:1`); each row's `source_result_ids` reference only provider rows with the same `ordinal` (assert via SQL join).
2. **Negative isolation test:** an extreme item-scoped calorie value does NOT change the event canonical calories (assert event canonical equals consensus of event-scope providers alone).
3. Mixed statuses: item 1 has only `failed`/`unavailable` providers -> item 1 canonical row exists with `status='pending'`/`consensus_status='insufficient_data'` and NULL nutrients; event and item 0 unaffected.
4. Retry (same fingerprint) -> deduplicated, still exactly one canonical row per scope (no duplicates; UNIQUE `(event_id, version, scope_key)` untouched).
5. Correction via `commitCalculationCorrection` with event+item scopes -> new version has per-scope canonical rows; prior version's rows intact (immutability assert: row count and values for version N unchanged).
6. Rollback: inject failure after provider insert (existing failure-injection pattern in the suite) -> zero canonical rows for the aborted version, zero orphan provider rows.

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/calculation-bundles.integration.test.ts
# Expected RED: new tests fail — one canonical row with ordinal NULL, item rows missing
bun test src/calculation-bundles.test.ts
# Expected RED: recomputeCalculationBundle has no per-scope shape
```

**Implementation boundary (GREEN):** Only the symbols listed above. The consensus policy itself (`computeConsensus`, thresholds, policy version) is untouched. Caller-proposed values remain non-authoritative. `readPersistedWriteStatus` keeps failing closed ("canonical result was not persisted") when the **event-scope** row is missing and now also verifies one canonical row exists per distinct ordinal among succeeded provider rows.

**REFACTOR:** Deduplicate the two canonical-INSERT code paths (bundle + correction) into one private `persistCanonicalPerScope(client, eventId, version, perScope)` helper. Gates stay green.

**PostgreSQL/MCP acceptance commands:**

```bash
bun run typecheck && bun run test:unit
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
# MCP layer: commit_calculation_bundle / get_calculation_provenance round-trip with item scopes
# is exercised inside legacy-meal-tools.integration.test.ts or mcp-food-tracking.test.ts via
# InMemoryTransport — at least ONE end-to-end MCP test must submit an event+item bundle and read
# item_canonicals back through get_calculation_provenance with structuredContent schema-parsed.
git diff --check && bunx prettier --check src/calculation-bundles.ts src/meal-events.ts src/mcp.ts src/calculation-bundles.test.ts src/calculation-bundles.integration.test.ts src/mcp.test.ts
```

**Documentation impact:** `docs/food-tracking-agent-driven.md` — one paragraph: canonical rows are materialized per scope; `item_canonicals` in bundle/correction/provenance outputs. `README.md` provenance section: mention item scopes.

**Commit boundary:** 2 commits: `test: cover per-scope canonical materialization (RED->GREEN together with fix)` may be merged as one `fix: materialize calculation canonicals per scope` (tests + fix), then `docs: describe per-scope canonical readback`. Push after gates.

**Reviewer-terra checklist:**

- [ ] SQL evidence in test output/assertions proves 3 canonical rows for the matrix case and per-scope `source_result_ids` (FAIL if source IDs are still selected with a bare `ordinal IS NULL`).
- [ ] Negative isolation test exists and passes (item calories cannot move event calories).
- [ ] Correction path has its own per-scope test (not just the bundle path).
- [ ] Prior-version immutability asserted after correction.
- [ ] `item_canonicals` present in `commit_calculation_bundle`, `commit_calculation_correction`, and `get_calculation_provenance` structured outputs and Zod-parsed in at least one real MCP transport test.
- [ ] No migration file changed (`git diff HEAD~2 -- db/migrations` empty).
- [ ] Gate counts reported; unit and db counts strictly greater than S0 baseline; 0 fail / 0 db-skip.

**Risks/rollback:** Behavior change for any existing consumer that read the single canonical row — legacy reads use `ordinal IS NULL` event rows (unchanged, still written). If the per-scope write breaks the DB gate irreparably mid-slice, `git revert` the fix commit; no schema rollback needed (no DDL).

---

## Slice S2 — Concurrency acceptance + correction/migration acceptance matrix

**Goal:** One focused acceptance suite that pins the literal plan promises: concurrent identical bundles converge, migration `005` reruns safely, correction rollback/stale-version/cross-user/failed-provider round-trips are proven against real PostgreSQL and real MCP transport.

**Non-goals:** New product behavior. If a test finds a real defect, STOP, report to reviewer-terra, and the fix becomes its own micro-slice — do not silently widen this slice.

**Dependencies:** S1 (asserts per-scope shapes).

**Exact files/symbols:**

- Create: `src/calculation-acceptance.integration.test.ts` (new destructive DB suite; migrate-all in `beforeAll` following the pattern of `src/meal-captures.integration.test.ts:19`).
- Modify: `scripts/test-db-gate.ts:23` — append the new suite to `suites` (gate then reports 8 suites; its zero-test-hidden-skip guard applies automatically).

**RED tests (all in the new file; each is a named case reviewer-terra can grep):**

1. `"concurrent identical calculation bundles converge"` — two `Promise.all`-raced `commitCalculationBundle` calls (two pool clients), same fingerprint. Assert: one fingerprint on the version row; exactly one provider row per provider+scope; exactly one canonical row per scope; loser either deduplicates or fails cleanly with **zero** partial rows (`SELECT count(*)` per table).
2. `"concurrent identical corrections yield one new version"` — race `commitCalculationCorrection` with the same `correction_idempotency_key`. Assert: exactly one version `N+1`, no version `N+2`, no orphan rows.
3. `"migration 005 reruns safely"` — apply `001..005`, then re-apply `db/migrations/005_calculation_corrections.sql` on a populated DB. Assert: no error, no data loss (row counts before == after), constraints/indexes still present (`pg_constraint`/`pg_indexes` checks for `meal_event_versions_prior_fk`, `uniq_correction_bundle_fingerprint`).
4. `"correction rollback leaves prior state intact"` — failure injected after new provider/canonical rows are written; transaction aborts. Assert: `current_version` unchanged, zero rows for aborted version.
5. `"stale-version correction with fresh idempotency key is rejected"` — correction targeting version N when current is N+1, new idempotency key. Assert: `"correction must append the current version"` error, no writes.
6. `"direct cross-user correction is rejected"` — repository-level call with mismatched `user_id`. Assert: not-found/ownership error, no writes.
7. `"MCP correction round-trip"` — `InMemoryTransport` client calls `commit_calculation_correction`; assert `structuredContent` parses with the correction schema and the DB shows version N+1 (SQL assert in the same test).
8. `"failed provider is readable through public provenance"` — bundle containing a `failed` provider with `error_code`/`error_message`; `get_calculation_provenance` over MCP returns them verbatim with NULL nutrients.

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/calculation-acceptance.integration.test.ts
# Expected RED initially: file does not exist -> create with failing/todo-free real asserts; cases
# 1-2 may pass immediately if S1 code is already correct — that is allowed; RED here means the
# suite runs and any genuinely-unmet promise fails loudly. Report which cases were born green.
```

**Implementation boundary (GREEN):** test code + one-line suites addition only. Production edits forbidden (see non-goals escape hatch).

**REFACTOR:** extract shared bundle-builder fixtures if the file exceeds ~600 lines.

**PostgreSQL/MCP acceptance commands:** full gate battery; DB gate must now print `... across 8 DB suites`.

**Documentation impact:** none.

**Commit boundary:** one commit: `test: add calculation concurrency and correction acceptance matrix`. Push after gates.

**Reviewer-terra checklist:**

- [ ] All 8 named cases exist (grep the names) and pass against real PostgreSQL.
- [ ] Case 1/2 use genuine concurrency (`Promise.all` with two clients), not sequential retry.
- [ ] Case 3 re-applies the real `005` file, not a paraphrase of it.
- [ ] DB gate output shows 8 suites, 0 fail, 0 skip; unit counts unchanged or higher.
- [ ] Zero production-file diffs in the commit (`git show --stat` contains only the new test + `scripts/test-db-gate.ts`).

**Risks/rollback:** Races can be flaky — use deterministic barriers (start both after `Promise.resolve`, rely on `FOR UPDATE` ordering), and if a case is irreducibly timing-dependent, serialize the assert phase, never `sleep`-and-hope. Rollback = revert the single commit.

---

## Slice S3 — NULL-vs-zero presence contract in public aggregates

**Goal:** Missing/pending core macros (`calories`, `protein_g`, `carbs_g`, `fat_g`) stop becoming numeric `0` in summary, goal progress, trends, widgets, and CSV export. Provider-supplied real `0` stays `0`. (Decision D4.)

**Non-goals:** Legacy write provenance statuses (S4). Fiber/sugar/alcohol day-sum semantics (already handled; see comments at `src/mcp.ts:403-415` and `TRENDS_DAY_ITEM`).

**Dependencies:** S0 (independent of S1/S2, but scheduled after to avoid `src/mcp.ts` merge conflicts).

**Exact files/symbols:**

- Modify: `src/mcp.ts` — `sumMeals` (:394): per-macro presence-aware sum returning `number | null` for the four core macros plus `meals_total`/`meals_calculated` counts; `TOTALS_ITEM` (:556): four core macros become `.nullable()`, add `meals_total: z.number().int()`, `meals_calculated: z.number().int()`; every totals literal builder (`totalsPayloadOf`-style builders near the schema; the plan's implementer must update ALL call sites the compiler flags — `get_nutrition_summary` :2077 block, `get_goal_progress` :2497 block, `get_trends` :3739 block, `buildMealProgress` users at log_meal :1254 / update_meal :2666); CSV export path used by `export_meals` (:3908) keeps empty cells (never writes `0` for NULL — verify and pin, it may already be correct).
- Modify: `public/widgets/src/templates/*.html` where totals render (at minimum `meal-logged` progress and summary/trends templates) — render `—`/hidden stat for null, keep `0` rendering for real zero.
- Test: `src/mcp.test.ts` (unit: `sumMeals` presence table), `src/legacy-meal-tools.integration.test.ts` (MCP round-trips), `src/widgets.test.ts` (template guards, same style as the existing trends null test at :62).

**RED tests:**

Unit:

```ts
test("sumMeals: fully pending selection yields null core macros", () => {
    const t = sumMeals([pendingMeal(), pendingMeal()]);
    expect(t.calories).toBeNull();
    expect(t.meals_calculated).toBe(0);
    expect(t.meals_total).toBe(2);
});
test("sumMeals: mixed pending+ready sums only calculated values", () => {
    const t = sumMeals([pendingMeal(), mealWith({ calories: 300 })]);
    expect(t.calories).toBe(300);
    expect(t.meals_calculated).toBe(1);
});
test("sumMeals: explicit zero is a real zero, not null", () => {
    const t = sumMeals([mealWith({ calories: 0 })]);
    expect(t.calories).toBe(0);
    expect(t.meals_calculated).toBe(1);
});
```

MCP integration (real transport + PostgreSQL, in `src/legacy-meal-tools.integration.test.ts`): `get_nutrition_summary`, `get_goal_progress`, `get_trends`, and `export_meals` for three fixtures — fully pending day, mixed day, explicit-zero meal. Assert `structuredContent` nulls/counts and CSV empty-cell behavior. **Remove/rewrite the existing assertions that pin `calories: 0` for pending meals** (audit: the old test enshrines the bug) — list every deleted assertion in the handoff.

```bash
bun test src/mcp.test.ts          # RED: sumMeals returns 0s and has no counts
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts   # RED on new cases
```

**Implementation boundary (GREEN):** `sumMeals` + declared schemas + builders + templates. Do NOT touch storage, consensus, or provider paths — they are already null-correct. Goal-progress percentage against a null total renders as "no data yet", never `0%` of goal met... nor `NaN`.

**REFACTOR:** single `presenceSum(meals, key)` helper; template null-guard partial if duplicated.

**PostgreSQL/MCP acceptance commands:** full gate battery.

**Documentation impact:** README provenance paragraph + `docs/food-tracking-agent-driven.md`: totals are nullable with presence counts; null means "no calculated value in selection".

**Commit boundary:** 2 commits: `fix: preserve null core macros in public aggregates` (code+tests), `docs: document totals presence contract`. Push after gates.

**Reviewer-terra checklist:**

- [ ] The three-fixture matrix (pending / mixed / explicit-zero) is asserted through REAL MCP transport for summary, progress, trends, and export.
- [ ] Old `calories: 0`-for-pending assertions are gone; handoff lists them.
- [ ] `TOTALS_ITEM` core macros `.nullable()` + integer presence counts; declared output schemas of all four read tools re-parse in tests.
- [ ] Explicit zero fixture proves `0` survives end-to-end.
- [ ] No `?? 0` remains on the four core macros in `sumMeals` (grep evidence) — fiber/sugar/alcohol day-sum `?? 0` at :406-408 may remain (documented rationale in code comment).
- [ ] Widget templates guard null (test-pinned as in `src/widgets.test.ts:62` style).
- [ ] Gates green; counts reported.

**Risks/rollback:** Breaking change for schema-pinned clients (accepted per D4). Widgets rendering `null` unexpectedly — template tests pin it. Rollback = revert both commits; no DDL.

---

## Slice S4 — Honest provenance status on legacy writes

**Goal:** `log_meal`, `bulk_import_meals`, and `update_meal` structured outputs state explicitly that a compatibility write is not a complete calculation bundle: `provenance_status`, `event_version`, `has_calculation_bundle`, and a one-line `provenance_note`.

**Non-goals:** Changing what legacy writes persist (compatibility provider row semantics stay).

**Dependencies:** S3 (same schemas/builders in `src/mcp.ts`).

**Exact files/symbols:**

- Modify: `src/mcp.ts` — `MEAL_PROGRESS_OUTPUT_SCHEMA` (:590): add `provenance_status: z.enum(["pending","compatibility","complete"])`, `event_version: z.number().int().min(1)`, `has_calculation_bundle: z.boolean()`, `provenance_note: z.string()`; `BULK_IMPORT_OUTPUT_SCHEMA` (near :1452 block): same per-import summary fields; `buildMealProgress` and the bulk-import serializer populate them from `readPersistedWriteStatus`/`deriveWriteProvenance` (`src/meal-events.ts:255`).
- Test: `src/legacy-meal-tools.integration.test.ts` — MCP round-trips assert the new fields for (a) plain `log_meal` -> `compatibility`, `has_calculation_bundle:false`; (b) `update_meal` on a compatibility event -> same; (c) an event later completed by `commit_calculation_bundle` -> a follow-up read shows `complete` via provenance tool (cross-check).

**RED:**

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  RUN_LEGACY_MEAL_DB_TESTS=1 bun test src/legacy-meal-tools.integration.test.ts
# RED: structuredContent lacks provenance_status; Zod parse of extended schema fails
```

**GREEN boundary:** output construction only; reuse existing derivation helpers, no new persistence. **REFACTOR:** share one `writeProvenanceFields(status)` builder between the three tools.

**Acceptance commands:** full gate battery.

**Documentation impact:** README + agent-driven doc: legacy writes always disclose `pending/compatibility`; only `commit_calculation_bundle` produces `complete`.

**Commit boundary:** one commit `feat: disclose provenance status on legacy meal writes`; push after gates.

**Reviewer-terra checklist:**

- [ ] All three tools' declared `outputSchema` carry the four fields; asserted via real MCP transport, not handler unit calls.
- [ ] Status values proven: compatibility write -> `compatibility`; bundle-completed event readback -> `complete`.
- [ ] No change to persisted rows (diff shows only output-layer code + tests + docs).
- [ ] Gates green; counts reported.

**Risks/rollback:** none structural; revert single commit.

---

## Slice S5 — Public capture media path with real byte lifecycle

**Goal:** A new `attach_meal_capture_media` MCP tool makes `meal_capture_media` reachable end-to-end with the promised lifecycle: base64 bytes in, backend-generated capture-scoped storage key, SHA-256/byte-size verification, staging via `MediaStore`, retry-safe attach, staged-file cleanup when the DB transaction rolls back. (Decision D2.)

**Non-goals:** STT/OCR/vision; event/version media promotion at confirm time beyond what `confirmMealCapture` already validates; receipt-based host adapter.

**Dependencies:** S0. (Independent of S1–S4 but touches `src/mcp.ts`; run serially.)

**Exact files/symbols:**

- Modify: `src/media-store.ts` — add `generateCaptureStorageKey({capture_id, kind, sha256})` => `capture/${capture_id}/${kind}-${sha256}`, `isGeneratedCaptureStorageKey(...)`; extend `MediaStore` with `putCapture(...)` and `delete(storage_key)` if `delete` is absent (inspect interface at :50 first).
- Modify: `src/meal-captures.ts` — new `attachCaptureMediaBytes(pool, mediaStore, captureId, userId, input)` that: decodes/validates bytes (cap 8 MiB decoded, MIME allow-list `image/jpeg|image/png|image/webp|audio/ogg|audio/mpeg|audio/mp4`), computes SHA-256 server-side (never trusts caller hash; caller-supplied `sha256`, if present, must match or the call fails), stages the file, then INSERTs the row inside a transaction reusing `saveCaptureMedia`'s state checks (:219); on transaction error deletes the staged file before rethrowing; on `ON CONFLICT (capture_id, sha256) DO NOTHING` duplicate, returns the existing identity (retry-safe) and removes the redundant staged copy only if the key differs (generated keys are content-addressed, so re-staging the same key is a no-op overwrite of identical bytes).
- Modify: `src/mcp.ts` — `registerTools` deps seam (:1245) gains `mediaStore?: MediaStore`; default `createMediaStore(process.env.MEDIA_ROOT ?? "var/media")`; register `attach_meal_capture_media` with strict input schema (`capture_id`, `kind`, `mime_type`, `bytes_base64`, optional `duration_ms/width/height/metadata`, `idempotency_key`), declared `outputSchema` + `structuredContent` (capture id, media id, `storage_key`, `sha256`, `byte_size`, capture state), user scope from `userId`, annotations `readOnlyHint:false, destructiveHint:false, idempotentHint:true`.
- Modify: `src/index.ts` — pass a process-wide media store into server construction (follow `buildMcpServer` at `src/mcp.ts:4892`); add `MEDIA_ROOT` to README env docs.
- Test: `src/meal-captures.integration.test.ts` (repository-level lifecycle), `src/mcp-food-tracking.test.ts` (MCP round-trips).

**RED tests:**

Repository-level (real PostgreSQL + tmp dir media root):

1. attach happy path: file exists at generated key, on-disk SHA-256 recomputed == returned `sha256`, DB row matches (`storage_key`, `byte_size`, `sha256`).
2. rollback cleanup: failure injected between staging and COMMIT -> DB row absent AND file absent.
3. retry-safe: same bytes attached twice -> one DB row, one file, second call returns same identity without error.
4. tampered hash: caller supplies wrong `sha256` -> rejected, nothing staged/persisted.
5. capture state guard: attach on `confirmed`/`cancelled` capture -> `"capture is no longer editable"`.

MCP-level (`InMemoryTransport` + real PostgreSQL): 6. full public path: `start_meal_capture` -> `attach_meal_capture_media` -> `save_meal_capture_draft` (draft referencing the media) -> `confirm_meal_capture` succeeds and event aggregate carries the media row (this is the exact path the audit says is impossible today — confirmation currently rejects media-bearing drafts because the table can't be filled over MCP). 7. cross-user attach rejected (distinct name from existing cross-user tests — see S6 dedup). 8. malformed input matrix: oversized payload, disallowed MIME, invalid base64 -> structured errors, no rows/files.

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/meal-captures.integration.test.ts    # RED: attachCaptureMediaBytes not defined
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/mcp-food-tracking.test.ts            # RED: tool not registered
```

**GREEN boundary:** listed symbols only. `saveCaptureMedia` stays (internal seam) but the MCP tool goes through the byte-verified path exclusively — no MCP input may set `storage_key` directly. **REFACTOR:** fold shared validation between `validateCaptureMedia` and the new path.

**PostgreSQL/MCP acceptance commands:** full gate battery. Additionally file-level evidence in tests (`Bun.file(path).exists()` asserts) — reviewer-terra checks tests assert the filesystem, not only DB rows.

**Documentation impact:** README (tool table + `MEDIA_ROOT` env + byte lifecycle paragraph), `docs/food-tracking-agent-driven.md` (Hermes sends bytes; backend owns identity/verification/cleanup).

**Commit boundary:** 2 commits: `feat: attach meal capture media through MCP with staged byte lifecycle` (code+tests), `docs: document capture media byte lifecycle`. Push after gates.

**Reviewer-terra checklist:**

- [ ] `attach_meal_capture_media` registered with strict input schema, declared `outputSchema`, `structuredContent`, user scope; no caller-controlled `storage_key`.
- [ ] SHA-256 computed server-side; tampered-hash test passes.
- [ ] Rollback test proves BOTH row and file are gone; retry test proves single row+file.
- [ ] Case 6 (start->attach->draft->confirm over real MCP) passes — the previously-impossible path.
- [ ] 8 MiB cap and MIME allow-list enforced with tests.
- [ ] No Telegram/provider imports appeared (`git grep -iE 'telegram|myfitnesspal' src/meal-captures.ts src/media-store.ts` shows nothing new beyond existing provider enum usage).
- [ ] Gates green; counts reported.

**Risks/rollback:** Filesystem state outside the DB transaction — mitigated by stage-then-insert with cleanup-on-error ordering and content-addressed keys (orphan risk limited to a crash window; keys are re-derivable and idempotent). No DDL (table `meal_capture_media` already exists). Rollback = revert commits + `rm -rf var/media` in dev only.

---

## Slice S6 — Machine-checkable capture outputs + dedicated correction schema + test dedup

**Goal:** Every capture lifecycle tool (`start/append/answer/draft/get/cancel/expire/confirm` + S5's attach) declares `outputSchema` and returns `structuredContent`; corrections get their own explicit output schema (D7); the duplicated cross-user test name is fixed.

**Non-goals:** Changing capture behavior or persistence.

**Dependencies:** S5 (attach tool included in the sweep), S1 (schema shapes include `item_canonicals`).

**Exact files/symbols:**

- Modify: `src/mcp.ts` — capture tool registrations at :4491, :4524, :4548, :4577, :4599, :4621, :4644, :4668 (+ attach from S5): add Zod `outputSchema` per tool and return `structuredContent` alongside human-readable text (current handlers return `JSON.stringify` inside text — e.g. `start_meal_capture` at :4508-4519).
- Modify: `src/calculation-bundles.ts:128` — replace the alias with `CALCULATION_CORRECTION_OUTPUT_SCHEMA = CALCULATION_BUNDLE_OUTPUT_SCHEMA.extend({ prior_version: z.number().int().min(1), correction_reason: z.string().min(1), correction_author: z.string().min(1) }).strict()`; populate in the correction handler (`src/mcp.ts:4817` block, `outputSchema` at :4840).
- Modify: `src/mcp-food-tracking.test.ts:343/:454` — rename one duplicate to describe its actual scenario (inspect both bodies; they differ in setup).
- Test: `src/mcp.test.ts` — exact runtime schema tests: call each capture tool over `InMemoryTransport` (DB-gated where needed -> place DB-dependent ones in `src/mcp-food-tracking.test.ts`), parse `structuredContent` with the declared schema, assert `.strict()` rejection of extra keys.

**RED:**

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/mcp-food-tracking.test.ts   # RED: structuredContent undefined for capture tools
bun test src/mcp.test.ts                   # RED where transport-only schema checks apply
```

**GREEN boundary:** output layer + schemas + the rename. **REFACTOR:** one `captureStateOutput(capture)` serializer shared by all capture tools.

**Acceptance commands:** full gate battery. Handoff includes `git grep -c 'outputSchema' src/mcp.ts` before/after (before: 14).

**Documentation impact:** README tool table gains a note that all capture tools return structured content.

**Commit boundary:** 2 commits: `feat: declare structured outputs for capture lifecycle tools`, `fix: give corrections a dedicated output contract and dedupe cross-user test names`. Push after gates.

**Reviewer-terra checklist:**

- [ ] All 9 capture tools have declared `outputSchema` AND runtime `structuredContent` proven by transport tests.
- [ ] `CALCULATION_CORRECTION_OUTPUT_SCHEMA` is no longer `=== CALCULATION_BUNDLE_OUTPUT_SCHEMA` (identity check in a unit test) and carries the three correction fields end-to-end.
- [ ] `grep -c '"rejects cross-user capture message, answer, and draft mutations"' src/mcp-food-tracking.test.ts` == 1.
- [ ] Gates green; counts reported.

**Risks/rollback:** Clients parsing the old text-JSON keep working (text content remains). Revert commits.

---

## Slice S7 — Database readiness distinct from process health

**Goal:** A readiness probe that actually checks PostgreSQL: `/ready` returns 200 only when `SELECT 1` succeeds; failure returns 503 with a redacted, actionable message; `/health` stays a pure process liveness check.

**Non-goals:** Blocking server start (Bun serves immediately; readiness is the gate), connection retry loops, orchestration.

**Dependencies:** S0 only.

**Exact files/symbols:**

- Modify: `src/index.ts` — near `app.get("/health", ...)` (:268): add `app.get("/ready", ...)` performing `SELECT 1` via the shared pool with a 2s timeout; 503 body names the host/db from a **redacted** `DATABASE_URL` (strip credentials: parse URL, print `host:port/dbname` only); keep `/health` untouched and keep it excluded from the access log (:23) — add `/ready` to the same exclusion.
- Create: `src/readiness.ts` — `checkDatabaseReadiness(pool): Promise<{ok:true} | {ok:false, error:string}>` and `redactDatabaseUrl(url:string): string` (pure, unit-testable).
- Test: `src/readiness.test.ts` (unit: redaction never leaks password/user; error mapping), plus a DB-gated case in `src/db.integration.test.ts`: readiness ok against the live test DB; readiness fails against a wrong-port pool (`postgres://localhost:5439/nope`, short timeout) with a redacted message.

**RED:**

```bash
bun test src/readiness.test.ts   # RED: module missing
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun test src/db.integration.test.ts   # RED on new readiness cases
```

**GREEN boundary:** the two files + `src/index.ts` route wiring. **REFACTOR:** none expected.

**Acceptance commands:** full gate battery, plus manual evidence in handoff:

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test bun src/index.ts &   # dev-only, kill after
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/ready   # 200
curl -s localhost:3000/health                                    # ok
```

(Port per README/env; if the server reads `PORT`, use it. Kill the process afterwards.)

**Documentation impact:** README: `/health` = liveness, `/ready` = DB readiness; troubleshooting line for 503.

**Commit boundary:** one commit `feat: add database readiness probe with redacted diagnostics`; push after gates.

**Reviewer-terra checklist:**

- [ ] `/ready` 200 requires a real successful `SELECT 1` (test-proven); `/health` unchanged.
- [ ] Redaction test proves no credentials in any failure output (unit test includes a password-bearing URL fixture).
- [ ] Failed-readiness path tested against an unreachable port, bounded by timeout (suite doesn't hang).
- [ ] Gates green; counts reported.

**Risks/rollback:** none structural; revert commit.

---

## Slice S8 — Supabase/OAuth drift removal and repo-truth docs

**Goal:** One architecture in the repository: delete `supabase/migrations/*` and `docs/google-auth-setup.md`, rename `src/supabase.test.ts` to match its subject (D6), rewrite `CLAUDE.md`'s stale claims (analytics-to-Supabase at line 7, any other Supabase mentions), scrub stale Supabase comments in `src/import.ts` and `src/mcp.test.ts`.

**Non-goals:** Touching `db/migrations/*` (the historical-fixture references to `meals` in migration files are correct and stay), changing analytics behavior.

**Dependencies:** S0.

**Exact files/symbols:**

- Delete: `supabase/` (12 SQL files), `docs/google-auth-setup.md`.
- Rename: `src/supabase.test.ts` -> name matching its content (coder inspects first; e.g. `src/analytics.test.ts` — the handoff states the inspected subject).
- Modify: `CLAUDE.md` (line 7 claim -> current truth: analytics persisted to local PostgreSQL `tool_analytics` table — verify actual sink in `src/analytics.ts` before writing), `src/import.ts` + `src/mcp.test.ts` comment scrub.
- Test: none new beyond the rename keeping the suite green; this slice is proven by grep + gates.

**RED-equivalent (evidence-first for a cleanup slice):**

```bash
git grep -in supabase -- ':!supabase' ':!.hermes' | sort > /tmp/supabase-before.txt   # record
```

**GREEN:** perform deletions/renames/edits. Then:

```bash
git grep -in supabase -- ':!.hermes' ':!db/migrations'
# Expected: zero hits, or only deliberate historical mentions in README's "older deployments" note —
# each surviving hit must be justified in the handoff line by line.
```

**Acceptance commands:** full gate battery (unit count may shift if the renamed file's describe labels change — report).

**Documentation impact:** is the slice.

**Commit boundary:** one commit `chore: remove Supabase/OAuth artifacts and fix repo-truth docs`; push after gates.

**Reviewer-terra checklist:**

- [ ] `supabase/` and `docs/google-auth-setup.md` gone; `src/supabase.test.ts` gone; renamed file's tests all pass and the new name matches its describe blocks.
- [ ] `CLAUDE.md` contains no false Supabase claims; its analytics statement matches `src/analytics.ts` reality (terra spot-checks the code).
- [ ] Surviving `supabase` grep hits (outside `.hermes/` and `db/migrations/`) each justified.
- [ ] Gates green; counts reported.

**Risks/rollback:** Deletions are in git history; revert restores. No runtime risk (runtime never touched `supabase/`).

---

## Slice S9 — Operator docs and smoke truth

**Goal:** README migration order is real (`001..005`), and `scripts/mcp-smoke.ts` exercises all eight legacy read paths plus the capture attach path, so the operator smoke reflects the actual system.

**Non-goals:** New product behavior; CI wiring.

**Dependencies:** S5 (attach tool exists for the smoke).

**Exact files/symbols:**

- Modify: `README.md:123-127` — full `psql` chain `001..005`; `:153` — order sentence lists `001..005`; keep the destructive-`002` warning.
- Modify: `scripts/mcp-smoke.ts` — add calls + asserts for `get_meals_today`, `get_meals_by_date_range`, `get_goal_progress`, `get_trends`, `get_meal_patterns`; add a capture round-trip (`start_meal_capture` -> `attach_meal_capture_media` with a tiny fixture image -> `save_meal_capture_draft` -> `confirm_meal_capture`); smoke asserts `structuredContent` presence per S6.
- Test: the smoke IS the test.

**RED:** run the current smoke, record which paths are absent (grep list in handoff). **GREEN:**

```bash
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test \
  bun run scripts/mcp-smoke.ts
# Expected: exits 0; output names every tool exercised, including the five added reads and the capture path
```

**Acceptance commands:** smoke run above + full gate battery (unchanged counts expected) + README chain copy-paste-verified against a fresh disposable DB:

```bash
dropdb --if-exists nutrition_mcp_smoke && createdb nutrition_mcp_smoke
for f in db/migrations/00{1,2,3,4,5}_*.sql; do psql postgres://localhost:5432/nutrition_mcp_smoke -v ON_ERROR_STOP=1 -f "$f"; done
dropdb nutrition_mcp_smoke
```

**Documentation impact:** is the slice.

**Commit boundary:** 2 commits: `docs: document the full 001-005 migration chain`, `test: extend MCP smoke to all legacy reads and capture media`. Push after gates.

**Reviewer-terra checklist:**

- [ ] README shows all five migrations in both the command block and the order sentence; the chain was actually executed against a fresh DB (output in handoff).
- [ ] Smoke calls all 8 legacy read tools (`log`->`today`->`by_date`->`by_date_range`->`search`->`summary`->`goal_progress`->`trends`->`patterns`->`export`->`delete` at minimum) + capture attach path; exits 0.
- [ ] Gates green; counts reported.

**Risks/rollback:** none; revert commits.

---

## Slice S10 — Plan directory becomes a source of truth

**Goal:** `.hermes/plans/INDEX.md` gives every plan family a status (`superseded | implemented | accepted | open`) with pointers to the superseding document; the 14 historical markdown files that keep `format:check` red are prettier-formatted; the repository-wide format gate goes green.

**Non-goals:** Rewriting historical verdicts (FAIL documents stay FAIL — the index says what superseded them); any production code.

**Dependencies:** S9 (index reflects final campaign docs).

**Exact files/symbols:**

- Create: `.hermes/plans/INDEX.md` — table: family, files, status, superseded-by, evidence (commit range or slice).
- Modify: exactly the files `bunx prettier --check .` lists (14 at audit time + any archived by S0 commit 5 — re-run the check to enumerate; formatting only, `git diff --word-diff` must show no semantic edits).
- No production files.

**RED:** `bun run format:check` — record the failing file list. **GREEN:** `bunx prettier --write <that list>` + write INDEX; `bun run format:check` — passes repo-wide.

**Acceptance commands:** `bun run format:check` (green, repo-wide — first time in the repo's recent history), full gate battery unchanged.

**Documentation impact:** is the slice. Optionally note in README's contributing section that `format:check` is now a real repo gate.

**Commit boundary:** 2 commits: `docs: add plan status index`, `style: format historical plan documents`. Push after gates.

**Reviewer-terra checklist:**

- [ ] Every plan family from the audit table appears in INDEX with a status and, where superseded, a pointer.
- [ ] `bun run format:check` green repo-wide.
- [ ] Formatting commit contains zero non-markdown files and no semantic diffs (spot-check 3 files with `git diff --word-diff HEAD~1 -- <file>` — whitespace/wrapping only).
- [ ] Historical FAIL verdict documents were not edited except formatting.
- [ ] Gates green.

**Risks/rollback:** none; revert commits.

---

## Slice S11 — Campaign truth-sync and closeout

**Goal:** Final verification that repo truth, docs, and the plan record agree: full gate battery from a clean clone, counts recorded, INDEX updated with this campaign's outcome, closeout document written.

**Non-goals:** New code. Any red discovered here spawns a new micro-slice; it is not patched inside S11.

**Dependencies:** all slices.

**Exact files/symbols:**

- Create: `.hermes/plans/2026-08-05-gap-remediation-closeout.md` — per-slice commit SHAs, final gate counts, deviations from this plan (each with reviewer-terra's acceptance reference), remaining known-external items (restating the audit's out-of-repo list verbatim so nobody mistakes them for regressions).
- Modify: `.hermes/plans/INDEX.md` — this campaign marked `accepted` with evidence range.

**Verification (the slice's substance):**

```bash
# From a pristine clone to kill working-directory luck:
cd "$(mktemp -d)" && git clone /Users/fishhead/.workspace/projects/nutrition-mcp repo && cd repo
bun install
bun run typecheck
bun run test:unit
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run test:db
bun run format:check
git diff --check
DATABASE_URL=postgres://localhost:5432/nutrition_mcp_test DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test bun run scripts/mcp-smoke.ts
```

Expected: everything green; DB gate reports 8 suites; counts strictly above the S0 baseline; smoke exits 0.

**Commit boundary:** one commit `docs: close out gap-remediation campaign`; push.

**Reviewer-terra checklist:**

- [ ] Clean-clone battery output included verbatim in the closeout doc; all green; 8 DB suites.
- [ ] Closeout lists every slice with its commit SHAs and terra verdict reference.
- [ ] External follow-ups restated as out-of-repo (no silent scope creep into the domain layer during the campaign: `git grep -iE 'telegram|node-telegram|grammy' src/` empty).
- [ ] `main` == `origin/main`; working tree clean.

**Risks/rollback:** none.

---

## Appendix A — Baseline numbers reviewer-terra holds every slice against

| Gate                                    | Baseline (post-S0)                   | Rule                                                                       |
| --------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------- |
| `bun run test:unit`                     | 445 pass / 84 skip / 0 fail          | fail=0 always; pass count monotonically non-decreasing; skip only DB-gated |
| `bun run test:db`                       | 82 pass / 0 skip / 0 fail / 7 suites | fail=0, skip=0 always; suites become 8 at S2                               |
| `bun run typecheck`                     | clean                                | always                                                                     |
| `git diff --check`                      | clean                                | always                                                                     |
| `bunx prettier --check <changed files>` | clean                                | every slice; repo-wide only from S10                                       |

## Appendix B — What must never appear in any diff

`CREATE TABLE meals`, `CREATE VIEW meals`, Telegram/provider SDK imports in `src/`, `?? 0` on core-macro presence paths after S3, caller-authoritative consensus, caller-supplied `storage_key` on the MCP media path, `synced` written to a journal row by this repo, edits to `db/migrations/001..005` in place.
