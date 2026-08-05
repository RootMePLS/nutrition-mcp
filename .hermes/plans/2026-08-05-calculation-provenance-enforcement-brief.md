# Brief: enforce calculation provenance for every nutrition meal write

## Repository
- `/Users/fishhead/.workspace/projects/nutrition-mcp`
- Bun + TypeScript MCP server, PostgreSQL, append-only `meal_events` model.
- Current branch: `main`, currently aligned with `origin/main` at audit time.
- Working tree is already dirty with unrelated tracked changes and many untracked `.hermes/plans/*` files. Do not reset, stash, overwrite, or clean unrelated work.

## User-visible incident
On 2026-08-05 Hermes logged a breakfast through a path that persisted a meal with zero nutrition values instead of retaining the three calculations (own calculation, nutrition-local, MyFitnessPal) and the canonical median. The agent-side workflow was supposed to calculate independently, query nutrition-local and MFP, compare all three, preserve raw results, and store the median.

The immediate data was manually repaired, but the repository must prevent a repeat and make the provenance queryable. A successful write response must not mean "meal row exists" when provider results/canonical evidence were not persisted.

## Grounded repository evidence
- `db/migrations/002_food_tracking.sql` is the append-only event schema and explicitly removes the flat `meals` model.
- `db/migrations/003_meal_captures.sql` adds capture/event storage.
- `db/migrations/004_calculation_bundles.sql` adds `source_id`, `basis`, `units`, `provenance`, and `calculation_bundle_fingerprint`.
- `db/migrations/005_calculation_corrections.sql` adds correction/audit fields.
- `src/nutrition-bundle-types.ts` defines provider results, raw payloads, fingerprints, and validation.
- `src/calculation-bundles.ts` implements transactional `commitCalculationBundle()` and `commitCalculationCorrection()`, recomputes canonical consensus, and persists provider rows plus canonical rows.
- `src/mcp.ts` exposes `validate_calculation_bundle` and `commit_calculation_bundle`, but there is no verified read tool that returns the persisted provider bundle/raw payloads for an event/version.
- `src/meal-types.ts` permits `CreateMealEventCommand.provider_results`, but the planner must verify every production write path and whether any compatibility/legacy path can still create an event with an empty or synthetic provider result set.
- Existing integration coverage in `src/calculation-bundles.integration.test.ts` proves transactional bundle persistence, idempotency, raw payload/provenance fields, canonical recomputation, and immutable corrections. Do not duplicate this coverage without identifying the missing public/write-path guarantee.
- Existing adjacent plans may be stale or in progress. Reconcile live HEAD and current code before proposing file changes; do not assume the legacy meal migration plan is complete.

## Required workflow
Planner-fable must inspect the live repository and write a grounded implementation plan at:
`/Users/fishhead/.workspace/projects/nutrition-mcp/.hermes/plans/2026-08-05-calculation-provenance-enforcement-plan.md`

The plan must answer:
1. Which MCP-reachable meal creation/correction paths can persist a meal without a complete provider-result bundle or canonical result?
2. Whether the fix belongs in `createMealEvent`, `confirm_meal_capture`, legacy compatibility writes, `commit_calculation_bundle`, or a new explicit command/tool boundary. State the invariant and the narrowest enforcement point.
3. How the agent can retrieve all persisted calculations for an event/version, including provider, source_id, status, raw_payload, provenance, nutrients, basis, units, algorithm/request fingerprints, errors, canonical result, eligible/outlier providers, threshold, policy version, and fingerprint.
4. Whether a new read MCP tool is required, and its exact user-scoped schema/output/error behavior.
5. How idempotency, current-version reads, immutable corrections, pending/failed/unavailable providers, and explicit external-write authorization remain intact.
6. How to distinguish NULL/missing nutrition from zero. No defaulting missing values to zero.
7. How to preserve the agent boundary: Hermes performs external provider calls and independent calculation; nutrition-mcp stores/validates/recomputes/reads results. Do not add Telegram, webhook, STT, OCR, vision, or provider workers.
8. How to handle already-created legacy events with no bundle. Recommend an honest read status and a correction/backfill path; do not fabricate historical provider results.

## Scope
In scope:
- A bounded backend/MCP contract change that makes calculation provenance durable and queryable.
- Validation/guardrails at the narrowest common write boundary.
- Readback of provider results and canonical audit evidence.
- RED-GREEN tests through real PostgreSQL and a real MCP client/transport where applicable.
- Documentation and tool descriptions that state the actual contract.

Out of scope:
- Calling nutrition-local, MyFitnessPal, web search, or any external provider from the repository.
- Telegram/agent orchestration, photo/OCR/vision/audio processing.
- Rebuilding the old flat `meals` table or compatibility view.
- Rewriting unrelated legacy meal read/write migration work unless the audit proves this provenance fix cannot be correct without a focused dependency.
- Manual repair of the breakfast data already corrected in external systems.

## Mandatory TDD/acceptance requirements for the plan
- Start with failing tests proving a meal write cannot report nutrition-ready while its calculation bundle/canonical evidence is absent, unless the contract explicitly permits a pending state and exposes it.
- Test three provider results with two-agree/one-outlier consensus and assert the persisted canonical value is recomputed, not a caller proposal.
- Test raw payload and source/provenance fields survive a write/read round trip.
- Test failed/unavailable providers are retained as status/error evidence and are not converted to zero.
- Test duplicate bundle commit is idempotent and conflicting fingerprint content is rejected without mutation.
- Test correction creates a new version and leaves prior provider/canonical rows unchanged.
- Test event/user scoping through MCP: another user cannot read or mutate the bundle by event ID.
- Test a legacy event with no bundle returns an explicit pending/unavailable provenance state rather than invented results.
- Gate PostgreSQL tests on `DATABASE_URL_TEST`; a missing variable is a skip, never evidence of passing database coverage.
- Include focused, full-suite, typecheck, format, diff, and real MCP smoke/regression commands with real local values, never placeholders.

## Planner output
The plan must contain:
- current-reality gap report;
- architecture stance and invariant;
- exact files/functions/tests to modify or add;
- public MCP schema/output and error semantics;
- TDD slice order;
- migration decision, if any;
- acceptance criteria;
- executable verification commands;
- risks, out-of-scope boundaries, and follow-on work.

Do not implement production code during planning. After the plan artifact is written and verified, stop and report its path plus any user decision required before coder-kimi starts.
