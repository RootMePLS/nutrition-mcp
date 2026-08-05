# Terra remediation: agent-driven capture and calculation bundle

Repo: /Users/fishhead/.workspace/projects/nutrition-mcp
Rejected commit: b931c0b2804655beadc475a2a58b060301c54cb4
Plan: .hermes/plans/2026-08-04-food-tracking-ingestion-and-calculation-plan.md

Reviewer findings are real. Preserve existing work, but do not claim Stage A/B complete until these are implemented and proven with real PostgreSQL tests.

## Stage A fixes

1. Implement capture repository lifecycle:
    - `readMealCapture`
    - `cancelMealCapture`
    - `expireMealCapture`
    - explicit state transition validation and idempotent replay
    - row locking for every mutating transition
    - tests for restart/read, cancel, expiry, invalid transitions, duplicate requests

2. Make confirmation atomic:
    - lock the capture row with `FOR UPDATE` before checking state or creating the event;
    - derive the event idempotency key from the capture identity server-side; do not allow a caller to create a different root for the same capture;
    - create event, child rows, capture confirmation state, and journal intent in one transaction, or provide a repository transaction callback that keeps the entire operation atomic;
    - rollback must leave no event when capture confirmation fails;
    - concurrent confirms must yield exactly one event root and one current capture state.

3. Implement capture media path:
    - insert/read `meal_capture_media` metadata;
    - require generated media identity tied to capture/event/version/kind/hash;
    - preserve raw media references without weakening `enforce_media_identity` on final event attachment;
    - test media attach, read, safe unrelated key rejection, and cleanup/rollback behavior.

4. Enforce evidence/provenance validation at runtime:
    - validate source kind/precedence, hashes, metadata, and retention of all submitted evidence;
    - user text remains authoritative but lower-precedence evidence is retained.

## Stage B fixes

5. Create `src/nutrition-bundle.ts` and implement the actual persistence seam:
    - validate bundle structure, scopes, basis/units, raw payload, algorithm/model version, statuses, finite nullable nutrients;
    - compute and verify the stable fingerprint from canonical bundle content; reject mismatches;
    - recompute canonical solely from normalized provider rows through `computeConsensus`;
    - submitted Hermes proposal is non-authoritative audit data only;
    - persist all provider rows and canonical rows with source result IDs in one transaction;
    - preserve item and event scopes.

6. Add bundle idempotency/correction behavior:
    - same capture/event/version + same verified bundle fingerprint returns existing persisted result without duplicates;
    - changed portion/evidence/provider input produces a new fingerprint and explicit correction/version path;
    - concurrent identical bundle submissions converge to one logical result.

7. Add an additive MCP tool, e.g. `commit_meal_calculation_bundle`:
    - accepts only confirmed capture/event context;
    - accepts Hermes-supplied provider rows and optional non-authoritative canonical proposal;
    - recomputes backend canonical;
    - returns provider statuses, canonical state, event/version IDs, journal state honestly;
    - does not call external MCP servers.

8. Separate MFP calculation availability from write authorization:
    - `myfitnesspal` provider may be unavailable/failed without implying sync;
    - only an explicit confirmed `добавь` authorization creates pending MFP write journal intent;
    - add tests for no authorization, authorized commit, unavailable MFP, retries, and no false synced.

## Tests and verification

Add real DB integration files:

- `src/meal-captures.integration.test.ts`
- `src/nutrition-bundle.integration.test.ts`

Coverage must include:

- migrations `001 → 002 → 003`;
- capture read/cancel/expiry/restart;
- atomic confirmation rollback;
- concurrent confirmation with alternate caller keys rejected/ignored;
- one capture → one event root;
- capture media persistence and identity;
- all provider scopes/results/canonical source IDs;
- fingerprint mismatch/retry/concurrent bundle idempotency;
- changed input correction;
- MFP authorization vs unavailable calculation.

Run:

```bash
DATABASE_URL_TEST='postgres://localhost:5432/nutrition_mcp_test' bun test
bun run typecheck
bun run format:check
bun run scripts/typecheck.ts
bunx prettier --check <changed files>
git diff --check
```

Report pre-existing repository format failures separately. Do not modify plan artifacts. Commit the remediation with a focused commit and report exact SHA and test totals.
