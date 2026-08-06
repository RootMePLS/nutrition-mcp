# Nutrition MCP gap-remediation campaign brief

## Goal

Turn the verified plan-vs-code audit into an executable campaign for the standard workflow:

`planner-fable -> coder-kimi -> reviewer-terra`

The campaign must close the actual repository gaps without restoring the flat `meals` model or moving Hermes-owned orchestration into `nutrition-mcp`.

## Source of truth

Read first:

- `/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-05-plan-vs-code-gap-audit.md`
- current `HEAD`, git history and working tree in `/Users/fishhead/.workspace/projects/nutrition-mcp`
- current source, migrations, MCP registration, tests and operator docs

If `graphify-out/graph.json` exists by the time planning starts, query it before reading source. If it does not exist, do not invent graph evidence.

## Current state

- Branch: `main`
- Pinned baseline at brief creation: `fdfa2e6`
- `main` matched `origin/main` during the audit.
- The checkout is dirty. It contains substantial provenance/readback/output-schema work that passes tests but is not in `HEAD`.
- Do not reset, clean, discard or overwrite any existing work.
- No workflow writer process was active when this brief was created.
- Verified current-working-tree gates:
    - unit: 445 pass, 0 fail, 84 DB-gated skips;
    - PostgreSQL DB gate: 82 pass, 0 fail, 0 skip across 7 suites;
    - typecheck: pass;
    - `git diff --check`: pass.
- Repository-wide format remains red because of historical plan markdown. Keep this separate from changed-file formatting.

## Confirmed implementation gaps

### Product and persistence gaps

1. Calculation bundle accepts event and item scopes but computes one consensus across all results and persists canonical only for `ordinal IS NULL`.
2. Correction materialization repeats the same per-scope bug.
3. `saveCaptureMedia()` is not reachable through a public MCP tool.
4. Capture media lacks the promised byte lifecycle: generated identity, byte/hash verification, retry-safe staging and cleanup after rollback.
5. Core macro aggregates can turn missing/pending `NULL` values into numeric zero.
6. Legacy writes do not expose explicit `pending/compatibility/complete` provenance status.
7. The late provenance campaign exists only in the dirty working tree and must be delivered as focused, reviewable commits.

### Acceptance and operational gaps

1. No concurrent identical calculation-bundle PostgreSQL test.
2. No complete event-plus-item-scope bundle/correction matrix.
3. No explicit safe rerun test for migration `005`.
4. Missing correction rollback, stale-version, direct cross-user and real MCP/PostgreSQL round-trip cases.
5. No public failed-provider round-trip with `error_code` and `error_message`.
6. Capture lifecycle MCP outputs are inconsistent; several tools return JSON text without declared output schemas and structured content.
7. No database readiness probe distinct from process health.
8. README migration order is stale, and the local MCP smoke omits five legacy read paths.
9. Supabase/OAuth artifacts and contradictory repository guidance remain.
10. Historical plans need a status index, but plan cleanup must not masquerade as feature implementation.

### External follow-ups, not backend imports

Keep these outside the nutrition domain layer:

- Telegram/STT/OCR/vision ingestion;
- Hermes parsing, clarification and independent estimate;
- calls to nutrition-local and MyFitnessPal tools;
- real MyFitnessPal journal delivery adapter;
- backup scheduler/cloud retention/restore drills;
- operational permanent delete of real backup copies.

The repository may expose honest seams and contracts for these systems. It must not grow direct Telegram/provider imports unless a later explicit task says so.

## Planning requirements

Produce one repo-grounded campaign plan at:

`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-05-gap-remediation-campaign-plan.md`

The plan must:

1. Reconcile `HEAD` truth and working-tree truth before proposing edits.
2. Start with a safe closeout strategy for the existing dirty provenance work. Do not mix unrelated pre-existing changes into feature commits.
3. Decompose the campaign into small ordered slices. Each slice gets its own coder-kimi implementation and reviewer-terra gate before the next slice starts.
4. State dependencies and recommended order. Do not send the whole campaign to one coder invocation.
5. Give exact files and symbols for every task.
6. Require TDD with visible RED, GREEN and REFACTOR commands.
7. Require focused commits after each logical task and push only after gates pass.
8. Preserve append-only `meal_events`; never restore a flat `meals` table or compatibility view.
9. Preserve raw evidence, source IDs, provider payloads and nullable missing values.
10. Recompute canonical data in the backend once per scope using the existing consensus policy.
11. Keep event scope and every item ordinal independent through validation, persistence, source-result IDs, readback, correction and retry.
12. Make media identity and cleanup executable through the public MCP path, not repository-only tests.
13. Require real PostgreSQL evidence with explicit disposable `DATABASE_URL_TEST=postgres://localhost:5432/nutrition_mcp_test`.
14. Require real MCP SDK transport tests for all affected public tools.
15. Report unit and DB pass/skip/fail counts separately.
16. Keep historical plan formatting debt separate from changed-file quality gates.
17. Include rollback and recovery instructions for each migration or storage change.
18. Include acceptance criteria that reviewer-terra can evaluate as PASS/FAIL without interpreting intent.
19. Add a final campaign truth-sync and documentation closeout slice.
20. Identify contradictions or decisions at the top of the plan. Prefer a recommended resolution instead of stopping on low-risk ambiguity.

## Required slice shape

For every slice include:

- goal and non-goals;
- dependencies;
- exact files/symbols;
- RED tests;
- implementation boundary;
- PostgreSQL/MCP acceptance commands;
- documentation impact;
- commit boundary;
- reviewer-terra acceptance checklist;
- risks and rollback notes.

## Delivery rule

Planner-fable writes only the campaign plan. It must not modify production code, tests, migrations or current git state.
